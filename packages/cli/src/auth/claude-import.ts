import { spawnSync } from "node:child_process";
import { AuthError } from "../../../core/src/errors.ts";
import { maskSecret } from "../../../agents/src/auth.ts";

export type SpawnSyncLike = (command: string, args: readonly string[], options: { encoding: "utf8"; cwd?: string }) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export interface ClaudeImportOptions {
  repo?: string;
  secret?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  spawnSyncImpl?: SpawnSyncLike;
  masker?: { setSecret(value: string): void };
}

export async function runClaudeImport(options: ClaudeImportOptions = {}): Promise<string> {
  const token = (await readStdin(options.stdin ?? process.stdin)).trim();
  validateClaudeToken(token);
  maskSecret(token, "Claude token", options.masker);
  if (options.repo) {
    storeGitHubSecret(token, options.repo, options.secret ?? "CLAUDE_CODE_OAUTH_TOKEN", options.spawnSyncImpl ?? spawnSyncLike);
  }
  options.stdout?.write("Claude token imported.\n");
  return token;
}

export const spawnSyncLike: SpawnSyncLike = (command, args, options) => {
  const result = spawnSync(command, [...args], options);
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
};

export function validateClaudeToken(token: string): void {
  if (token.trim().length < 20) throw new AuthError("Claude token is too short or empty");
}

function storeGitHubSecret(token: string, repo: string, secret: string, spawnImpl: SpawnSyncLike): void {
  const result = spawnImpl("gh", ["secret", "set", secret, "--repo", repo, "--body", token], {
    encoding: "utf8"
  });
  if (result.status !== 0) throw new AuthError(`gh secret set failed: ${result.stderr || result.stdout}`);
}

function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      value += chunk;
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(value));
    stdin.resume();
  });
}
