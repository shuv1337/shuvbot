import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { findCommandInEvent } from "../../core/src/commands.ts";
import { isSupportedEventName, normalizeEvent } from "../../core/src/events.ts";
import { resolveMode } from "../../core/src/modes.ts";
import { buildRuntimePolicy } from "../../core/src/policy.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";

export interface ReplayResult {
  fixture: string;
  eventName: string;
  mode: string;
  command: string | null;
  shell: string;
  push: string;
  canApprove: boolean;
  redactedPayload: string;
}

export async function replayGithubEventFixture(path: string): Promise<ReplayResult> {
  const raw = await readFile(path, "utf8");
  const eventName = eventNameFromFixture(path);
  if (!isSupportedEventName(eventName)) {
    return {
      fixture: path,
      eventName,
      mode: "unsupported",
      command: null,
      shell: "disabled",
      push: "disabled",
      canApprove: false,
      redactedPayload: new DefaultRedactor().redactString(raw)
    };
  }
  const event = normalizeEvent({ eventName, payload: JSON.parse(raw) });
  const command = findCommandInEvent(event);
  const resolved = resolveMode({ explicit: "auto", event, command, promptText: raw });
  const policy = buildRuntimePolicy({
    event,
    mode: resolved.mode,
    actor: {
      login: event.sender.login,
      actorPermission: "write",
      isFork: event.kind === "pull_request" && event.pullRequest.isFork,
      isPrivateRepo: event.repo.isPrivate
    },
    configCaps: { shell: "restricted", push: "restricted" }
  });
  return {
    fixture: path,
    eventName,
    mode: resolved.mode,
    command: command?.command ?? null,
    shell: policy.shell,
    push: policy.push,
    canApprove: policy.canApprove,
    redactedPayload: new DefaultRedactor().redactString(raw)
  };
}

function eventNameFromFixture(path: string): string {
  const name = basename(path);
  if (name.startsWith("pull_request.")) return "pull_request";
  if (name.startsWith("issue_comment.")) return "issue_comment";
  if (name.startsWith("review_comment.")) return "pull_request_review_comment";
  if (name.startsWith("workflow_dispatch.")) return "workflow_dispatch";
  if (name.startsWith("workflow_run.")) return "workflow_run";
  if (name.startsWith("check_suite.")) return "check_suite";
  return name.replace(/\.json$/, "");
}
