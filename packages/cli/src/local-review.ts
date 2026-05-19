import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeConfig, type ReviewbotConfig } from "../../core/src/config.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { createFakeReviewAgent, runReview } from "../../core/src/review-runner.ts";
import type { PullRequestEvent } from "../../core/src/events.ts";

const execFileAsync = promisify(execFile);

export interface LocalReviewOptions {
  cwd: string;
  base: string;
  head: string;
  config?: ReviewbotConfig;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  agentFindings?: unknown[];
}

export async function runLocalReview(options: LocalReviewOptions): Promise<Awaited<ReturnType<typeof runReview>>> {
  const diff = (await execFileAsync("git", ["diff", `${options.base}...${options.head}`], { cwd: options.cwd })).stdout;
  const filesOutput = (await execFileAsync("git", ["diff", "--name-only", `${options.base}...${options.head}`], {
    cwd: options.cwd
  })).stdout;
  const files = filesOutput.split("\n").filter(Boolean).map((filename) => ({ filename }));
  const config = options.config ?? normalizeConfig({});
  const result = await runReview({
    cwd: options.cwd,
    repo: "local/repo",
    event: fakePullRequestEvent(files),
    diff,
    files,
    config,
    policy: defaultRuntimePolicy({
      actor: "local",
      actorPermission: "write",
      event: "pull_request",
      isFork: false,
      isPrivateRepo: false
    }),
    agent: createFakeReviewAgent(options.agentFindings ?? [])
  });
  options.stdout?.write(`${JSON.stringify(result.findings, null, 2)}\n`);
  return result;
}

export const localReviewCommandName = "review";

function fakePullRequestEvent(files: unknown[]): PullRequestEvent {
  return {
    kind: "pull_request",
    name: "pull_request",
    action: "opened",
    repo: { owner: "local", name: "repo", fullName: "local/repo", isPrivate: false },
    sender: { login: "local" },
    raw: { files },
    pullRequest: {
      number: 0,
      title: "Local review",
      body: "",
      state: "open",
      draft: false,
      user: { login: "local" },
      baseRef: "",
      baseSha: "",
      headRef: "",
      headSha: "",
      headRepoFullName: null,
      isFork: false
    }
  };
}
