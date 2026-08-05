import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../../core/src/config.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { CoordinatorEngineResult } from "../src/engine.ts";
import { createReviewExecutionPlanFromConfig, type ReviewPlanFile } from "../src/plan.ts";
import { parseCoordinatorResult, type CoordinatorResult } from "../src/results.ts";
import {
  coordinatorRunStatus,
  createReviewDeadline,
  parseReviewDurationMs,
  renderSharedReviewContext,
  runCoordinatorReview,
  type RunCoordinatorReviewInput
} from "../src/run.ts";
import type { PersistedReviewState, ReviewStateStore } from "../src/state.ts";

function changedFile(overrides: Partial<ReviewPlanFile> = {}): ReviewPlanFile {
  return {
    path: "src/index.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: "@@ -1,3 +1,5 @@\n+const value = 1;\n",
    ...overrides
  };
}

function coordinatorResult(
  overrides: Partial<{
    decision: CoordinatorResult["decision"];
    findings: unknown[];
    quorumMet: boolean;
  }> = {}
): CoordinatorResult {
  const quorumMet = overrides.quorumMet ?? true;
  return parseCoordinatorResult({
    decision: overrides.decision ?? "clean",
    findings: overrides.findings ?? [],
    dropped: [],
    coverage: {
      scheduled: ["code-quality"],
      completed: quorumMet ? ["code-quality"] : [],
      failed: quorumMet ? [] : ["code-quality"],
      timedOut: [],
      required: ["code-quality"],
      quorumMet
    },
    summary: "Coordinator result."
  });
}

function execution(overrides: Partial<CoordinatorEngineResult> = {}): CoordinatorEngineResult {
  const result = overrides.result ?? coordinatorResult();
  return {
    status: "completed",
    result,
    quorum: { met: true, required: ["code-quality"], missing: [], reason: "quorum met" } as never,
    coverage: result.coverage,
    specialistResults: [],
    sessions: [],
    retries: 0,
    events: [],
    repairAttempted: false,
    ...overrides
  };
}

function memoryStateStore(initial: PersistedReviewState | null = null): ReviewStateStore & {
  written: PersistedReviewState[];
} {
  const written: PersistedReviewState[] = [];
  return {
    written,
    async readReviewState() {
      return initial;
    },
    async writeReviewState(_changeId, state) {
      written.push(state);
    }
  };
}

function runInput(overrides: Partial<RunCoordinatorReviewInput> = {}): RunCoordinatorReviewInput {
  const config = normalizeConfig({});
  const deadline = createReviewDeadline(30_000);
  return {
    config,
    cwd: process.cwd(),
    files: [changedFile()],
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    redactor: new DefaultRedactor(),
    deadline,
    artifactDirectory: "/tmp/shuvbot-run-test",
    contextHeader: "Test review context.",
    dependencies: {
      executeCoordinator: async () => execution(),
      startRuntime: async () => {
        throw new Error("runtime should not start in this test");
      },
      now: () => new Date("2026-08-04T00:00:00.000Z")
    },
    ...overrides
  };
}

describe("shared coordinator review run", () => {
  test("reports no reviewable changes without starting the engine", async () => {
    let executed = 0;
    const input = runInput({
      files: [changedFile({ path: "bun.lock", patch: "@@ -1 +1 @@\n-a\n+b\n" })],
      dependencies: {
        executeCoordinator: async () => {
          executed += 1;
          return execution();
        },
        startRuntime: async () => {
          throw new Error("unused");
        },
        now: () => new Date()
      }
    });

    const run = await runCoordinatorReview(input);
    input.deadline.dispose();

    expect(run.kind).toBe("no_reviewable_changes");
    expect(executed).toBe(0);
  });

  test("returns a reviewed run with a report", async () => {
    const input = runInput();
    const run = await runCoordinatorReview(input);
    input.deadline.dispose();

    expect(run.kind).toBe("reviewed");
    if (run.kind !== "reviewed") return;
    expect(run.status).toBe("completed");
    expect(run.report.decision).toBe("clean");
    expect(run.plan.risk.tier).toBeDefined();
  });

  test("cleans up the review workspace after the engine runs", async () => {
    let workspacePath = "";
    const input = runInput({
      dependencies: {
        executeCoordinator: async ({ workspace }) => {
          workspacePath = workspace.root;
          return execution();
        },
        startRuntime: async () => {
          throw new Error("unused");
        },
        now: () => new Date()
      }
    });

    await runCoordinatorReview(input);
    input.deadline.dispose();

    expect(workspacePath).not.toBe("");
    expect(await Bun.file(`${workspacePath}/manifest.json`).exists()).toBe(false);
  });

  test("cleans up the workspace even when the engine fails", async () => {
    let workspacePath = "";
    const input = runInput({
      dependencies: {
        executeCoordinator: async ({ workspace }) => {
          workspacePath = workspace.root;
          throw new Error("engine exploded");
        },
        startRuntime: async () => {
          throw new Error("unused");
        },
        now: () => new Date()
      }
    });

    await expect(runCoordinatorReview(input)).rejects.toThrow("engine exploded");
    input.deadline.dispose();

    expect(await Bun.file(`${workspacePath}/manifest.json`).exists()).toBe(false);
  });

  test("skips state entirely when no incremental store is supplied", async () => {
    const input = runInput();
    const run = await runCoordinatorReview(input);
    input.deadline.dispose();

    expect(run.kind === "reviewed" && run.reconciliation).toBeUndefined();
  });

  test("reconciles and persists state when incremental review is enabled", async () => {
    const store = memoryStateStore();
    const input = runInput({
      incremental: { changeId: "pull-request:v1:abc", store }
    });

    const run = await runCoordinatorReview(input);
    input.deadline.dispose();

    expect(store.written).toHaveLength(1);
    expect(store.written[0]?.changeId).toBe("pull-request:v1:abc");
    expect(run.kind === "reviewed" && run.reconciliation).toBeDefined();
  });

  test("a cancelled deadline aborts the run", async () => {
    const controller = new AbortController();
    const input = runInput({ deadline: createReviewDeadline(30_000, controller.signal) });
    controller.abort();

    await expect(runCoordinatorReview(input)).rejects.toThrow("was cancelled");
    input.deadline.dispose();
  });
});

describe("coordinator run status", () => {
  test("degrades a completed run that missed quorum", () => {
    expect(
      coordinatorRunStatus(
        execution({ result: coordinatorResult({ decision: "degraded", quorumMet: false }) })
      )
    ).toBe("degraded");
  });

  test("preserves a non-completed engine status", () => {
    expect(coordinatorRunStatus(execution({ status: "timed_out" }))).toBe("timed_out");
  });

  test("reports a clean, complete run as completed", () => {
    expect(coordinatorRunStatus(execution())).toBe("completed");
  });
});

describe("shared reviewer context", () => {
  test("names the review surface and lists filtered files with reasons", () => {
    const plan = createReviewExecutionPlanFromConfig({
      files: [changedFile(), changedFile({ path: "bun.lock" })],
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      config: normalizeConfig({})
    });

    const rendered = renderSharedReviewContext(plan, "Pull request review context.");

    expect(rendered).toStartWith("Pull request review context.");
    expect(rendered).toContain(`Base SHA: ${"a".repeat(40)}`);
    expect(rendered).toContain("- modified src/index.ts (+3 -1)");
    expect(rendered).toContain("bun.lock");
    expect(rendered).toContain("[filtered:");
  });
});

describe("review duration parsing", () => {
  test("accepts compound durations and rejects zero or unbounded ones", () => {
    expect(parseReviewDurationMs("1h30m")).toBe(5_400_000);
    expect(() => parseReviewDurationMs("0s")).toThrow();
    expect(() => parseReviewDurationMs("garbage")).toThrow();
  });
});
