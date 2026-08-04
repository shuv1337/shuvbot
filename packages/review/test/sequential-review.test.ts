import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { reconcileReviewState } from "../src/reconcile.ts";
import { parseCoordinatorResult, type CoordinatedFinding } from "../src/results.ts";
import { FileReviewStateStore } from "../src/state.ts";

describe("sequential local review lifecycle", () => {
  test("persists new, unresolved, fixed, and user-resolved transitions atomically", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-sequential-review-"));
    const store = new FileReviewStateStore(cwd, new DefaultRedactor());
    const changeId = "local/repo:main:feature";
    const first = reconcileReviewState({
      changeId,
      baseSha: "base-1",
      headSha: "head-1",
      findings: [finding("A remains"), finding("B is fixed"), finding("C acknowledged")],
      previous: null,
      degraded: false,
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });
    await store.writeReviewState(changeId, first.state);

    const acknowledged = (await store.readReviewState(changeId))!;
    acknowledged.findings.find((item) => item.title === "C acknowledged")!.status = "user_resolved";
    acknowledged.findings.find((item) => item.title === "C acknowledged")!.userReplies = [
      "Maintainer accepted this behavior."
    ];
    await store.writeReviewState(changeId, acknowledged);

    const second = reconcileReviewState({
      changeId,
      baseSha: "base-1",
      headSha: "head-2",
      findings: [finding("A remains"), finding("C acknowledged"), finding("D is new")],
      previous: await store.readReviewState(changeId),
      degraded: false,
      now: () => new Date("2026-08-03T00:05:00.000Z")
    });
    await store.writeReviewState(changeId, second.state);

    expect(second.activeFindings.map(({ title, disposition }) => [title, disposition])).toEqual([
      ["A remains", "unresolved"],
      ["D is new", "new"]
    ]);
    expect(second.fixedFingerprints).toEqual([fingerprint("B is fixed")]);
    expect(second.preservedResolvedFingerprints).toEqual([fingerprint("C acknowledged")]);

    const persisted = await store.readReviewState(changeId);
    expect(persisted).toMatchObject({ baseSha: "base-1", headSha: "head-2", degraded: false });
    expect(
      Object.fromEntries(persisted!.findings.map((item) => [item.title, item.status]))
    ).toEqual({
      "A remains": "unresolved",
      "B is fixed": "fixed",
      "C acknowledged": "user_resolved",
      "D is new": "new"
    });
  });
});

function finding(title: string): CoordinatedFinding {
  return parseCoordinatorResult({
    decision: "comments",
    findings: [
      {
        id: title,
        reviewer: "code-quality",
        skill: "code-quality",
        title,
        body: "Concrete changed-code defect.",
        evidence: `src/a.ts:5 demonstrates ${title}.`,
        severity: "medium",
        confidence: "high",
        path: "src/a.ts",
        line: 5,
        disposition: "new"
      }
    ],
    dropped: [],
    coverage: {
      scheduled: ["code-quality"],
      completed: ["code-quality"],
      failed: [],
      timedOut: [],
      required: ["code-quality"],
      quorumMet: true
    },
    summary: "One finding."
  }).findings[0]!;
}

function fingerprint(title: string): string {
  return finding(title).fingerprint;
}
