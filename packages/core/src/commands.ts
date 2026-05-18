import type { BotEvent } from "./events.ts";

export const SUPPORTED_COMMANDS = [
  "review",
  "improve",
  "ask",
  "implement",
  "fix-ci",
  "describe",
  "changelog",
  "test-plan",
  "explain",
  "summarize"
] as const;

export type CommandName = (typeof SUPPORTED_COMMANDS)[number];

export const DEFAULT_COMMAND_PREFIX = "@reviewbot";

export type CommandSource =
  | "issue_comment"
  | "review_comment"
  | "issue_body"
  | "pr_body"
  | "workflow_dispatch";

export interface ParsedCommand {
  prefix: string;
  command: CommandName;
  args: string;
  raw: string;
  actor: string;
  source: CommandSource;
}

export interface ParseCommandInput {
  text: string;
  prefix?: string;
  actor: string;
  source: CommandSource;
}

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === "string" && (SUPPORTED_COMMANDS as readonly string[]).includes(value);
}

export function parseCommand(input: ParseCommandInput): ParsedCommand | null {
  const prefix = (input.prefix ?? DEFAULT_COMMAND_PREFIX).trim();
  if (!prefix) return null;
  const text = (input.text ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const escaped = escapeRegExp(prefix);
  const pattern = new RegExp(`(^|\\s)${escaped}\\s+([\\w-]+)([^\\n]*)`);

  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    const candidate = match[2]?.toLowerCase();
    if (!candidate || !isCommandName(candidate)) continue;
    const args = (match[3] ?? "").trim();
    return {
      prefix,
      command: candidate,
      args,
      raw: line.trim(),
      actor: input.actor,
      source: input.source
    };
  }
  return null;
}

export function findCommandInEvent(
  event: BotEvent | null,
  prefix: string = DEFAULT_COMMAND_PREFIX
): ParsedCommand | null {
  if (!event) return null;
  switch (event.kind) {
    case "issue_comment":
      return parseCommand({
        text: event.comment.body,
        prefix,
        actor: event.comment.user.login || event.sender.login,
        source: "issue_comment"
      });
    case "pull_request_review_comment":
      return parseCommand({
        text: event.comment.body,
        prefix,
        actor: event.comment.user.login || event.sender.login,
        source: "review_comment"
      });
    case "issues":
      return parseCommand({
        text: event.issue.body,
        prefix,
        actor: event.issue.user.login || event.sender.login,
        source: "issue_body"
      });
    case "pull_request":
      return parseCommand({
        text: event.pullRequest.body,
        prefix,
        actor: event.pullRequest.user.login || event.sender.login,
        source: "pr_body"
      });
    default:
      return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
