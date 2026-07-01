import { describe, expect, test } from "bun:test";
import { assembleReviewContext } from "../../src/context/assembler.ts";

describe("assembleReviewContext", () => {
  test("labels prSummary and learnings as untrusted since they derive from diff content", () => {
    const context = assembleReviewContext({
      event: { action: "opened" },
      repo: "octo/reviewbot",
      diff: "diff --git a/a.ts b/a.ts",
      files: [{ filename: "a.ts" }],
      repoInstructions: [],
      prSummary: "Previous run summarized these changes.",
      learnings: "Repo learning: avoid X."
    });

    const prSummarySection = context.sections.find((section) => section.id === "L6:pr-summary");
    const learningsSection = context.sections.find((section) => section.id === "L7:repo-learnings");

    expect(prSummarySection?.untrusted).toBe(true);
    expect(learningsSection?.untrusted).toBe(true);
  });
});
