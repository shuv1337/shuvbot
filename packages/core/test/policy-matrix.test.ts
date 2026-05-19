import { describe, expect, test } from "bun:test";
import { normalizeEvent, type BotEvent } from "../src/events.ts";
import { buildRuntimePolicy } from "../src/policy.ts";
import type { ActorPermission } from "../src/types.ts";

function makePullRequest(opts: { fork: boolean; isPrivateRepo?: boolean }): BotEvent {
  const headRepoFullName = opts.fork ? "outsider/widget" : "acme/widget";
  return normalizeEvent({
    eventName: "pull_request",
    payload: {
      action: "opened",
      repository: {
        owner: { login: "acme" },
        name: "widget",
        full_name: "acme/widget",
        private: opts.isPrivateRepo ?? false
      },
      sender: { login: "alice" },
      pull_request: {
        number: 1,
        title: "t",
        body: "",
        state: "open",
        draft: false,
        user: { login: "alice" },
        head: { ref: "topic", sha: "1", repo: { full_name: headRepoFullName } },
        base: { ref: "main", sha: "0", repo: { full_name: "acme/widget" } }
      }
    }
  });
}

function makeIssueComment(): BotEvent {
  return normalizeEvent({
    eventName: "issue_comment",
    payload: {
      action: "created",
      repository: {
        owner: { login: "acme" },
        name: "widget",
        full_name: "acme/widget",
        private: false
      },
      sender: { login: "maintainer" },
      issue: {
        number: 1,
        title: "x",
        body: "x",
        state: "open",
        user: { login: "alice" }
      },
      comment: { id: 1, body: "@reviewbot implement x", user: { login: "maintainer" } }
    }
  });
}

function makeSchedule(): BotEvent {
  return normalizeEvent({
    eventName: "schedule",
    payload: {
      repository: {
        owner: { login: "acme" },
        name: "widget",
        full_name: "acme/widget",
        private: false
      },
      sender: { login: "github-actions[bot]" }
    }
  });
}

function makeDispatch(): BotEvent {
  return normalizeEvent({
    eventName: "workflow_dispatch",
    payload: {
      repository: {
        owner: { login: "acme" },
        name: "widget",
        full_name: "acme/widget",
        private: false
      },
      sender: { login: "operator" },
      ref: "refs/heads/main"
    }
  });
}

const RESTRICTED_CAPS = { shell: "restricted" as const, push: "restricted" as const };

describe("buildRuntimePolicy matrix", () => {
  test("fork PR disables shell/push/secrets even for write actors", () => {
    const event = makePullRequest({ fork: true, isPrivateRepo: true });
    const policy = buildRuntimePolicy({
      event,
      mode: "review",
      actor: { login: "alice", actorPermission: "write", isFork: true, isPrivateRepo: true },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("disabled");
    expect(policy.push).toBe("disabled");
    expect(policy.canReadSecrets).toBe(false);
    expect(policy.canApprove).toBe(false);
  });

  test("same-repo PR by non-collaborator gets restricted shell and disabled push", () => {
    const event = makePullRequest({ fork: false });
    const policy = buildRuntimePolicy({
      event,
      mode: "review",
      actor: { login: "alice", actorPermission: "read", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("disabled");
  });

  test("collaborator mention gets restricted shell/push", () => {
    const policy = buildRuntimePolicy({
      event: makeIssueComment(),
      mode: "implement",
      actor: { login: "alice", actorPermission: "write", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("restricted");
    expect(policy.canCreatePr).toBe(true);
  });

  test("fork PR mention denies shell, push, and secrets for implement mode", () => {
    const policy = buildRuntimePolicy({
      event: makeIssueComment(),
      mode: "implement",
      actor: { login: "alice", actorPermission: "write", isFork: true, isPrivateRepo: true },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("disabled");
    expect(policy.push).toBe("disabled");
    expect(policy.canReadSecrets).toBe(false);
  });

  test("maintainer mention gets restricted shell/push by default", () => {
    const policy = buildRuntimePolicy({
      event: makeIssueComment(),
      mode: "implement",
      actor: { login: "alice", actorPermission: "maintain", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("restricted");
    expect(policy.canReadSecrets).toBe(false);
  });

  test("scheduled maintenance keeps restricted defaults", () => {
    const policy = buildRuntimePolicy({
      event: makeSchedule(),
      mode: "triage",
      actor: {
        login: "github-actions[bot]",
        actorPermission: "write",
        isFork: false,
        isPrivateRepo: false
      },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("restricted");
  });

  test("workflow_dispatch with maintain actor honors config caps", () => {
    const policy = buildRuntimePolicy({
      event: makeDispatch(),
      mode: "implement",
      actor: { login: "operator", actorPermission: "maintain", isFork: false, isPrivateRepo: false },
      configCaps: { shell: "enabled", push: "enabled" }
    });
    // Config asks for enabled; the default matrix puts dispatch at restricted, so it stays restricted.
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("restricted");
  });

  test("input caps cannot escalate above context defaults", () => {
    const policy = buildRuntimePolicy({
      event: makePullRequest({ fork: false }),
      mode: "review",
      actor: { login: "alice", actorPermission: "read", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS,
      inputCaps: { shell: "enabled", push: "enabled" }
    });
    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("disabled");
  });

  test("input caps can downgrade restricted to disabled", () => {
    const policy = buildRuntimePolicy({
      event: makeIssueComment(),
      mode: "implement",
      actor: { login: "alice", actorPermission: "write", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS,
      inputCaps: { shell: "disabled", push: "disabled" }
    });
    expect(policy.shell).toBe("disabled");
    expect(policy.push).toBe("disabled");
  });

  test("review mode forces push disabled even when otherwise restricted", () => {
    const policy = buildRuntimePolicy({
      event: makePullRequest({ fork: false }),
      mode: "review",
      actor: { login: "alice", actorPermission: "write", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.push).toBe("disabled");
    expect(policy.reasons.some((r) => r.startsWith("mode:review:push"))).toBe(true);
  });

  test("canApprove is always disabled in v1", () => {
    const policy = buildRuntimePolicy({
      event: makePullRequest({ fork: false }),
      mode: "review",
      actor: { login: "alice", actorPermission: "admin", isFork: false, isPrivateRepo: false },
      configCaps: RESTRICTED_CAPS
    });
    expect(policy.canApprove).toBe(false);
  });
});

describe("permissions across all actor levels", () => {
  const levels: ActorPermission[] = ["none", "read", "triage", "write", "maintain", "admin"];
  for (const level of levels) {
    test(`fork PR with ${level} permission still forbids escalation`, () => {
      const event = makePullRequest({ fork: true });
      const policy = buildRuntimePolicy({
        event,
        mode: "review",
        actor: { login: "alice", actorPermission: level, isFork: true, isPrivateRepo: false },
        configCaps: { shell: "enabled", push: "enabled" }
      });
      expect(policy.shell).toBe("disabled");
      expect(policy.push).toBe("disabled");
      expect(policy.canReadSecrets).toBe(false);
    });
  }
});
