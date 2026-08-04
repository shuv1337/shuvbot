import { describe, expect, test } from "bun:test";
import { defaultRuntimePolicy } from "../src/policy.ts";
import { runImplement } from "../src/implement-runner.ts";

describe("implement runner", () => {
  test("runs an implement fixture with a fake agent and final summary", async () => {
    const prepared: unknown[] = [];
    const result = await runImplement({
      cwd: "/repo",
      runId: "run-1",
      startPoint: "abc123",
      command: {
        prefix: "@shuvbot",
        command: "implement",
        args: "fix the bug",
        raw: "@shuvbot implement fix the bug",
        actor: "alice",
        source: "issue_comment"
      },
      policy: defaultRuntimePolicy({
        actor: "alice",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      }),
      async prepareBranch(input) {
        prepared.push(input);
      },
      agent: {
        async run(input) {
          return {
            workDone: [`used ${input.branch}`],
            filesChanged: ["src/a.ts"],
            commandsRun: ["bun test"],
            checks: ["pass"],
            commits: ["abc123"],
            followUps: []
          };
        }
      }
    });

    expect(result.branch).toStartWith("shuvbot/implement-alice-fix-the-bug");
    expect(prepared).toHaveLength(1);
    expect(result.summary).toContain("Requested task: fix the bug");
    expect(result.summary).toContain("### Work done");
    expect(result.summary).toContain("src/a.ts");
  });

  test("denies untrusted implement policy", async () => {
    await expect(
      runImplement({
        cwd: "/repo",
        runId: "run-1",
        startPoint: "abc123",
        command: {
          prefix: "@shuvbot",
          command: "implement",
          args: "fix",
          raw: "@shuvbot implement fix",
          actor: "alice",
          source: "issue_comment"
        },
        policy: defaultRuntimePolicy({
          actor: "alice",
          actorPermission: "read",
          event: "issue_comment",
          isFork: false,
          isPrivateRepo: false
        }),
        async prepareBranch() {},
        agent: {
          async run() {
            return {};
          }
        }
      })
    ).rejects.toThrow("trusted push");
  });
});
