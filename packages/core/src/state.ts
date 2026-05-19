import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import type { Redactor } from "./redaction.ts";
import type { RunRecord } from "./run-record.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import { appendMarker, findExistingMarker } from "../../github/src/comments.ts";

export interface StateStore {
  readPrSummary(pullNumber: number): Promise<string | null>;
  writePrSummary(pullNumber: number, summary: string): Promise<void>;
  readRepoLearnings(namespace: string): Promise<string | null>;
  writeRepoLearnings(namespace: string, learnings: string): Promise<void>;
  putRun(record: RunRecord): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private readonly prSummaries = new Map<number, string>();
  private readonly repoLearnings = new Map<string, string>();
  private readonly runs = new Map<string, RunRecord>();

  async readPrSummary(pullNumber: number): Promise<string | null> {
    return this.prSummaries.get(pullNumber) ?? null;
  }

  async writePrSummary(pullNumber: number, summary: string): Promise<void> {
    this.prSummaries.set(pullNumber, summary);
  }

  async readRepoLearnings(namespace: string): Promise<string | null> {
    return this.repoLearnings.get(namespace) ?? null;
  }

  async writeRepoLearnings(namespace: string, learnings: string): Promise<void> {
    this.repoLearnings.set(namespace, learnings);
  }

  async putRun(record: RunRecord): Promise<void> {
    this.runs.set(record.runId, record);
  }
}

export class FileStateStore implements StateStore {
  private readonly root: string;

  constructor(cwd: string, private readonly redactor: Redactor) {
    this.root = resolve(cwd, ".reviewbot", "state");
  }

  async readPrSummary(pullNumber: number): Promise<string | null> {
    return this.read(`pr-summary-${pullNumber}.txt`);
  }

  async writePrSummary(pullNumber: number, summary: string): Promise<void> {
    await this.write(`pr-summary-${pullNumber}.txt`, summary);
  }

  async readRepoLearnings(namespace: string): Promise<string | null> {
    return this.read(`learnings-${safeName(namespace)}.txt`);
  }

  async writeRepoLearnings(namespace: string, learnings: string): Promise<void> {
    await this.write(`learnings-${safeName(namespace)}.txt`, learnings);
  }

  async putRun(record: RunRecord): Promise<void> {
    await this.write(`runs/${safeName(record.runId)}.json`, JSON.stringify(record, null, 2));
  }

  private async read(name: string): Promise<string | null> {
    try {
      return await readFile(this.path(name), "utf8");
    } catch {
      return null;
    }
  }

  private async write(name: string, value: string): Promise<void> {
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.redactor.redactString(value));
  }

  private path(name: string): string {
    const path = resolve(this.root, name);
    if (relative(this.root, path).startsWith("..")) throw new Error("state path escaped .reviewbot/state");
    return path;
  }
}

export class GitHubStateStore implements StateStore {
  constructor(
    private readonly input: {
      client: GitHubClient;
      repo: { owner: string; name: string };
      redactor: Redactor;
    }
  ) {}

  async readPrSummary(pullNumber: number): Promise<string | null> {
    const comments = await this.issueComments(pullNumber);
    const existing = findExistingMarker(comments, markerKey("pr-summary", String(pullNumber)));
    return existing?.body?.replace(/<!-- reviewbot:[\s\S]*?-->/, "").trim() ?? null;
  }

  async writePrSummary(pullNumber: number, summary: string): Promise<void> {
    const key = markerKey("pr-summary", String(pullNumber));
    const body = appendMarker(this.input.redactor.redactString(summary), key);
    const comments = await this.issueComments(pullNumber);
    const existing = findExistingMarker(comments, key);
    if (existing?.id) {
      await this.input.client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        params: { owner: this.input.repo.owner, repo: this.input.repo.name, comment_id: existing.id },
        body: { body }
      });
    } else {
      await this.input.client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        params: { owner: this.input.repo.owner, repo: this.input.repo.name, issue_number: pullNumber },
        body: { body }
      });
    }
  }

  async readRepoLearnings(_namespace: string): Promise<string | null> {
    return null;
  }

  async writeRepoLearnings(_namespace: string, _learnings: string): Promise<void> {}
  async putRun(_record: RunRecord): Promise<void> {}

  private async issueComments(issueNumber: number): Promise<Array<{ id?: number; body?: string | null }>> {
    const response = await this.input.client.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      params: { owner: this.input.repo.owner, repo: this.input.repo.name, issue_number: issueNumber, per_page: 100 }
    });
    return Array.isArray(response.data)
      ? response.data.map((comment) => {
          const record = asRecord(comment);
          return {
            ...(typeof record.id === "number" ? { id: record.id } : {}),
            body: typeof record.body === "string" ? record.body : null
          };
        })
      : [];
  }
}

export class ApiStateStore implements StateStore {
  async readPrSummary(): Promise<string | null> { return null; }
  async writePrSummary(): Promise<void> {}
  async readRepoLearnings(): Promise<string | null> { return null; }
  async writeRepoLearnings(): Promise<void> {}
  async putRun(): Promise<void> {}
}

export interface StateConfig {
  enabled: boolean;
  learnings: boolean;
  store?: StateStore;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function markerKey(kind: string, id: string): string {
  return `${kind}:v1:${id}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
