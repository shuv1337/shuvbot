import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolExecutionError } from "../../../core/src/errors.ts";
import type { ActorPermission } from "../../../core/src/policy.ts";
import { assertShuvbotBranchName } from "../../../github/src/branches.ts";
import type { ToolContext, ToolSchema, ToolSpec } from "../tool-spec.ts";
import { requireCwd } from "./shared.ts";

const execFileAsync = promisify(execFile);
const WRITE_PERMISSIONS: readonly ActorPermission[] = ["write", "maintain", "admin"];

type EmptyInput = Record<string, never>;

interface GitDiffInput {
  ref?: string;
}

interface GitFetchInput {
  remote?: string;
}

interface GitCommitInput {
  message: string;
}

interface BranchInput {
  branch: string;
}

interface CreatePullRequestInput {
  branch: string;
  title: string;
  body: string;
  base?: string;
}

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false
} satisfies ToolSchema;

const GIT_DIFF_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ref: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const GIT_FETCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    remote: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const GIT_COMMIT_INPUT_SCHEMA = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const BRANCH_INPUT_SCHEMA = {
  type: "object",
  required: ["branch"],
  properties: {
    branch: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const CREATE_PR_INPUT_SCHEMA = {
  type: "object",
  required: ["branch", "title", "body"],
  properties: {
    branch: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const gitStatusTool: ToolSpec<EmptyInput, Record<string, unknown>> = {
  name: "git_status",
  description: "Return porcelain git status for the workspace.",
  inputSchema: EMPTY_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canReadChecks: true },
  async handler(_input, context) {
    const result = await runGit(context, ["status", "--short", "--branch"]);
    return { stdout: result.stdout, stderr: result.stderr };
  }
};

export const gitDiffTool: ToolSpec<GitDiffInput, Record<string, unknown>> = {
  name: "git_diff",
  description: "Return git diff output for the workspace.",
  inputSchema: GIT_DIFF_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canReadChecks: true },
  async handler(input, context) {
    const args = input.ref ? ["diff", input.ref] : ["diff"];
    const result = await runGit(context, args);
    return { stdout: result.stdout, stderr: result.stderr };
  }
};

export const gitFetchTool: ToolSpec<GitFetchInput, Record<string, unknown>> = {
  name: "git_fetch",
  description: "Fetch refs for the workspace repository.",
  inputSchema: GIT_FETCH_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canReadChecks: true },
  async handler(input, context) {
    const args = input.remote ? ["fetch", input.remote] : ["fetch", "--all", "--prune"];
    const result = await runGit(context, args);
    return { stdout: result.stdout, stderr: result.stderr };
  }
};

export const gitCommitTool: ToolSpec<GitCommitInput, Record<string, unknown>> = {
  name: "git_commit",
  description: "Create a shuvbot commit after validating commit-message policy.",
  inputSchema: GIT_COMMIT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  async handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertShuvbotCommitMessage(input.message);
    const result = await runGit(context, ["commit", "-am", input.message]);
    return { accepted: true, executed: true, stdout: result.stdout, stderr: result.stderr };
  }
};

export const pushBranchTool: ToolSpec<BranchInput, Record<string, unknown>> = {
  name: "push_branch",
  description: "Push a shuvbot branch to origin.",
  inputSchema: BRANCH_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  async handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertShuvbotBranch(input.branch);
    const result = await runGit(context, ["push", "origin", `${input.branch}:${input.branch}`]);
    return {
      accepted: true,
      executed: true,
      branch: input.branch,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
};

export const pushTagsTool: ToolSpec<EmptyInput, Record<string, unknown>> = {
  name: "push_tags",
  description: "Represent tag push behavior. Disabled in conservative v0 tooling.",
  inputSchema: EMPTY_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  handler(_input, context) {
    assertWriteActor(context.policy.actorPermission);
    throw new ToolExecutionError("push_tags is disabled in v0 conservative tooling");
  }
};

export const deleteBranchTool: ToolSpec<BranchInput, Record<string, unknown>> = {
  name: "delete_branch",
  description: "Delete a local shuvbot branch.",
  inputSchema: BRANCH_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  async handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertShuvbotBranch(input.branch);
    const result = await runGit(context, ["branch", "-D", input.branch]);
    return {
      accepted: true,
      executed: true,
      branch: input.branch,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
};

export const createPullRequestTool: ToolSpec<CreatePullRequestInput, Record<string, unknown>> = {
  name: "create_pull_request",
  description: "Create a pull request from a shuvbot branch.",
  inputSchema: CREATE_PR_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canCreatePr: true },
  async handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertShuvbotBranch(input.branch);
    if (!context.client || !context.repo)
      throw new ToolExecutionError("create_pull_request requires GitHub client and repo context");
    const base = input.base ?? (await resolveDefaultBranch(context.client, context.repo));
    const existing = await context.client.request("GET /repos/{owner}/{repo}/pulls", {
      params: {
        owner: context.repo.owner,
        repo: context.repo.name,
        head: `${context.repo.owner}:${input.branch}`,
        state: "open",
        per_page: 1
      }
    });
    const existingPr = Array.isArray(existing.data) ? asRecord(existing.data[0]) : {};
    const response =
      typeof existingPr.number === "number"
        ? await context.client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
            params: {
              owner: context.repo.owner,
              repo: context.repo.name,
              pull_number: existingPr.number
            },
            body: { title: input.title, body: input.body }
          })
        : await context.client.request("POST /repos/{owner}/{repo}/pulls", {
            params: { owner: context.repo.owner, repo: context.repo.name },
            body: {
              head: input.branch,
              base,
              title: input.title,
              body: input.body
            }
          });
    return {
      accepted: true,
      executed: true,
      branch: input.branch,
      title: input.title,
      base,
      pullRequest: response.data
    };
  }
};

export const gitTools = [
  gitStatusTool,
  gitDiffTool,
  gitFetchTool,
  gitCommitTool,
  pushBranchTool,
  pushTagsTool,
  deleteBranchTool,
  createPullRequestTool
] as const;

async function resolveDefaultBranch(
  client: NonNullable<ToolContext["client"]>,
  repo: NonNullable<ToolContext["repo"]>
): Promise<string> {
  const response = await client.request("GET /repos/{owner}/{repo}", {
    params: { owner: repo.owner, repo: repo.name }
  });
  const defaultBranch = asRecord(response.data).default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw new ToolExecutionError(
      "create_pull_request could not resolve the repository's default branch"
    );
  }
  return defaultBranch;
}

async function runGit(
  context: ToolContext,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const cwd = requireCwd(context);
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function assertWriteActor(actorPermission: ActorPermission): void {
  if (!WRITE_PERMISSIONS.includes(actorPermission)) {
    throw new ToolExecutionError(`git write requires write permission, got ${actorPermission}`);
  }
}

function assertShuvbotBranch(branch: string): void {
  try {
    assertShuvbotBranchName(branch);
  } catch {
    throw new ToolExecutionError("git write branch must start with shuvbot/");
  }
}

function assertShuvbotCommitMessage(message: string): void {
  if (!message.startsWith("shuvbot:")) {
    throw new ToolExecutionError("git commit message must start with shuvbot:");
  }
  for (const required of ["Requested-by:", "Run-id:", "Mode:"]) {
    if (!message.includes(required))
      throw new ToolExecutionError(`git commit message missing ${required}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
