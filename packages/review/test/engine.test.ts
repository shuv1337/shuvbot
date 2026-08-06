import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { executeCoordinatorEngine } from "../src/engine.ts";
import type {
  CoordinatorEngineEventClock,
  CoordinatorEngineFileSystem,
  CoordinatorEngineProgressEvent
} from "../src/engine.ts";
import { classifyReviewError } from "../src/errors.ts";
import { createReviewExecutionPlan, type ReviewPlanFile } from "../src/plan.ts";
import type { ResolvedReviewPluginConfig } from "../src/plugins/types.ts";
import { REVIEW_SESSION_POLICY } from "../src/runtime/shuvcode.ts";
import type {
  ShuvcodeEvent,
  ShuvcodePromptInput,
  ShuvcodeRuntime,
  ShuvcodeSessionCreateInput,
  ShuvcodeSessionPolicy
} from "../src/runtime/shuvcode.ts";
import { BUILT_IN_REVIEWER_IDS, type BuiltInReviewerId, type ReviewTier } from "../src/types.ts";
import { createReviewWorkspace } from "../src/workspace.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("local coordinator engine", () => {
  test.each(["trivial", "lite", "full"] as const)(
    "executes a %s review end to end",
    async (tier) => {
      const runtime = new FakeRuntime();
      const { result, root } = await runEngine(tier, runtime);

      expect(result.status).toBe("completed");
      expect(result.result.decision).toBe("clean");
      expect(result.quorum.status).toBe("complete");
      expect(runtime.parents).toHaveLength(1);
      expect(runtime.specialists).toHaveLength(reviewersFor(tier).length);
      expect(runtime.prompts.every(({ text }) => !text.includes("diff --git"))).toBe(true);
      expect(runtime.prompts.at(-1)?.text).toContain("/results/code-quality.json");
      expect(existsSync(root)).toBe(false);
      expect(runtime.closed).toBe(true);
    }
  );

  test("caps specialist concurrency and configures child models", async () => {
    const runtime = new FakeRuntime({ delayMs: 15 });
    const { result } = await runEngine("full", runtime, { maxConcurrency: 6 });

    expect(result.status).toBe("completed");
    expect(runtime.maximumActive).toBe(3);
    // Shuvbot's `subscription/…` names are never sent to the runtime; each one
    // is resolved to a routable model first. This covers the coordinator session
    // as well as every specialist.
    expect(
      [...runtime.configured.values()].every(({ model }) => model?.providerID === "acme")
    ).toBe(true);
    expect(runtime.parents.at(0)?.model).toEqual({
      providerID: "acme",
      id: "reasoning",
      variant: "high"
    });
  });

  test("rejects an unsupported reasoning effort before starting a runtime", async () => {
    let started = false;
    await expect(
      runEngine("trivial", new FakeRuntime(), {
        models: {
          coordinator: "subscription/acme:reasoning@high",
          standard: "subscription/grok-4.5@xhigh"
        },
        onRuntimeStart: () => (started = true)
      })
    ).rejects.toThrow(/Unknown reasoning effort xhigh for grok-4\.5/);
    // Nothing may be spawned for a configuration fault the catalog can settle.
    expect(started).toBe(false);
  });

  test("creates policy-scoped specialist sessions instead of forking the unprompted coordinator", async () => {
    const runtime = new FakeRuntime();
    await runEngine("trivial", runtime);

    // The runtime resolves a fork boundary from persisted messages, so forking the
    // coordinator before it is prompted fails with an empty-session request error.
    expect(runtime.lifecycle.some((entry) => entry.startsWith("fork:"))).toBe(false);
    expect(runtime.lifecycle.indexOf("create:coordinator")).toBeLessThan(
      runtime.lifecycle.indexOf("prompt:coordinator")
    );
    for (const id of runtime.specialists) {
      const policy = runtime.policies.get(id);
      expect(policy).toBeDefined();
      expect(
        policy!.tools.allow.every((tool) => REVIEW_SESSION_POLICY.tools.allow.includes(tool))
      ).toBe(true);
    }
    const fresh = new FakeRuntime();
    const unprompted = await fresh.createSession({ title: "coordinator" });
    await expect(fresh.forkSession(unprompted.id, REVIEW_SESSION_POLICY)).rejects.toThrow(
      /Cannot fork empty session/
    );
  });

  test("installs policy before prompts and does not expose tool authorization in metadata", async () => {
    const runtime = new FakeRuntime();
    await runEngine("trivial", runtime);

    expect(runtime.lifecycle.slice(0, 5)).toEqual([
      "create:coordinator",
      "create:child-1:read",
      "configure:child-1",
      "prompt:child-1",
      "prompt:coordinator"
    ]);
    expect(runtime.prompts.every(({ metadata }) => metadata?.tools === undefined)).toBe(true);
  });

  test("selects specialist models from the immutable plan tier and honors reviewer overrides", async () => {
    const trivialRuntime = new FakeRuntime();
    const trivial = await runEngine("trivial", trivialRuntime, {
      models: {
        coordinator: "subscription/acme:reasoning@high",
        standard: "subscription/acme:standard",
        light: "subscription/acme:light"
      },
      pluginConfig: pluginConfigWith({
        "code-quality": { model: "subscription/acme:standard", modelOverride: false }
      })
    });
    expect(trivialRuntime.configured.get("child-1")?.model).toEqual({
      providerID: "acme",
      id: "light"
    });
    expect(trivial.plan.assignment.reviewers[0]?.modelTier).toBe("light");

    const explicitRuntime = new FakeRuntime();
    await runEngine("trivial", explicitRuntime, {
      models: {
        coordinator: "subscription/acme:reasoning@high",
        standard: "subscription/acme:standard",
        light: "subscription/acme:light"
      },
      pluginConfig: pluginConfigWith({
        "code-quality": { model: "subscription/acme:standard", modelOverride: true }
      })
    });
    expect(explicitRuntime.configured.get("child-1")?.model?.id).toBe("standard");

    const fullRuntime = new FakeRuntime();
    const full = await runEngine("full", fullRuntime, {
      models: {
        coordinator: "subscription/acme:reasoning@high",
        standard: "subscription/acme:standard",
        light: "subscription/acme:light"
      },
      pluginConfig: pluginConfigWith(
        { security: { model: "subscription/acme:security-override" } },
        "subscription/acme:standard"
      )
    });
    expect(fullRuntime.configured.get("child-1")?.model?.id).toBe("standard");
    const securitySession = [...fullRuntime.reviewers.entries()].find(
      ([, reviewer]) => reviewer === "security"
    )?.[0];
    expect(fullRuntime.configured.get(securitySession!)?.model?.id).toBe("security-override");
    expect(full.plan.assignment.reviewers.every(({ modelTier }) => modelTier === "standard")).toBe(
      true
    );
  });

  test("rejects reviewer models outside the resolved provider catalog", async () => {
    await expect(
      runEngine("trivial", new FakeRuntime(), {
        pluginConfig: pluginConfigWith({
          "code-quality": { model: "subscription/acme:not-in-catalog", modelOverride: true }
        })
      })
    ).rejects.toThrow("configured provider catalog");
  });

  test("gives specialists only matching patch references without mutating the global plan", async () => {
    const runtime = new FakeRuntime();
    const scopedConfig = pluginConfigWith({
      "code-quality": { paths: ["src/**"], ignorePaths: ["**/*.test.ts"] },
      security: { paths: ["security/**"] },
      performance: { paths: ["src/**"] },
      tests: { paths: ["**/*.test.ts"] },
      documentation: { paths: ["docs/**"] },
      release: { paths: ["changesets/**"] }
    });
    const files = [
      reviewFile("src/change.ts", 200),
      reviewFile("src/change.test.ts", 1),
      reviewFile("docs/usage.md", 1)
    ];
    const { result, plan, planSnapshot } = await runEngine("full", runtime, {
      files,
      pluginConfig: scopedConfig
    });

    expect(result.quorum.status).toBe("complete");
    expect(runtime.scopedFiles.get("code-quality")).toEqual(["src/change.ts"]);
    expect(runtime.scopedFiles.get("tests")).toEqual(["src/change.test.ts"]);
    expect(runtime.scopedFiles.get("documentation")).toEqual(["docs/usage.md"]);
    expect(runtime.scopedFiles.get("security")).toEqual([]);
    expect(runtime.prompts.every(({ text }) => !text.includes("diff --git"))).toBe(true);
    expect(plan).toEqual(planSnapshot);
    expect(Object.isFrozen(plan.assignment.reviewers)).toBe(true);
  });

  test("repairs invalid coordinator output exactly once", async () => {
    const runtime = new FakeRuntime({ invalidCoordinatorOnce: true });
    const { result } = await runEngine("trivial", runtime);

    expect(result.status).toBe("completed");
    expect(result.repairAttempted).toBe(true);
    expect(runtime.coordinatorPrompts).toBe(2);
    expect(result.retries).toBe(1);
  });

  test("repairs invalid specialist output exactly once", async () => {
    const runtime = new FakeRuntime({ invalidSpecialistOnce: "code-quality" });
    const { result } = await runEngine("trivial", runtime);

    expect(result.status).toBe("completed");
    expect(result.repairAttempted).toBe(true);
    expect(result.retries).toBe(1);
    expect(runtime.attempts.get("code-quality")).toBe(2);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "child-1",
      reviewer: "code-quality",
      status: "completed",
      retryCount: 1,
      repairAttempted: true
    });
  });

  test("reports a second invalid specialist output as a failed repaired session", async () => {
    const runtime = new FakeRuntime({ invalidSpecialistAlways: "code-quality" });
    const { result } = await runEngine("trivial", runtime);

    expect(result.status).toBe("completed");
    expect(result.result.decision).toBe("degraded");
    expect(result.repairAttempted).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.sessions[0]).toMatchObject({
      status: "failed",
      retryCount: 1,
      error: { category: "schema" }
    });
  });

  test("reports a timed-out specialist repair with its attempt accounting", async () => {
    const runtime = new FakeRuntime({
      invalidSpecialistOnce: "code-quality",
      hangSpecialistRepair: "code-quality"
    });
    const { result } = await runEngine("trivial", runtime, { specialistTimeoutMs: 15 });

    expect(result.repairAttempted).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "child-1",
      status: "timed_out",
      retryCount: 1,
      repairAttempted: true,
      error: { category: "service" }
    });
  });

  test("retries transient specialist failure and degrades when required coverage still fails", async () => {
    const runtime = new FakeRuntime({ failingReviewer: "security" });
    const { result } = await runEngine("full", runtime, { specialistTimeoutMs: 100_000 });

    expect(runtime.attempts.get("security")).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.result.decision).toBe("degraded");
    expect(result.quorum.reason).toBe("REQUIRED_REVIEWER_MISSING");
    expect(result.specialistResults.find(({ reviewer }) => reviewer === "security")?.status).toBe(
      "failed"
    );
  });

  test("enforces the hard overall deadline and cleans up", async () => {
    const runtime = new FakeRuntime({ hangReviewer: "code-quality" });
    const { result, root } = await runEngine("trivial", runtime, {
      overallTimeoutMs: 25,
      specialistTimeoutMs: 1_000
    });

    expect(result.status).toBe("timed_out");
    expect(result.result.decision).toBe("degraded");
    expect(runtime.interrupted.length).toBeGreaterThan(0);
    expect(runtime.closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("external cancellation interrupts all work and cleans up", async () => {
    const controller = new AbortController();
    const runtime = new FakeRuntime({ hangReviewer: "code-quality" });
    const running = runEngine("trivial", runtime, {
      signal: controller.signal,
      overallTimeoutMs: 1_000,
      specialistTimeoutMs: 1_000
    });
    await sleep(10);
    controller.abort();
    const { result, root } = await running;

    expect(result.status).toBe("cancelled");
    expect(result.error?.category).toBe("cancellation");
    expect(runtime.closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("uses event failure classification, cumulative usage, and actual session IDs", async () => {
    const runtime = new FakeRuntime({ eventFailureReviewer: "code-quality" });
    const { result } = await runEngine("trivial", runtime, { specialistTimeoutMs: 100_000 });

    expect(runtime.attempts.get("code-quality")).toBe(2);
    expect(result.sessions.slice(0, 2)).toMatchObject([
      {
        sessionId: "child-1",
        reviewer: "code-quality",
        attempt: 1,
        status: "failed",
        usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 }
      },
      {
        sessionId: "child-2",
        reviewer: "code-quality",
        attempt: 2,
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 }
      }
    ]);
    expect(result.events.some(({ sessionId }) => sessionId === "child-1")).toBe(true);
    expect(result.events.some(({ sessionId }) => sessionId === "child-2")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-provider-token");
  });

  test("does not retain provider text, tool inputs, errors, or unknown payloads", async () => {
    const runtime = new FakeRuntime({ emitSensitiveEvents: true });
    const { result } = await runEngine("trivial", runtime);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("completed");
    expect(serialized).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(serialized).not.toContain("raw provider response");
    expect(serialized).not.toContain("private tool input");
    expect(serialized).not.toContain("future secret payload");
  });

  test("idle without structured output fails schema validation", async () => {
    const runtime = new FakeRuntime({ idleReviewer: "code-quality" });
    const { result } = await runEngine("trivial", runtime, { specialistTimeoutMs: 100_000 });

    expect(runtime.attempts.get("code-quality")).toBe(1);
    expect(result.specialistResults[0]).toMatchObject({
      status: "failed",
      error: { category: "schema", retryable: false }
    });
  });

  test("emits a heartbeat only after 30 quiet seconds without changing hard deadlines", async () => {
    const controller = new AbortController();
    const clock = new FakeEventClock();
    const runtime = new FakeRuntime({ hangReviewer: "code-quality" });
    const running = runEngine("trivial", runtime, {
      signal: controller.signal,
      overallTimeoutMs: 1_000,
      specialistTimeoutMs: 1_000,
      eventClock: clock
    });
    while (runtime.specialists.length === 0) await sleep(0);

    clock.nowMs = 29_999;
    clock.tick();
    clock.nowMs = 30_000;
    clock.tick();
    controller.abort();
    const { result } = await running;

    expect(result.status).toBe("cancelled");
    expect(result.events.filter(({ event }) => event === "session.heartbeat")).toHaveLength(1);
    expect(result.events.find(({ event }) => event === "session.heartbeat")).toMatchObject({
      sessionId: "child-1",
      attempt: 1,
      durationMs: 30_000
    });
  });

  test("classifies a coordinator deadline consistently and cleans up", async () => {
    const runtime = new FakeRuntime({ hangCoordinator: true });
    const { result, root } = await runEngine("trivial", runtime, { coordinatorTimeoutMs: 10 });

    expect(result.status).toBe("timed_out");
    expect(result.error?.category).toBe("service");
    expect(result.sessions.at(-1)).toMatchObject({
      sessionId: "coordinator",
      status: "timed_out",
      error: { category: "service" }
    });
    expect(
      result.events.some(
        ({ event, sessionId }) => event === "session.timed_out" && sessionId === "coordinator"
      )
    ).toBe(true);
    expect(runtime.closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("accounts for a second invalid coordinator result and a timed-out repair", async () => {
    const invalid = await runEngine("trivial", new FakeRuntime({ invalidCoordinatorAlways: true }));
    expect(invalid.result).toMatchObject({
      status: "failed",
      retries: 1,
      repairAttempted: true,
      error: { category: "schema" }
    });
    expect(invalid.result.sessions.at(-1)).toMatchObject({
      status: "failed",
      retryCount: 1,
      error: { category: "schema" }
    });

    const timedOut = await runEngine(
      "trivial",
      new FakeRuntime({ invalidCoordinatorOnce: true, hangCoordinatorRepair: true }),
      { coordinatorTimeoutMs: 10 }
    );
    expect(timedOut.result).toMatchObject({
      status: "timed_out",
      retries: 1,
      repairAttempted: true,
      error: { category: "service" }
    });
    expect(timedOut.result.sessions.at(-1)).toMatchObject({
      status: "timed_out",
      retryCount: 1
    });
  });

  test("repairs provenance-invalid coordinator output", async () => {
    const runtime = new FakeRuntime({ provenanceInvalidCoordinatorOnce: true });
    const { result } = await runEngine("trivial", runtime);

    expect(result.status).toBe("completed");
    expect(result.repairAttempted).toBe(true);
    expect(runtime.coordinatorPrompts).toBe(2);
    expect(result.result.findings[0]?.id).toBe("quality-1");
  });

  test("streams sanitized progress in order and isolates throwing presentation", async () => {
    const events: CoordinatorEngineProgressEvent[] = [];
    const { result } = await runEngine("trivial", new FakeRuntime(), {
      onProgress(event) {
        events.push(event);
        if (event.status === "running") throw new Error("terminal renderer failed");
      }
    });

    expect(result.status).toBe("completed");
    expect(
      events
        .filter(({ role }) => role === "specialist")
        .map(({ status, sessionId, attempt }) => ({ status, sessionId, attempt }))
    ).toEqual([
      { status: "queued", sessionId: "specialist:code-quality", attempt: 1 },
      { status: "running", sessionId: "child-1", attempt: 1 },
      { status: "completed", sessionId: "child-1", attempt: 1 }
    ]);
    expect(JSON.stringify(events)).not.toContain("No findings");
  });

  test("streams heartbeat timing without extending its deadline", async () => {
    const controller = new AbortController();
    const clock = new FakeEventClock();
    const events: CoordinatorEngineProgressEvent[] = [];
    const running = runEngine("trivial", new FakeRuntime({ hangReviewer: "code-quality" }), {
      signal: controller.signal,
      overallTimeoutMs: 1_000,
      specialistTimeoutMs: 1_000,
      eventClock: clock,
      onProgress: (event) => {
        events.push(event);
      }
    });
    while (!events.some(({ status }) => status === "running")) await sleep(0);
    clock.nowMs = 30_000;
    clock.tick();
    controller.abort();
    await running;

    const started = events.find(
      ({ role, status }) => role === "specialist" && status === "running"
    );
    const heartbeat = events.find(({ status }) => status === "heartbeat");
    expect(heartbeat).toMatchObject({
      sessionId: "child-1",
      attempt: 1,
      atMs: 30_000,
      deadlineAtMs: started?.deadlineAtMs
    });
  });

  test("accounts for what a timed-out session spent", async () => {
    const runtime = new FakeRuntime({ burnThenHangReviewer: "code-quality" });
    const { result } = await runEngine("trivial", runtime, {
      specialistTimeoutMs: 60,
      overallTimeoutMs: 5_000
    });

    const timedOut = result.sessions.find(
      (session) => session.reviewer === "code-quality" && session.status === "timed_out"
    );
    // The scheduler abandons the losing side of the race, so the attempt itself
    // reports nothing. Reporting that as zero understated a real run by 15x.
    expect(timedOut?.usage).toMatchObject({ inputTokens: 900, outputTokens: 12_000, cost: 9.5 });
  });

  test("keeps a redacted sample of every refused result", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-rejected-"));
    await runEngine("trivial", new FakeRuntime({ invalidSpecialistAlways: "code-quality" }), {
      artifactDirectory
    });

    const rejected = JSON.parse(
      await readFile(join(artifactDirectory, "shuvbot-rejected-results.json"), "utf8")
    ) as { rejected: { role: string; repair: boolean; reason: string; sample: string }[] };

    // Both the first result and its repair are kept, so a rejection can be
    // diagnosed instead of only appearing as REVIEW_SCHEMA_INVALID.
    expect(rejected.rejected).toHaveLength(2);
    expect(rejected.rejected.map(({ repair }) => repair)).toEqual([false, true]);
    for (const sample of rejected.rejected) {
      expect(sample.role).toBe("specialist");
      expect(sample.reason.length).toBeGreaterThan(0);
      expect(sample.sample.length).toBeGreaterThan(0);
    }
  });

  test("keeps a redacted sample explaining why a session failed outright", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-provider-failure-"));
    await runEngine("trivial", new FakeRuntime({ providerFailureReviewer: "code-quality" }), {
      artifactDirectory
    });

    const rejected = JSON.parse(
      await readFile(join(artifactDirectory, "shuvbot-rejected-results.json"), "utf8")
    ) as {
      rejected: { kind: string; role: string; reviewer?: string; reason: string; sample: string }[];
    };

    // Without this the run reports only "Provider request failed" and the cause
    // has to be guessed from the model roster.
    const failure = rejected.rejected.find(({ kind }) => kind === "failure");
    expect(failure).toMatchObject({
      kind: "failure",
      role: "specialist",
      reviewer: "code-quality",
      reason: "Provider request failed"
    });
    expect(failure?.sample).toContain("type=provider.request status=400");
    // Pinned as an exact string. Asserting only "the token is absent" passed
    // for the wrong reason: DEFAULT_SECRET_PATTERNS happened to match the
    // planted value, so a sample that was never redacted at all would still
    // have satisfied it as long as the fixture used a recognisable shape.
    expect(failure?.sample).toBe(
      "type=provider.request status=400 model claude-fable-5 " +
        "rejected for authorization: Bearer [REDACTED]"
    );
  });

  test("keeps a failure sample when the coordinator itself fails", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-coordinator-failure-"));
    await runEngine("trivial", new FakeRuntime({ providerFailureCoordinator: true }), {
      artifactDirectory
    });

    const rejected = JSON.parse(
      await readFile(join(artifactDirectory, "shuvbot-rejected-results.json"), "utf8")
    ) as { rejected: { kind: string; role: string; sample: string }[] };

    const failure = rejected.rejected.find(({ kind }) => kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", role: "coordinator" });
    expect(failure?.sample).toContain("coordinator upstream refused");
  });

  test("does not spend the sample budget on sessions it cancelled itself", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-cancelled-"));
    await runEngine("trivial", new FakeRuntime({ cancelledDetailReviewer: "code-quality" }), {
      artifactDirectory
    });

    // A timed-out full-tier run would otherwise fill the bounded artifact with
    // shuvbot's own interruptions and crowd out real refusals.
    expect(existsSync(join(artifactDirectory, "shuvbot-rejected-results.json"))).toBe(false);
  });

  test("does not retain a failure sample when the failure carries no detail", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-failure-bare-"));
    await runEngine("trivial", new FakeRuntime({ failingReviewer: "code-quality" }), {
      artifactDirectory
    });
    expect(existsSync(join(artifactDirectory, "shuvbot-rejected-results.json"))).toBe(false);
  });

  test("does not write a rejected-result artifact when nothing was refused", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-rejected-none-"));
    await runEngine("trivial", new FakeRuntime(), { artifactDirectory });
    expect(existsSync(join(artifactDirectory, "shuvbot-rejected-results.json"))).toBe(false);
  });

  test("flushes durable secret-free artifacts before workspace cleanup", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-artifacts-"));
    const { result, root } = await runEngine(
      "trivial",
      new FakeRuntime({ emitSensitiveEvents: true }),
      { artifactDirectory }
    );

    expect(existsSync(root)).toBe(false);
    expect(result.artifacts).toEqual({ directory: artifactDirectory, status: "written" });
    const artifacts = await Promise.all(
      ["shuvbot-events.jsonl", "shuvbot-review-sessions.json", "shuvbot-review-result.json"].map(
        (name) => readFile(join(artifactDirectory, name), "utf8")
      )
    );
    const serialized = artifacts.join("\n");
    expect(serialized).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(serialized).not.toContain("raw provider response");
    expect(serialized).not.toContain("private tool input");
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("body");
  });

  test("reports artifact persistence failure without misreporting it as written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shuvbot-artifact-failure-"));
    const destination = join(directory, "not-a-directory");
    await writeFile(destination, "occupied");

    const { result } = await runEngine("trivial", new FakeRuntime(), {
      artifactDirectory: destination
    });

    expect(result.status).toBe("completed");
    expect(result.artifacts).toMatchObject({
      directory: destination,
      status: "failed",
      error: { category: "config" }
    });
  });

  test("times out hanging artifact I/O and leaves no atomic temp files", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "shuvbot-artifact-timeout-"));
    const fileSystem: CoordinatorEngineFileSystem = {
      mkdir,
      rename,
      rm,
      writeFile: (async (path, ...args) => {
        await (writeFile as (...values: unknown[]) => Promise<void>)(path, ...args);
        if (String(path).includes("shuvbot-events.jsonl")) {
          await new Promise<void>(() => undefined);
        }
      }) as typeof writeFile
    };
    const { result } = await runEngine("trivial", new FakeRuntime(), {
      artifactDirectory,
      overallTimeoutMs: 30,
      interruptTimeoutMs: 10,
      fileSystem
    });

    expect(result).toMatchObject({
      status: "timed_out",
      artifacts: { status: "failed", error: { category: "service" } }
    });
    expect((await readdir(artifactDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("shares one deadline and cleanup grace with delayed workspace cleanup", async () => {
    const startedAt = Date.now();
    const { result, root } = await runEngine("trivial", new FakeRuntime(), {
      overallTimeoutMs: 20,
      interruptTimeoutMs: 10,
      workspaceCleanupDelayMs: 50
    });

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(result).toMatchObject({
      status: "timed_out",
      cleanup: { status: "failed", errors: [{ message: "Review workspace cleanup timed out" }] }
    });
    await sleep(60);
    expect(existsSync(root)).toBe(false);
  });

  test("bounds hanging runtime close and reports cleanup failure without overriding review", async () => {
    const runtime = new FakeRuntime({ hangClose: true });
    const startedAt = Date.now();
    const { result, root } = await runEngine("trivial", runtime, {
      overallTimeoutMs: 20,
      interruptTimeoutMs: 15
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result.status).toBe("timed_out");
    expect(result.cleanup).toMatchObject({
      status: "failed",
      errors: [{ category: "service", message: "Review runtime cleanup timed out" }]
    });
    expect(runtime.closeStarted).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("closes a runtime that finishes starting after cancellation before workspace cleanup", async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    const runtime = new FakeRuntime({ onClose: () => lifecycle.push("runtime-close") });
    const running = runEngine("trivial", runtime, {
      signal: controller.signal,
      runtimeFactoryDelayMs: 20,
      interruptTimeoutMs: 100,
      onWorkspaceCleanup: () => lifecycle.push("workspace-cleanup")
    });
    await sleep(5);
    controller.abort();
    const { result, root } = await running;

    expect(result.status).toBe("cancelled");
    expect(runtime.closed).toBe(true);
    expect(lifecycle).toEqual(["runtime-close", "workspace-cleanup"]);
    expect(existsSync(root)).toBe(false);
  });
});

class FakeRuntime implements ShuvcodeRuntime {
  readonly url = "http://127.0.0.1:1";
  readonly parents: ShuvcodeSessionCreateInput[] = [];
  readonly specialists: string[] = [];
  readonly configured = new Map<string, Parameters<ShuvcodeRuntime["configureSession"]>[1]>();
  readonly prompts: ShuvcodePromptInput[] = [];
  readonly interrupted: string[] = [];
  readonly attempts = new Map<BuiltInReviewerId, number>();
  maximumActive = 0;
  coordinatorPrompts = 0;
  closed = false;
  private active = 0;
  private sequence = 0;
  readonly reviewers = new Map<string, BuiltInReviewerId>();
  readonly scopedFiles = new Map<BuiltInReviewerId, string[]>();
  readonly policies = new Map<string, ShuvcodeSessionPolicy>();
  readonly lifecycle: string[] = [];
  closeStarted = false;
  private readonly listeners = new Set<(event: ShuvcodeEvent) => void>();

  constructor(
    private readonly behavior: {
      delayMs?: number;
      invalidCoordinatorOnce?: boolean;
      invalidCoordinatorAlways?: boolean;
      provenanceInvalidCoordinatorOnce?: boolean;
      hangCoordinatorRepair?: boolean;
      invalidSpecialistOnce?: BuiltInReviewerId;
      invalidSpecialistAlways?: BuiltInReviewerId;
      hangSpecialistRepair?: BuiltInReviewerId;
      failingReviewer?: BuiltInReviewerId;
      providerFailureReviewer?: BuiltInReviewerId;
      hangReviewer?: BuiltInReviewerId;
      burnThenHangReviewer?: BuiltInReviewerId;
      cancelledDetailReviewer?: BuiltInReviewerId;
      eventFailureReviewer?: BuiltInReviewerId;
      idleReviewer?: BuiltInReviewerId;
      emitSensitiveEvents?: boolean;
      hangCoordinator?: boolean;
      providerFailureCoordinator?: boolean;
      hangClose?: boolean;
      onClose?: () => void;
    } = {}
  ) {}

  async createSession(input: ShuvcodeSessionCreateInput = {}) {
    if (input.policy === undefined) {
      this.parents.push(input);
      this.lifecycle.push("create:coordinator");
      const policy = { tools: { allow: ["read"] } } as const;
      this.policies.set("coordinator", policy);
      return { id: "coordinator", policy };
    }
    const policy = input.policy;
    const id = `child-${++this.sequence}`;
    this.specialists.push(id);
    this.lifecycle.push(`create:${id}:${policy.tools.allow.join(",")}`);
    this.policies.set(id, policy);
    return { id, policy };
  }

  /**
   * Mirrors the runtime precondition: a fork boundary is resolved from the
   * parent's persisted messages, so forking an unprompted session fails.
   */
  async forkSession(sessionID: string, policy: ShuvcodeSessionPolicy) {
    if (!this.prompts.some((prompt) => prompt.sessionID === sessionID)) {
      throw new Error(`Cannot fork empty session: ${sessionID}`);
    }
    const id = `child-${++this.sequence}`;
    this.lifecycle.push(`fork:${id}:${policy.tools.allow.join(",")}`);
    this.policies.set(id, policy);
    return { id, policy };
  }

  async configureSession(
    sessionID: string,
    input: Parameters<ShuvcodeRuntime["configureSession"]>[1]
  ) {
    this.lifecycle.push(`configure:${sessionID}`);
    this.configured.set(sessionID, input);
  }

  async prompt(input: ShuvcodePromptInput) {
    if (!this.policies.has(input.sessionID)) throw new Error("prompt before policy");
    this.lifecycle.push(`prompt:${input.sessionID}`);
    this.prompts.push(input);
    const reviewer = input.metadata?.reviewer;
    if (typeof reviewer === "string") {
      this.reviewers.set(input.sessionID, reviewer as BuiltInReviewerId);
      const manifestPath = input.text.match(/manifest at ([^\n]+)\./)?.[1];
      if (manifestPath !== undefined) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          files: Array<{ path: string }>;
        };
        this.scopedFiles.set(
          reviewer as BuiltInReviewerId,
          manifest.files.map(({ path }) => path)
        );
      }
    } else this.coordinatorPrompts += 1;
  }

  async wait(sessionID: string, options: { readonly signal?: AbortSignal } = {}) {
    const reviewer = this.reviewers.get(sessionID);
    if (reviewer !== undefined) {
      const attempt = (this.attempts.get(reviewer) ?? 0) + 1;
      this.attempts.set(reviewer, attempt);
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        if (this.behavior.burnThenHangReviewer === reviewer) {
          // Spends real tokens, then never finishes - what a timed-out
          // specialist actually does.
          this.emit({
            type: "session.usage.updated",
            data: { sessionID, tokens: { input: 900, output: 12_000 }, cost: 9.5 }
          });
          await untilAbort(options.signal);
        }
        if (this.behavior.cancelledDetailReviewer === reviewer) {
          // Cancellation reported inline rather than through the scheduler's
          // race, so the engine actually reaches recordFailedSession with a
          // detail in hand and the guard is what excludes it.
          throw Object.assign(
            classifyReviewError({ category: "cancellation", message: "Review session cancelled" }),
            { detail: "type=session.interrupted reason=shutdown" }
          );
        }
        if (this.behavior.hangReviewer === reviewer) await untilAbort(options.signal);
        if (this.behavior.delayMs) await sleep(this.behavior.delayMs);
        this.emit({
          type: "session.usage.updated",
          data: { sessionID, tokens: { input: 10, output: 2 }, cost: 0.01 }
        });
        if (this.behavior.emitSensitiveEvents) {
          this.emit({
            type: "session.text.delta",
            data: { sessionID, delta: "raw provider response CLAUDE_CODE_OAUTH_TOKEN=secret" }
          });
          this.emit({
            type: "session.tool.input.ended",
            data: { sessionID, text: "private tool input CLAUDE_CODE_OAUTH_TOKEN=secret" }
          });
          this.emit({
            type: "future.runtime.event",
            data: { sessionID, nested: "future secret payload CLAUDE_CODE_OAUTH_TOKEN=secret" }
          });
        }
        if (this.behavior.eventFailureReviewer === reviewer && attempt === 1) {
          this.emit({
            type: "session.error",
            data: {
              sessionID,
              error: {
                name: "APIError",
                data: { statusCode: 429, message: "private-provider-token" }
              }
            }
          });
          throw new Error("raw runtime rejection");
        }
        if (this.behavior.idleReviewer === reviewer) {
          const idle = { type: "session.idle", data: { sessionID } };
          this.emit(idle);
          return idle;
        }
        if (this.behavior.failingReviewer === reviewer) {
          throw classifyReviewError({ category: "service", message: `${reviewer} unavailable` });
        }
        if (this.behavior.providerFailureReviewer === reviewer) {
          // Shaped like a ShuvcodeSessionError: a fixed safe message plus the
          // runtime's own bounded failure text.
          throw Object.assign(
            classifyReviewError({ category: "provider", message: "Provider request failed" }),
            {
              detail:
                "type=provider.request status=400 model claude-fable-5 " +
                "rejected for authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345"
            }
          );
        }
        if (
          this.behavior.invalidSpecialistAlways === reviewer ||
          (this.behavior.invalidSpecialistOnce === reviewer && attempt === 1)
        ) {
          const invalid = completedEvent(sessionID, { invalid: true });
          this.emit(invalid);
          return invalid;
        }
        if (this.behavior.hangSpecialistRepair === reviewer && attempt === 2) {
          await untilAbort(options.signal);
        }
        const completed = completedEvent(sessionID, {
          reviewer,
          status: "completed",
          summary: "No findings.",
          findings:
            this.behavior.provenanceInvalidCoordinatorOnce && reviewer === "code-quality"
              ? [qualityFinding]
              : []
        });
        this.emit(completed);
        return completed;
      } finally {
        this.active -= 1;
      }
    }
    if (
      this.behavior.invalidCoordinatorAlways ||
      (this.behavior.invalidCoordinatorOnce && this.coordinatorPrompts === 1)
    ) {
      return completedEvent(sessionID, { invalid: true });
    }
    if (this.behavior.hangCoordinatorRepair && this.coordinatorPrompts === 2) {
      await untilAbort(options.signal);
    }
    if (this.behavior.hangCoordinator) await untilAbort(options.signal);
    if (this.behavior.providerFailureCoordinator) {
      throw Object.assign(
        classifyReviewError({ category: "provider", message: "Provider request failed" }),
        { detail: "type=provider.request status=503 coordinator upstream refused" }
      );
    }
    if (this.behavior.provenanceInvalidCoordinatorOnce) {
      const finding =
        this.coordinatorPrompts === 1
          ? { ...coordinatedQualityFinding, id: "invented", fingerprint: "invented" }
          : coordinatedQualityFinding;
      return completedEvent(sessionID, coordinatorOutput([finding]));
    }
    const completed = completedEvent(sessionID, coordinatorOutput());
    this.emit(completed);
    return completed;
  }

  async interrupt(sessionID: string) {
    this.interrupted.push(sessionID);
  }

  subscribe(listener: (event: ShuvcodeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.closeStarted = true;
    this.behavior.onClose?.();
    if (this.behavior.hangClose) await new Promise<void>(() => undefined);
    this.closed = true;
  }

  private emit(event: ShuvcodeEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

async function runEngine(
  tier: ReviewTier,
  runtime: FakeRuntime,
  overrides: Partial<{
    maxConcurrency: number;
    overallTimeoutMs: number;
    specialistTimeoutMs: number;
    coordinatorTimeoutMs: number;
    signal: AbortSignal;
    eventClock: CoordinatorEngineEventClock;
    onProgress: (event: CoordinatorEngineProgressEvent) => void | Promise<void>;
    artifactDirectory: string;
    interruptTimeoutMs: number;
    runtimeFactoryDelayMs: number;
    onRuntimeStart: () => void;
    onWorkspaceCleanup: () => void;
    workspaceCleanupDelayMs: number;
    fileSystem: CoordinatorEngineFileSystem;
    files: readonly ReviewPlanFile[];
    pluginConfig: ResolvedReviewPluginConfig;
    models: {
      coordinator: `subscription/${string}`;
      standard?: `subscription/${string}`;
      light?: `subscription/${string}`;
    };
  }> = {}
) {
  const files = overrides.files ?? [fileFor(tier)];
  const plan = createReviewExecutionPlan({
    files,
    baseSha: "base",
    headSha: "head",
    maxConcurrency: overrides.maxConcurrency ?? 3
  });
  expect(plan.risk.tier).toBe(tier);
  const planSnapshot = structuredClone(plan);
  const workspace = await createReviewWorkspace({
    files: files.map(({ path, patch }) => ({ path, patch: patch ?? "" })),
    sharedContext: "Trusted deterministic context."
  });
  if (overrides.onWorkspaceCleanup !== undefined) {
    const cleanup = workspace.cleanup.bind(workspace);
    workspace.cleanup = async () => {
      overrides.onWorkspaceCleanup?.();
      await cleanup();
    };
  }
  if (overrides.workspaceCleanupDelayMs !== undefined) {
    const cleanup = workspace.cleanup.bind(workspace);
    workspace.cleanup = async () => {
      await sleep(overrides.workspaceCleanupDelayMs!);
      await cleanup();
    };
  }
  const root = workspace.root;
  const result = await executeCoordinatorEngine({
    plan,
    workspace,
    pluginConfig: overrides.pluginConfig ?? pluginConfig,
    models: overrides.models ?? { coordinator: "subscription/acme:reasoning@high" },
    runtimeFactory: async () => {
      overrides.onRuntimeStart?.();
      if (overrides.runtimeFactoryDelayMs !== undefined) {
        await sleep(overrides.runtimeFactoryDelayMs);
      }
      return runtime;
    },
    redactor: new DefaultRedactor(),
    overallTimeoutMs: overrides.overallTimeoutMs ?? 2_000,
    specialistTimeoutMs: overrides.specialistTimeoutMs ?? 1_000,
    coordinatorTimeoutMs: overrides.coordinatorTimeoutMs ?? 1_000,
    ...(overrides.interruptTimeoutMs === undefined
      ? {}
      : { interruptTimeoutMs: overrides.interruptTimeoutMs }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.eventClock === undefined ? {} : { eventClock: overrides.eventClock }),
    ...(overrides.onProgress === undefined ? {} : { onProgress: overrides.onProgress }),
    ...(overrides.artifactDirectory === undefined
      ? {}
      : { artifactDirectory: overrides.artifactDirectory }),
    ...(overrides.fileSystem === undefined ? {} : { fileSystem: overrides.fileSystem })
  });
  return { result, root, plan, planSnapshot };
}

class FakeEventClock implements CoordinatorEngineEventClock {
  nowMs = 0;
  private readonly callbacks = new Set<() => void>();

  now() {
    return this.nowMs;
  }

  setInterval(callback: () => void, _intervalMs: number) {
    this.callbacks.add(callback);
    return callback;
  }

  clearInterval(handle: unknown) {
    this.callbacks.delete(handle as () => void);
  }

  tick() {
    for (const callback of this.callbacks) callback();
  }
}

const pluginConfig: ResolvedReviewPluginConfig = Object.freeze({
  reviewers: BUILT_IN_REVIEWER_IDS.map((id) => ({
    id,
    name: id,
    description: id,
    model: `subscription/acme:${id}` as const,
    tools: ["filesystem.read", "repository.read", "git.diff"] as const,
    promptSections: []
  })),
  providers: [
    {
      id: "subscription",
      models: [
        "acme:reasoning",
        "acme:standard",
        "acme:light",
        "acme:security-override",
        // A curated name, so a bad effort on it reaches model resolution.
        "grok-4.5",
        ...BUILT_IN_REVIEWER_IDS.map((id) => `acme:${id}`)
      ]
    }
  ],
  tiers: {
    trivial: ["code-quality"] as const,
    lite: ["code-quality", "tests", "performance"] as const,
    full: [...BUILT_IN_REVIEWER_IDS]
  }
});

function fileFor(tier: ReviewTier) {
  const additions = tier === "trivial" ? 1 : tier === "lite" ? 20 : 200;
  return {
    path: "src/change.ts",
    status: "modified" as const,
    additions,
    deletions: 0,
    patch: "diff --git a/src/change.ts b/src/change.ts\n+change"
  };
}

function reviewFile(path: string, additions: number): ReviewPlanFile {
  return {
    path,
    status: "modified",
    additions,
    deletions: 0,
    patch: `diff --git a/${path} b/${path}\n+change`
  };
}

function pluginConfigWith(
  overrides: Partial<
    Record<
      BuiltInReviewerId,
      {
        model?: `subscription/${string}`;
        modelOverride?: boolean;
        paths?: string[];
        ignorePaths?: string[];
      }
    >
  >,
  defaultModel?: `subscription/${string}`
): ResolvedReviewPluginConfig {
  return Object.freeze({
    ...pluginConfig,
    reviewers: pluginConfig.reviewers.map((reviewer) => ({
      ...reviewer,
      ...(defaultModel === undefined ? {} : { model: defaultModel }),
      ...overrides[reviewer.id],
      ...(overrides[reviewer.id]?.model !== undefined &&
      overrides[reviewer.id]?.modelOverride === undefined
        ? { modelOverride: true }
        : {})
    }))
  });
}

function reviewersFor(tier: ReviewTier): readonly BuiltInReviewerId[] {
  if (tier === "trivial") return ["code-quality"];
  if (tier === "lite") return ["code-quality", "tests", "performance"];
  return BUILT_IN_REVIEWER_IDS;
}

function completedEvent(sessionID: string, value: unknown): ShuvcodeEvent {
  return { type: "session.structured.completed", data: { sessionID, value } };
}

function coordinatorOutput(findings: readonly unknown[] = []) {
  return {
    decision: findings.length === 0 ? "clean" : "comments",
    findings,
    dropped: [],
    coverage: {
      scheduled: ["code-quality"],
      completed: ["code-quality"],
      failed: [],
      timedOut: [],
      required: ["code-quality"],
      quorumMet: true
    },
    summary: "No findings."
  };
}

const qualityFinding = {
  id: "quality-1",
  reviewer: "code-quality",
  skill: "code-quality",
  title: "Incorrect result",
  body: "The changed result is incorrect.",
  evidence: "src/change.ts:1 returns the wrong result.",
  severity: "medium",
  confidence: "high",
  path: "src/change.ts",
  line: 1
} as const;

const coordinatedQualityFinding = {
  ...qualityFinding,
  disposition: "new",
  fingerprint: "quality-1"
} as const;

function untilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("cancelled"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
