import { describe, expect, test } from "bun:test";
import { assertReviewbotBranchName, createOrFastForwardReviewbotBranch, deriveReviewbotBranch } from "../src/branches.ts";

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

  test("creates or fast-forwards branch from trigger commit", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    await expect(
      createOrFastForwardReviewbotBranch({
        cwd: "/repo",
        branch: "reviewbot/task-123",
        startPoint: "abc123",
        async exec(file, args, options) {
          calls.push({ file, args, cwd: options.cwd });
        }
      })
    ).resolves.toEqual({ branch: "reviewbot/task-123", startPoint: "abc123" });

    expect(calls).toEqual([
      { file: "git", args: ["fetch", "--no-tags", "origin", "abc123"], cwd: "/repo" },
      { file: "git", args: ["checkout", "-B", "reviewbot/task-123", "FETCH_HEAD"], cwd: "/repo" }
    ]);
    await expect(
      createOrFastForwardReviewbotBranch({
        cwd: "/repo",
        branch: "main",
        startPoint: "abc123",
        async exec() {}
      })
    ).rejects.toThrow();
  });
});
