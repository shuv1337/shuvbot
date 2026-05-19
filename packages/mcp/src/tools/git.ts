import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolExecutionError } from "../../../core/src/errors.ts";
import type { ActorPermission } from "../../../core/src/policy.ts";
import { assertReviewbotBranchName } from "../../../github/src/branches.ts";
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
  description: "Validate a reviewbot commit request. Actual write execution is deferred to implementation mode.",
  inputSchema: GIT_COMMIT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertReviewbotCommitMessage(input.message);
    return { accepted: true, executed: false, reason: "git write execution is deferred to implementation mode" };
  }
};

export const pushBranchTool: ToolSpec<BranchInput, Record<string, unknown>> = {
  name: "push_branch",
  description: "Validate a reviewbot branch push request. Actual push execution is deferred to implementation mode.",
  inputSchema: BRANCH_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertReviewbotBranch(input.branch);
    return { accepted: true, executed: false, branch: input.branch };
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
  description: "Validate a reviewbot branch delete request. Actual deletion is deferred to implementation mode.",
  inputSchema: BRANCH_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { push: "restricted" },
  handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertReviewbotBranch(input.branch);
    return { accepted: true, executed: false, branch: input.branch };
  }
};

export const createPullRequestTool: ToolSpec<CreatePullRequestInput, Record<string, unknown>> = {
  name: "create_pull_request",
  description: "Validate a reviewbot pull request creation request. Actual creation is deferred to implementation mode.",
  inputSchema: CREATE_PR_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canCreatePr: true },
  handler(input, context) {
    assertWriteActor(context.policy.actorPermission);
    assertReviewbotBranch(input.branch);
    return {
      accepted: true,
      executed: false,
      branch: input.branch,
      title: input.title,
      base: input.base ?? "default"
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

async function runGit(context: ToolContext, args: string[]): Promise<{ stdout: string; stderr: string }> {
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

function assertReviewbotBranch(branch: string): void {
  try {
    assertReviewbotBranchName(branch);
  } catch {
    throw new ToolExecutionError("git write branch must start with reviewbot/");
  }
}

function assertReviewbotCommitMessage(message: string): void {
  if (!message.startsWith("reviewbot:")) {
    throw new ToolExecutionError("git commit message must start with reviewbot:");
  }
  for (const required of ["Requested-by:", "Run-id:", "Mode:"]) {
    if (!message.includes(required)) throw new ToolExecutionError(`git commit message missing ${required}`);
  }
}
