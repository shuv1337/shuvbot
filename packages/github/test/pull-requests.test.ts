import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "../../core/src/events.ts";
import { resolveReviewTarget } from "../src/pull-requests.ts";
import type { GitHubClient } from "../src/octokit.ts";

const REPO = {
  owner: { login: "octo" },
  name: "repo",
  full_name: "octo/repo",
  private: false
};

function pullRequest(headRepo: string) {
  return {
    number: 7,
    title: "t",
    body: "",
    state: "open",
    draft: false,
    user: { login: "alice" },
    head: { ref: "topic", sha: "aaa", repo: { full_name: headRepo } },
    base: { ref: "main", sha: "bbb", repo: { full_name: "octo/repo" } }
  };
}

function issueComment(opts: { onPullRequest: boolean }) {
  return normalizeEvent({
    eventName: "issue_comment",
    payload: {
      action: "created",
      repository: REPO,
      sender: { login: "alice" },
      issue: {
        number: 7,
        title: "t",
        body: "",
        state: "open",
        user: { login: "alice" },
        ...(opts.onPullRequest
          ? { pull_request: { url: "https://api.github.com/repos/octo/repo/pulls/7" } }
          : {})
      },
      comment: { id: 1, body: "@shuvbot review", user: { login: "alice" } }
    }
  });
}

function clientReturning(body: unknown): GitHubClient {
  return {
    async request() {
      return { data: body, status: 200, headers: {} };
    }
  } as unknown as GitHubClient;
}

describe("resolveReviewTarget", () => {
  test("reads a pull_request event straight from its payload", async () => {
    const event = normalizeEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: REPO,
        sender: { login: "alice" },
        pull_request: pullRequest("octo/repo")
      }
    });

    const target = await resolveReviewTarget({ event });
    expect(target).toMatchObject({ pullNumber: 7, isFork: false, trigger: "event" });
    expect(target!.event.kind).toBe("pull_request");
  });

  test("presents a review comment as its pull request", async () => {
    const event = normalizeEvent({
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        repository: REPO,
        sender: { login: "alice" },
        pull_request: pullRequest("mallory/repo"),
        comment: { id: 1, body: "@shuvbot review", user: { login: "alice" } }
      }
    });

    const target = await resolveReviewTarget({ event });
    // Review skills trigger on pull_request actions, so the synthesized event
    // must look like one for the pipeline to run at all.
    expect(target!.event.kind).toBe("pull_request");
    expect(target!.event.action).toBe("synchronize");
    expect(target).toMatchObject({ pullNumber: 7, isFork: true, trigger: "comment" });
  });

  test("fetches the pull request behind an issue comment", async () => {
    const target = await resolveReviewTarget({
      event: issueComment({ onPullRequest: true }),
      client: clientReturning(pullRequest("octo/repo"))
    });
    expect(target).toMatchObject({ pullNumber: 7, isFork: false, trigger: "comment" });
  });

  test("detects a fork head that the comment payload could not have known", async () => {
    const target = await resolveReviewTarget({
      event: issueComment({ onPullRequest: true }),
      client: clientReturning(pullRequest("mallory/repo"))
    });
    expect(target!.isFork).toBe(true);
  });

  test("treats an unreadable head repository as a fork", async () => {
    const pr = pullRequest("octo/repo");
    const target = await resolveReviewTarget({
      event: issueComment({ onPullRequest: true }),
      client: clientReturning({ ...pr, head: { ...pr.head, repo: null } })
    });
    expect(target!.isFork).toBe(true);
  });

  test("ignores a comment on an ordinary issue", async () => {
    const target = await resolveReviewTarget({
      event: issueComment({ onPullRequest: false }),
      client: clientReturning(pullRequest("octo/repo"))
    });
    expect(target).toBeNull();
  });
});
