import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "../src/events.ts";
import { findCommandInEvent } from "../src/commands.ts";
import { resolveMode } from "../src/modes.ts";

function makeIssueCommentEvent(body: string) {
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
      sender: { login: "alice" },
      issue: { number: 1, title: "x", body: "x", state: "open", user: { login: "alice" } },
      comment: { id: 1, body, user: { login: "alice" } }
    }
  });
}

describe("resolveMode", () => {
  test("uses explicit mode when not auto", () => {
    const result = resolveMode({
      explicit: "release-notes",
      event: null,
      command: null
    });
    expect(result.mode).toBe("release-notes");
  });

  test("falls back to event when explicit is auto", () => {
    const pr = normalizeEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: {
          owner: { login: "acme" },
          name: "widget",
          full_name: "acme/widget",
          private: false
        },
        sender: { login: "alice" },
        pull_request: {
          number: 1,
          title: "t",
          body: "",
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: { ref: "topic", sha: "1", repo: { full_name: "acme/widget" } },
          base: { ref: "main", sha: "0", repo: { full_name: "acme/widget" } }
        }
      }
    });
    expect(resolveMode({ explicit: "auto", event: pr, command: null }).mode).toBe("review");
  });

  test("maps command tokens to modes", () => {
    const event = makeIssueCommentEvent("@reviewbot implement the spec");
    const command = findCommandInEvent(event);
    const result = resolveMode({ explicit: "auto", event, command });
    expect(result.mode).toBe("implement");
  });

  test("maps fix-ci command", () => {
    const event = makeIssueCommentEvent("@reviewbot fix-ci");
    const command = findCommandInEvent(event);
    expect(resolveMode({ explicit: "auto", event, command }).mode).toBe("fix-ci");
  });

  test("maps release-notes-style commands", () => {
    const event = makeIssueCommentEvent("@reviewbot changelog");
    const command = findCommandInEvent(event);
    expect(resolveMode({ explicit: "auto", event, command }).mode).toBe("release-notes");
  });

  test("infers fix-ci from failed workflow_run", () => {
    const event = normalizeEvent({
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: {
          owner: { login: "acme" },
          name: "widget",
          full_name: "acme/widget",
          private: false
        },
        sender: { login: "actions" },
        workflow_run: { name: "CI", conclusion: "failure", head_branch: "x", head_sha: "y" }
      }
    });
    expect(resolveMode({ explicit: "auto", event, command: null }).mode).toBe("fix-ci");
  });

  test("infers from workflow_dispatch prompt keyword", () => {
    const event = normalizeEvent({
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
    const result = resolveMode({
      explicit: "auto",
      event,
      command: null,
      promptText: "Please generate release notes for v1.2"
    });
    expect(result.mode).toBe("release-notes");
  });
});
