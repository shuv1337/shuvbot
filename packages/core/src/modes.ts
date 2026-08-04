import type { ParsedCommand, CommandName } from "./commands.ts";
import type { BotEvent } from "./events.ts";
import { MODES, type ShuvbotMode, isOneOf } from "./types.ts";

export { MODES, type ShuvbotMode } from "./types.ts";

export const COMMAND_TO_MODE: Record<CommandName, ShuvbotMode> = {
  review: "review",
  improve: "implement",
  ask: "triage",
  implement: "implement",
  "fix-ci": "fix-ci",
  describe: "release-notes",
  changelog: "release-notes",
  "test-plan": "review",
  explain: "triage",
  summarize: "triage"
};

export interface ResolveModeInput {
  explicit?: ShuvbotMode | "auto";
  event: BotEvent | null;
  command: ParsedCommand | null;
  promptText?: string;
}

export interface ResolvedMode {
  mode: ShuvbotMode;
  reason: string;
}

export function resolveMode(input: ResolveModeInput): ResolvedMode {
  const explicit = input.explicit;
  if (explicit && explicit !== "auto" && isOneOf(explicit, MODES)) {
    return { mode: explicit, reason: `explicit:${explicit}` };
  }

  if (input.command) {
    const mapped = COMMAND_TO_MODE[input.command.command];
    return { mode: mapped, reason: `command:${input.command.command}` };
  }

  if (input.event) {
    switch (input.event.kind) {
      case "pull_request":
        return { mode: "review", reason: "event:pull_request" };
      case "pull_request_review_comment":
        return { mode: "review", reason: "event:pull_request_review_comment" };
      case "workflow_run": {
        if (input.event.conclusion === "failure") {
          return { mode: "fix-ci", reason: "event:workflow_run.failure" };
        }
        return { mode: "triage", reason: "event:workflow_run" };
      }
      case "schedule":
        return { mode: "triage", reason: "event:schedule" };
      case "issues":
        return { mode: "triage", reason: "event:issues" };
      case "issue_comment":
        return inferFromText(input.event.comment.body, "issue_comment");
      case "workflow_dispatch":
        return inferFromText(input.promptText ?? "", "workflow_dispatch");
    }
  }

  return inferFromText(input.promptText ?? "", "prompt");
}

function inferFromText(text: string, reasonTag: string): ResolvedMode {
  const lower = text.toLowerCase();
  if (/release\s*notes|changelog/.test(lower)) {
    return { mode: "release-notes", reason: `${reasonTag}:release-notes-keyword` };
  }
  if (/fix\s*ci|ci\s*fail|failing\s*check|broken\s*build/.test(lower)) {
    return { mode: "fix-ci", reason: `${reasonTag}:fix-ci-keyword` };
  }
  if (/implement|build|add\s+(?:a|the)|fix\s+(?:the|this)/.test(lower)) {
    return { mode: "implement", reason: `${reasonTag}:implement-keyword` };
  }
  if (/review|audit/.test(lower)) {
    return { mode: "review", reason: `${reasonTag}:review-keyword` };
  }
  return { mode: "review", reason: `${reasonTag}:default` };
}
