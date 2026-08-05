import { describe, expect, test } from "bun:test";
import { resolveShuvcodeCredential } from "../src/runtime/auth.ts";

describe("review runtime authentication", () => {
  test("user mode injects nothing even when credentials are present", () => {
    const credential = resolveShuvcodeCredential({
      mode: "user",
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        ANTHROPIC_API_KEY: "api-key"
      }
    });

    expect(credential).toBeUndefined();
  });

  test("environment mode prefers the OAuth token over an API key", () => {
    const credential = resolveShuvcodeCredential({
      mode: "environment",
      env: {
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token"
      }
    });

    expect(credential).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token" });
  });

  test("environment mode falls back to the API key", () => {
    const credential = resolveShuvcodeCredential({
      mode: "environment",
      env: { ANTHROPIC_API_KEY: "api-key" }
    });

    expect(credential).toEqual({ name: "ANTHROPIC_API_KEY", value: "api-key" });
  });

  test("environment mode ignores a blank credential rather than injecting it", () => {
    expect(() =>
      resolveShuvcodeCredential({
        mode: "environment",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "   " }
      })
    ).toThrow("requires a credential in the environment");
  });

  test("environment mode fails closed with an actionable message", () => {
    expect(() => resolveShuvcodeCredential({ mode: "environment", env: {} })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY/
    );
  });

  test("the failure never repeats a credential value", () => {
    let message = "";
    try {
      resolveShuvcodeCredential({ mode: "environment", env: { UNRELATED: "super-secret" } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("super-secret");
  });
});
