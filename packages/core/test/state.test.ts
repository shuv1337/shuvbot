import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../src/redaction.ts";
import { FileStateStore, GitHubStateStore, MemoryStateStore } from "../src/state.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";

describe("state stores", () => {
  test("memory store reads and writes summaries and learnings", async () => {
    const store = new MemoryStateStore();
    await store.writePrSummary(1, "summary");
    await store.writeRepoLearnings("default", "learning");
    await store.putRun(runRecord("run-1"));
    expect(await store.readPrSummary(1)).toBe("summary");
    expect(await store.readRepoLearnings("default")).toBe("learning");
  });

  test("file store writes under .reviewbot/state and redacts secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-state-"));
    const store = new FileStateStore(cwd, new DefaultRedactor());
    await store.writePrSummary(2, "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz");
    await store.putRun(runRecord("run-secret", "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz"));
    const stored = await readFile(join(cwd, ".reviewbot", "state", "pr-summary-2.txt"), "utf8");
    const run = await readFile(join(cwd, ".reviewbot", "state", "runs", "run-secret.json"), "utf8");
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(run).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  test("github store creates and updates hidden PR summary comments idempotently", async () => {
    const requests: string[] = [];
    let comments: Array<{ id: number; body: string }> = [];
    const client = {
      async request(route: string, options: { body?: { body?: string } }) {
        requests.push(route);
        if (route.startsWith("GET ")) return { status: 200, headers: {}, data: comments };
        if (route.startsWith("POST ")) {
          comments = [{ id: 1, body: options.body?.body ?? "" }];
          return { status: 201, headers: {}, data: comments[0] };
        }
        comments = [{ id: 1, body: options.body?.body ?? "" }];
        return { status: 200, headers: {}, data: comments[0] };
      }
    } as GitHubClient;
    const store = new GitHubStateStore({
      client,
      repo: { owner: "octo", name: "repo" },
      redactor: new DefaultRedactor()
    });
    await store.writePrSummary(1, "first");
    await store.writePrSummary(1, "second");
    expect(await store.readPrSummary(1)).toBe("second");
    expect(requests).toEqual([
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
    ]);
  });
});

function runRecord(runId: string, repo = "octo/repo") {
  return {
    runId,
    repo,
    event: "workflow_dispatch",
    actor: "alice",
    trigger: "test",
    mode: "review" as const,
    agent: "claude-code" as const,
    model: "claude/sonnet",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running" as const,
    timings: {},
    toolCalls: [],
    filesConsidered: [],
    filesIgnored: [],
    errors: []
  };
}
