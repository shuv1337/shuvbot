import type { AgentId, ReviewbotMode } from "./types.ts";
import type { RuntimePolicy } from "./policy.ts";
import type { ReviewFinding } from "./review-schema.ts";
import type { ReviewerId, ReviewTier } from "../../review/src/types.ts";

export interface ToolCallSummary {
  name: string;
  durationMs: number;
  status: "success" | "failure";
}

export interface ToolAuditRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  totalDurationMs: number;
  byTool: Record<string, ToolAuditRunToolSummary>;
}

export interface ToolAuditRunToolSummary {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  totalDurationMs: number;
}

export interface ReviewSessionSummary {
  sessionId: string;
  role: "coordinator" | "specialist";
  reviewer?: ReviewerId;
  model: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ReviewRunSummary {
  engine: "legacy" | "coordinator";
  tier: ReviewTier;
  decision: "clean" | "comments" | "minor_issues" | "significant_concerns" | "degraded";
  quorumMet: boolean;
  requiredReviewers: ReviewerId[];
  successfulReviewers: ReviewerId[];
  missingReviewers: ReviewerId[];
  sessions: ReviewSessionSummary[];
  retries: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
  findingAccounting?: {
    active: number;
    new: number;
    unresolved: number;
    fixed: number;
    userResolved: number;
    dismissed: number;
  };
}

export interface RunRecord {
  runId: string;
  repo?: string;
  event: string;
  eventAction?: string;
  actor: string;
  trigger: string;
  mode: ReviewbotMode;
  agent: AgentId;
  model: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failure";
  timings: Record<string, number>;
  toolCalls: ToolCallSummary[];
  toolAudit?: ToolAuditRunSummary;
  findings?: ReviewFinding[];
  review?: ReviewRunSummary;
  postedComments?: number;
  contextManifestPath?: string;
  implementation?: {
    requestedTask: string;
    branch: string;
    commandsRun: string[];
    checks: string[];
    commits: string[];
  };
  filesConsidered: string[];
  filesIgnored: string[];
  errors: Array<{ class: string; message: string }>;
  policy?: PolicySummary;
  failure?: {
    class: string;
    message: string;
  };
}

export interface PolicySummary {
  actor: string;
  actorPermission: string;
  event: string;
  isFork: boolean;
  isPrivateRepo: boolean;
  shell: string;
  push: string;
  canCreatePr: boolean;
  canComment: boolean;
  canReview: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReadChecks: boolean;
  canReadSecrets: boolean;
  canAddLabels: boolean;
  canUpdateIssue: boolean;
  canUpdatePullRequest: boolean;
  reasons: string[];
}

export interface CreateRunRecordInput {
  repo?: string;
  event: string;
  eventAction?: string;
  actor: string;
  trigger?: string;
  mode: ReviewbotMode;
  agent: AgentId;
  model: string;
}

export function createRunRecord(input: CreateRunRecordInput): RunRecord {
  const record: RunRecord = {
    runId: crypto.randomUUID(),
    event: input.event,
    actor: input.actor,
    trigger: input.trigger ?? input.event,
    mode: input.mode,
    agent: input.agent,
    model: input.model,
    startedAt: new Date().toISOString(),
    status: "running",
    timings: {},
    toolCalls: [],
    filesConsidered: [],
    filesIgnored: [],
    errors: []
  };
  if (input.repo !== undefined) record.repo = input.repo;
  if (input.eventAction !== undefined) record.eventAction = input.eventAction;
  return record;
}

export function completeRunRecord(record: RunRecord, status: "success" | "failure"): RunRecord {
  return {
    ...record,
    status,
    completedAt: new Date().toISOString()
  };
}

export function recordPolicy(record: RunRecord, policy: RuntimePolicy): RunRecord {
  return { ...record, policy: summarizePolicy(policy) };
}

export function recordError(record: RunRecord, error: unknown): RunRecord {
  const errorClass = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { ...record, errors: [...record.errors, { class: errorClass, message }] };
}

export function recordToolAudit(record: RunRecord, audit: ToolAuditRunSummary): RunRecord {
  return {
    ...record,
    toolAudit: {
      total: audit.total,
      succeeded: audit.succeeded,
      failed: audit.failed,
      denied: audit.denied,
      totalDurationMs: audit.totalDurationMs,
      byTool: Object.fromEntries(
        Object.entries(audit.byTool).map(([toolName, summary]) => [
          toolName,
          {
            total: summary.total,
            succeeded: summary.succeeded,
            failed: summary.failed,
            denied: summary.denied,
            totalDurationMs: summary.totalDurationMs
          }
        ])
      )
    }
  };
}

export function recordReview(record: RunRecord, review: ReviewRunSummary): RunRecord {
  return { ...record, review: structuredClone(review) };
}

export function summarizePolicy(policy: RuntimePolicy): PolicySummary {
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
