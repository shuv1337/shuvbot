import { describe, expect, test } from "bun:test";
import { assertReviewModelsReachable, resolveShuvcodeCredential } from "../src/runtime/auth.ts";

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

  test("refuses the default roster, which no single credential can reach", () => {
    // Exactly what the first real Action run hit: the coordinator is Anthropic
    // and reachable, every specialist is xAI and is not.
    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token" },
        models: {
          coordinator: "subscription/default-reasoning",
          standard: "subscription/default-coding",
          light: "subscription/default-fast"
        }
      })
    ).toThrow(/standard .*needs xai.*light .*needs openai/s);
  });

  test("accepts a roster entirely on the credential's provider", () => {
    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "ANTHROPIC_API_KEY", value: "key" },
        models: {
          coordinator: "subscription/claude-opus-5@medium",
          standard: "subscription/claude-fable-5@high",
          light: "subscription/claude-fable-5@low"
        }
      })
    ).not.toThrow();
  });

  test("names the role, the model, and both providers", () => {
    let message = "";
    try {
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token" },
        models: { standard: "subscription/default-coding" }
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("standard");
    expect(message).toContain("subscription/default-coding");
    expect(message).toContain("xai");
    expect(message).toContain("anthropic");
    expect(message).not.toContain("token");
  });

  test("leaves unresolvable names to the resolver's own diagnostics", () => {
    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token" },
        models: { standard: "subscription/not-a-real-model" }
      })
    ).not.toThrow();
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
