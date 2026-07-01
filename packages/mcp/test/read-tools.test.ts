import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import type { GitHubClient, GitHubRequestOptions, GitHubResponse } from "../../github/src/octokit.ts";
import { startReviewbotMcpServer, type ReviewbotMcpServer } from "../src/server.ts";
import { executeTool, type ToolContext } from "../src/tool-spec.ts";
import { AuditLog } from "../src/audit.ts";
import { getCheckLogsTool, getCheckRunsTool } from "../src/tools/checks.ts";
import { readFileTool, searchRepoTool } from "../src/tools/files.ts";
import { getIssueCommentsTool, getIssueTool, getReviewCommentsTool } from "../src/tools/issue.ts";
import { getPrDiffTool, getPrFilesTool, getPrTool } from "../src/tools/pr.ts";

let server: ReviewbotMcpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("read-context MCP tools", () => {
  test("read PR metadata and diff through the MCP server with a mocked GitHub client", async () => {
    const audit = new AuditLog(new DefaultRedactor());
    const client = new MockGitHubClient({
      "GET /repos/octo/reviewbot/pulls/42": {
        number: 42,
        title: "Improve MCP tools",
        body: "please review",
        state: "open",
        draft: false,
        html_url: "https://github.test/pull/42",
        mergeable: true,
        mergeable_state: "clean",
        labels: [{ name: "enhancement", color: "a2eeef" }],
        head: { ref: "feature", sha: "abc123", repo: { full_name: "octo/reviewbot" } },
        base: { ref: "main", sha: "def456", repo: { full_name: "octo/reviewbot" } }
      }
    });
    client.textRoutes.set("GET /repos/octo/reviewbot/pulls/42", "diff --git a/a.ts b/a.ts\n+ok\n");
    server = await startReviewbotMcpServer({
      tools: [getPrTool, getPrDiffTool],
      context: context({ client, audit })
    });

    const mcpClient = new Client({ name: "fake-agent", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(server.url);
    await mcpClient.connect(transport as Transport);

    const pr = await mcpClient.callTool({ name: "get_pr", arguments: { number: 42 } });
    expect(pr.structuredContent).toMatchObject({
      number: 42,
      title: "Improve MCP tools",
      mergeable: true,
      mergeStateStatus: "clean"
    });

    const diff = await mcpClient.callTool({ name: "get_pr_diff", arguments: { number: 42, maxBytes: 12 } });
    expect(diff.structuredContent).toMatchObject({
      number: 42,
      truncated: true,
      untrusted: true
    });
    expect(String((diff.structuredContent as Record<string, unknown>).diff)).toContain("[reviewbot:truncated");
    expect(audit.snapshot().summary).toMatchObject({ total: 2, succeeded: 2, failed: 0 });

    await mcpClient.close();
  });

  test("reads PR files, issues, comments, checks, logs, and search results", async () => {
    const client = new MockGitHubClient({
      "GET /repos/octo/reviewbot/pulls/5/files": [
        { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ patch" }
      ],
      "GET /repos/octo/reviewbot/issues/7": {
        number: 7,
        title: "Bug",
        body: "bad",
        state: "open",
        html_url: "https://github.test/issues/7",
        user: { login: "alice" },
        labels: [{ name: "bug" }]
      },
      "GET /repos/octo/reviewbot/issues/7/comments": [
        { id: 1, body: "comment", user: { login: "bob" }, created_at: "now", updated_at: "now", html_url: "url" }
      ],
      "GET /repos/octo/reviewbot/pulls/5/comments": [
        {
          id: 2,
          body: "review",
          path: "src/a.ts",
          position: 3,
          line: 10,
          side: "RIGHT",
          user: { login: "carol" },
          created_at: "now",
          updated_at: "now",
          html_url: "url"
        }
      ],
      "GET /repos/octo/reviewbot/commits/main/check-runs": {
        total_count: 1,
        check_runs: [{ id: 9, name: "test", status: "completed", conclusion: "failure", html_url: "url" }]
      },
      "GET /search/code": {
        total_count: 1,
        incomplete_results: false,
        items: [{ name: "a.ts", path: "src/a.ts", sha: "abc", html_url: "url", repository: { full_name: "octo/reviewbot" } }]
      }
    });
    client.textRoutes.set("GET /repos/octo/reviewbot/actions/jobs/9/logs", "secret log line");

    const toolContext = context({ client });
    await expect(executeTool(getPrFilesTool, { number: 5 }, toolContext)).resolves.toMatchObject({
      files: [{ filename: "src/a.ts", additions: 2 }]
    });
    await expect(executeTool(getIssueTool, { number: 7 }, toolContext)).resolves.toMatchObject({
      number: 7,
      user: "alice",
      untrusted: true
    });
    await expect(executeTool(getIssueCommentsTool, { number: 7 }, toolContext)).resolves.toMatchObject({
      comments: [{ id: 1, user: "bob", untrusted: true }]
    });
    await expect(executeTool(getReviewCommentsTool, { number: 5 }, toolContext)).resolves.toMatchObject({
      comments: [{ id: 2, path: "src/a.ts", position: 3, untrusted: true }]
    });
    await expect(executeTool(getCheckRunsTool, { ref: "main" }, toolContext)).resolves.toMatchObject({
      totalCount: 1,
      checkRuns: [{ id: 9, conclusion: "failure" }]
    });
    await expect(executeTool(getCheckLogsTool, { runId: 9, maxBytes: 5 }, toolContext)).resolves.toMatchObject({
      runId: 9,
      truncated: true,
      untrusted: true
    });
    await expect(executeTool(searchRepoTool, { query: "TODO", limit: 1 }, toolContext)).resolves.toMatchObject({
      totalCount: 1,
      items: [{ path: "src/a.ts" }]
    });
  });

  test("read_file bounds workspace access", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-mcp-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.txt"), "hello world");
    const toolContext = context({ cwd });

    await expect(executeTool(readFileTool, { path: "src/a.txt", maxBytes: 5 }, toolContext)).resolves.toMatchObject({
      path: "src/a.txt",
      content: "hello\n[reviewbot:truncated maxBytes=5]",
      truncated: true
    });
    await expect(executeTool(readFileTool, { path: "../outside.txt" }, toolContext)).rejects.toThrow(
      "escapes the workspace"
    );
    await expect(executeTool(readFileTool, { path: "/tmp/outside.txt" }, toolContext)).rejects.toThrow(
      "must be relative"
    );
  });

  test("read_file refuses credential-bearing workspace paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-mcp-"));
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, ".git", "config"), "token");
    await writeFile(join(cwd, ".env"), "SECRET=value");
    await writeFile(join(cwd, "src", "a.txt"), "hello world");
    const toolContext = context({ cwd });

    await expect(executeTool(readFileTool, { path: ".git/config" }, toolContext)).rejects.toThrow(
      "credential-bearing path"
    );
    await expect(executeTool(readFileTool, { path: ".env" }, toolContext)).rejects.toThrow(
      "credential-bearing path"
    );
    await expect(executeTool(readFileTool, { path: "src/a.txt" }, toolContext)).resolves.toMatchObject({
      path: "src/a.txt",
      content: "hello world",
      truncated: false
    });
  });

  test("read_file rejects symlink escapes and credential targets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-mcp-"));
    const outside = await mkdtemp(join(tmpdir(), "reviewbot-mcp-outside-"));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "token");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(cwd, "outside-link.txt"));
    await symlink(join(cwd, ".git", "config"), join(cwd, "git-config-link.txt"));
    const toolContext = context({ cwd });

    await expect(executeTool(readFileTool, { path: "outside-link.txt" }, toolContext)).rejects.toThrow(
      "escapes the workspace"
    );
    await expect(executeTool(readFileTool, { path: "git-config-link.txt" }, toolContext)).rejects.toThrow(
      "credential-bearing path"
    );
  });

  test("check log access is policy gated", async () => {
    const deniedContext = context({
      client: new MockGitHubClient({}),
      policy: {
        ...defaultRuntimePolicy({
        actor: "reader",
        actorPermission: "read",
        event: "pull_request",
        isFork: true,
        isPrivateRepo: false
        }),
        canReadChecks: false
      }
    });
    await expect(executeTool(getCheckLogsTool, { runId: 9 }, deniedContext)).rejects.toThrow("denied by runtime policy");
  });
});

function context(input: {
  client?: GitHubClient;
  cwd?: string;
  audit?: AuditLog;
  policy?: ReturnType<typeof defaultRuntimePolicy>;
}): ToolContext {
  const redactor = new DefaultRedactor();
  const toolContext: ToolContext = {
    repo: { owner: "octo", name: "reviewbot" },
    runId: "run-1",
    actor: "maintainer",
    mode: "review",
    policy:
      input.policy ??
      defaultRuntimePolicy({
        actor: "maintainer",
        actorPermission: "write",
        event: "issue_comment",
        isFork: false,
        isPrivateRepo: false
      }),
    redactor,
    audit: input.audit ?? new AuditLog(redactor)
  };
  if (input.client !== undefined) toolContext.client = input.client;
  if (input.cwd !== undefined) toolContext.cwd = input.cwd;
  return toolContext;
}

class MockGitHubClient implements GitHubClient {
  readonly textRoutes = new Map<string, string>();

  constructor(private readonly routes: Record<string, unknown>) {}

  async request<T = unknown>(route: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const key = resolveRoute(route, options);
    if (options.responseType === "text") {
      if (!this.textRoutes.has(key)) throw new Error(`Missing text route: ${key}`);
      return { status: 200, data: this.textRoutes.get(key) as T };
    }
    if (!(key in this.routes)) throw new Error(`Missing route: ${key}`);
    return { status: 200, data: this.routes[key] as T };
  }
}

function resolveRoute(route: string, options: GitHubRequestOptions): string {
  const match = route.match(/^([A-Z]+)\s+(.*)$/);
  const method = match?.[1] ?? options.method ?? "GET";
  let path = match?.[2] ?? route;
  for (const [key, value] of Object.entries(options.params ?? {})) {
    path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  return `${method} ${path}`;
}
