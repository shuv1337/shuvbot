import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "./errors.ts";
import {
  AGENTS,
  CONFIDENCES,
  MODES,
  PERMISSION_LEVELS,
  SEVERITIES,
  type AgentId,
  type Confidence,
  type PermissionLevel,
  type ReviewbotMode,
  type Severity,
  isOneOf
} from "./types.ts";

export interface ReviewbotConfig {
  agent: AgentId;
  model: string;
  mode: ReviewbotMode;
  timeout: string;
  activityTimeout: string;
  failOn: Severity;
  failCheck: boolean;
  requestChanges: boolean;
  reportOn: Severity;
  minConfidence: Confidence;
  shell: PermissionLevel;
  push: PermissionLevel;
  shellSandbox: {
    allowCommands: string[];
    denyCommands: string[];
  };
  fixCi: {
    maxAttempts: number;
    maxRuntime: string;
    rerunChecks: boolean;
  };
  paths: {
    include: string[];
    ignore: string[];
  };
  memory: {
    enabled: boolean;
    backend: "github" | "file" | "api" | "disabled";
    learnings: boolean;
    prSummaries: boolean;
  };
}

export const DEFAULT_CONFIG: ReviewbotConfig = {
  agent: "claude-code",
  model: "claude/sonnet",
  mode: "review",
  timeout: "1h",
  activityTimeout: "5m",
  failOn: "high",
  failCheck: false,
  requestChanges: false,
  reportOn: "medium",
  minConfidence: "medium",
  shell: "restricted",
  push: "restricted",
  shellSandbox: {
    allowCommands: [],
    denyCommands: ["sudo", "su", "docker", "podman"]
  },
  fixCi: {
    maxAttempts: 3,
    maxRuntime: "90m",
    rerunChecks: true
  },
  paths: {
    include: ["**/*"],
    ignore: []
  },
  memory: {
    enabled: false,
    backend: "github",
    learnings: false,
    prSummaries: true
  }
};

const TOP_LEVEL_KEYS = new Set([
  "agent",
  "model",
  "mode",
  "timeout",
  "activityTimeout",
  "activity_timeout",
  "failOn",
  "fail_on",
  "failCheck",
  "fail_check",
  "requestChanges",
  "request_changes",
  "reportOn",
  "report_on",
  "minConfidence",
  "min_confidence",
  "shell",
  "shellSandbox",
  "shell_sandbox",
  "fixCi",
  "fix_ci",
  "push",
  "paths",
  "memory"
]);

export async function loadConfigFile(path: string): Promise<ReviewbotConfig> {
  const contents = await readFile(path, "utf8");
  return parseConfig(contents);
}

export function parseConfig(contents: string): ReviewbotConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch (error) {
    throw new ConfigError("Config is not valid TOML.", { cause: error });
  }
  return normalizeConfig(assertRecord(parsed, "config"));
}

export function normalizeConfig(raw: Record<string, unknown>): ReviewbotConfig {
  rejectUnknownTopLevelKeys(raw);
  const config = structuredClone(DEFAULT_CONFIG);

  config.agent = enumValue(raw.agent, AGENTS, "agent", config.agent);
  config.model = stringValue(raw.model, "model", config.model);
  config.mode = enumValue(raw.mode, MODES, "mode", config.mode);
  config.timeout = stringValue(raw.timeout, "timeout", config.timeout);
  config.activityTimeout = stringValue(
    raw.activityTimeout ?? raw.activity_timeout,
    "activity_timeout",
    config.activityTimeout
  );
  config.failOn = enumValue(raw.failOn ?? raw.fail_on, SEVERITIES, "fail_on", config.failOn);
  config.failCheck = booleanValue(raw.failCheck ?? raw.fail_check, "fail_check", config.failCheck);
  config.requestChanges = booleanValue(
    raw.requestChanges ?? raw.request_changes,
    "request_changes",
    config.requestChanges
  );
  config.reportOn = enumValue(
    raw.reportOn ?? raw.report_on,
    SEVERITIES,
    "report_on",
    config.reportOn
  );
  config.minConfidence = enumValue(
    raw.minConfidence ?? raw.min_confidence,
    CONFIDENCES,
    "min_confidence",
    config.minConfidence
  );
  config.shell = enumValue(raw.shell, PERMISSION_LEVELS, "shell", config.shell);
  config.push = enumValue(raw.push, PERMISSION_LEVELS, "push", config.push);

  const shellSandboxRaw = raw.shellSandbox ?? raw.shell_sandbox;
  if (shellSandboxRaw !== undefined) {
    const shellSandbox = assertRecord(shellSandboxRaw, "shell_sandbox");
    config.shellSandbox.allowCommands = stringList(
      shellSandbox.allowCommands ?? shellSandbox.allow_commands,
      "shell_sandbox.allow_commands",
      config.shellSandbox.allowCommands
    );
    config.shellSandbox.denyCommands = stringList(
      shellSandbox.denyCommands ?? shellSandbox.deny_commands,
      "shell_sandbox.deny_commands",
      config.shellSandbox.denyCommands
    );
  }

  if (raw.paths !== undefined) {
    const paths = assertRecord(raw.paths, "paths");
    config.paths.include = globList(paths.include, "paths.include", config.paths.include);
    config.paths.ignore = globList(paths.ignore, "paths.ignore", config.paths.ignore);
  }

  const fixCiRaw = raw.fixCi ?? raw.fix_ci;
  if (fixCiRaw !== undefined) {
    const fixCi = assertRecord(fixCiRaw, "fix_ci");
    config.fixCi.maxAttempts = integerValue(
      fixCi.maxAttempts ?? fixCi.max_attempts,
      "fix_ci.max_attempts",
      config.fixCi.maxAttempts
    );
    config.fixCi.maxRuntime = stringValue(
      fixCi.maxRuntime ?? fixCi.max_runtime,
      "fix_ci.max_runtime",
      config.fixCi.maxRuntime
    );
    config.fixCi.rerunChecks = booleanValue(
      fixCi.rerunChecks ?? fixCi.rerun_checks,
      "fix_ci.rerun_checks",
      config.fixCi.rerunChecks
    );
  }

  if (raw.memory !== undefined) {
    const memory = assertRecord(raw.memory, "memory");
    config.memory.enabled = booleanValue(memory.enabled, "memory.enabled", config.memory.enabled);
    config.memory.backend = enumValue(
      memory.backend,
      ["github", "file", "api", "disabled"] as const,
      "memory.backend",
      config.memory.backend
    );
    config.memory.learnings = booleanValue(
      memory.learnings,
      "memory.learnings",
      config.memory.learnings
    );
    config.memory.prSummaries = booleanValue(
      memory.prSummaries ?? memory.pr_summaries,
      "memory.pr_summaries",
      config.memory.prSummaries
    );
  }

  return config;
}

function rejectUnknownTopLevelKeys(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith("x-")) {
      throw new ConfigError(`Unknown top-level config key: ${key}`);
    }
  }
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number]
): T[number] {
  if (value === undefined) return fallback;
  if (isOneOf(value, allowed)) return value;
  throw new ConfigError(`${field} must be one of: ${allowed.join(", ")}`);
}

function stringValue(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new ConfigError(`${field} must be a non-empty string.`);
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new ConfigError(`${field} must be a boolean.`);
}

function integerValue(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ConfigError(`${field} must be a positive integer.`);
}

function globList(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${field} must be an array of glob strings.`);
  }
  for (const glob of value) validateGlob(glob, field);
  return [...value];
}

function stringList(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new ConfigError(`${field} must be an array of non-empty strings.`);
  }
  return [...value];
}

function validateGlob(glob: string, field: string): void {
  if (glob.trim().length === 0) throw new ConfigError(`${field} contains an empty glob.`);
  let bracketDepth = 0;
  for (const char of glob) {
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth -= 1;
    if (bracketDepth < 0) throw new ConfigError(`${field} contains invalid glob syntax: ${glob}`);
  }
  if (bracketDepth !== 0) throw new ConfigError(`${field} contains invalid glob syntax: ${glob}`);
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ConfigError(`${field} must be a table/object.`);
}
