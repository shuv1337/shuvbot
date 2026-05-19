import { AuthError } from "../../../core/src/errors.ts";
import { maskSecret } from "../../../agents/src/auth.ts";
import { spawnSyncLike, validateClaudeToken, type SpawnSyncLike } from "./claude-import.ts";

export interface ClaudeSetupTokenOptions {
  repo?: string;
  secret?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  spawnSyncImpl?: SpawnSyncLike;
  masker?: { setSecret(value: string): void };
}

export function runClaudeSetupToken(options: ClaudeSetupTokenOptions = {}): string {
  const spawnImpl = options.spawnSyncImpl ?? spawnSyncLike;
  const version = spawnImpl("claude", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new AuthError(`Claude CLI not available: ${version.stderr || version.stdout}`);

  const result = spawnImpl("claude", ["setup-token"], { encoding: "utf8" });
  if (result.status !== 0) throw new AuthError(`claude setup-token failed: ${result.stderr || result.stdout}`);
  const token = extractToken(result.stdout);
  validateClaudeToken(token);
  maskSecret(token, "Claude token", options.masker);
  if (options.repo) {
    const secret = options.secret ?? "CLAUDE_CODE_OAUTH_TOKEN";
    const gh = spawnImpl("gh", ["secret", "set", secret, "--repo", options.repo, "--body", token], {
      encoding: "utf8"
    });
    if (gh.status !== 0) throw new AuthError(`gh secret set failed: ${gh.stderr || gh.stdout}`);
  }
  options.stdout?.write("Claude setup token captured.\n");
  return token;
}

function extractToken(stdout: string): string {
  const token = stdout
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => part.length >= 20);
  if (!token) throw new AuthError("claude setup-token did not print a usable token");
  return token;
}
