import { describe, expect, test } from "bun:test";
import { mapDiffPositions, parseUnifiedDiff } from "../../github/src/diff.ts";
import { runReviewPipeline } from "../src/review-pipeline.ts";
import { parseFindings } from "../src/review-schema.ts";

describe("review schema and pipeline", () => {
  test("parses valid findings and reports invalid ones", () => {
    const result = parseFindings([
      {
        id: "one",
        skill: "code-review",
        title: "Bug",
        body: "Body",
        severity: "high",
        confidence: "high",
        path: "src/a.ts",
        line: 2,
        reviewer: "security",
        evidence: "src/a.ts:2 demonstrates the defect.",
        fingerprint: "stable-fingerprint",
        disposition: "new",
        priorFindingId: "prior-1"
      },
      { id: "bad" }
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      reviewer: "security",
      evidence: "src/a.ts:2 demonstrates the defect.",
      fingerprint: "stable-fingerprint",
      disposition: "new",
      priorFindingId: "prior-1"
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("thresholds, dedupes, maps inline positions, and falls back to summary", () => {
    const positions = mapDiffPositions(
      parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;`)
    );
    const candidates = [
      finding("one", "src/a.ts", 2, "high", "high", "Bug"),
      finding("dupe", "src/a.ts", 2, "high", "high", "Bug"),
      finding("low", "src/a.ts", 2, "info", "high", "Info"),
      finding("missing", "src/missing.ts", 10, "high", "high", "Missing")
    ];

    const result = runReviewPipeline({
      candidates,
      diffPositions: positions,
      config: {
        minConfidence: "medium",
        reportOn: ["critical", "high", "medium"],
        maxFindings: 10,
        maxInlineFindings: 1
      }
    });

    expect(result.inlineFindings).toHaveLength(1);
    expect(result.inlineFindings[0]?.inline).toMatchObject({
      path: "src/a.ts",
      line: 2,
      position: 3
    });
    expect(result.summaryFindings).toHaveLength(1);
    expect(result.summaryFindings[0]?.fallbackReason).toContain("not commentable");
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "duplicate",
      "below reportOn severity"
    ]);
  });

  test("verification, calibration, noise filters, suggested fixes, and gates are enforced", () => {
    const positions = mapDiffPositions(
      parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const token = "";
+const token = process.env.TOKEN;`)
    );
    const candidates = [
      finding("verified", "src/a.ts", 1, "high", "high", "Security bug"),
      finding("unverified", "src/a.ts", 1, "high", "high", "Missing guard"),
      {
        ...finding("speculative", "src/a.ts", 1, "high", "high", "Could crash"),
        body: "Maybe a bug"
      },
      { ...finding("style", "src/a.ts", 1, "high", "high", "Style nit"), tags: ["style"] },
      {
        ...finding("fix", "src/a.ts", 1, "high", "high", "Bad fix"),
        startLine: 1,
        endLine: 20,
        suggestedFix: "replacement"
      }
    ];

    const result = runReviewPipeline({
      candidates,
      diffPositions: positions,
      verifiedFindingIds: new Set(["verified", "speculative", "style", "fix"]),
      config: {
        minConfidence: "medium",
        reportOn: ["critical", "high", "medium"],
        failOn: "high",
        maxFindings: 10,
        maxInlineFindings: 10,
        requestChanges: true,
        failCheck: true
      }
    });

    expect(result.findings.map((entry) => entry.id)).toEqual(["verified", "speculative"]);
    expect(result.findings.find((entry) => entry.id === "speculative")?.severity).toBe("medium");
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "not verified",
      "noise filter",
      "invalid suggested fix"
    ]);
    expect(result.reviewEvent).toBe("REQUEST_CHANGES");
    expect(result.failCheck).toBe(true);
  });
});

function finding(
  id: string,
  path: string,
  line: number,
  severity: "critical" | "high" | "medium" | "low" | "info",
  confidence: "high" | "medium" | "low",
  title: string
) {
  return {
    id,
    skill: "code-review",
    title,
    body: "Body",
    severity,
    confidence,
    path,
    line,
    tags: ["correctness"]
  };
}
