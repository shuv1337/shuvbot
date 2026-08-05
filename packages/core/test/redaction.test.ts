import { describe, expect, test } from "bun:test";
import { DefaultRedactor, withRedactedValues } from "../src/redaction.ts";

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

describe("exact-value redaction", () => {
  test("removes a credential the patterns cannot recognise", () => {
    const redactor = withRedactedValues(new DefaultRedactor(), ["opaque-credential-value"]);

    // No `NAME=` prefix and no recognisable shape: patterns alone keep this.
    expect(new DefaultRedactor().redactString("using opaque-credential-value now")).toContain(
      "opaque-credential-value"
    );
    expect(redactor.redactString("using opaque-credential-value now")).toBe("using [REDACTED] now");
  });

  test("still applies the underlying pattern redaction", () => {
    const redactor = withRedactedValues(new DefaultRedactor(), ["other"]);

    expect(redactor.redactString("CLAUDE_CODE_OAUTH_TOKEN=secret-value")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]"
    );
  });

  test("scrubs values nested anywhere in a structure", () => {
    const redactor = withRedactedValues(new DefaultRedactor(), ["opaque-credential-value"]);

    expect(
      redactor.redact({ items: [{ note: "saw opaque-credential-value here" }], safe: "hello" })
    ).toEqual({ items: [{ note: "saw [REDACTED] here" }], safe: "hello" });
  });

  test("longer values win so a shorter overlap cannot leave a fragment behind", () => {
    const redactor = withRedactedValues(new DefaultRedactor(), ["abc", "abcdef"]);

    expect(redactor.redactString("abcdef")).toBe("[REDACTED]");
  });

  test("ignores blank values rather than redacting everything", () => {
    const redactor = withRedactedValues(new DefaultRedactor(), ["", "   "]);

    expect(redactor.redactString("nothing secret here")).toBe("nothing secret here");
  });
});
