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
  review: {
    engine: "legacy" | "coordinator";
    maxConcurrency: number;
    overallTimeout: string;
    incremental: boolean;
    sensitivePaths: string[];
    shuvcode: {
      package: string;
      version: string;
      useUserAuth: boolean;
    };
    models: {
      coordinator: string;
      standard: string;
      light: string;
    };
    tiers: {
      trivial: ReviewTierConfig;
      lite: ReviewTierConfig;
      full: ReviewTierConfig;
    };
    reviewers: ReviewReviewerOverride[];
  };
}

export interface ReviewTierConfig {
  maxLines?: number;
  maxFiles?: number;
  reviewers: string[];
}

export interface ReviewReviewerOverride {
  id: string;
  paths: string[];
  ignorePaths: string[];
  promptAppend: string;
  model?: string;
}

export const PINNED_SHUVCODE_PACKAGE = "shuvcode";
export const SHUVCODE_SOURCE_BASELINE_VERSION = "1.18.4";
export const APPROVED_SHUVCODE_RUNTIME_VERSION: string | null = "2.0.0-alpha-9";

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
    // A review writes its run artifacts and state into the reviewed repository.
    // Jujutsu records every file in the working-copy commit, so without this a
    // review would report on the output of the previous one.
    ignore: [".reviewbot/**"]
  },
  memory: {
    enabled: false,
    backend: "github",
    learnings: false,
    prSummaries: true
  },
  review: {
    engine: "coordinator",
    maxConcurrency: 3,
    overallTimeout: "15m",
    incremental: true,
    sensitivePaths: [],
    shuvcode: {
      package: PINNED_SHUVCODE_PACKAGE,
      version: APPROVED_SHUVCODE_RUNTIME_VERSION ?? SHUVCODE_SOURCE_BASELINE_VERSION,
      useUserAuth: true
    },
    models: {
      coordinator: "subscription/default-reasoning",
      standard: "subscription/default-coding",
      light: "subscription/default-fast"
    },
    tiers: {
      trivial: { maxLines: 10, maxFiles: 20, reviewers: ["code-quality"] },
      lite: {
        maxLines: 100,
        maxFiles: 20,
        reviewers: ["code-quality", "tests", "performance", "documentation", "release"]
      },
      full: {
        reviewers: ["code-quality", "security", "performance", "tests", "documentation", "release"]
      }
    },
    reviewers: []
  }
};

const REVIEWER_IDS = [
  "code-quality",
  "security",
  "performance",
  "tests",
  "documentation",
  "release"
] as const;

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
  "memory",
  "review"
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

  if (raw.review !== undefined) {
    const review = assertRecord(raw.review, "review");
    config.review.engine = enumValue(
      review.engine,
      ["legacy", "coordinator"] as const,
      "review.engine",
      config.review.engine
    );
    config.review.maxConcurrency = boundedIntegerValue(
      review.maxConcurrency ?? review.max_concurrency,
      "review.max_concurrency",
      config.review.maxConcurrency,
      1,
      REVIEWER_IDS.length
    );
    config.review.overallTimeout = stringValue(
      review.overallTimeout ?? review.overall_timeout,
      "review.overall_timeout",
      config.review.overallTimeout
    );
    config.review.incremental = booleanValue(
      review.incremental,
      "review.incremental",
      config.review.incremental
    );
    config.review.sensitivePaths = globList(
      review.sensitivePaths ?? review.sensitive_paths,
      "review.sensitive_paths",
      config.review.sensitivePaths
    );

    if (review.shuvcode !== undefined) {
      const shuvcode = assertRecord(review.shuvcode, "review.shuvcode");
      config.review.shuvcode.package = stringValue(
        shuvcode.package,
        "review.shuvcode.package",
        config.review.shuvcode.package
      );
      config.review.shuvcode.version = exactVersionValue(
        shuvcode.version,
        "review.shuvcode.version",
        config.review.shuvcode.version
      );
      if (config.review.shuvcode.package !== PINNED_SHUVCODE_PACKAGE) {
        throw new ConfigError(`review.shuvcode.package must be ${PINNED_SHUVCODE_PACKAGE}.`);
      }
      config.review.shuvcode.useUserAuth = booleanValue(
        shuvcode.useUserAuth ?? shuvcode.use_user_auth,
        "review.shuvcode.use_user_auth",
        config.review.shuvcode.useUserAuth
      );
    }

    if (review.models !== undefined) {
      const models = assertRecord(review.models, "review.models");
      config.review.models.coordinator = subscriptionModelValue(
        models.coordinator,
        "review.models.coordinator",
        config.review.models.coordinator
      );
      config.review.models.standard = subscriptionModelValue(
        models.standard,
        "review.models.standard",
        config.review.models.standard
      );
      config.review.models.light = subscriptionModelValue(
        models.light,
        "review.models.light",
        config.review.models.light
      );
    }

    if (review.tiers !== undefined) {
      const tiers = assertRecord(review.tiers, "review.tiers");
      config.review.tiers.trivial = tierValue(
        tiers.trivial,
        "review.tiers.trivial",
        config.review.tiers.trivial
      );
      config.review.tiers.lite = tierValue(
        tiers.lite,
        "review.tiers.lite",
        config.review.tiers.lite
      );
      config.review.tiers.full = tierValue(
        tiers.full,
        "review.tiers.full",
        config.review.tiers.full
      );
      validateTierRoster("trivial", config.review.tiers.trivial.reviewers);
      validateTierRoster("lite", config.review.tiers.lite.reviewers);
      validateTierRoster("full", config.review.tiers.full.reviewers);
    }

    if (review.reviewers !== undefined) {
      if (!Array.isArray(review.reviewers))
        throw new ConfigError("review.reviewers must be an array of tables.");
      config.review.reviewers = review.reviewers.map((value, index) =>
        reviewerOverrideValue(value, index)
      );
      if (
        new Set(config.review.reviewers.map((reviewer) => reviewer.id)).size !==
        config.review.reviewers.length
      ) {
        throw new ConfigError("review.reviewers must not contain duplicate reviewer IDs.");
      }
    }
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

function boundedIntegerValue(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum)
    return value;
  throw new ConfigError(`${field} must be an integer from ${minimum} to ${maximum}.`);
}

function exactVersionValue(value: unknown, field: string, fallback: string): string {
  const version = stringValue(value, field, fallback);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ConfigError(`${field} must be an exact semantic version.`);
  }
  return version;
}

function tierValue(value: unknown, field: string, fallback: ReviewTierConfig): ReviewTierConfig {
  if (value === undefined) return fallback;
  const tier = assertRecord(value, field);
  const result: ReviewTierConfig = {
    reviewers: reviewerList(tier.reviewers, `${field}.reviewers`, fallback.reviewers)
  };
  const maxLines = optionalPositiveInteger(
    tier.maxLines ?? tier.max_lines,
    `${field}.max_lines`,
    fallback.maxLines
  );
  const maxFiles = optionalPositiveInteger(
    tier.maxFiles ?? tier.max_files,
    `${field}.max_files`,
    fallback.maxFiles
  );
  if (maxLines !== undefined) result.maxLines = maxLines;
  if (maxFiles !== undefined) result.maxFiles = maxFiles;
  return result;
}

function reviewerOverrideValue(value: unknown, index: number): ReviewReviewerOverride {
  const field = `review.reviewers[${index}]`;
  const reviewer = assertRecord(value, field);
  if (reviewer.id === undefined) throw new ConfigError(`${field}.id is required.`);
  const id = enumValue(reviewer.id, REVIEWER_IDS, `${field}.id`, "code-quality");
  const promptAppend = reviewer.promptAppend ?? reviewer.prompt_append;
  if (
    promptAppend !== undefined &&
    (typeof promptAppend !== "string" || promptAppend.length > 8_000)
  ) {
    throw new ConfigError(
      `${field}.prompt_append must be a string no longer than 8000 characters.`
    );
  }
  const result: ReviewReviewerOverride = {
    id,
    paths: globList(reviewer.paths, `${field}.paths`, []),
    ignorePaths: globList(
      reviewer.ignorePaths ?? reviewer.ignore_paths,
      `${field}.ignore_paths`,
      []
    ),
    promptAppend: typeof promptAppend === "string" ? promptAppend : ""
  };
  if (reviewer.model !== undefined) {
    result.model = subscriptionModelValue(
      reviewer.model,
      `${field}.model`,
      "subscription/default-coding"
    );
  }
  return result;
}

function reviewerList(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => !isOneOf(item, REVIEWER_IDS))) {
    throw new ConfigError(
      `${field} must contain only known reviewer IDs: ${REVIEWER_IDS.join(", ")}.`
    );
  }
  if (new Set(value).size !== value.length)
    throw new ConfigError(`${field} must not contain duplicates.`);
  return [...value];
}

function validateTierRoster(tier: "trivial" | "lite" | "full", reviewers: readonly string[]): void {
  const minimum = tier === "trivial" ? 1 : tier === "lite" ? 3 : 5;
  if (!reviewers.includes("code-quality")) {
    throw new ConfigError(`review.tiers.${tier}.reviewers must include code-quality.`);
  }
  if (tier === "lite" && !reviewers.includes("tests")) {
    throw new ConfigError("review.tiers.lite.reviewers must include tests.");
  }
  if (tier === "full" && !reviewers.includes("security")) {
    throw new ConfigError("review.tiers.full.reviewers must include security.");
  }
  if (reviewers.length < minimum) {
    throw new ConfigError(
      `review.tiers.${tier}.reviewers must contain at least ${minimum} reviewers.`
    );
  }
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
  fallback: number | undefined
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ConfigError(`${field} must be a positive integer.`);
}

function subscriptionModelValue(value: unknown, field: string, fallback: string): string {
  const model = stringValue(value, field, fallback);
  if (!/^subscription\/[^/\s]+$/.test(model)) {
    throw new ConfigError(`${field} must use the subscription provider.`);
  }
  return model;
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
