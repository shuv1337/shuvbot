import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, normalizeConfig, parseConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

describe("config", () => {
  test("parses a valid config", () => {
    const config = parseConfig(`
agent = "claude-code"
model = "claude/opus"
mode = "review"
fail_on = "critical"
report_on = "low"
min_confidence = "high"
shell = "restricted"
push = "disabled"

[paths]
include = ["packages/**/*.ts"]
ignore = ["dist/**"]

[memory]
enabled = false
backend = "github"
learnings = false
pr_summaries = true
`);

    expect(config.agent).toBe("claude-code");
    expect(config.model).toBe("claude/opus");
    expect(config.failOn).toBe("critical");
    expect(config.paths.include).toEqual(["packages/**/*.ts"]);
    expect(config.memory.learnings).toBe(false);
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
  });

  test("validates obvious glob syntax errors", () => {
    expect(() => normalizeConfig({ paths: { include: ["src/[broken"] } })).toThrow(ConfigError);
  });
});
