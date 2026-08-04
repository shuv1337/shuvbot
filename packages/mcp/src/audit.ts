import { createHash } from "node:crypto";
import type { ShuvbotMode } from "../../core/src/types.ts";
import type { Redactor } from "../../core/src/redaction.ts";

export type ToolPolicyDecision = "allowed" | "denied";
export type ToolAuditStatus = "success" | "failure";

export interface ToolAuditRecord {
  runId: string;
  toolName: string;
  actor: string;
  mode: ShuvbotMode;
  status: ToolAuditStatus;
  durationMs: number;
  policyDecision: ToolPolicyDecision;
  sanitizedInput: unknown;
  inputDigest: string;
  sanitizedOutput?: unknown;
  outputDigest?: string;
  sanitizedError?: string;
  errorCode?: string;
}

export interface ToolAuditRecordInput {
  runId: string;
  toolName: string;
  actor: string;
  mode: ShuvbotMode;
  status: ToolAuditStatus;
  durationMs: number;
  policyDecision: ToolPolicyDecision;
  input: unknown;
  output?: unknown;
  error?: unknown;
  errorCode?: string;
}

export interface ToolAuditSnapshot {
  records: ToolAuditRecord[];
  summary: ToolAuditSummary;
}

export interface ToolAuditSummary {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  totalDurationMs: number;
  byTool: Record<string, ToolAuditToolSummary>;
}

export interface ToolAuditToolSummary {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  totalDurationMs: number;
}

export interface ToolAuditSink {
  record(record: ToolAuditRecord): void | Promise<void>;
  snapshot?(): ToolAuditSnapshot;
}

export class AuditLog implements ToolAuditSink {
  private readonly records: ToolAuditRecord[] = [];

  constructor(private readonly redactor: Redactor) {}

  record(record: ToolAuditRecord): void {
    this.records.push(record);
  }

  createRecord(input: ToolAuditRecordInput): ToolAuditRecord {
    return createToolAuditRecord(input, this.redactor);
  }

  snapshot(): ToolAuditSnapshot {
    const records = this.records.map((record) => ({ ...record }));
    return {
      records,
      summary: summarizeToolAudit(records)
    };
  }
}

export function createToolAuditRecord(
  input: ToolAuditRecordInput,
  redactor: Redactor
): ToolAuditRecord {
  const sanitizedInput = redactor.redact(input.input);
  const record: ToolAuditRecord = {
    runId: input.runId,
    toolName: input.toolName,
    actor: input.actor,
    mode: input.mode,
    status: input.status,
    durationMs: input.durationMs,
    policyDecision: input.policyDecision,
    sanitizedInput,
    inputDigest: digest(sanitizedInput)
  };

  if (input.output !== undefined) {
    record.sanitizedOutput = redactor.redact(input.output);
    record.outputDigest = digest(record.sanitizedOutput);
  }

  if (input.error !== undefined) {
    record.sanitizedError = sanitizeError(input.error, redactor);
    if (input.errorCode !== undefined) record.errorCode = input.errorCode;
  }

  return record;
}

export function summarizeToolAudit(records: readonly ToolAuditRecord[]): ToolAuditSummary {
  const summary: ToolAuditSummary = {
    total: records.length,
    succeeded: 0,
    failed: 0,
    denied: 0,
    totalDurationMs: 0,
    byTool: {}
  };

  for (const record of records) {
    if (record.status === "success") summary.succeeded += 1;
    else summary.failed += 1;
    if (record.policyDecision === "denied") summary.denied += 1;
    summary.totalDurationMs += record.durationMs;

    const tool = (summary.byTool[record.toolName] ??= {
      total: 0,
      succeeded: 0,
      failed: 0,
      denied: 0,
      totalDurationMs: 0
    });
    tool.total += 1;
    if (record.status === "success") tool.succeeded += 1;
    else tool.failed += 1;
    if (record.policyDecision === "denied") tool.denied += 1;
    tool.totalDurationMs += record.durationMs;
  }

  return summary;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortValue(entryValue)])
    );
  }
  return value;
}

function sanitizeError(error: unknown, redactor: Redactor): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactor.redactString(message);
}
