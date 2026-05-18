import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../src/redaction.ts";

describe("redaction", () => {
  test("redacts secrets in strings", () => {
    const redactor = new DefaultRedactor();
    expect(redactor.redactString("CLAUDE_CODE_OAUTH_TOKEN=secret-value")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]"
    );
  });

  test("redacts nested secret keys", () => {
    const redactor = new DefaultRedactor();
    const redacted = redactor.redact({
      token: "plain-secret",
      nested: {
        apiKey: "another-secret",
        safe: "hello"
      }
    });

    expect(redacted).toEqual({
      token: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        safe: "hello"
      }
    });
  });
});
