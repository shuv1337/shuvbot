import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_ARTIFACT_SCHEMA_VERSION,
  DASHBOARD_MAX_ARTIFACT_BYTES,
  parseDashboardArtifact
} from "../src/artifact-schema.ts";

describe("dashboard artifact schema", () => {
  test("projects the current coordinator artifact shape", () => {
    const parsed = parseDashboardArtifact(artifact());
    expect(parsed.version).toBe(DASHBOARD_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.sessions).toHaveLength(1);
  });

  test("rejects unknown versions, invalid findings, and oversized artifacts", () => {
    expect(() => parseDashboardArtifact({ ...artifact(), version: 2 })).toThrow();
    expect(() =>
      parseDashboardArtifact({
        ...artifact(),
        findings: { findings: [{ ...finding(), severity: "urgent" }] }
      })
    ).toThrow();
    expect(() => parseDashboardArtifact(artifact(), DASHBOARD_MAX_ARTIFACT_BYTES + 1)).toThrow(
      /exceeds/
    );
  });
});

function artifact() {
  return {
    version: 1,
    workflow: {
      id: 42,
      htmlUrl: "https://github.com/example/repo/actions/runs/42",
      repository: {
        id: 7,
        fullName: "example/repo",
        htmlUrl: "https://github.com/example/repo",
        private: true
      },
      artifact: { id: 8, name: "shuvbot", sizeBytes: 1024, expiresAt: null }
    },
    run: {
      runId: "run-1",
      repo: "example/repo",
      subject: { kind: "pull_request", number: 9, commentId: 10 },
      command: { name: "review", args: "" },
      event: "issue_comment",
      actor: "alice",
      mode: "review",
      startedAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-20T00:01:00.000Z",
      status: "success",
      review: { decision: "comments", quorumMet: true, sessions: [session()] }
    },
    findings: { version: 1, findings: [finding()] }
  };
}

function finding() {
  return {
    id: "finding-1",
    title: "Unsafe interpolation",
    severity: "high",
    confidence: "high",
    path: "src/query.ts",
    line: 12
  };
}

function session() {
  return {
    sessionId: "specialist:security",
    role: "specialist",
    reviewer: "security",
    model: "subscription/standard",
    status: "completed",
    retryCount: 0,
    usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 }
  };
}
