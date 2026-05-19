import type { Redactor } from "../../core/src/redaction.ts";
import type { GitHubClient } from "./octokit.ts";

export interface FailedCheckRun {
  id: number;
  name: string;
  conclusion: string;
  htmlUrl?: string;
}

export interface FetchedCheckLog {
  runId: number;
  text: string;
  truncated: boolean;
  untrusted: true;
}

export async function findFailedCheckRuns(
  client: GitHubClient,
  repo: { owner: string; name: string },
  ref: string
): Promise<FailedCheckRun[]> {
  const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    params: { owner: repo.owner, repo: repo.name, ref, per_page: 100 }
  });
  const runs = asRecordArray(asRecord(response.data).check_runs);
  return runs
    .filter((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(stringValue(run.conclusion)))
    .map((run) => ({
      id: numberValue(run.id),
      name: stringValue(run.name),
      conclusion: stringValue(run.conclusion),
      ...(typeof run.html_url === "string" ? { htmlUrl: run.html_url } : {})
    }));
}

export async function fetchCheckLog(input: {
  client: GitHubClient;
  repo: { owner: string; name: string };
  runId: number;
  maxBytes: number;
  redactor: Redactor;
}): Promise<FetchedCheckLog> {
  const response = await input.client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs", {
    params: { owner: input.repo.owner, repo: input.repo.name, run_id: input.runId }
  });
  const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  const redacted = input.redactor.redactString(raw);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= input.maxBytes) {
    return { runId: input.runId, text: redacted, truncated: false, untrusted: true };
  }
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - input.maxBytes)).toString("utf8");
  return {
    runId: input.runId,
    text: `[truncated to last ${input.maxBytes} bytes]\n${tail}`,
    truncated: true,
    untrusted: true
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
