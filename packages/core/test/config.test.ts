import { describe, expect, test } from "bun:test";
import {
  APPROVED_SHUVCODE_RUNTIME_VERSION,
  DEFAULT_CONFIG,
  SHUVCODE_SOURCE_BASELINE_VERSION,
  normalizeConfig,
  parseConfig
} from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

describe("config", () => {
  test("parses a valid config", () => {
    const config = parseConfig(`
agent = "claude-code"
model = "claude/opus"
mode = "review"
fail_on = "critical"
fail_check = true
request_changes = true
report_on = "low"
min_confidence = "high"
shell = "restricted"
push = "disabled"

[shell_sandbox]
allow_commands = ["bun", "git"]
deny_commands = ["sudo"]

[fix_ci]
max_attempts = 2
max_runtime = "30m"
rerun_checks = false

[paths]
include = ["packages/**/*.ts"]
ignore = ["dist/**"]

[memory]
enabled = false
backend = "github"
learnings = false
pr_summaries = true

[review]
engine = "coordinator"
max_concurrency = 2
overall_timeout = "12m"
incremental = true
sensitive_paths = ["infra/policy/**"]

[review.shuvcode]
package = "shuvcode"
version = "1.18.4"
use_user_auth = true

[review.models]
coordinator = "subscription/opus"
standard = "subscription/codex"
light = "subscription/haiku"

[review.tiers.trivial]
max_lines = 8
max_files = 4
reviewers = ["code-quality"]

[review.tiers.lite]
max_lines = 80
max_files = 12
reviewers = ["code-quality", "tests", "documentation"]

[review.tiers.full]
reviewers = ["code-quality", "security", "performance", "tests", "documentation", "release"]

[[review.reviewers]]
id = "security"
paths = ["src/**"]
ignore_paths = ["**/*.test.ts"]
prompt_append = "Use the repository trust-boundary rules."
model = "subscription/sonnet"
`);

    expect(config.agent).toBe("claude-code");
    expect(config.model).toBe("claude/opus");
    expect(config.failOn).toBe("critical");
    expect(config.failCheck).toBe(true);
    expect(config.requestChanges).toBe(true);
    expect(config.shellSandbox.allowCommands).toEqual(["bun", "git"]);
    expect(config.shellSandbox.denyCommands).toEqual(["sudo"]);
    expect(config.fixCi).toEqual({ maxAttempts: 2, maxRuntime: "30m", rerunChecks: false });
    expect(config.paths.include).toEqual(["packages/**/*.ts"]);
    expect(config.memory.learnings).toBe(false);
    expect(config.review.engine).toBe("coordinator");
    expect(config.review.maxConcurrency).toBe(2);
    expect(config.review.sensitivePaths).toEqual(["infra/policy/**"]);
    expect(config.review.tiers.lite.reviewers).toEqual(["code-quality", "tests", "documentation"]);
    expect(config.review.reviewers).toEqual([
      {
        id: "security",
        paths: ["src/**"],
        ignorePaths: ["**/*.test.ts"],
        promptAppend: "Use the repository trust-boundary rules.",
        model: "subscription/sonnet"
      }
    ]);
  });

  test("rejects unknown top-level keys outside x-* namespace", () => {
    expect(() => normalizeConfig({ surprise: true })).toThrow(ConfigError);
    expect(() => normalizeConfig({ "x-local": { owner: "tests" } })).not.toThrow();
  });

  test("validates enum values", () => {
    expect(() => normalizeConfig({ mode: "deploy" })).toThrow(ConfigError);
    expect(() => normalizeConfig({ agent: "unknown-agent" })).toThrow(ConfigError);
    expect(() => normalizeConfig({ shell: "root" })).toThrow(ConfigError);
  });

  test("merges defaults", () => {
    const config = normalizeConfig({ model: "vendor/custom-model" });
    expect(config.model).toBe("vendor/custom-model");
    expect(config.agent).toBe(DEFAULT_CONFIG.agent);
    expect(config.timeout).toBe("1h");
    expect(config.activityTimeout).toBe("5m");
    expect(config.memory.learnings).toBe(false);
    expect(config.review.engine).toBe("coordinator");
    expect(config.review.shuvcode.version).toBe("2.0.0-alpha-9");
    expect(SHUVCODE_SOURCE_BASELINE_VERSION).toBe("1.18.4");
    expect(APPROVED_SHUVCODE_RUNTIME_VERSION).toBe("2.0.0-alpha-9");
  });

  test("validates obvious glob syntax errors", () => {
    expect(() => normalizeConfig({ paths: { include: ["src/[broken"] } })).toThrow(ConfigError);
  });

  test("validates coordinator review settings", () => {
    expect(() => normalizeConfig({ review: { engine: "unknown" } })).toThrow(ConfigError);
    expect(() => normalizeConfig({ review: { max_concurrency: 7 } })).toThrow(ConfigError);
    expect(() => normalizeConfig({ review: { shuvcode: { version: "latest" } } })).toThrow(
      ConfigError
    );
    expect(
      normalizeConfig({ review: { shuvcode: { version: "1.18.3" } } }).review.shuvcode.version
    ).toBe("1.18.3");
    expect(() => normalizeConfig({ review: { shuvcode: { package: "opencode" } } })).toThrow(
      ConfigError
    );
    // Authentication defaults to the local profile, so no configuration change
    // can make a run start injecting credentials by accident.
    expect(normalizeConfig({}).review.shuvcode.auth).toBe("user");
    expect(
      normalizeConfig({ review: { shuvcode: { auth: "environment" } } }).review.shuvcode.auth
    ).toBe("environment");
    expect(() => normalizeConfig({ review: { shuvcode: { auth: "inherit" } } })).toThrow(
      ConfigError
    );
    expect(() => normalizeConfig({ review: { models: { standard: "openai/codex" } } })).toThrow(
      ConfigError
    );
    expect(() =>
      normalizeConfig({ review: { tiers: { full: { reviewers: ["unknown"] } } } })
    ).toThrow(ConfigError);
    expect(() =>
      normalizeConfig({ review: { tiers: { lite: { reviewers: ["code-quality", "tests"] } } } })
    ).toThrow(ConfigError);
    expect(() =>
      normalizeConfig({
        review: {
          tiers: {
            full: {
              reviewers: ["code-quality", "performance", "tests", "documentation", "release"]
            }
          }
        }
      })
    ).toThrow(ConfigError);
    expect(() =>
      normalizeConfig({
        review: { reviewers: [{ id: "security" }, { id: "security" }] }
      })
    ).toThrow(ConfigError);
    expect(() => normalizeConfig({ review: { reviewers: [{}] } })).toThrow(ConfigError);
    expect(() =>
      normalizeConfig({ review: { reviewers: [{ id: "security", paths: ["src/[bad"] }] } })
    ).toThrow(ConfigError);
  });
});
