import * as core from "@actions/core";
import { AuthError } from "../../core/src/errors.ts";
import type { AgentId } from "../../core/src/types.ts";

export interface ClaudeAuth {
  kind: "oauth" | "api-key";
  env: Record<string, string>;
}

export function resolveClaudeAuth(env: Record<string, string | undefined>): ClaudeAuth {
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: "oauth", env: { CLAUDE_CODE_OAUTH_TOKEN: oauth } };

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: "api-key", env: { ANTHROPIC_API_KEY: apiKey } };

  throw new AuthError("Claude auth missing: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
}

export function resolveAuthFor(driverId: AgentId, env: Record<string, string | undefined>): ClaudeAuth {
  if (driverId === "claude-code") return resolveClaudeAuth(env);
  throw new AuthError(`Auth resolver not implemented for driver ${driverId}`);
}

export function maskSecret(value: string, label = "secret", masker: { setSecret(value: string): void } = core): void {
  const trimmed = value.trim();
  if (!trimmed) throw new AuthError(`${label} is empty`);
  masker.setSecret(trimmed);
}
