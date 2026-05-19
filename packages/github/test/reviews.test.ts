import { describe, expect, test } from "bun:test";
import { appendMarker } from "../src/comments.ts";
import { dedupePreviousFindings, fallbackToSummary, postReview } from "../src/reviews.ts";
import type { GitHubClient, GitHubRequestOptions, GitHubResponse } from "../src/octokit.ts";
import type { PipelineFinding } from "../../core/src/review-pipeline.ts";

describe("review posting", () => {
  test("dedupes existing marker comments before posting review", async () => {
    const client = new MockClient({
      "GET /repos/octo/reviewbot/pulls/1/comments": [
        { id: 1, body: appendMarker("old", "finding:one") }
      ],
      "POST /repos/octo/reviewbot/pulls/1/reviews": {
        id: 2,
        html_url: "https://github.test/review/2"
      }
    });

    const result = await postReview({
      client,
      repo: { owner: "octo", name: "reviewbot" },
      pullNumber: 1,
      body: "summary",
      event: "COMMENT",
      comments: [
        { path: "a.ts", position: 1, body: "old", markerKey: "finding:one" },
        { path: "a.ts", position: 2, body: "new", markerKey: "finding:two" }
      ]
    });

    expect(result).toMatchObject({ id: 2, postedComments: 1, dedupedComments: 1 });
    expect(client.calls[1]?.body).toMatchObject({
      comments: [expect.objectContaining({ position: 2 })]
    });
  });

  test("formats summary fallback and filters existing findings", () => {
    const finding = {
      id: "one",
      skill: "code-review",
      title: "Bug",
      body: "Fix it",
      severity: "high",
      confidence: "high",
      path: "src/a.ts",
      line: 10,
      markerKey: "finding:one"
    } satisfies PipelineFinding;

    expect(fallbackToSummary(finding)).toContain("src/a.ts:10");
    expect(dedupePreviousFindings([{ body: appendMarker("old", "finding:one") }], [finding])).toHaveLength(0);
  });
});

class MockClient implements GitHubClient {
  readonly calls: Array<{ key: string; body: unknown }> = [];
  constructor(private readonly routes: Record<string, unknown>) {}
  async request<T = unknown>(route: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
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
