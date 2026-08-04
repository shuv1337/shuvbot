import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { MemoryStateStore } from "../../core/src/state.ts";
import { AuditLog } from "../src/audit.ts";
import { executeTool, type ToolContext } from "../src/tool-spec.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import {
  createPullRequestTool,
  gitCommitTool,
  gitDiffTool,
  gitStatusTool,
  pushBranchTool
} from "../src/tools/git.ts";
import { killBackgroundProcessTool, runShellTool } from "../src/tools/shell.ts";
import {
  readPrSummaryTool,
  readRepoLearningsTool,
  writePrSummaryTool,
  writeRepoLearningsTool
} from "../src/tools/memory.ts";

const execFileAsync = promisify(execFile);

describe("git, shell, and memory MCP tools", () => {
  test("read-only git tools expose status and diff under policy gate", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-git-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-git-write-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd });
    await execFileAsync("git", ["config", "user.email", "shuvbot@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "shuvbot"], { cwd });
    await writeFile(join(cwd, "a.txt"), "hello\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    await writeFile(join(cwd, "a.txt"), "hello\nworld\n");
    const toolContext = context({
      cwd,
      policy: defaultRuntimePolicy({
        actor: "maintainer",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      })
    });
    const message =
      "shuvbot: implement task\n\nRequested-by: shuv1337\nRun-id: run-1\nMode: implement";

    await expect(executeTool(gitCommitTool, { message }, toolContext)).resolves.toMatchObject({
      accepted: true,
      executed: true
    });
    await expect(
      executeTool(pushBranchTool, { branch: "feature/nope" }, toolContext)
    ).rejects.toThrow("must start with shuvbot/");
    await expect(
      executeTool(pushBranchTool, { branch: "shuvbot/test" }, toolContext)
    ).rejects.toThrow();
    await expect(
      executeTool(
        createPullRequestTool,
        { branch: "shuvbot/test", title: "Test", body: "Body", base: "main" },
        context({
          cwd,
          policy: toolContext.policy,
          client: {
            async request(route: string) {
              if (route.startsWith("GET ")) return { status: 200, headers: {}, data: [] };
              return {
                status: 201,
                headers: {},
                data: { number: 1, html_url: "https://example.test/pr/1" }
              };
            }
          } as GitHubClient,
          repo: { owner: "octo", name: "repo" }
        })
      )
    ).resolves.toMatchObject({ accepted: true, branch: "shuvbot/test" });
    const routes: string[] = [];
    await expect(
      executeTool(
        createPullRequestTool,
        { branch: "shuvbot/test", title: "Updated", body: "Body", base: "main" },
        context({
          cwd,
          policy: toolContext.policy,
          client: {
            async request(route: string) {
              routes.push(route);
              if (route.startsWith("GET "))
                return { status: 200, headers: {}, data: [{ number: 2 }] };
              return { status: 200, headers: {}, data: { number: 2, title: "Updated" } };
            }
          } as GitHubClient,
          repo: { owner: "octo", name: "repo" }
        })
      )
    ).resolves.toMatchObject({ accepted: true, branch: "shuvbot/test" });
    expect(routes).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}"
    ]);

    await expect(executeTool(gitCommitTool, { message: "bad" }, toolContext)).rejects.toThrow(
      "must start with shuvbot:"
    );
  });

  test("create_pull_request resolves the repo's actual default branch when base is omitted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-git-default-branch-"));
    await execFileAsync("git", ["init"], { cwd });
    const routes: string[] = [];
    const toolContext = context({
      cwd,
      policy: defaultRuntimePolicy({
        actor: "maintainer",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      }),
      client: {
        async request(route: string) {
          routes.push(route);
          if (route === "GET /repos/{owner}/{repo}")
            return { status: 200, headers: {}, data: { default_branch: "trunk" } };
          if (route.startsWith("GET ")) return { status: 200, headers: {}, data: [] };
          return { status: 201, headers: {}, data: { number: 1, base: { ref: "trunk" } } };
        }
      } as GitHubClient,
      repo: { owner: "octo", name: "repo" }
    });

    await expect(
      executeTool(
        createPullRequestTool,
        { branch: "shuvbot/test", title: "Test", body: "Body" },
        toolContext
      )
    ).resolves.toMatchObject({ accepted: true, base: "trunk" });
    expect(routes).toEqual([
      "GET /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/pulls"
    ]);
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
      executeTool(
        gitCommitTool,
        {
          message: "shuvbot: x\n\nRequested-by: reader\nRun-id: run-1\nMode: implement"
        },
        deniedContext
      )
    ).rejects.toThrow("denied by runtime policy");
  });

  test("shell tools require shell policy and fail closed until sandbox implementation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-shell-"));
    const fakeDocker = join(cwd, "docker");
    await writeFile(fakeDocker, '#!/bin/sh\necho docker-called "$@"\n');
    await chmod(fakeDocker, 0o755);
    const allowedContext = context({
      cwd,
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
      "restricted shell requires Docker"
    );
    const previousDockerPath = process.env.SHUVBOT_DOCKER_PATH;
    process.env.SHUVBOT_DOCKER_PATH = fakeDocker;
    try {
      await expect(
        executeTool(runShellTool, { command: "echo hi" }, allowedContext)
      ).resolves.toMatchObject({
        executed: true,
        stdout: expect.stringContaining("docker-called")
      });
    } finally {
      if (previousDockerPath === undefined) delete process.env.SHUVBOT_DOCKER_PATH;
      else process.env.SHUVBOT_DOCKER_PATH = previousDockerPath;
    }
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
    await expect(
      executeTool(readPrSummaryTool, { pullNumber: 1 }, toolContext)
    ).resolves.toMatchObject({
      summary: null,
      enabled: false
    });
    await expect(
      executeTool(writePrSummaryTool, { pullNumber: 1, summary: "summary" }, toolContext)
    ).resolves.toMatchObject({
      written: false,
      enabled: false
    });
    await expect(executeTool(readRepoLearningsTool, {}, toolContext)).resolves.toMatchObject({
      learnings: null,
      enabled: false
    });
    await expect(
      executeTool(
        writeRepoLearningsTool,
        { namespace: "default", learnings: "remember this" },
        toolContext
      )
    ).resolves.toMatchObject({
      written: false,
      enabled: false
    });
  });

  test("memory tools route through enabled state store and gate learnings opt-in", async () => {
    const store = new MemoryStateStore();
    const toolContext = context({ state: { enabled: true, learnings: false, store } });
    await expect(
      executeTool(writePrSummaryTool, { pullNumber: 1, summary: "summary" }, toolContext)
    ).resolves.toMatchObject({
      written: true,
      enabled: true
    });
    await expect(
      executeTool(readPrSummaryTool, { pullNumber: 1 }, toolContext)
    ).resolves.toMatchObject({
      summary: "summary",
      enabled: true
    });
    await expect(
      executeTool(writeRepoLearningsTool, { learnings: "learn" }, toolContext)
    ).resolves.toMatchObject({
      written: false,
      enabled: false
    });

    const learningContext = context({ state: { enabled: true, learnings: true, store } });
    await expect(
      executeTool(writeRepoLearningsTool, { learnings: "learn" }, learningContext)
    ).resolves.toMatchObject({
      written: true,
      enabled: true
    });
    await expect(executeTool(readRepoLearningsTool, {}, learningContext)).resolves.toMatchObject({
      learnings: "learn",
      enabled: true
    });
  });
});

function context(input: {
  cwd?: string;
  policy?: ReturnType<typeof defaultRuntimePolicy>;
  client?: ToolContext["client"];
  repo?: ToolContext["repo"];
  state?: ToolContext["state"];
}): ToolContext {
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
  if (input.client !== undefined) toolContext.client = input.client;
  if (input.repo !== undefined) toolContext.repo = input.repo;
  if (input.state !== undefined) toolContext.state = input.state;
  return toolContext;
}
