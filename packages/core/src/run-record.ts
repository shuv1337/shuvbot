import type { AgentId, ReviewbotMode } from "./types.ts";

export interface RunRecord {
  runId: string;
  repo?: string;
  event: string;
  actor: string;
  mode: ReviewbotMode;
  agent: AgentId;
  model: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failure";
  timings: Record<string, number>;
  toolCalls: Array<{ name: string; durationMs: number; status: "success" | "failure" }>;
  failure?: {
    class: string;
    message: string;
  };
}

export function createRunRecord(input: {
  repo?: string;
  event: string;
  actor: string;
  mode: ReviewbotMode;
  agent: AgentId;
  model: string;
}): RunRecord {
  return {
    runId: crypto.randomUUID(),
    ...input,
    startedAt: new Date().toISOString(),
    status: "running",
    timings: {},
    toolCalls: []
  };
}

export function completeRunRecord(record: RunRecord, status: "success" | "failure"): RunRecord {
  return {
    ...record,
    status,
    completedAt: new Date().toISOString()
  };
}
