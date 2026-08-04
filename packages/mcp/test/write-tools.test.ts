import { describe, expect, test } from "bun:test";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type {
  GitHubClient,
  GitHubRequestOptions,
  GitHubResponse
} from "../../github/src/octokit.ts";
import { appendMarker, findExistingMarker, formatMarker } from "../../github/src/comments.ts";
import { AuditLog } from "../src/audit.ts";
import { executeTool, type ToolContext } from "../src/tool-spec.ts";
import { addLabelsTool } from "../src/tools/labels.ts";
import {
  createIssueCommentTool,
  editIssueCommentTool,
  replyToReviewCommentTool,
  updatePullRequestBodyTool
} from "../src/tools/comment.ts";
import { setOutputTool } from "../src/tools/output.ts";
import { createPullRequestReviewTool } from "../src/tools/review.ts";

describe("write GitHub MCP tools", () => {
  test("formats and finds hidden markers", () => {
    const marker = formatMarker("finding-1", { path: "src/a.ts" });
    expect(marker).toStartWith("<!-- shuvbot:finding-1:");
    expect(appendMarker("body", "finding-1", { path: "src/a.ts" })).toContain(marker);
    expect(findExistingMarker([{ id: 1, body: `hello\n${marker}` }], "finding-1")).toEqual({
      id: 1,
      body: `hello\n${marker}`
    });
  });

  test("dedupes issue comments by editing the existing marker comment", async () => {
    const client = new RecordingGitHubClient({
      "GET /repos/octo/shuvbot/issues/3/comments": [
        { id: 10, body: appendMarker("old", "comment-key", { id: 1 }) }
      ],
      "PATCH /repos/octo/shuvbot/issues/comments/10": {
        id: 10,
        body: "updated",
        html_url: "url"
      }
    });

    await expect(
      executeTool(
        createIssueCommentTool,
        { issueNumber: 3, body: "updated", markerKey: "comment-key", markerPayload: { id: 1 } },
        context({ client })
      )
    ).resolves.toMatchObject({ id: 10, deduped: true });
    expect(client.calls.map((call) => call.key)).toEqual([
      "GET /repos/octo/shuvbot/issues/3/comments",
      "PATCH /repos/octo/shuvbot/issues/comments/10"
    ]);
  });

  test("creates and edits comments, replies, labels, PR body, and outputs", async () => {
    const client = new RecordingGitHubClient({
      "GET /repos/octo/shuvbot/issues/3/comments": [],
      "POST /repos/octo/shuvbot/issues/3/comments": { id: 11, body: "new", html_url: "url" },
      "PATCH /repos/octo/shuvbot/issues/comments/11": { id: 11, body: "edited", html_url: "url" },
      "POST /repos/octo/shuvbot/pulls/comments/15/replies": {
        id: 16,
        body: "reply",
        html_url: "url"
      },
      "PATCH /repos/octo/shuvbot/pulls/3": { number: 3, body: "body", html_url: "url" },
      "POST /repos/octo/shuvbot/issues/3/labels": [{ name: "ready-for-agent" }]
    });
    const outputs = new Map<string, unknown>();
    const toolContext = context({
      client,
      outputs: {
        set(name, value) {
          outputs.set(name, value);
        }
      }
    });

    await expect(
      executeTool(
        createIssueCommentTool,
        { issueNumber: 3, body: "new", markerKey: "new-key" },
        toolContext
      )
    ).resolves.toMatchObject({ id: 11, deduped: false });
    await expect(
      executeTool(editIssueCommentTool, { commentId: 11, body: "edited" }, toolContext)
    ).resolves.toMatchObject({
      id: 11
    });
    await expect(
      executeTool(replyToReviewCommentTool, { commentId: 15, body: "reply" }, toolContext)
    ).resolves.toMatchObject({ id: 16 });
    await expect(
      executeTool(updatePullRequestBodyTool, { number: 3, body: "body" }, toolContext)
    ).resolves.toMatchObject({
      number: 3,
      body: "body"
    });
    await expect(
      executeTool(addLabelsTool, { issueNumber: 3, labels: ["ready-for-agent"] }, toolContext)
    ).resolves.toMatchObject({
      issueNumber: 3
    });
    await expect(
      executeTool(setOutputTool, { name: "result", value: { ok: true } }, toolContext)
    ).resolves.toMatchObject({
      name: "result",
      set: true
    });
    expect(outputs.get("result")).toEqual({ ok: true });
  });

  test("creates PR reviews, dedupes by review comment marker, and rejects APPROVE", async () => {
    const client = new RecordingGitHubClient({
      "GET /repos/octo/shuvbot/pulls/3/comments": [],
      "POST /repos/octo/shuvbot/pulls/3/reviews": { id: 20, state: "COMMENTED", html_url: "url" }
    });
    const toolContext = context({ client });

    await expect(
      executeTool(
        createPullRequestReviewTool,
        {
          number: 3,
          body: "summary",
          event: "COMMENT",
          comments: [{ path: "src/a.ts", position: 2, body: "inline" }],
          markerKey: "review-key"
        },
        toolContext
      )
    ).resolves.toMatchObject({ id: 20, event: "COMMENT", deduped: false });

    const dedupeClient = new RecordingGitHubClient({
      "GET /repos/octo/shuvbot/pulls/3/comments": [
        { id: 21, body: appendMarker("inline", "review-key", {}) }
      ]
    });
    await expect(
      executeTool(
        createPullRequestReviewTool,
        { number: 3, body: "summary", event: "REQUEST_CHANGES", markerKey: "review-key" },
        context({ client: dedupeClient })
      )
    ).resolves.toMatchObject({ id: 21, event: "REQUEST_CHANGES", deduped: true });

    await expect(
      executeTool(
        createPullRequestReviewTool,
        { number: 3, body: "summary", event: "APPROVE" },
        toolContext
      )
    ).rejects.toThrow("rejects APPROVE");
  });

  test("runtime policy gates write paths", async () => {
    const deniedContext = context({
      client: new RecordingGitHubClient({}),
      policy: {
        ...defaultRuntimePolicy({
          actor: "reader",
          actorPermission: "read",
          event: "pull_request",
          isFork: true,
          isPrivateRepo: false
        }),
        canComment: false
      }
    });

    await expect(
      executeTool(createIssueCommentTool, { issueNumber: 3, body: "denied" }, deniedContext)
    ).rejects.toThrow("denied by runtime policy");
  });
});

function context(input: {
  client: GitHubClient;
  policy?: ReturnType<typeof defaultRuntimePolicy>;
  outputs?: ToolContext["outputs"];
}): ToolContext {
  const redactor = new DefaultRedactor();
  const toolContext: ToolContext = {
    repo: { owner: "octo", name: "shuvbot" },
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
    client: input.client,
    redactor,
    audit: new AuditLog(redactor)
  };
  if (input.outputs !== undefined) toolContext.outputs = input.outputs;
  return toolContext;
}

class RecordingGitHubClient implements GitHubClient {
  readonly calls: Array<{ key: string; body: unknown }> = [];

  constructor(private readonly routes: Record<string, unknown>) {}

  async request<T = unknown>(
    route: string,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubResponse<T>> {
    const key = resolveRoute(route, options);
    this.calls.push({ key, body: options.body });
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
