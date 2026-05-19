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
        line: 2
      },
      { id: "bad" }
    ]);

    expect(result.findings).toHaveLength(1);
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
    expect(result.inlineFindings[0]?.inline).toMatchObject({ path: "src/a.ts", line: 2, position: 3 });
    expect(result.summaryFindings).toHaveLength(1);
    expect(result.summaryFindings[0]?.fallbackReason).toContain("not commentable");
    expect(result.dropped.map((entry) => entry.reason)).toEqual(["duplicate", "below reportOn severity"]);
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
    line
  };
}
