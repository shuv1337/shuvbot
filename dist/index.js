// packages/action/src/entry.ts
import * as core4 from "@actions/core";

// packages/action/src/main.ts
import * as core3 from "@actions/core";

// packages/action/src/inputs.ts
import * as core from "@actions/core";

// packages/core/src/errors.ts
var ReviewbotError = class extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
  code;
};
var ConfigError = class extends ReviewbotError {
  constructor(message, options) {
    super(message, "CONFIG_ERROR", options);
  }
};

// packages/core/src/types.ts
var MODES = ["review", "run", "fix", "ci-repair", "explain"];
var AGENTS = ["claude-code", "anthropic-sdk", "openai", "codex-cli", "aider"];
var SEVERITIES = ["critical", "high", "medium", "low", "info"];
var CONFIDENCES = ["high", "medium", "low"];
var PERMISSION_LEVELS = ["disabled", "restricted", "enabled"];
function isOneOf(value, allowed) {
  return typeof value === "string" && allowed.includes(value);
}

// packages/action/src/inputs.ts
function readActionInputs() {
  const inputs = {};
  setOptional(inputs, "prompt", optionalInput("prompt"));
  setOptional(inputs, "mode", optionalEnumInput("mode", MODES));
  setOptional(inputs, "config", optionalInput("config"));
  setOptional(inputs, "model", optionalInput("model"));
  setOptional(inputs, "agent", optionalEnumInput("agent", AGENTS));
  setOptional(inputs, "timeout", optionalInput("timeout"));
  setOptional(inputs, "activityTimeout", optionalInput("activity_timeout"));
  setOptional(inputs, "cwd", optionalInput("cwd"));
  setOptional(inputs, "push", optionalEnumInput("push", PERMISSION_LEVELS));
  setOptional(inputs, "shell", optionalEnumInput("shell", PERMISSION_LEVELS));
  setOptional(inputs, "outputSchema", optionalInput("output_schema"));
  setOptional(inputs, "token", optionalInput("token"));
  return inputs;
}
function setOptional(inputs, key, value) {
  if (value !== void 0) inputs[key] = value;
}
function optionalInput(name) {
  const value = core.getInput(name);
  return value.length > 0 ? value : void 0;
}
function optionalEnumInput(name, allowed) {
  const value = optionalInput(name);
  if (value === void 0) return void 0;
  if (isOneOf(value, allowed)) return value;
  throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}`);
}

// packages/core/src/config.ts
import { readFile } from "fs/promises";
import { parse as parseToml } from "smol-toml";
var DEFAULT_CONFIG = {
  agent: "claude-code",
  model: "claude/sonnet",
  mode: "review",
  timeout: "1h",
  activityTimeout: "5m",
  failOn: "high",
  reportOn: "medium",
  minConfidence: "medium",
  shell: "restricted",
  push: "restricted",
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
var TOP_LEVEL_KEYS = /* @__PURE__ */ new Set([
  "agent",
  "model",
  "mode",
  "timeout",
  "activityTimeout",
  "activity_timeout",
  "failOn",
  "fail_on",
  "reportOn",
  "report_on",
  "minConfidence",
  "min_confidence",
  "shell",
  "push",
  "paths",
  "memory",
  "telemetry"
]);
async function loadConfigFile(path) {
  const contents = await readFile(path, "utf8");
  return parseConfig(contents);
}
function parseConfig(contents) {
  let parsed;
  try {
    parsed = parseToml(contents);
  } catch (error) {
    throw new ConfigError("Config is not valid TOML.", { cause: error });
  }
  return normalizeConfig(assertRecord(parsed, "config"));
}
function normalizeConfig(raw) {
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
  config.reportOn = enumValue(raw.reportOn ?? raw.report_on, SEVERITIES, "report_on", config.reportOn);
  config.minConfidence = enumValue(
    raw.minConfidence ?? raw.min_confidence,
    CONFIDENCES,
    "min_confidence",
    config.minConfidence
  );
  config.shell = enumValue(raw.shell, PERMISSION_LEVELS, "shell", config.shell);
  config.push = enumValue(raw.push, PERMISSION_LEVELS, "push", config.push);
  if (raw.paths !== void 0) {
    const paths = assertRecord(raw.paths, "paths");
    config.paths.include = globList(paths.include, "paths.include", config.paths.include);
    config.paths.ignore = globList(paths.ignore, "paths.ignore", config.paths.ignore);
  }
  if (raw.memory !== void 0) {
    const memory = assertRecord(raw.memory, "memory");
    config.memory.enabled = booleanValue(memory.enabled, "memory.enabled", config.memory.enabled);
    config.memory.backend = enumValue(
      memory.backend,
      ["github", "file", "api", "disabled"],
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
function rejectUnknownTopLevelKeys(raw) {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith("x-")) {
      throw new ConfigError(`Unknown top-level config key: ${key}`);
    }
  }
}
function enumValue(value, allowed, field, fallback) {
  if (value === void 0) return fallback;
  if (isOneOf(value, allowed)) return value;
  throw new ConfigError(`${field} must be one of: ${allowed.join(", ")}`);
}
function stringValue(value, field, fallback) {
  if (value === void 0) return fallback;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new ConfigError(`${field} must be a non-empty string.`);
}
function booleanValue(value, field, fallback) {
  if (value === void 0) return fallback;
  if (typeof value === "boolean") return value;
  throw new ConfigError(`${field} must be a boolean.`);
}
function globList(value, field, fallback) {
  if (value === void 0) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${field} must be an array of glob strings.`);
  }
  for (const glob of value) validateGlob(glob, field);
  return [...value];
}
function validateGlob(glob, field) {
  if (glob.trim().length === 0) throw new ConfigError(`${field} contains an empty glob.`);
  let bracketDepth = 0;
  for (const char of glob) {
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth -= 1;
    if (bracketDepth < 0) throw new ConfigError(`${field} contains invalid glob syntax: ${glob}`);
  }
  if (bracketDepth !== 0) throw new ConfigError(`${field} contains invalid glob syntax: ${glob}`);
}
function assertRecord(value, field) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  throw new ConfigError(`${field} must be a table/object.`);
}

// packages/core/src/redaction.ts
var DEFAULT_SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(CLAUDE_CODE_OAUTH_TOKEN=)([^\s]+)/g,
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=)([^\s]+)/gi
];
var SECRET_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|oauth)/i;
var DefaultRedactor = class {
  constructor(replacement = "[REDACTED]") {
    this.replacement = replacement;
  }
  replacement;
  redactString(value) {
    return DEFAULT_SECRET_PATTERNS.reduce(
      (current, pattern) => current.replace(pattern, (...args) => {
        const captures = args.slice(1, -2).filter((capture) => typeof capture === "string");
        const prefix = captures.length > 1 ? captures[0] : "";
        return `${prefix}${this.replacement}`;
      }),
      value
    );
  }
  redact(value) {
    return this.redactValue(value);
  }
  redactValue(value, key) {
    if (typeof value === "string") {
      return key !== void 0 && SECRET_KEY_PATTERN.test(key) ? this.replacement : this.redactString(value);
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
};

// packages/core/src/observability.ts
var RunLogger = class {
  constructor(redactor = new DefaultRedactor()) {
    this.redactor = redactor;
  }
  redactor;
  events = [];
  log(level, event, data) {
    this.events.push({
      time: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      event,
      data: data === void 0 ? void 0 : this.redactor.redact(data)
    });
  }
  snapshot() {
    return [...this.events];
  }
};

// packages/core/src/run-record.ts
function createRunRecord(input) {
  return {
    runId: crypto.randomUUID(),
    ...input,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: "running",
    timings: {},
    toolCalls: []
  };
}
function completeRunRecord(record, status) {
  return {
    ...record,
    status,
    completedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// packages/action/src/workflow-summary.ts
import * as core2 from "@actions/core";
async function writeWorkflowSummary(record) {
  await core2.summary.addHeading("reviewbot").addTable([
    [
      { data: "Field", header: true },
      { data: "Value", header: true }
    ],
    ["Run ID", record.runId],
    ["Status", record.status],
    ["Mode", record.mode],
    ["Agent", record.agent],
    ["Model", record.model]
  ]).write();
}

// packages/action/src/main.ts
async function main() {
  const logger = new RunLogger();
  const inputs = readActionInputs();
  const fileConfig = inputs.config ? await loadConfigFile(inputs.config) : normalizeConfig({});
  const config = {
    ...fileConfig,
    agent: inputs.agent ?? fileConfig.agent,
    model: inputs.model ?? fileConfig.model,
    mode: inputs.mode ?? fileConfig.mode,
    timeout: inputs.timeout ?? fileConfig.timeout,
    activityTimeout: inputs.activityTimeout ?? fileConfig.activityTimeout,
    shell: inputs.shell ?? fileConfig.shell,
    push: inputs.push ?? fileConfig.push
  };
  const record = createRunRecord({
    event: process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch",
    actor: process.env.GITHUB_ACTOR ?? "unknown",
    mode: config.mode,
    agent: config.agent,
    model: config.model
  });
  logger.log("info", "run.initialized", {
    runId: record.runId,
    mode: config.mode,
    agent: config.agent,
    model: config.model
  });
  core3.setOutput("result", JSON.stringify({ runId: record.runId, status: "initialized" }));
  await writeWorkflowSummary(completeRunRecord(record, "success"));
}

// packages/action/src/entry.ts
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core4.setFailed(message);
});
//# sourceMappingURL=index.js.map