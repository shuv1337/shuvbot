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
