// packages/action/src/entry.ts
import * as core4 from "@actions/core";

// packages/action/src/main.ts
import { readFile as readFile2 } from "fs/promises";
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
var MODES = ["auto", "review", "implement", "fix-ci", "triage", "release-notes"];
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
  const record = {
    runId: crypto.randomUUID(),
    event: input.event,
    actor: input.actor,
    trigger: input.trigger ?? input.event,
    mode: input.mode,
    agent: input.agent,
    model: input.model,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: "running",
    timings: {},
    toolCalls: [],
    filesConsidered: [],
    filesIgnored: [],
    errors: []
  };
  if (input.repo !== void 0) record.repo = input.repo;
  if (input.eventAction !== void 0) record.eventAction = input.eventAction;
  return record;
}
function completeRunRecord(record, status) {
  return {
    ...record,
    status,
    completedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function recordPolicy(record, policy) {
  return { ...record, policy: summarizePolicy(policy) };
}
function summarizePolicy(policy) {
  return {
    actor: policy.actor,
    actorPermission: policy.actorPermission,
    event: policy.event,
    isFork: policy.isFork,
    isPrivateRepo: policy.isPrivateRepo,
    shell: policy.shell,
    push: policy.push,
    canCreatePr: policy.canCreatePr,
    canComment: policy.canComment,
    canReview: policy.canReview,
    canApprove: policy.canApprove,
    canRequestChanges: policy.canRequestChanges,
    canReadChecks: policy.canReadChecks,
    canReadSecrets: policy.canReadSecrets,
    canAddLabels: policy.canAddLabels,
    canUpdateIssue: policy.canUpdateIssue,
    canUpdatePullRequest: policy.canUpdatePullRequest,
    reasons: [...policy.reasons]
  };
}

// packages/action/src/workflow-summary.ts
import * as core2 from "@actions/core";
async function writeWorkflowSummary(record) {
  const summary2 = core2.summary.addHeading("reviewbot").addTable([
    [
      { data: "Field", header: true },
      { data: "Value", header: true }
    ],
    ["Run ID", record.runId],
    ["Status", record.status],
    ["Trigger", record.trigger],
    ["Event", `${record.event}${record.eventAction ? `:${record.eventAction}` : ""}`],
    ["Actor", record.actor],
    ["Mode", record.mode],
    ["Agent", record.agent],
    ["Model", record.model]
  ]);
  if (record.policy) {
    const p = record.policy;
    summary2.addHeading("Runtime policy", 2).addTable([
      [
        { data: "Permission", header: true },
        { data: "Value", header: true }
      ],
      ["shell", p.shell],
      ["push", p.push],
      ["actorPermission", p.actorPermission],
      ["isFork", String(p.isFork)],
      ["isPrivateRepo", String(p.isPrivateRepo)],
      ["canComment", String(p.canComment)],
      ["canReview", String(p.canReview)],
      ["canApprove", String(p.canApprove)],
      ["canRequestChanges", String(p.canRequestChanges)],
      ["canCreatePr", String(p.canCreatePr)],
      ["canReadSecrets", String(p.canReadSecrets)],
      ["canAddLabels", String(p.canAddLabels)],
      ["canUpdateIssue", String(p.canUpdateIssue)],
      ["canUpdatePullRequest", String(p.canUpdatePullRequest)]
    ]);
    if (p.reasons.length > 0) {
      summary2.addHeading("Policy reasons", 3).addList(p.reasons);
    }
  }
  if (record.filesConsidered.length > 0) {
    summary2.addHeading("Files considered", 2).addList(record.filesConsidered);
  }
  if (record.filesIgnored.length > 0) {
    summary2.addHeading("Files ignored", 2).addList(record.filesIgnored);
  }
  if (record.toolCalls.length > 0) {
    summary2.addHeading("Tools called", 2).addTable([
      [
        { data: "Tool", header: true },
        { data: "Duration (ms)", header: true },
        { data: "Status", header: true }
      ],
      ...record.toolCalls.map(
        (call) => [call.name, String(call.durationMs), call.status]
      )
    ]);
  }
  if (record.errors.length > 0) {
    summary2.addHeading("Errors", 2).addTable([
      [
        { data: "Class", header: true },
        { data: "Message", header: true }
      ],
      ...record.errors.map((err) => [err.class, err.message])
    ]);
  }
  await summary2.write();
}

// packages/core/src/events.ts
var EventNormalizationError = class extends ConfigError {
  constructor(message) {
    super(message);
  }
};
var SUPPORTED_EVENT_NAMES = /* @__PURE__ */ new Set([
  "pull_request",
  "pull_request_target",
  "issue_comment",
  "pull_request_review_comment",
  "issues",
  "workflow_dispatch",
  "workflow_run",
  "schedule"
]);
function isSupportedEventName(name) {
  return SUPPORTED_EVENT_NAMES.has(name);
}
function normalizeEvent(input) {
  const payload = asRecord(input.payload, "event payload");
  const repo = parseRepo(payload);
  const sender = parseSender(payload);
  switch (input.eventName) {
    case "pull_request":
    case "pull_request_target": {
      const pr = parsePullRequest(payload, repo);
      return {
        kind: "pull_request",
        name: input.eventName,
        action: stringField(payload.action) ?? "opened",
        repo,
        sender,
        pullRequest: pr,
        raw: payload
      };
    }
    case "issue_comment": {
      return {
        kind: "issue_comment",
        name: input.eventName,
        action: stringField(payload.action) ?? "created",
        repo,
        sender,
        issue: parseIssue(payload),
        comment: parseComment(payload.comment),
        raw: payload
      };
    }
    case "pull_request_review_comment": {
      return {
        kind: "pull_request_review_comment",
        name: input.eventName,
        action: stringField(payload.action) ?? "created",
        repo,
        sender,
        pullRequest: parsePullRequest(payload, repo),
        comment: parseComment(payload.comment),
        raw: payload
      };
    }
    case "issues": {
      return {
        kind: "issues",
        name: input.eventName,
        action: stringField(payload.action) ?? "opened",
        repo,
        sender,
        issue: parseIssue(payload),
        raw: payload
      };
    }
    case "workflow_dispatch": {
      const inputs = asOptionalRecord(payload.inputs) ?? {};
      return {
        kind: "workflow_dispatch",
        name: input.eventName,
        repo,
        sender,
        inputs,
        ref: stringField(payload.ref) ?? "",
        raw: payload
      };
    }
    case "workflow_run": {
      const run = asRecord(payload.workflow_run, "workflow_run");
      return {
        kind: "workflow_run",
        name: input.eventName,
        action: stringField(payload.action) ?? "completed",
        repo,
        sender,
        workflowName: stringField(run.name) ?? "",
        conclusion: stringField(run.conclusion) ?? null,
        headBranch: stringField(run.head_branch) ?? "",
        headSha: stringField(run.head_sha) ?? "",
        raw: payload
      };
    }
    case "schedule": {
      return {
        kind: "schedule",
        name: input.eventName,
        repo,
        sender,
        raw: payload
      };
    }
    default:
      throw new EventNormalizationError(`Unsupported GitHub event: ${input.eventName}`);
  }
}
function parseRepo(payload) {
  const repo = asRecord(payload.repository, "repository");
  const owner = asRecord(repo.owner, "repository.owner");
  return {
    owner: stringField(owner.login) ?? "",
    name: stringField(repo.name) ?? "",
    fullName: stringField(repo.full_name) ?? "",
    isPrivate: Boolean(repo.private),
    defaultBranch: stringField(repo.default_branch) ?? ""
  };
}
function parseSender(payload) {
  const sender = asOptionalRecord(payload.sender) ?? {};
  return {
    login: stringField(sender.login) ?? "",
    type: stringField(sender.type) ?? ""
  };
}
function parsePullRequest(payload, repo) {
  const pr = asRecord(payload.pull_request, "pull_request");
  const head = asRecord(pr.head, "pull_request.head");
  const base = asRecord(pr.base, "pull_request.base");
  const headRepo = asOptionalRecord(head.repo);
  const headRepoFullName = stringField(headRepo?.full_name) ?? null;
  const isFork = headRepoFullName !== null && headRepoFullName !== repo.fullName;
  const stateValue = stringField(pr.state) ?? "open";
  return {
    number: numberField(pr.number) ?? 0,
    title: stringField(pr.title) ?? "",
    body: stringField(pr.body) ?? "",
    state: stateValue === "closed" ? "closed" : "open",
    draft: Boolean(pr.draft),
    user: parseActor(pr.user),
    baseRef: stringField(base.ref) ?? "",
    baseSha: stringField(base.sha) ?? "",
    headRef: stringField(head.ref) ?? "",
    headSha: stringField(head.sha) ?? "",
    headRepoFullName,
    isFork
  };
}
function parseIssue(payload) {
  const issue = asRecord(payload.issue, "issue");
  const stateValue = stringField(issue.state) ?? "open";
  return {
    number: numberField(issue.number) ?? 0,
    title: stringField(issue.title) ?? "",
    body: stringField(issue.body) ?? "",
    state: stateValue === "closed" ? "closed" : "open",
    user: parseActor(issue.user),
    isPullRequest: Boolean(issue.pull_request)
  };
}
function parseComment(payload) {
  const comment = asRecord(payload, "comment");
  return {
    id: numberField(comment.id) ?? 0,
    body: stringField(comment.body) ?? "",
    user: parseActor(comment.user)
  };
}
function parseActor(value) {
  const record = asOptionalRecord(value);
  if (!record) return { login: "" };
  return {
    login: stringField(record.login) ?? "",
    type: stringField(record.type) ?? ""
  };
}
function stringField(value) {
  if (typeof value === "string") return value;
  return void 0;
}
function numberField(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return void 0;
}
function asRecord(value, label) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  throw new EventNormalizationError(`${label} must be an object.`);
}
function asOptionalRecord(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return void 0;
}

// packages/core/src/commands.ts
var SUPPORTED_COMMANDS = [
  "review",
  "improve",
  "ask",
  "implement",
  "fix-ci",
  "describe",
  "changelog",
  "test-plan",
  "explain",
  "summarize"
];
var DEFAULT_COMMAND_PREFIX = "@reviewbot";
function isCommandName(value) {
  return typeof value === "string" && SUPPORTED_COMMANDS.includes(value);
}
function parseCommand(input) {
  const prefix = (input.prefix ?? DEFAULT_COMMAND_PREFIX).trim();
  if (!prefix) return null;
  const text = (input.text ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const escaped = escapeRegExp(prefix);
  const pattern = new RegExp(`(^|\\s)${escaped}\\s+([\\w-]+)([^\\n]*)`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    const candidate = match[2]?.toLowerCase();
    if (!candidate || !isCommandName(candidate)) continue;
    const args = (match[3] ?? "").trim();
    return {
      prefix,
      command: candidate,
      args,
      raw: line.trim(),
      actor: input.actor,
      source: input.source
    };
  }
  return null;
}
function findCommandInEvent(event, prefix = DEFAULT_COMMAND_PREFIX) {
  if (!event) return null;
  switch (event.kind) {
    case "issue_comment":
      return parseCommand({
        text: event.comment.body,
        prefix,
        actor: event.comment.user.login || event.sender.login,
        source: "issue_comment"
      });
    case "pull_request_review_comment":
      return parseCommand({
        text: event.comment.body,
        prefix,
        actor: event.comment.user.login || event.sender.login,
        source: "review_comment"
      });
    case "issues":
      return parseCommand({
        text: event.issue.body,
        prefix,
        actor: event.issue.user.login || event.sender.login,
        source: "issue_body"
      });
    case "pull_request":
      return parseCommand({
        text: event.pullRequest.body,
        prefix,
        actor: event.pullRequest.user.login || event.sender.login,
        source: "pr_body"
      });
    default:
      return null;
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// packages/core/src/modes.ts
var COMMAND_TO_MODE = {
  review: "review",
  improve: "implement",
  ask: "triage",
  implement: "implement",
  "fix-ci": "fix-ci",
  describe: "release-notes",
  changelog: "release-notes",
  "test-plan": "review",
  explain: "triage",
  summarize: "triage"
};
function resolveMode(input) {
  const explicit = input.explicit;
  if (explicit && explicit !== "auto" && isOneOf(explicit, MODES)) {
    return { mode: explicit, reason: `explicit:${explicit}` };
  }
  if (input.command) {
    const mapped = COMMAND_TO_MODE[input.command.command];
    return { mode: mapped, reason: `command:${input.command.command}` };
  }
  if (input.event) {
    switch (input.event.kind) {
      case "pull_request":
        return { mode: "review", reason: "event:pull_request" };
      case "pull_request_review_comment":
        return { mode: "review", reason: "event:pull_request_review_comment" };
      case "workflow_run": {
        if (input.event.conclusion === "failure") {
          return { mode: "fix-ci", reason: "event:workflow_run.failure" };
        }
        return { mode: "triage", reason: "event:workflow_run" };
      }
      case "schedule":
        return { mode: "triage", reason: "event:schedule" };
      case "issues":
        return { mode: "triage", reason: "event:issues" };
      case "issue_comment":
        return inferFromText(input.event.comment.body, "issue_comment");
      case "workflow_dispatch":
        return inferFromText(input.promptText ?? "", "workflow_dispatch");
    }
  }
  return inferFromText(input.promptText ?? "", "prompt");
}
function inferFromText(text, reasonTag) {
  const lower = text.toLowerCase();
  if (/release\s*notes|changelog/.test(lower)) {
    return { mode: "release-notes", reason: `${reasonTag}:release-notes-keyword` };
  }
  if (/fix\s*ci|ci\s*fail|failing\s*check|broken\s*build/.test(lower)) {
    return { mode: "fix-ci", reason: `${reasonTag}:fix-ci-keyword` };
  }
  if (/implement|build|add\s+(?:a|the)|fix\s+(?:the|this)/.test(lower)) {
    return { mode: "implement", reason: `${reasonTag}:implement-keyword` };
  }
  if (/review|audit/.test(lower)) {
    return { mode: "review", reason: `${reasonTag}:review-keyword` };
  }
  return { mode: "review", reason: `${reasonTag}:default` };
}

// packages/core/src/policy.ts
var WRITE_LEVELS = ["write", "maintain", "admin"];
var MAINTAIN_LEVELS = ["maintain", "admin"];
var LEVEL_RANK = {
  disabled: 0,
  restricted: 1,
  enabled: 2
};
function defaultRuntimePolicy(input) {
  const hasWrite = WRITE_LEVELS.includes(input.actorPermission);
  const hasMaintain = MAINTAIN_LEVELS.includes(input.actorPermission);
  const isTrusted = hasWrite && !input.isFork;
  const canComment = input.actorPermission !== "none";
  return {
    ...input,
    shell: isTrusted ? "restricted" : "disabled",
    push: isTrusted ? "restricted" : "disabled",
    canCreatePr: isTrusted,
    canComment,
    canReview: canComment && !input.isFork,
    canApprove: false,
    canRequestChanges: isTrusted,
    canReadChecks: canComment,
    canReadSecrets: hasMaintain && !input.isFork && input.isPrivateRepo,
    canAddLabels: hasWrite && !input.isFork,
    canUpdateIssue: hasWrite && !input.isFork,
    canUpdatePullRequest: hasWrite && !input.isFork,
    reasons: [`actor:${input.actorPermission}`, `fork:${input.isFork}`]
  };
}
function applyRuntimeCaps(policy, caps) {
  const reasons = [...policy.reasons];
  let { shell, push } = policy;
  if (caps.shell !== void 0) {
    const capped = capPermission(policy.shell, caps.shell);
    if (capped !== policy.shell) reasons.push(`cap:shell=${capped}`);
    shell = capped;
  }
  if (caps.push !== void 0) {
    const capped = capPermission(policy.push, caps.push);
    if (capped !== policy.push) reasons.push(`cap:push=${capped}`);
    push = capped;
  }
  return { ...policy, shell, push, reasons };
}
function capPermission(current, requested) {
  return LEVEL_RANK[requested] < LEVEL_RANK[current] ? requested : current;
}
function buildRuntimePolicy(input) {
  const base = contextDefaults({
    actor: input.actor.login,
    actorPermission: input.actor.actorPermission,
    event: input.event.name,
    isFork: input.actor.isFork,
    isPrivateRepo: input.actor.isPrivateRepo
  });
  let policy = applyRuntimeCaps(base, input.configCaps);
  if (input.inputCaps) policy = applyRuntimeCaps(policy, input.inputCaps);
  policy = applyEventRestrictions(policy, input.event, input.mode);
  return policy;
}
function contextDefaults(input) {
  const policy = defaultRuntimePolicy(input);
  const reasons = [...policy.reasons];
  const isPrEvent = input.event === "pull_request" || input.event === "pull_request_target";
  const isScheduled = input.event === "schedule";
  const isDispatch = input.event === "workflow_dispatch";
  const isCommentEvent = input.event === "issue_comment" || input.event === "pull_request_review_comment" || input.event === "issues";
  const hasWrite = WRITE_LEVELS.includes(input.actorPermission);
  const hasMaintain = MAINTAIN_LEVELS.includes(input.actorPermission);
  let shell = policy.shell;
  let push = policy.push;
  if (input.isFork) {
    shell = "disabled";
    push = "disabled";
    reasons.push("fork:shell=disabled", "fork:push=disabled");
  } else if (isPrEvent && !hasWrite) {
    shell = "restricted";
    push = "disabled";
    reasons.push("pr-non-collab:shell=restricted", "pr-non-collab:push=disabled");
  } else if (isCommentEvent && hasMaintain) {
    shell = "restricted";
    push = "restricted";
    reasons.push("maintainer-mention:default=restricted");
  } else if (isCommentEvent && hasWrite) {
    shell = "restricted";
    push = "restricted";
    reasons.push("collab-mention:default=restricted");
  } else if (isScheduled) {
    shell = "restricted";
    push = "restricted";
    reasons.push("schedule:default=restricted");
  } else if (isDispatch && hasWrite) {
    shell = "restricted";
    push = "restricted";
    reasons.push("dispatch:default=restricted");
  }
  return { ...policy, shell, push, reasons };
}
function applyEventRestrictions(policy, event, mode) {
  const reasons = [...policy.reasons];
  let { shell, push, canReadSecrets, canApprove } = policy;
  if (policy.isFork) {
    if (shell !== "disabled") {
      shell = "disabled";
      reasons.push("hard:fork:shell=disabled");
    }
    if (push !== "disabled") {
      push = "disabled";
      reasons.push("hard:fork:push=disabled");
    }
    if (canReadSecrets) {
      canReadSecrets = false;
      reasons.push("hard:fork:no-secrets");
    }
  }
  if (mode === "review") {
    if (push !== "disabled") {
      push = "disabled";
      reasons.push("mode:review:push=disabled");
    }
  }
  if (mode === "release-notes" && push !== "disabled") {
    push = "disabled";
    reasons.push("mode:release-notes:push=disabled");
  }
  if (event.kind === "workflow_run" && event.conclusion !== "failure" && mode === "fix-ci") {
    reasons.push("warn:workflow_run-not-failed");
  }
  if (canApprove) {
    canApprove = false;
    reasons.push("hard:no-ai-approval");
  }
  return { ...policy, shell, push, canReadSecrets, canApprove, reasons };
}

// packages/github/src/permissions.ts
function detectFork(event) {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_review_comment":
      return event.pullRequest.isFork;
    default:
      return false;
  }
}
function detectPrivateRepo(event) {
  return Boolean(event.repo.isPrivate);
}
function resolveActorLogin(event) {
  switch (event.kind) {
    case "issue_comment":
    case "pull_request_review_comment":
      return event.comment.user.login || event.sender.login;
    case "issues":
      return event.issue.user.login || event.sender.login;
    case "pull_request":
      return event.pullRequest.user.login || event.sender.login;
    default:
      return event.sender.login;
  }
}
async function deriveActorContext(input) {
  const login = resolveActorLogin(input.event);
  const isFork = detectFork(input.event);
  const isPrivateRepo = detectPrivateRepo(input.event);
  const explicit = input.actorPermission;
  if (explicit) {
    return { login, actorPermission: explicit, isFork, isPrivateRepo };
  }
  if (!input.client || !login || !input.event.repo.owner || !input.event.repo.name) {
    return { login, actorPermission: "none", isFork, isPrivateRepo };
  }
  const actorPermission = await fetchActorPermission({
    client: input.client,
    owner: input.event.repo.owner,
    repo: input.event.repo.name,
    username: login
  });
  return { login, actorPermission, isFork, isPrivateRepo };
}
var PERMISSION_MAP = {
  none: "none",
  read: "read",
  triage: "triage",
  write: "write",
  maintain: "maintain",
  admin: "admin"
};
async function fetchActorPermission(input) {
  try {
    const response = await input.client.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { params: { owner: input.owner, repo: input.repo, username: input.username } }
    );
    const role = response.data.role_name?.toLowerCase();
    if (role && PERMISSION_MAP[role]) return PERMISSION_MAP[role];
    const permission = response.data.permission?.toLowerCase();
    if (permission && PERMISSION_MAP[permission]) return PERMISSION_MAP[permission];
    return "none";
  } catch {
    return "none";
  }
}

// packages/github/src/octokit.ts
var DEFAULT_BASE_URL = "https://api.github.com";
function createGitHubClient(input) {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const userAgent = input.userAgent ?? "reviewbot";
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async request(route, options = {}) {
      const { method, path } = parseRoute(route, options.method ?? "GET");
      const url = applyParams(`${baseUrl}${path}`, options.params, method === "GET" ? "query" : "path");
      const init = {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "user-agent": userAgent,
          "x-github-api-version": "2022-11-28"
        }
      };
      if (options.body !== void 0 && method !== "GET") {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      const response = await fetchImpl(url, init);
      const text = await response.text();
      const data = text.length > 0 ? JSON.parse(text) : {};
      if (!response.ok) {
        const message = data && typeof data === "object" && "message" in data ? String(data.message) : response.statusText;
        throw new GitHubRequestError(`GitHub request failed (${response.status}): ${message}`, response.status, data);
      }
      return { status: response.status, data };
    }
  };
}
var GitHubRequestError = class extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = "GitHubRequestError";
  }
  status;
  data;
};
function parseRoute(route, fallbackMethod) {
  const trimmed = route.trim();
  if (!trimmed) return { method: fallbackMethod, path: "/" };
  const match = trimmed.match(/^([A-Z]+)\s+(.*)$/);
  if (match && match[1] && match[2]) {
    return { method: match[1], path: ensureLeadingSlash(match[2]) };
  }
  return { method: fallbackMethod, path: ensureLeadingSlash(trimmed) };
}
function ensureLeadingSlash(path) {
  return path.startsWith("/") ? path : `/${path}`;
}
function applyParams(url, params, mode) {
  if (!params) return url;
  let resolved = url;
  const queryEntries = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0) continue;
    const token = `{${key}}`;
    if (resolved.includes(token)) {
      resolved = resolved.replace(token, encodeURIComponent(String(value)));
    } else if (mode === "query") {
      queryEntries.push([key, String(value)]);
    }
  }
  if (queryEntries.length === 0) return resolved;
  const search = new URLSearchParams(queryEntries).toString();
  return resolved.includes("?") ? `${resolved}&${search}` : `${resolved}?${search}`;
}

// packages/action/src/main.ts
async function main() {
  const logger = new RunLogger();
  const inputs = readActionInputs();
  const fileConfig = inputs.config ? await loadConfigFile(inputs.config) : normalizeConfig({});
  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPayload = await readEventPayload();
  const event = isSupportedEventName(eventName) && eventPayload ? normalizeEvent({ eventName, payload: eventPayload }) : null;
  const command = findCommandInEvent(event);
  const explicitMode = isExplicitMode(inputs.mode) ? inputs.mode : "auto";
  const resolved = resolveMode({
    explicit: explicitMode,
    event,
    command,
    promptText: inputs.prompt ?? ""
  });
  const mode = resolved.mode;
  const config = {
    ...fileConfig,
    agent: inputs.agent ?? fileConfig.agent,
    model: inputs.model ?? fileConfig.model,
    mode,
    timeout: inputs.timeout ?? fileConfig.timeout,
    activityTimeout: inputs.activityTimeout ?? fileConfig.activityTimeout,
    shell: inputs.shell ?? fileConfig.shell,
    push: inputs.push ?? fileConfig.push
  };
  const actorLogin = process.env.GITHUB_ACTOR ?? event?.sender.login ?? "unknown";
  const client = inputs.token ? createGitHubClient({ token: inputs.token }) : void 0;
  const actor = event ? await deriveActorContext({
    event,
    ...client ? { client } : {}
  }) : fallbackActor(actorLogin);
  const eventAction = extractAction(event);
  const record = createRunRecord({
    event: eventName,
    actor: actor.login || actorLogin,
    trigger: triggerLabel(event, command, explicitMode),
    mode,
    agent: config.agent,
    model: config.model,
    ...event?.repo.fullName ? { repo: event.repo.fullName } : {},
    ...eventAction ? { eventAction } : {}
  });
  let withPolicy = record;
  if (event) {
    const policy = buildRuntimePolicy({
      event,
      mode,
      actor,
      configCaps: { shell: fileConfig.shell, push: fileConfig.push },
      inputCaps: {
        ...inputs.shell ? { shell: inputs.shell } : {},
        ...inputs.push ? { push: inputs.push } : {}
      }
    });
    withPolicy = recordPolicy(record, policy);
    logger.log("info", "policy.resolved", {
      shell: policy.shell,
      push: policy.push,
      reasons: policy.reasons
    });
  }
  logger.log("info", "run.initialized", {
    runId: withPolicy.runId,
    mode,
    agent: config.agent,
    model: config.model,
    trigger: withPolicy.trigger,
    modeReason: resolved.reason
  });
  core3.setOutput(
    "result",
    JSON.stringify({
      runId: withPolicy.runId,
      status: "initialized",
      mode,
      trigger: withPolicy.trigger
    })
  );
  await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
}
function isExplicitMode(value) {
  return typeof value === "string" && MODES.includes(value);
}
function triggerLabel(event, command, explicit) {
  if (command) return `command:${command.command}`;
  if (event) return `event:${event.kind}`;
  return `input:${explicit}`;
}
function extractAction(event) {
  if (!event) return void 0;
  if ("action" in event && typeof event.action === "string") return event.action;
  return void 0;
}
function fallbackActor(login) {
  return {
    login,
    actorPermission: "none",
    isFork: false,
    isPrivateRepo: false
  };
}
async function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const raw = await readFile2(path, "utf8");
    return raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// packages/action/src/entry.ts
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core4.setFailed(message);
});
//# sourceMappingURL=index.js.map