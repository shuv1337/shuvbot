import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { AuditLog } from "../src/audit.ts";
import { executeTool, type ToolContext } from "../src/tool-spec.ts";
import { createPullRequestTool, gitCommitTool, gitDiffTool, gitStatusTool, pushBranchTool } from "../src/tools/git.ts";
import { killBackgroundProcessTool, runShellTool } from "../src/tools/shell.ts";
import { readPrSummaryTool, readRepoLearningsTool, writePrSummaryTool, writeRepoLearningsTool } from "../src/tools/memory.ts";

const execFileAsync = promisify(execFile);

describe("git, shell, and memory MCP tools", () => {
  test("read-only git tools expose status and diff under policy gate", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-git-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "a.txt"), "hello\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd });
    await writeFile(join(cwd, "a.txt"), "hello\nworld\n");
    const toolContext = context({ cwd });

    await expect(executeTool(gitStatusTool, {}, toolContext)).resolves.toMatchObject({
      stdout: expect.stringContaining("a.txt")
    });
    await expect(executeTool(gitDiffTool, {}, toolContext)).resolves.toMatchObject({
      stdout: expect.stringContaining("a.txt")
    });
  });

  test("git write contracts enforce policy, actor permission, branch prefix, and commit template", async () => {
    const toolContext = context({
      policy: defaultRuntimePolicy({
        actor: "maintainer",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      })
    });
    const message = "reviewbot: implement task\n\nRequested-by: shuv1337\nRun-id: run-1\nMode: implement";

    await expect(executeTool(gitCommitTool, { message }, toolContext)).resolves.toMatchObject({
      accepted: true,
      executed: false
    });
    await expect(executeTool(pushBranchTool, { branch: "feature/nope" }, toolContext)).rejects.toThrow(
      "must start with reviewbot/"
    );
    await expect(executeTool(pushBranchTool, { branch: "reviewbot/test" }, toolContext)).resolves.toMatchObject({
      accepted: true,
      branch: "reviewbot/test"
    });
    await expect(
      executeTool(
        createPullRequestTool,
        { branch: "reviewbot/test", title: "Test", body: "Body", base: "main" },
        toolContext
      )
    ).resolves.toMatchObject({ accepted: true, branch: "reviewbot/test" });

    await expect(executeTool(gitCommitTool, { message: "bad" }, toolContext)).rejects.toThrow(
      "must start with reviewbot:"
    );
  });

  test("git write tools deny read actors and disabled push policy", async () => {
    const deniedContext = context({
      policy: {
        ...defaultRuntimePolicy({
          actor: "reader",
          actorPermission: "read",
          event: "pull_request",
          isFork: true,
          isPrivateRepo: false
        }),
        push: "disabled"
      }
    });

    await expect(
      executeTool(gitCommitTool, {
        message: "reviewbot: x\n\nRequested-by: reader\nRun-id: run-1\nMode: implement"
      }, deniedContext)
    ).rejects.toThrow("denied by runtime policy");
  });

  test("shell tools require shell policy and fail closed until sandbox implementation", async () => {
    const allowedContext = context({
      policy: {
        ...defaultRuntimePolicy({
          actor: "maintainer",
          actorPermission: "write",
          event: "issue_comment",
          isFork: false,
          isPrivateRepo: false
        }),
        shell: "restricted"
      }
    });
    await expect(executeTool(runShellTool, { command: "echo hi" }, allowedContext)).rejects.toThrow(
      "disabled until the restricted shell sandbox is implemented"
    );
    await expect(
      executeTool(killBackgroundProcessTool, { processId: "proc-1" }, allowedContext)
    ).resolves.toMatchObject({
      killed: false,
      processId: "proc-1"
    });

    const deniedContext = context({
      policy: {
        ...allowedContext.policy,
        shell: "disabled"
      }
    });
    await expect(executeTool(runShellTool, { command: "echo hi" }, deniedContext)).rejects.toThrow(
      "denied by runtime policy"
    );
  });

  test("memory tools default to null or no-op", async () => {
    const toolContext = context({});
    await expect(executeTool(readPrSummaryTool, { pullNumber: 1 }, toolContext)).resolves.toMatchObject({
      summary: null,
      enabled: false
    });
    await expect(executeTool(writePrSummaryTool, { pullNumber: 1, summary: "summary" }, toolContext)).resolves.toMatchObject({
      written: false,
      enabled: false
    });
    await expect(executeTool(readRepoLearningsTool, {}, toolContext)).resolves.toMatchObject({
      learnings: null,
      enabled: false
    });
    await expect(
      executeTool(writeRepoLearningsTool, { namespace: "default", learnings: "remember this" }, toolContext)
    ).resolves.toMatchObject({
      written: false,
      enabled: false
    });
  });
});

function context(input: { cwd?: string; policy?: ReturnType<typeof defaultRuntimePolicy> }): ToolContext {
  const redactor = new DefaultRedactor();
  const toolContext: ToolContext = {
    runId: "run-1",
    actor: input.policy?.actor ?? "maintainer",
    mode: "implement",
    policy:
      input.policy ??
      defaultRuntimePolicy({
        actor: "maintainer",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      }),
    redactor,
    audit: new AuditLog(redactor)
  };
  if (input.cwd !== undefined) toolContext.cwd = input.cwd;
  return toolContext;
}
