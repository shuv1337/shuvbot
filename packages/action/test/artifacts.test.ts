import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createRunRecord, recordReview, type RunRecord } from "../../core/src/run-record.ts";
import type { ReviewFinding } from "../../core/src/review-schema.ts";
import {
  ACTION_ARTIFACT_MAX_BYTES,
  ACTION_ARTIFACT_MAX_EVENTS,
  ACTION_ARTIFACT_MAX_FIELD_BYTES,
  writeFailureDiagnostics,
  writeReviewArtifacts
} from "../src/artifacts.ts";

describe("review artifacts", () => {
  test("writes redacted run, findings, manifest, session, and event artifacts with safe modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifacts-"));
    const secret = "private-token";
    const artifacts = await writeReviewArtifacts({
      runnerTemp: root,
      runRecord: reviewedRun({ errors: [{ class: "provider", message: secretValue(secret) }] }),
      findings: [finding(secretValue(secret))],
      contextManifest: {
        sections: [{ id: "secret", title: secretValue(secret), bytes: 1, untrusted: true }],
        totalBytes: 1
      },
      sessionLog: [failedEvent(secretValue(secret))]
    });

    for (const path of artifactPaths(artifacts)) {
      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain(secret);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(artifacts.dir)).mode & 0o077).toBe(0);
    await expect(readFile(artifacts.findingsPath, "utf8")).resolves.toContain("[REDACTED]");
    await expect(readFile(artifacts.eventsPath!, "utf8")).resolves.toContain(
      '"event":"session.failed"'
    );
  });

  test("accepts an artifact exactly at the byte limit and rejects one byte over", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-boundary-"));
    const findings = Array.from({ length: 33 }, (_, index) => ({
      ...finding(""),
      id: `finding-${index}`
    }));
    let remaining = ACTION_ARTIFACT_MAX_BYTES - (JSON.stringify(findings, null, 2).length + 1);
    for (const item of findings) {
      const bytes = Math.min(remaining, ACTION_ARTIFACT_MAX_FIELD_BYTES);
      item.body = "x".repeat(bytes);
      remaining -= bytes;
    }
    expect(remaining).toBe(0);
    const identityRedactor = {
      redactString: (value: string) => value,
      redact: <T>(value: T): T => value
    };
    const exact = await writeReviewArtifacts({
      runnerTemp: root,
      runRecord: run(),
      findings,
      contextManifest: { sections: [], totalBytes: 0 },
      redactor: identityRedactor
    });
    expect((await readFile(exact.findingsPath)).byteLength).toBe(ACTION_ARTIFACT_MAX_BYTES);

    findings.at(-1)!.body += "x";
    await expect(
      writeReviewArtifacts({
        runnerTemp: root,
        runRecord: run(),
        findings,
        contextManifest: { sections: [], totalBytes: 0 },
        redactor: identityRedactor
      })
    ).rejects.toThrow(
      `reviewbot-findings.json exceeds the ${ACTION_ARTIFACT_MAX_BYTES}-byte limit`
    );
  });

  test("rejects oversized model-derived run, context, session, and event fields", async () => {
    const oversized = "x".repeat(ACTION_ARTIFACT_MAX_FIELD_BYTES + 1);
    const cases = [
      { runRecord: run({ errors: [{ class: "model", message: oversized }] }) },
      {
        contextManifest: {
          sections: [{ id: "context", title: oversized, bytes: 1, untrusted: true }],
          totalBytes: 1
        }
      },
      { runRecord: reviewedRun({ reviewSessionMessage: oversized }) },
      { sessionLog: [failedEvent(oversized)] }
    ];

    for (const overrides of cases) {
      const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-oversized-"));
      await expect(
        writeReviewArtifacts({
          runnerTemp: root,
          runRecord: run(),
          findings: [],
          contextManifest: { sections: [], totalBytes: 0 },
          ...overrides
        })
      ).rejects.toThrow(/field exceeding the \d+-byte limit/);
      await expect(readdir(root)).resolves.toEqual([]);
    }
  });

  test("bounds event count without silently truncating", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-events-"));
    const event = failedEvent("failure");
    const exact = await writeReviewArtifacts({
      runnerTemp: root,
      runRecord: run(),
      findings: [],
      contextManifest: { sections: [], totalBytes: 0 },
      sessionLog: Array.from({ length: ACTION_ARTIFACT_MAX_EVENTS }, () => event)
    });
    const exactContents = await readFile(exact.eventsPath!, "utf8");
    expect(exactContents.trimEnd().split("\n")).toHaveLength(ACTION_ARTIFACT_MAX_EVENTS);

    await expect(
      writeReviewArtifacts({
        runnerTemp: root,
        runRecord: run(),
        findings: [],
        contextManifest: { sections: [], totalBytes: 0 },
        sessionLog: Array.from({ length: ACTION_ARTIFACT_MAX_EVENTS + 1 }, () => event)
      })
    ).rejects.toThrow(
      `session events exceed the ${ACTION_ARTIFACT_MAX_EVENTS}-item artifact limit`
    );
    await expect(readFile(exact.eventsPath!, "utf8")).resolves.toBe(exactContents);
    expect((await readdir(exact.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("preserves every existing final when any artifact fails before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-precommit-"));
    const dir = join(root, "reviewbot");
    await mkdir(dir);
    const names = [
      "reviewbot-run.json",
      "reviewbot-findings.json",
      "reviewbot-context-manifest.json"
    ];
    await Promise.all(names.map((name) => writeFile(join(dir, name), `old:${name}`)));

    await expect(
      writeReviewArtifacts({
        runnerTemp: root,
        runRecord: run(),
        findings: [finding("x".repeat(ACTION_ARTIFACT_MAX_FIELD_BYTES + 1))],
        contextManifest: { sections: [], totalBytes: 0 }
      })
    ).rejects.toThrow(/field exceeding the \d+-byte limit/);

    for (const name of names) {
      await expect(readFile(join(dir, name), "utf8")).resolves.toBe(`old:${name}`);
    }
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("cleans all temps and preserves complete finals when a deterministic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-rename-"));
    const dir = join(root, "reviewbot");
    await mkdir(dir);
    await writeFile(join(dir, "reviewbot-run.json"), "old-run");
    await writeFile(join(dir, "reviewbot-findings.json"), "old-findings");
    await mkdir(join(dir, "reviewbot-context-manifest.json"));

    await expect(
      writeReviewArtifacts({
        runnerTemp: root,
        runRecord: run(),
        findings: [],
        contextManifest: { sections: [], totalBytes: 0 }
      })
    ).rejects.toThrow("Unable to commit review artifacts");

    await expect(readFile(join(dir, "reviewbot-run.json"), "utf8")).resolves.toEndWith("\n");
    await expect(readFile(join(dir, "reviewbot-findings.json"), "utf8")).resolves.toBe("[]\n");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("sanitizes preparation and filesystem failure messages", async () => {
    const secret = "private-token";
    const redactor = {
      redactString: (value: string) => value.replaceAll(secret, "[REDACTED]"),
      redact<T>(_value: T): T {
        throw new Error(`serialization failed: ${secret}`);
      }
    };
    await expect(
      writeReviewArtifacts({
        runnerTemp: await mkdtemp(join(tmpdir(), "reviewbot-artifact-error-")),
        runRecord: run(),
        findings: [],
        contextManifest: { sections: [], totalBytes: 0 },
        redactor
      })
    ).rejects.toThrow("serialization failed: [REDACTED]");

    const root = await mkdtemp(join(tmpdir(), "reviewbot-artifact-write-error-"));
    const secretPath = join(root, secretValue(secret));
    await writeFile(secretPath, "not a directory");
    await chmod(secretPath, 0o600);
    let failure: unknown;
    try {
      await writeReviewArtifacts({
        runnerTemp: secretPath,
        runRecord: run(),
        findings: [],
        contextManifest: { sections: [], totalBytes: 0 }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Unable to commit review artifacts");
    expect((failure as Error).message).not.toContain(secret);
  });

  test("persists failure diagnostics to the reviewbot artifact directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reviewbot-diagnostics-"));
    const path = await writeFailureDiagnostics({
      runnerTemp: dir,
      message: "All review skills failed: Claude exited with 1\nstdout: Not logged in"
    });

    expect(path).toBe(join(dir, "reviewbot", "reviewbot-agent-error.txt"));
    await expect(readFile(path, "utf8")).resolves.toContain("Claude exited with 1");
    await expect(readFile(path, "utf8")).resolves.toContain("Not logged in");
  });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ...createRunRecord({
      event: "pull_request",
      actor: "alice",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    }),
    ...overrides
  };
}

function reviewedRun(
  options: { errors?: RunRecord["errors"]; reviewSessionMessage?: string } = {}
): RunRecord {
  return recordReview(run(options.errors === undefined ? {} : { errors: options.errors }), {
    engine: "coordinator",
    tier: "trivial",
    decision: "degraded",
    quorumMet: false,
    requiredReviewers: ["code-quality"],
    successfulReviewers: [],
    missingReviewers: ["code-quality"],
    sessions: [
      {
        sessionId: "specialist-1",
        role: "specialist",
        reviewer: "code-quality",
        model: "subscription/default-coding",
        status: options.reviewSessionMessage === undefined ? "completed" : "failed",
        retryCount: 0,
        ...(options.reviewSessionMessage === undefined
          ? {}
          : {
              error: {
                code: "REVIEW_PROVIDER_FAILURE",
                message: options.reviewSessionMessage,
                retryable: false
              }
            })
      }
    ],
    retries: 0
  });
}

function finding(body: string): ReviewFinding {
  return {
    id: "finding-1",
    skill: "security",
    title: "Finding",
    body,
    severity: "high",
    confidence: "high",
    path: "src/index.ts"
  };
}

function failedEvent(message: string) {
  return {
    time: "2026-08-03T00:00:00.000Z",
    event: "session.failed",
    sessionId: "specialist-1",
    role: "specialist",
    reviewer: "security",
    model: "subscription/default-coding",
    attempt: 1,
    error: { code: "REVIEW_PROVIDER_FAILURE", message, retryable: true }
  } as const;
}

function secretValue(secret: string): string {
  return `CLAUDE_CODE_OAUTH_TOKEN=${secret}`;
}

function artifactPaths(artifacts: Awaited<ReturnType<typeof writeReviewArtifacts>>): string[] {
  return [
    artifacts.runPath,
    artifacts.findingsPath,
    artifacts.contextManifestPath,
    artifacts.reviewSessionsPath!,
    artifacts.eventsPath!
  ];
}
