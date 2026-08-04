import { describe, expect, test } from "bun:test";
import type { CoordinatedFinding } from "../src/results.ts";
import { reconcileReviewState } from "../src/reconcile.ts";
import type { PersistedReviewState } from "../src/state.ts";

describe("incremental finding reconciliation", () => {
  test("retains unresolved findings and marks absent findings fixed on complete runs", () => {
    const result = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head-2",
      findings: [finding("still-present")],
      previous: previousState(),
      degraded: false,
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });

    expect(result.activeFindings[0]?.disposition).toBe("unresolved");
    expect(result.fixedFingerprints).toEqual(["now-fixed"]);
    expect(result.state.findings.find((item) => item.fingerprint === "now-fixed")?.status).toBe(
      "fixed"
    );
  });

  test("never resolves an absent finding during degraded coverage", () => {
    const result = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head-2",
      findings: [],
      previous: previousState(),
      degraded: true
    });

    expect(result.fixedFingerprints).toEqual([]);
    expect(result.state.findings.map((item) => item.status)).toEqual(["unresolved", "unresolved"]);
  });

  test("respects user resolution unless the coordinator marks material worsening", () => {
    const previous = previousState();
    previous.findings[0]!.status = "user_resolved";
    previous.findings[0]!.userReplies = ["acknowledged"];
    const preserved = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head-2",
      findings: [finding("still-present")],
      previous,
      degraded: false
    });
    expect(preserved.activeFindings).toEqual([]);
    expect(preserved.preservedResolvedFingerprints).toEqual(["still-present"]);

    previous.findings[0]!.severity = "medium";
    const worsened = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head-3",
      findings: [finding("still-present")],
      previous,
      degraded: false
    });
    expect(worsened.activeFindings[0]?.disposition).toBe("unresolved");
  });

  test("deterministically separates plausible fingerprint collisions", () => {
    const result = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head",
      findings: [
        finding("duplicate"),
        {
          ...finding("duplicate"),
          id: "other-id",
          body: "A separate root cause.",
          evidence: "src/a.ts:2 demonstrates a separate failure.",
          line: 2
        }
      ],
      previous: null,
      degraded: false
    });
    expect(result.activeFindings).toHaveLength(2);
    expect(new Set(result.activeFindings.map(({ fingerprint }) => fingerprint)).size).toBe(2);
    expect(
      result.activeFindings.every(({ fingerprint }) => fingerprint.includes(":collision:"))
    ).toBe(true);
  });

  test("collapses byte-equivalent duplicate rediscoveries without aborting", () => {
    const duplicate = finding("duplicate");
    const result = reconcileReviewState({
      changeId: "change",
      baseSha: "base",
      headSha: "head",
      findings: [duplicate, { ...duplicate, id: "run-local-other-id" }],
      previous: null,
      degraded: false
    });
    expect(result.activeFindings).toHaveLength(1);
  });
});

function finding(fingerprint: string): CoordinatedFinding {
  return {
    id: `id-${fingerprint}`,
    fingerprint,
    reviewer: "code-quality",
    skill: "code-quality",
    title: "Finding",
    body: "Concrete problem.",
    evidence: "src/a.ts:1 demonstrates the failure.",
    severity: "high",
    confidence: "high",
    path: "src/a.ts",
    line: 1,
    disposition: "new"
  };
}

function previousState(): PersistedReviewState {
  return {
    version: 1,
    changeId: "change",
    baseSha: "base",
    headSha: "head-1",
    updatedAt: "2026-08-02T00:00:00.000Z",
    degraded: false,
    findings: [persisted("still-present"), persisted("now-fixed")]
  };
}

function persisted(fingerprint: string): PersistedReviewState["findings"][number] {
  return {
    fingerprint,
    reviewer: "code-quality",
    title: "Finding",
    path: "src/a.ts",
    line: 1,
    severity: "high",
    evidence: "src/a.ts:1 demonstrates the failure.",
    status: "unresolved",
    userReplies: []
  };
}
