import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "../../core/src/events.ts";
import {
  GitHubRequestError,
  type GitHubClient,
  type GitHubRequestOptions
} from "../src/octokit.ts";
import {
  addCommentReaction,
  applyMentionLifecycle,
  signalMentionLifecycle,
  triggerCommentFromEvent
} from "../src/reactions.ts";

describe("triggerCommentFromEvent", () => {
  test("returns the issue comment a mention was typed into", () => {
    const event = normalizeEvent({
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository: repoPayload(),
        sender: { login: "alice" },
        issue: {
          number: 1,
          title: "Add feature",
          body: "",
          state: "open",
          user: { login: "alice" },
          pull_request: { url: "https://example.test" }
        },
        comment: { id: 10, body: "@shuvbot review", user: { login: "alice" } }
      }
    });
    expect(triggerCommentFromEvent(event)).toEqual({ kind: "issue_comment", commentId: 10 });
  });

  test("returns the inline review comment a mention was typed into", () => {
    const event = normalizeEvent({
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        repository: repoPayload(),
        sender: { login: "alice" },
        pull_request: {
          number: 1,
          title: "Add feature",
          body: "",
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: { ref: "topic", sha: "aaa", repo: { full_name: "octo/repo" } },
          base: { ref: "main", sha: "bbb", repo: { full_name: "octo/repo" } }
        },
        comment: { id: 11, body: "@shuvbot review", user: { login: "alice" } }
      }
    });
    expect(triggerCommentFromEvent(event)).toEqual({
      kind: "pull_request_review_comment",
      commentId: 11
    });
  });

  test("has nothing to react on for a pull_request event", () => {
    const event = normalizeEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: repoPayload(),
        sender: { login: "alice" },
        pull_request: {
          number: 1,
          title: "Add feature",
          body: "",
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: { ref: "topic", sha: "aaa", repo: { full_name: "octo/repo" } },
          base: { ref: "main", sha: "bbb", repo: { full_name: "octo/repo" } }
        }
      }
    });
    expect(triggerCommentFromEvent(event)).toBeUndefined();
  });
});

describe("mention reaction lifecycle", () => {
  test("start posts eyes on an issue comment", async () => {
    const client = new MockClient({
      "POST /repos/octo/repo/issues/comments/10/reactions": { id: 1 }
    });
    await applyMentionLifecycle({ ...baseInput(client), phase: "start" });
    expect(client.calls).toEqual([
      {
        key: "POST /repos/octo/repo/issues/comments/10/reactions",
        body: { content: "eyes" }
      }
    ]);
  });

  test("success replaces eyes with rocket", async () => {
    const client = new MockClient({
      "GET /repos/octo/repo/issues/comments/10/reactions": [
        { id: 7, content: "eyes", user: { login: "github-actions[bot]" } },
        { id: 8, content: "eyes", user: { login: "someone-else" } }
      ],
      "DELETE /repos/octo/repo/issues/comments/10/reactions/7": {},
      "POST /repos/octo/repo/issues/comments/10/reactions": { id: 9 }
    });
    await applyMentionLifecycle({ ...baseInput(client), phase: "success" });
    expect(client.calls.map((call) => call.key)).toEqual([
      "GET /repos/octo/repo/issues/comments/10/reactions",
      "DELETE /repos/octo/repo/issues/comments/10/reactions/7",
      "POST /repos/octo/repo/issues/comments/10/reactions"
    ]);
    expect(client.calls.at(-1)?.body).toEqual({ content: "rocket" });
  });

  test("failure replaces eyes with confused on an inline review comment", async () => {
    const client = new MockClient({
      "GET /repos/octo/repo/pulls/comments/11/reactions": [],
      "POST /repos/octo/repo/pulls/comments/11/reactions": { id: 2 }
    });
    await applyMentionLifecycle({
      ...baseInput(client, {
        kind: "pull_request_review_comment",
        commentId: 11
      }),
      phase: "failure"
    });
    expect(client.calls.at(-1)).toEqual({
      key: "POST /repos/octo/repo/pulls/comments/11/reactions",
      body: { content: "confused" }
    });
  });

  test("already-reacted is not a failure", async () => {
    const client: GitHubClient = {
      async request() {
        throw new GitHubRequestError("already reacted", 422, { message: "Already reacted" });
      }
    };
    await addCommentReaction(baseInput(client), "eyes");
  });

  test("signalMentionLifecycle never throws", async () => {
    const client: GitHubClient = {
      async request() {
        throw new Error("network down");
      }
    };
    await expect(signalMentionLifecycle({ ...baseInput(client), phase: "start" })).resolves.toBe(
      "skipped"
    );
  });
});

function repoPayload() {
  return {
    owner: { login: "octo" },
    name: "repo",
    full_name: "octo/repo",
    private: false
  };
}

function baseInput(
  client: GitHubClient,
  target: { kind: "issue_comment" | "pull_request_review_comment"; commentId: number } = {
    kind: "issue_comment",
    commentId: 10
  }
) {
  return {
    client,
    repo: { owner: "octo", name: "repo" },
    target,
    botLogin: "github-actions[bot]"
  };
}

class MockClient implements GitHubClient {
  readonly calls: Array<{ key: string; body: unknown }> = [];
  constructor(private readonly routes: Record<string, unknown>) {}
  async request<T = unknown>(
    route: string,
    options: GitHubRequestOptions = {}
  ): Promise<{ status: number; data: T }> {
    const key = resolveRoute(route, options);
    this.calls.push({ key, body: options.body });
    if (!(key in this.routes)) throw new Error(`Missing route ${key}`);
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
