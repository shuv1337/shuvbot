export interface Redactor {
  redactString(value: string): string;
  redact<T>(value: T): T;
}

const DEFAULT_SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(CLAUDE_CODE_OAUTH_TOKEN=)([^\s]+)/g,
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=)([^\s]+)/gi
];

const SECRET_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|oauth)/i;

/**
 * Wraps a redactor with an exact-value pass over known secret literals.
 *
 * The pattern-based redactor cannot recognise a credential whose shape it does
 * not know, and it misses a value that arrives split across stream chunks or
 * embedded without its `NAME=` prefix. Any path that holds a resolved secret
 * value should redact through this rather than trusting the patterns alone.
 * Empty and whitespace-only values are ignored so a blank credential cannot
 * turn every string into `[REDACTED]`.
 */
export function withRedactedValues(
  base: Redactor,
  values: readonly string[],
  replacement = "[REDACTED]"
): Redactor {
  const secrets = [...new Set(values.filter((value) => value.trim().length > 0))].sort(
    (left, right) => right.length - left.length
  );
  if (secrets.length === 0) return base;

  const scrub = (value: string): string =>
    secrets.reduce((current, secret) => current.split(secret).join(replacement), value);

  return {
    redactString: (value) => scrub(base.redactString(value)),
    redact: <T>(value: T): T => scrubDeep(base.redact(value), scrub) as T
  };
}

function scrubDeep(value: unknown, scrub: (value: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry, scrub)])
    );
  }
  return value;
}

export class DefaultRedactor implements Redactor {
  constructor(private readonly replacement = "[REDACTED]") {}

  redactString(value: string): string {
    return DEFAULT_SECRET_PATTERNS.reduce(
      (current, pattern) =>
        current.replace(pattern, (...args: unknown[]) => {
          const captures = args
            .slice(1, -2)
            .filter((capture): capture is string => typeof capture === "string");
          const prefix = captures.length > 1 ? captures[0] : "";
          return `${prefix}${this.replacement}`;
        }),
      value
    );
  }

  redact<T>(value: T): T {
    return this.redactValue(value) as T;
  }

  private redactValue(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      return key !== undefined && SECRET_KEY_PATTERN.test(key)
        ? this.replacement
        : this.redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          this.redactValue(entryValue, entryKey)
        ])
      );
    }
    return value;
  }
}
