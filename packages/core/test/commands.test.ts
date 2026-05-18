import { describe, expect, test } from "bun:test";
import { findCommandInEvent, parseCommand } from "../src/commands.ts";
import { normalizeEvent } from "../src/events.ts";

describe("parseCommand", () => {
  test("parses a basic command with args", () => {
    const result = parseCommand({
      text: "@reviewbot implement the TODO in src/foo.ts",
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
      text: "@reviewbot dance",
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
      text: "Some context here.\n@reviewbot ask why does the build fail?\nThanks!",
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
        comment: { id: 1, body: "@reviewbot review", user: { login: "alice" } }
      }
    });
    const command = findCommandInEvent(event);
    expect(command?.command).toBe("review");
    expect(command?.source).toBe("issue_comment");
  });
});
