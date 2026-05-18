import { readFile } from "node:fs/promises";
import * as core from "@actions/core";
import { readActionInputs } from "./inputs.ts";
import { loadConfigFile, normalizeConfig } from "../../core/src/config.ts";
import { RunLogger } from "../../core/src/observability.ts";
import {
  completeRunRecord,
  createRunRecord,
  recordPolicy
} from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";
import {
  isSupportedEventName,
  normalizeEvent,
  type BotEvent
} from "../../core/src/events.ts";
import { findCommandInEvent } from "../../core/src/commands.ts";
import { resolveMode } from "../../core/src/modes.ts";
import { buildRuntimePolicy } from "../../core/src/policy.ts";
import {
  deriveActorContext,
  type ActorContext
} from "../../github/src/permissions.ts";
import { createGitHubClient } from "../../github/src/octokit.ts";
import { MODES, type ReviewbotMode } from "../../core/src/types.ts";

export async function main(): Promise<void> {
  const logger = new RunLogger();
  const inputs = readActionInputs();
  const fileConfig = inputs.config ? await loadConfigFile(inputs.config) : normalizeConfig({});

  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPayload = await readEventPayload();
  const event = isSupportedEventName(eventName) && eventPayload
    ? normalizeEvent({ eventName, payload: eventPayload })
    : null;

  const command = findCommandInEvent(event);
  const explicitMode = isExplicitMode(inputs.mode) ? inputs.mode : "auto";
  const resolved = resolveMode({
    explicit: explicitMode,
    event,
    command,
    promptText: inputs.prompt ?? ""
  });
  const mode: ReviewbotMode = resolved.mode;

  const config = {
    ...fileConfig,
    agent: inputs.agent ?? fileConfig.agent,
    model: inputs.model ?? fileConfig.model,
    mode,
    timeout: inputs.timeout ?? fileConfig.timeout,
    activityTimeout: inputs.activityTimeout ?? fileConfig.activityTimeout,
    shell: inputs.shell ?? fileConfig.shell,
    push: inputs.push ?? fileConfig.push
  };

  const actorLogin = process.env.GITHUB_ACTOR ?? event?.sender.login ?? "unknown";
  const client = inputs.token ? createGitHubClient({ token: inputs.token }) : undefined;
  const actor = event
    ? await deriveActorContext({
        event,
        ...(client ? { client } : {})
      })
    : fallbackActor(actorLogin);

  const eventAction = extractAction(event);
  const record = createRunRecord({
    event: eventName,
    actor: actor.login || actorLogin,
    trigger: triggerLabel(event, command, explicitMode),
    mode,
    agent: config.agent,
    model: config.model,
    ...(event?.repo.fullName ? { repo: event.repo.fullName } : {}),
    ...(eventAction ? { eventAction } : {})
  });

  let withPolicy = record;
  if (event) {
    const policy = buildRuntimePolicy({
      event,
      mode,
      actor,
      configCaps: { shell: fileConfig.shell, push: fileConfig.push },
      inputCaps: {
        ...(inputs.shell ? { shell: inputs.shell } : {}),
        ...(inputs.push ? { push: inputs.push } : {})
      }
    });
    withPolicy = recordPolicy(record, policy);
    logger.log("info", "policy.resolved", {
      shell: policy.shell,
      push: policy.push,
      reasons: policy.reasons
    });
  }

  logger.log("info", "run.initialized", {
    runId: withPolicy.runId,
    mode,
    agent: config.agent,
    model: config.model,
    trigger: withPolicy.trigger,
    modeReason: resolved.reason
  });

  core.setOutput(
    "result",
    JSON.stringify({
      runId: withPolicy.runId,
      status: "initialized",
      mode,
      trigger: withPolicy.trigger
    })
  );
  await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
}

function isExplicitMode(value: string | undefined): value is ReviewbotMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function triggerLabel(
  event: BotEvent | null,
  command: ReturnType<typeof findCommandInEvent>,
  explicit: string
): string {
  if (command) return `command:${command.command}`;
  if (event) return `event:${event.kind}`;
  return `input:${explicit}`;
}

function extractAction(event: BotEvent | null): string | undefined {
  if (!event) return undefined;
  if ("action" in event && typeof event.action === "string") return event.action;
  return undefined;
}

function fallbackActor(login: string): ActorContext {
  return {
    login,
    actorPermission: "none",
    isFork: false,
    isPrivateRepo: false
  };
}

async function readEventPayload(): Promise<unknown> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}


