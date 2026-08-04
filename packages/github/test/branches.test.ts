import { describe, expect, test } from "bun:test";
import {
  assertShuvbotBranchName,
  createOrFastForwardShuvbotBranch,
  deriveShuvbotBranch
} from "../src/branches.ts";

describe("shuvbot branch helpers", () => {
  test("derive and enforce shuvbot branch names", () => {
    const branch = deriveShuvbotBranch({
      mode: "implement",
      runId: "run-123",
      requestedBy: "alice",
      task: "Fix the broken workflow!"
    });

    expect(branch).toStartWith("shuvbot/implement-alice-fix-the-broken-workflow");
    expect(() => assertShuvbotBranchName(branch)).not.toThrow();
    expect(() => assertShuvbotBranchName("main")).toThrow();
    expect(() => assertShuvbotBranchName("shuvbot/../main")).toThrow();
  });

  test("creates or fast-forwards branch from trigger commit", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    await expect(
      createOrFastForwardShuvbotBranch({
        cwd: "/repo",
        branch: "shuvbot/task-123",
        startPoint: "abc123",
        async exec(file, args, options) {
          calls.push({ file, args, cwd: options.cwd });
        }
      })
    ).resolves.toEqual({ branch: "shuvbot/task-123", startPoint: "abc123" });

    expect(calls).toEqual([
      { file: "git", args: ["fetch", "--no-tags", "origin", "abc123"], cwd: "/repo" },
      { file: "git", args: ["checkout", "-B", "shuvbot/task-123", "FETCH_HEAD"], cwd: "/repo" }
    ]);
    await expect(
      createOrFastForwardShuvbotBranch({
        cwd: "/repo",
        branch: "main",
        startPoint: "abc123",
        async exec() {}
      })
    ).rejects.toThrow();
  });
});
