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
import type { RunRecord } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";
import { writeReviewArtifacts } from "./artifacts.ts";
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
import { fetchPullRequestDiff } from "../../github/src/diff.ts";
import { createFakeReviewAgent, runReview } from "../../core/src/review-runner.ts";
import { fallbackToSummary, postReview } from "../../github/src/reviews.ts";

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

  let withPolicy: RunRecord = record;
  let policy: ReturnType<typeof buildRuntimePolicy> | undefined;
  if (event) {
    policy = buildRuntimePolicy({
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

  if (mode === "review" && event?.kind === "pull_request" && client && policy) {
    const repo = { owner: event.repo.owner, name: event.repo.name };
    const diff = await fetchPullRequestDiff(client, repo, event.pullRequest.number);
    const filesResponse = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      params: { owner: repo.owner, repo: repo.name, pull_number: event.pullRequest.number, per_page: 100 }
    });
    const review = await runReview({
      cwd: inputs.cwd ?? process.cwd(),
      repo: event.repo.fullName,
      event,
      diff: diff.raw,
      files: Array.isArray(filesResponse.data) ? filesResponse.data : [],
      config,
      policy,
      agent: createFakeReviewAgent(parsePromptFindings(inputs.prompt))
    });
    let postedComments = 0;
    if (policy.canReview) {
      const posted = await postReview({
        client,
        repo,
        pullNumber: event.pullRequest.number,
        body: buildReviewSummary(review.pipeline.summaryFindings),
        event: "COMMENT",
        comments: review.pipeline.inlineFindings
          .filter((finding) => finding.inline)
          .map((finding) => ({
            path: finding.inline!.path,
            position: finding.inline!.position,
            body: finding.body,
            markerKey: finding.markerKey
          }))
      });
      postedComments = posted.postedComments;
    }
    withPolicy = {
      ...withPolicy,
      findings: review.findings,
      postedComments
    };
    const artifacts = await writeReviewArtifacts({
      runRecord: withPolicy,
      findings: review.findings,
      contextManifest: review.context.manifest
    });
    withPolicy = { ...withPolicy, contextManifestPath: artifacts.contextManifestPath };
    core.setOutput("review_findings", JSON.stringify(review.findings));
    core.setOutput("summary", buildReviewSummary(review.pipeline.summaryFindings));
    core.setOutput("result", JSON.stringify({ runId: withPolicy.runId, status: "reviewed", mode, findings: review.findings.length }));
    await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
    return;
  }

  core.setOutput("result", JSON.stringify({ runId: withPolicy.runId, status: "initialized", mode, trigger: withPolicy.trigger }));
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

function parsePromptFindings(prompt: string | undefined): unknown[] {
  if (!prompt) return [];
  try {
    const parsed = JSON.parse(prompt);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildReviewSummary(findings: Parameters<typeof fallbackToSummary>[0][]): string {
  if (findings.length === 0) return "reviewbot found no summary-only findings.";
  return findings.map((finding) => fallbackToSummary(finding)).join("\n");
}

