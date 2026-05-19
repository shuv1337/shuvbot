import { ToolExecutionError } from "../../../core/src/errors.ts";

const DEFAULT_ENV_ALLOWLIST = ["CI", "HOME", "PATH", "TMPDIR"] as const;
const SECRET_NAME_PATTERN = /(token|secret|password|credential|key)/i;

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
    throw new ToolExecutionError("restricted shell requires Docker and fails closed when Docker is unavailable");
  }
  return input.dockerPath;
}
