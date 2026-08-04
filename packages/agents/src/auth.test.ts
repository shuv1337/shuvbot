import { describe, expect, test } from "bun:test";
import { AuthError } from "../../core/src/errors.ts";
import { maskSecret, resolveClaudeAuth } from "./auth.ts";

describe("agent auth", () => {
  test("prefers Claude OAuth over Anthropic API key", () => {
    expect(
      resolveClaudeAuth({
        CLAUDE_CODE_OAUTH_TOKEN: " oauth-token-value ",
        ANTHROPIC_API_KEY: "api-key-value"
      })
    ).toEqual({
      kind: "oauth",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" }
    });
  });

  test("falls back to API key and rejects missing or blank credentials", () => {
    expect(resolveClaudeAuth({ ANTHROPIC_API_KEY: " api-key-value " })).toEqual({
      kind: "api-key",
      env: { ANTHROPIC_API_KEY: "api-key-value" }
    });
    expect(() =>
      resolveClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: " ", ANTHROPIC_API_KEY: "" })
    ).toThrow(AuthError);
  });

  test("masks non-empty secrets", () => {
    const masked: string[] = [];
    maskSecret(" secret-value ", "test", {
      setSecret(value) {
        masked.push(value);
      }
    });
    expect(masked).toEqual(["secret-value"]);
    expect(() => maskSecret(" ", "test", { setSecret() {} })).toThrow(AuthError);
  });
});
