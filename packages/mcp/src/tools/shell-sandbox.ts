import { ToolExecutionError } from "../../../core/src/errors.ts";

const DEFAULT_ENV_ALLOWLIST = ["CI", "HOME", "PATH", "TMPDIR"] as const;
const SECRET_NAME_PATTERN = /(token|secret|password|credential|key)/i;
const processes = new Map<string, AbortController>();

export function filterShellEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST
): Record<string, string> {
  const allowed = new Set(allowlist);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowed.has(key) || value === undefined || SECRET_NAME_PATTERN.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export function assertDockerSandboxAvailable(input: { dockerPath?: string | null }): string {
  if (!input.dockerPath) {
    throw new ToolExecutionError(
      "restricted shell requires Docker and fails closed when Docker is unavailable"
    );
  }
  return input.dockerPath;
}

export function validateShellCommand(input: {
  command: string;
  allowCommands?: readonly string[];
  denyCommands?: readonly string[];
}): void {
  const executables = commandTokens(input.command);
  if (executables.length === 0) throw new ToolExecutionError("shell command is empty");
  for (const executable of executables) {
    if (input.denyCommands?.includes(executable)) {
      throw new ToolExecutionError(`shell command is denied: ${executable}`);
    }
    if (
      input.allowCommands &&
      input.allowCommands.length > 0 &&
      !input.allowCommands.includes(executable)
    ) {
      throw new ToolExecutionError(`shell command is not allowlisted: ${executable}`);
    }
  }
}

export function buildDockerShellInvocation(input: {
  dockerPath: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
}): { file: string; args: string[] } {
  return {
    file: input.dockerPath,
    args: [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${input.cwd}:/workspace`,
      "-w",
      "/workspace",
      ...Object.entries(input.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "shuvbot-shell:latest",
      "sh",
      "-lc",
      input.command
    ]
  };
}

export function trackBackgroundProcess(processId: string, controller: AbortController): void {
  processes.set(processId, controller);
}

export function killTrackedBackgroundProcess(processId: string): boolean {
  const controller = processes.get(processId);
  if (!controller) return false;
  controller.abort();
  processes.delete(processId);
  return true;
}

// Matches shell operators that chain or inject additional commands into a single
// invocation: `;`, `&&`, `||`, `|`, `&`, newlines, backticks, and `$(` substitutions.
// Splitting on these (rather than only inspecting the first word of the raw string)
// closes the bypass where `git status; sudo rm -rf /` passed allow/deny checks under
// the "git" executable while `sudo` ran unchecked.
const COMMAND_CHAIN_PATTERN = /&&|\|\||\$\(|[;&|`\n]/;

function commandTokens(command: string): string[] {
  return command
    .split(COMMAND_CHAIN_PATTERN)
    .map((segment) => firstCommandToken(segment))
    .filter((token): token is string => Boolean(token));
}

function firstCommandToken(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^["']|["']$/g, "");
}
