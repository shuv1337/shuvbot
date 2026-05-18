import { describe, expect, test } from "bun:test";
import {
  EnvelopeError,
  EventNormalizationError,
  isSupportedEventName,
  normalizeEvent,
  validateEnvelope
} from "../src/events.ts";

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    owner: { login: "acme" },
    name: "widget",
    full_name: "acme/widget",
    private: false,
    default_branch: "main",
    ...overrides
  };
}

describe("normalizeEvent", () => {
  test("normalizes pull_request opened from same repo", () => {
    const event = normalizeEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: makeRepo(),
        sender: { login: "alice" },
        pull_request: {
          number: 42,
          title: "feat: add",
          body: "body",
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: {
            ref: "topic",
            sha: "deadbeef",
            repo: { full_name: "acme/widget" }
          },
          base: {
            ref: "main",
            sha: "cafebabe",
            repo: { full_name: "acme/widget" }
          }
        }
      }
    });
    expect(event.kind).toBe("pull_request");
    if (event.kind !== "pull_request") throw new Error("expected pull_request");
    expect(event.pullRequest.isFork).toBe(false);
    expect(event.pullRequest.number).toBe(42);
    expect(event.repo.fullName).toBe("acme/widget");
  });

  test("detects fork pull requests", () => {
    const event = normalizeEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: makeRepo(),
        sender: { login: "outsider" },
        pull_request: {
          number: 7,
          title: "drive-by",
          body: "",
          state: "open",
          draft: false,
          user: { login: "outsider" },
          head: {
            ref: "fork",
            sha: "1",
            repo: { full_name: "outsider/widget" }
          },
          base: { ref: "main", sha: "0", repo: { full_name: "acme/widget" } }
        }
      }
    });
    if (event.kind !== "pull_request") throw new Error("expected pull_request");
    expect(event.pullRequest.isFork).toBe(true);
  });

  test("normalizes issue_comment", () => {
    const event = normalizeEvent({
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository: makeRepo(),
        sender: { login: "alice" },
        issue: {
          number: 12,
          title: "Bug",
          body: "x",
          state: "open",
          user: { login: "alice" }
        },
        comment: { id: 99, body: "@reviewbot review", user: { login: "alice" } }
      }
    });
    expect(event.kind).toBe("issue_comment");
    if (event.kind !== "issue_comment") throw new Error("expected issue_comment");
    expect(event.comment.body).toBe("@reviewbot review");
  });

  test("normalizes workflow_run with conclusion", () => {
    const event = normalizeEvent({
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: makeRepo(),
        sender: { login: "actions[bot]" },
        workflow_run: {
          name: "CI",
          conclusion: "failure",
          head_branch: "feature",
          head_sha: "abc"
        }
      }
    });
    if (event.kind !== "workflow_run") throw new Error("expected workflow_run");
    expect(event.conclusion).toBe("failure");
    expect(event.workflowName).toBe("CI");
  });

  test("normalizes workflow_dispatch", () => {
    const event = normalizeEvent({
      eventName: "workflow_dispatch",
      payload: {
        repository: makeRepo(),
        sender: { login: "operator" },
        inputs: { mode: "review" },
        ref: "refs/heads/main"
      }
    });
    if (event.kind !== "workflow_dispatch") throw new Error("expected workflow_dispatch");
    expect(event.inputs.mode).toBe("review");
    expect(event.ref).toBe("refs/heads/main");
  });

  test("normalizes schedule", () => {
    const event = normalizeEvent({
      eventName: "schedule",
      payload: {
        repository: makeRepo(),
        sender: { login: "github-actions[bot]" }
      }
    });
    expect(event.kind).toBe("schedule");
  });

  test("rejects unsupported event names", () => {
    expect(() => normalizeEvent({ eventName: "deployment", payload: {} })).toThrow(EventNormalizationError);
  });

  test("isSupportedEventName covers the documented set", () => {
    for (const name of [
      "pull_request",
      "pull_request_target",
      "issue_comment",
      "pull_request_review_comment",
      "issues",
      "workflow_dispatch",
      "workflow_run",
      "schedule"
    ]) {
      expect(isSupportedEventName(name)).toBe(true);
    }
    expect(isSupportedEventName("deployment")).toBe(false);
  });
});

describe("validateEnvelope", () => {
  test("returns the envelope for valid input", () => {
    const envelope = validateEnvelope({ prompt: "hello", mode: "review" });
    expect(envelope.prompt).toBe("hello");
    expect(envelope.mode).toBe("review");
  });

  test("rejects forbidden runtime fields", () => {
    for (const field of ["shell", "push", "canWrite", "canUseSecrets", "permissions", "actorPermission"]) {
      expect(() => validateEnvelope({ prompt: "x", [field]: "enabled" })).toThrow(EnvelopeError);
    }
  });

  test("requires a prompt", () => {
    expect(() => validateEnvelope({})).toThrow(EnvelopeError);
  });
});
