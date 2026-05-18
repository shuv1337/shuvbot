import { ConfigError } from "./errors.ts";

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch?: string;
}

export interface ActorRef {
  login: string;
  type?: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  user: ActorRef;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headRepoFullName: string | null;
  isFork: boolean;
}

export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: ActorRef;
  isPullRequest: boolean;
}

export interface CommentSummary {
  id: number;
  body: string;
  user: ActorRef;
}

export interface BaseBotEvent {
  name: string;
  action?: string;
  repo: RepoRef;
  sender: ActorRef;
  raw: unknown;
}

export interface PullRequestEvent extends BaseBotEvent {
  kind: "pull_request";
  action: string;
  pullRequest: PullRequestSummary;
}

export interface IssueCommentEvent extends BaseBotEvent {
  kind: "issue_comment";
  action: string;
  issue: IssueSummary;
  comment: CommentSummary;
}

export interface PullRequestReviewCommentEvent extends BaseBotEvent {
  kind: "pull_request_review_comment";
  action: string;
  pullRequest: PullRequestSummary;
  comment: CommentSummary;
}

export interface IssuesEvent extends BaseBotEvent {
  kind: "issues";
  action: string;
  issue: IssueSummary;
}

export interface WorkflowDispatchEvent extends BaseBotEvent {
  kind: "workflow_dispatch";
  inputs: Record<string, unknown>;
  ref: string;
}

export interface WorkflowRunEvent extends BaseBotEvent {
  kind: "workflow_run";
  action: string;
  workflowName: string;
  conclusion: string | null;
  headBranch: string;
  headSha: string;
}

export interface ScheduleEvent extends BaseBotEvent {
  kind: "schedule";
}

export type BotEvent =
  | PullRequestEvent
  | IssueCommentEvent
  | PullRequestReviewCommentEvent
  | IssuesEvent
  | WorkflowDispatchEvent
  | WorkflowRunEvent
  | ScheduleEvent;

export interface NormalizeInput {
  eventName: string;
  payload: unknown;
}

export class EventNormalizationError extends ConfigError {
  constructor(message: string) {
    super(message);
  }
}

const SUPPORTED_EVENT_NAMES = new Set<string>([
  "pull_request",
  "pull_request_target",
  "issue_comment",
  "pull_request_review_comment",
  "issues",
  "workflow_dispatch",
  "workflow_run",
  "schedule"
]);

export function isSupportedEventName(name: string): boolean {
  return SUPPORTED_EVENT_NAMES.has(name);
}

export function normalizeEvent(input: NormalizeInput): BotEvent {
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

export interface BotEnvelope {
  prompt: string;
  mode?: string;
  model?: string;
  agent?: string;
  timeout?: string;
  eventInstructions?: string;
  previousRunsNote?: string;
  generateSummary?: boolean;
  progressComment?: {
    id: string;
    type: "issue" | "review";
  };
  version?: string;
}

const FORBIDDEN_ENVELOPE_FIELDS = [
  "shell",
  "push",
  "canWrite",
  "canUseSecrets",
  "permissions",
  "actorPermission"
] as const;

export class EnvelopeError extends ConfigError {
  constructor(message: string) {
    super(message);
  }
}

export function validateEnvelope(payload: unknown): BotEnvelope {
  const record = asRecord(payload, "envelope");
  for (const field of FORBIDDEN_ENVELOPE_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new EnvelopeError(
        `Envelope must not declare runtime permission field: ${field}.`
      );
    }
  }

  const prompt = stringField(record.prompt);
  if (prompt === undefined) {
    throw new EnvelopeError("Envelope must include a prompt string.");
  }

  const envelope: BotEnvelope = { prompt };
  const mode = stringField(record.mode);
  if (mode !== undefined) envelope.mode = mode;
  const model = stringField(record.model);
  if (model !== undefined) envelope.model = model;
  const agent = stringField(record.agent);
  if (agent !== undefined) envelope.agent = agent;
  const timeout = stringField(record.timeout);
  if (timeout !== undefined) envelope.timeout = timeout;
  const eventInstructions = stringField(record.eventInstructions);
  if (eventInstructions !== undefined) envelope.eventInstructions = eventInstructions;
  const previousRunsNote = stringField(record.previousRunsNote);
  if (previousRunsNote !== undefined) envelope.previousRunsNote = previousRunsNote;
  if (typeof record.generateSummary === "boolean") {
    envelope.generateSummary = record.generateSummary;
  }
  const version = stringField(record.version);
  if (version !== undefined) envelope.version = version;

  const progress = asOptionalRecord(record.progressComment);
  if (progress) {
    const id = stringField(progress.id);
    const type = stringField(progress.type);
    if (!id || (type !== "issue" && type !== "review")) {
      throw new EnvelopeError(
        "progressComment.id must be a string and type must be 'issue' or 'review'."
      );
    }
    envelope.progressComment = { id, type };
  }

  return envelope;
}

function parseRepo(payload: Record<string, unknown>): RepoRef {
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

function parseSender(payload: Record<string, unknown>): ActorRef {
  const sender = asOptionalRecord(payload.sender) ?? {};
  return {
    login: stringField(sender.login) ?? "",
    type: stringField(sender.type) ?? ""
  };
}

function parsePullRequest(payload: Record<string, unknown>, repo: RepoRef): PullRequestSummary {
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

function parseIssue(payload: Record<string, unknown>): IssueSummary {
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

function parseComment(payload: unknown): CommentSummary {
  const comment = asRecord(payload, "comment");
  return {
    id: numberField(comment.id) ?? 0,
    body: stringField(comment.body) ?? "",
    user: parseActor(comment.user)
  };
}

function parseActor(value: unknown): ActorRef {
  const record = asOptionalRecord(value);
  if (!record) return { login: "" };
  return {
    login: stringField(record.login) ?? "",
    type: stringField(record.type) ?? ""
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new EventNormalizationError(`${label} must be an object.`);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
