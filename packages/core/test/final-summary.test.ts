import { describe, expect, test } from "bun:test";
import { formatFinalSummary } from "../src/final-summary.ts";

describe("final summary", () => {
  test("includes required implementation fields", () => {
    const summary = formatFinalSummary({
      requestedTask: "implement feature",
      workDone: ["added branch helper"],
      filesChanged: ["packages/github/src/branches.ts"],
      commandsRun: ["bun test"],
      checks: ["pass"],
      commits: ["abc123"],
      followUps: []
    });

    expect(summary).toContain("Requested task: implement feature");
    expect(summary).toContain("### Work done");
    expect(summary).toContain("### Files changed");
    expect(summary).toContain("### Commands run");
    expect(summary).toContain("### Checks");
    expect(summary).toContain("### Commits");
    expect(summary).toContain("### Follow-ups");
  });
});
