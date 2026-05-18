import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "../../core/src/events.ts";
import { deriveActorContext, detectFork, fetchActorPermission } from "../src/permissions.ts";
import type { GitHubClient } from "../src/octokit.ts";

function makePullRequest(opts: { fork: boolean }) {
  return normalizeEvent({
    eventName: "pull_request",
    payload: {
      action: "opened",
      repository: {
        owner: { login: "acme" },
        name: "widget",
        full_name: "acme/widget",
        private: true
      },
      sender: { login: "alice" },
      pull_request: {
        number: 1,
        title: "t",
        body: "",
        state: "open",
        draft: false,
        user: { login: "alice" },
        head: {
          ref: "topic",
          sha: "1",
          repo: { full_name: opts.fork ? "alice/widget" : "acme/widget" }
        },
        base: { ref: "main", sha: "0", repo: { full_name: "acme/widget" } }
      }
    }
  });
}

describe("permissions", () => {
  test("detectFork picks up cross-repo PR heads", () => {
    expect(detectFork(makePullRequest({ fork: true }))).toBe(true);
    expect(detectFork(makePullRequest({ fork: false }))).toBe(false);
  });

  test("deriveActorContext returns explicit override without calling client", async () => {
    const event = makePullRequest({ fork: false });
    const ctx = await deriveActorContext({ event, actorPermission: "maintain" });
    expect(ctx.actorPermission).toBe("maintain");
    expect(ctx.isFork).toBe(false);
    expect(ctx.isPrivateRepo).toBe(true);
  });

  test("fetchActorPermission maps role_name when available", async () => {
    const client: GitHubClient = {
      async request<T = unknown>(route: string, options?: { params?: Record<string, unknown> }) {
        expect(route).toContain("/repos/{owner}/{repo}/collaborators/{username}/permission");
        expect(options?.params?.username).toBe("alice");
        return {
          status: 200,
          data: { permission: "write", role_name: "maintain" } as unknown as T
        };
      }
    };
    const permission = await fetchActorPermission({
      client,
      owner: "acme",
      repo: "widget",
      username: "alice"
    });
    expect(permission).toBe("maintain");
  });

  test("fetchActorPermission falls back to none on client error", async () => {
    const client: GitHubClient = {
      async request() {
        throw new Error("boom");
      }
    };
    const permission = await fetchActorPermission({
      client,
      owner: "acme",
      repo: "widget",
      username: "alice"
    });
    expect(permission).toBe("none");
  });

  test("deriveActorContext falls back to none when no client", async () => {
    const ctx = await deriveActorContext({ event: makePullRequest({ fork: true }) });
    expect(ctx.actorPermission).toBe("none");
    expect(ctx.isFork).toBe(true);
  });
});
