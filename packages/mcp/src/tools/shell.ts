import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import { assertDockerSandboxAvailable, filterShellEnv } from "./shell-sandbox.ts";

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
  handler(_input) {
    const dockerPath = process.env.REVIEWBOT_DOCKER_PATH;
    assertDockerSandboxAvailable(dockerPath ? { dockerPath } : {});
    return {
      executed: false,
      env: filterShellEnv(process.env),
      reason: "Docker sandbox command execution is not enabled in this scaffold"
    };
  }
};

export const killBackgroundProcessTool: ToolSpec<KillBackgroundProcessInput, Record<string, unknown>> = {
  name: "kill_background_process",
  description: "Represent background process termination for future shell execution.",
  inputSchema: KILL_BACKGROUND_PROCESS_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { shell: "restricted" },
  handler(input) {
    return {
      processId: input.processId,
      killed: false,
      reason: "background process tracking is not active until the shell sandbox is implemented"
    };
  }
};

export const shellTools = [runShellTool, killBackgroundProcessTool] as const;
