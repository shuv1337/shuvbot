import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import {
  assertDockerSandboxAvailable,
  buildDockerShellInvocation,
  filterShellEnv,
  killTrackedBackgroundProcess,
  validateShellCommand
} from "./shell-sandbox.ts";
import { requireCwd } from "./shared.ts";

const execFileAsync = promisify(execFile);

interface RunShellInput {
  command: string;
  timeoutMs?: number;
}

interface KillBackgroundProcessInput {
  processId: string;
}

const RUN_SHELL_INPUT_SCHEMA = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const KILL_BACKGROUND_PROCESS_INPUT_SCHEMA = {
  type: "object",
  required: ["processId"],
  properties: {
    processId: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const runShellTool: ToolSpec<RunShellInput, Record<string, unknown>> = {
  name: "run_shell",
  description: "Represent restricted shell execution through a Docker sandbox. Fails closed when Docker is unavailable.",
  inputSchema: RUN_SHELL_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { shell: "restricted" },
  async handler(input, context) {
    const shellPolicy: { command: string; allowCommands?: readonly string[]; denyCommands?: readonly string[] } = {
      command: input.command
    };
    if (context.shellSandbox?.allowCommands !== undefined) shellPolicy.allowCommands = context.shellSandbox.allowCommands;
    if (context.shellSandbox?.denyCommands !== undefined) shellPolicy.denyCommands = context.shellSandbox.denyCommands;
    validateShellCommand(shellPolicy);
    const dockerPath = process.env.REVIEWBOT_DOCKER_PATH;
    const docker = assertDockerSandboxAvailable(dockerPath ? { dockerPath } : {});
    const env = filterShellEnv(process.env);
    const invocation = buildDockerShellInvocation({
      dockerPath: docker,
      cwd: requireCwd(context),
      command: input.command,
      env
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 3_600_000);
    try {
      const result = await execFileAsync(invocation.file, invocation.args, {
        signal: controller.signal,
        maxBuffer: 1024 * 1024
      });
      return {
        executed: true,
        invocation,
        env,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } finally {
      clearTimeout(timeout);
    }
  }
};

export const killBackgroundProcessTool: ToolSpec<KillBackgroundProcessInput, Record<string, unknown>> = {
  name: "kill_background_process",
  description: "Represent background process termination for future shell execution.",
  inputSchema: KILL_BACKGROUND_PROCESS_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { shell: "restricted" },
  handler(input) {
    const killed = killTrackedBackgroundProcess(input.processId);
    return {
      processId: input.processId,
      killed,
      reason: killed ? "background process aborted" : "background process was not tracked"
    };
  }
};

export const shellTools = [runShellTool, killBackgroundProcessTool] as const;
