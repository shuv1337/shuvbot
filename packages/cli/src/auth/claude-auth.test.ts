import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import { runClaudeImport } from "./claude-import.ts";
import { runClaudeSetupToken } from "./claude-setup-token.ts";

describe("Claude CLI auth helpers", () => {
  test("imports token from stdin, masks it, and stores optional GitHub secret", async () => {
    const masked: string[] = [];
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const token = await runClaudeImport({
      repo: "octo/shuvbot",
      stdin: Readable.from(["claude-oauth-token-value-12345"]) as NodeJS.ReadStream,
      masker: {
        setSecret(value) {
          masked.push(value);
        }
      },
      spawnSyncImpl(command, args) {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(token).toBe("claude-oauth-token-value-12345");
    expect(masked).toEqual(["claude-oauth-token-value-12345"]);
    expect(calls[0]).toMatchObject({
      command: "gh",
      args: ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", "octo/shuvbot", "--body", token]
    });
  });

  test("runs claude setup-token and masks the captured token", () => {
    const masked: string[] = [];
    const calls: string[] = [];
    const token = runClaudeSetupToken({
      masker: {
        setSecret(value) {
          masked.push(value);
        }
      },
      spawnSyncImpl(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "claude" && args[0] === "--version") {
          return { status: 0, stdout: "1.0.0", stderr: "" };
        }
        return {
          status: 0,
          stdout: "claude-oauth-token-value-67890",
          stderr: ""
        };
      }
    });

    expect(token).toBe("claude-oauth-token-value-67890");
    expect(masked).toEqual(["claude-oauth-token-value-67890"]);
    expect(calls).toEqual(["claude --version", "claude setup-token"]);
  });
});
