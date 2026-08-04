import { describe, expect, test } from "bun:test";
import { findCommandInEvent, parseCommand } from "../src/commands.ts";
import { normalizeEvent } from "../src/events.ts";

describe("parseCommand", () => {
  test("parses a basic command with args", () => {
    const result = parseCommand({
      text: "@shuvbot implement the TODO in src/foo.ts",
      actor: "alice",
      source: "issue_comment"
    });
    expect(result).not.toBeNull();
    expect(result?.command).toBe("implement");
    expect(result?.args).toBe("the TODO in src/foo.ts");
    expect(result?.actor).toBe("alice");
  });

  test("ignores text without prefix", () => {
    const result = parseCommand({ text: "looks good", actor: "bob", source: "issue_comment" });
    expect(result).toBeNull();
  });

  test("returns null for unknown commands", () => {
    const result = parseCommand({
      text: "@shuvbot dance",
      actor: "alice",
      source: "issue_comment"
    });
    expect(result).toBeNull();
  });

  test("respects custom prefix", () => {
    const result = parseCommand({
      text: "@friendbot fix-ci",
      prefix: "@friendbot",
      actor: "alice",
      source: "issue_comment"
    });
    expect(result?.command).toBe("fix-ci");
  });

  test("finds command inside multi-line comment", () => {
    const result = parseCommand({
      text: "Some context here.\n@shuvbot ask why does the build fail?\nThanks!",
      actor: "alice",
      source: "issue_comment"
    });
    expect(result?.command).toBe("ask");
    expect(result?.args).toBe("why does the build fail?");
  });

  test("findCommandInEvent extracts from issue_comment event", () => {
    const event = normalizeEvent({
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
        comment: { id: 1, body: "@shuvbot review", user: { login: "alice" } }
      }
    });
    const command = findCommandInEvent(event);
    expect(command?.command).toBe("review");
    expect(command?.source).toBe("issue_comment");
    expect(command?.actor).toBe("alice");
  });

  test("preserves source for write-capable review comments", () => {
    const event = normalizeEvent({
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        repository: {
          owner: { login: "acme" },
          name: "widget",
          full_name: "acme/widget",
          private: false
        },
        sender: { login: "maintainer" },
        pull_request: {
          number: 1,
          title: "t",
          body: "",
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: { ref: "topic", sha: "1", repo: { full_name: "acme/widget" } },
          base: { ref: "main", sha: "0", repo: { full_name: "acme/widget" } }
        },
        comment: { id: 1, body: "@shuvbot implement this", user: { login: "maintainer" } }
      }
    });
    const command = findCommandInEvent(event);
    expect(command?.command).toBe("implement");
    expect(command?.source).toBe("review_comment");
    expect(command?.actor).toBe("maintainer");
  });
});
