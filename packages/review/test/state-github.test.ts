import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import type { ReviewFindingThread } from "../../github/src/reviews.ts";
import { GitHubReviewStateStore } from "../src/state-github.ts";
import type { PersistedFindingState, PersistedReviewState } from "../src/state.ts";

const CHANGE_ID = "pull-request:v1:abc";

interface RecordedRequest {
  route: string;
  params?: Record<string, unknown>;
  body?: unknown;
}

function client(comments: unknown[] = []): {
  client: GitHubClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    client: {
      async request(route: string, options?: { params?: Record<string, unknown>; body?: unknown }) {
        requests.push({
          route,
          ...(options?.params === undefined ? {} : { params: options.params }),
          ...(options?.body === undefined ? {} : { body: options.body })
        });
        if (route.startsWith("GET ")) return { status: 200, data: comments as never, headers: {} };
        return { status: 200, data: {} as never, headers: {} };
      }
    }
  };
}

function finding(overrides: Partial<PersistedFindingState> = {}): PersistedFindingState {
  return {
    fingerprint: "f".repeat(64),
    reviewer: "security",
    title: "Unvalidated input",
    path: "src/index.ts",
    line: 12,
    severity: "high",
    evidence: "user input flows into the query",
    status: "unresolved",
    userReplies: [],
    ...overrides
  };
}

function state(overrides: Partial<PersistedReviewState> = {}): PersistedReviewState {
  return {
    version: 1,
    changeId: CHANGE_ID,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    updatedAt: "2026-08-04T00:00:00.000Z",
    degraded: false,
    findings: [finding()],
    ...overrides
  };
}

function store(
  input: {
    comments?: unknown[];
    threads?: ReviewFindingThread[];
    threadsFail?: boolean;
    limits?: ConstructorParameters<typeof GitHubReviewStateStore>[0]["limits"];
  } = {}
) {
  const transport = client(
    (input.comments ?? []).map((comment) =>
      typeof comment === "object" && comment !== null && !("user" in comment)
        ? { ...comment, user: { login: "shuvbot[bot]" } }
        : comment
    )
  );
  const subject = new GitHubReviewStateStore({
    client: transport.client,
    repo: { owner: "octo", name: "shuvbot" },
    pullNumber: 7,
    redactor: new DefaultRedactor(),
    botLogin: "shuvbot[bot]",
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    readThreads: async () => {
      if (input.threadsFail) throw new Error("thread ingestion failed");
      return input.threads ?? [];
    }
  });
  return { subject, requests: transport.requests };
}

function thread(overrides: Partial<ReviewFindingThread> = {}): ReviewFindingThread {
  return {
    fingerprint: "f".repeat(64),
    markerKey: "finding",
    commentId: 555,
    path: "src/index.ts",
    line: 12,
    resolution: "unresolved",
    replies: [],
    ...overrides
  };
}

/** Renders a stored state comment the way the store itself would. */
async function storedComment(value: PersistedReviewState): Promise<string> {
  const transport = client([]);
  const subject = new GitHubReviewStateStore({
    client: transport.client,
    repo: { owner: "octo", name: "shuvbot" },
    pullNumber: 7,
    redactor: new DefaultRedactor(),
    botLogin: "shuvbot[bot]"
  });
  await subject.writeReviewState(value.changeId, value);
  const body = (transport.requests.at(-1)?.body as { body: string }).body;
  return body;
}

describe("GitHub review state store", () => {
  test("returns null when the pull request has no state comment", async () => {
    const { subject } = store({ comments: [{ id: 1, body: "a normal review comment" }] });
    expect(await subject.readReviewState(CHANGE_ID)).toBeNull();
  });

  test("round-trips state through a hidden marker comment", async () => {
    const body = await storedComment(state());
    const { subject } = store({ comments: [{ id: 9, body }] });

    const read = await subject.readReviewState(CHANGE_ID);
    expect(read).toMatchObject({ changeId: CHANGE_ID, degraded: false });
    expect(read?.findings[0]).toMatchObject({ title: "Unvalidated input", severity: "high" });
  });

  test("updates the existing comment instead of posting a second one", async () => {
    const body = await storedComment(state());
    const { subject, requests } = store({ comments: [{ id: 9, body }] });

    await subject.writeReviewState(CHANGE_ID, state({ degraded: true }));

    const writes = requests.filter((request) => !request.route.startsWith("GET "));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.route).toContain("PATCH");
    expect(writes[0]?.params?.comment_id).toBe(9);
  });

  test("finds a state comment after the first page", async () => {
    const body = await storedComment(state());
    const requests: RecordedRequest[] = [];
    const subject = new GitHubReviewStateStore({
      client: {
        async request(route, options) {
          requests.push({
            route,
            ...(options?.params === undefined ? {} : { params: options.params }),
            ...(options?.body === undefined ? {} : { body: options.body })
          });
          const page = Number(options?.params?.page);
          return {
            status: 200,
            data: (page === 1
              ? Array.from({ length: 100 }, (_, id) => ({
                  id,
                  body: "ordinary",
                  user: { login: "someone" }
                }))
              : [{ id: 101, body, user: { login: "shuvbot[bot]" } }]) as never
          };
        }
      },
      repo: { owner: "octo", name: "shuvbot" },
      pullNumber: 7,
      redactor: new DefaultRedactor(),
      botLogin: "shuvbot[bot]",
      readThreads: async () => []
    });

    expect(await subject.readReviewState(CHANGE_ID)).toMatchObject({ changeId: CHANGE_ID });
    expect(requests.map((request) => request.params?.page)).toEqual([1, 2]);
  });

  test("ignores a state marker owned by another user", async () => {
    const body = await storedComment(state());
    const { subject, requests } = store({
      comments: [{ id: 9, body, user: { login: "contributor" } }]
    });

    expect(await subject.readReviewState(CHANGE_ID)).toBeNull();
    await subject.writeReviewState(CHANGE_ID, state());

    expect(requests.some((request) => request.route.startsWith("PATCH "))).toBe(false);
    expect(requests.some((request) => request.route.startsWith("POST "))).toBe(true);
  });

  test("a resolved thread marks the finding user_resolved so it is not reposted", async () => {
    const body = await storedComment(state());
    const { subject } = store({
      comments: [{ id: 9, body }],
      threads: [thread({ resolution: "resolved" })]
    });

    const read = await subject.readReviewState(CHANGE_ID);
    expect(read?.findings[0]?.status).toBe("user_resolved");
    expect(read?.findings[0]?.priorCommentId).toBe("555");
  });

  test("a resolved thread cannot revive a dismissed finding", async () => {
    const body = await storedComment(state({ findings: [finding({ status: "dismissed" })] }));
    const { subject } = store({
      comments: [{ id: 9, body }],
      threads: [thread({ resolution: "resolved" })]
    });

    expect((await subject.readReviewState(CHANGE_ID))?.findings[0]?.status).toBe("dismissed");
  });

  test("an unresolved thread leaves the stored status alone", async () => {
    const body = await storedComment(state());
    const { subject } = store({ comments: [{ id: 9, body }], threads: [thread()] });

    expect((await subject.readReviewState(CHANGE_ID))?.findings[0]?.status).toBe("unresolved");
  });

  test("captures replies, bounded and redacted", async () => {
    const body = await storedComment(state());
    const { subject } = store({
      comments: [{ id: 9, body }],
      threads: [
        thread({
          replies: Array.from({ length: 25 }, (_unused, index) => ({
            id: index,
            body:
              index === 24
                ? `token is CLAUDE_CODE_OAUTH_TOKEN=super-secret ${"x".repeat(4_000)}`
                : `reply ${index}`,
            authorLogin: "maintainer",
            createdAt: null,
            untrusted: true as const
          }))
        })
      ]
    });

    const replies = (await subject.readReviewState(CHANGE_ID))?.findings[0]?.userReplies ?? [];
    expect(replies).toHaveLength(10);
    expect(replies.join("\n")).not.toContain("super-secret");
    for (const reply of replies) expect(reply.length).toBeLessThanOrEqual(500);
  });

  test("failed thread ingestion degrades to stored state rather than losing it", async () => {
    const body = await storedComment(state());
    const { subject } = store({ comments: [{ id: 9, body }], threadsFail: true });

    const read = await subject.readReviewState(CHANGE_ID);
    expect(read?.findings).toHaveLength(1);
    expect(read?.findings[0]?.status).toBe("unresolved");
  });

  test("a damaged state comment reads as absent instead of failing the review", async () => {
    const damaged = (await storedComment(state())).replace(/\{[\s\S]*\}/, "{not json");
    const { subject } = store({ comments: [{ id: 9, body: damaged }] });

    expect(await subject.readReviewState(CHANGE_ID)).toBeNull();
  });

  test("state belonging to another change is not adopted", async () => {
    const body = await storedComment(state());
    const { subject } = store({ comments: [{ id: 9, body }] });

    expect(await subject.readReviewState("pull-request:v1:other")).toBeNull();
  });

  test("keeps the body within a comment, dropping the least severe findings first", async () => {
    const many = Array.from({ length: 400 }, (_unused, index) =>
      finding({
        fingerprint: index.toString(16).padStart(64, "0"),
        severity: index === 0 ? "critical" : "info",
        evidence: "e".repeat(5_000)
      })
    );
    const { subject, requests } = store();

    await subject.writeReviewState(CHANGE_ID, state({ findings: many }));

    const body = (requests.at(-1)?.body as { body: string }).body;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
    const written = JSON.parse(
      body.match(/```shuvbot-review-state\s*\n([\s\S]*?)\n```/)![1]!
    ) as PersistedReviewState;
    expect(written.findings.length).toBeLessThan(400);
    expect(written.findings[0]?.severity).toBe("critical");
    expect(written.findings[0]?.evidence.length).toBeLessThanOrEqual(1_000);
  });

  test("the visible body explains itself and hides the payload", async () => {
    const body = await storedComment(state());

    expect(body).toContain("shuvbot review state");
    expect(body).toContain("deleting it makes the next review start fresh");
    expect(body).toContain("<details>");
    expect(body).toContain("<!-- shuvbot:review-state:v1:");
  });
});
