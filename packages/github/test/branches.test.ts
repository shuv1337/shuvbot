import { describe, expect, test } from "bun:test";
import { assertReviewbotBranchName, deriveReviewbotBranch } from "../src/branches.ts";

describe("reviewbot branch helpers", () => {
  test("derive and enforce reviewbot branch names", () => {
    const branch = deriveReviewbotBranch({
      mode: "implement",
      runId: "run-123",
      requestedBy: "alice",
      task: "Fix the broken workflow!"
    });

    expect(branch).toStartWith("reviewbot/implement-alice-fix-the-broken-workflow");
    expect(() => assertReviewbotBranchName(branch)).not.toThrow();
    expect(() => assertReviewbotBranchName("main")).toThrow();
    expect(() => assertReviewbotBranchName("reviewbot/../main")).toThrow();
  });
});
