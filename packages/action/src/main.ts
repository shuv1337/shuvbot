import { readFile } from "node:fs/promises";
import * as core from "@actions/core";
import { readActionInputs } from "./inputs.ts";
import { loadConfigFile, normalizeConfig } from "../../core/src/config.ts";
import { RunLogger } from "../../core/src/observability.ts";
import {
  completeRunRecord,
  createRunRecord,
  recordError,
  recordPolicy,
  recordToolAudit
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
import { ConfigError } from "../../core/src/errors.ts";
import { MODES, type AgentId, type ReviewbotMode } from "../../core/src/types.ts";
import { fetchPullRequestDiff } from "../../github/src/diff.ts";
import { runReview } from "../../core/src/review-runner.ts";
import { fallbackToSummary, postReview } from "../../github/src/reviews.ts";
import { runImplement } from "../../core/src/implement-runner.ts";
import { createOrFastForwardReviewbotBranch } from "../../github/src/branches.ts";
import { parseDurationMs, runFixCiLoop } from "../../core/src/fix-ci.ts";
import { fetchCheckLog, findFailedCheckRuns } from "../../github/src/checks.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { AgentDriver } from "../../agents/src/driver.ts";
import { createClaudeCodeDriver } from "../../agents/src/claude-code.ts";
import { createDriverReviewAgent } from "../../agents/src/review-agent.ts";
import { startReviewbotMcpServer } from "../../mcp/src/server.ts";
import { allMcpTools } from "../../mcp/src/tools/index.ts";
import { AuditLog } from "../../mcp/src/audit.ts";

export interface MainOverrides {
  /** Injected in tests to avoid spawning a real agent CLI subprocess. */
  driver?: AgentDriver;
  /** Injected in tests to point the GitHub client at a local stand-in server. */
  fetchImpl?: typeof fetch;
}

export async function main(overrides: MainOverrides = {}): Promise<void> {
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
  const client = inputs.token
    ? createGitHubClient({ token: inputs.token, ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}) })
    : undefined;
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

  try {
    if (mode === "review" && event?.kind === "pull_request" && client && policy) {
      const repo = { owner: event.repo.owner, name: event.repo.name };
      const diff = await fetchPullRequestDiff(client, repo, event.pullRequest.number);
      const filesResponse = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        params: { owner: repo.owner, repo: repo.name, pull_number: event.pullRequest.number, per_page: 100 }
      });

      const cwd = inputs.cwd ?? process.cwd();
      const redactor = new DefaultRedactor();
      const audit = new AuditLog(redactor);
      const mcpServer = await startReviewbotMcpServer({
        tools: allMcpTools,
        context: {
          repo,
          runId: withPolicy.runId,
          actor: withPolicy.actor,
          mode,
          policy,
          client,
          cwd,
          redactor,
          audit,
          logger,
          shellSandbox: {
            allowCommands: config.shellSandbox.allowCommands,
            denyCommands: config.shellSandbox.denyCommands
          }
        }
      });

      let review: Awaited<ReturnType<typeof runReview>>;
      try {
        const driver = overrides.driver ?? createReviewDriver(config.agent);
        await driver.prepare({ cwd });
        const agent = createDriverReviewAgent({
          driver,
          cwd,
          env: process.env,
          timeoutMs: parseDurationMs(config.timeout),
          activityTimeoutMs: parseDurationMs(config.activityTimeout),
          model: config.model,
          mcpServerUrl: mcpServer.url.toString(),
          logger
        });
        review = await runReview({
          cwd,
          repo: event.repo.fullName,
          event,
          diff: diff.raw,
          files: Array.isArray(filesResponse.data) ? filesResponse.data : [],
          config,
          policy,
          agent
        });
      } finally {
        withPolicy = recordToolAudit(withPolicy, audit.snapshot().summary);
        await mcpServer.close();
      }

      let postedComments = 0;
      if (policy.canReview) {
        const posted = await postReview({
          client,
          repo,
          pullNumber: event.pullRequest.number,
          body: buildReviewSummary(review.pipeline.summaryFindings),
          event: review.pipeline.reviewEvent,
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
      core.setOutput(
        "result",
        JSON.stringify({
          runId: withPolicy.runId,
          status: review.pipeline.failCheck ? "failed" : "reviewed",
          mode,
          findings: review.findings.length
        })
      );
      await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
      return;
    }

    if (mode === "implement" && command && event && policy) {
      const implementation = await runImplement({
        cwd: inputs.cwd ?? process.cwd(),
        runId: withPolicy.runId,
        command,
        policy,
        startPoint: triggerSha(event),
        prepareBranch: createOrFastForwardReviewbotBranch,
        agent: {
          async run() {
            return {
              workDone: ["Prepared reviewbot implementation branch and validated implement-mode policy."],
              filesChanged: [],
              commandsRun: [],
              checks: [],
              commits: [],
              followUps: [
                "implement mode is not wired to a real agent in this version; no patch was written." +
                  " See docs/workflows.md for current mode support."
              ]
            };
          }
        }
      });
      withPolicy = {
        ...withPolicy,
        implementation: {
          requestedTask: implementation.requestedTask,
          branch: implementation.branch,
          commandsRun: implementation.commandsRun,
          checks: implementation.checks,
          commits: implementation.commits
        }
      };
      core.setOutput("summary", implementation.summary);
      core.setOutput(
        "result",
        JSON.stringify({ runId: withPolicy.runId, status: "implemented", mode, branch: implementation.branch })
      );
      await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
      return;
    }

    if (mode === "fix-ci" && event?.kind === "workflow_run" && client && policy) {
      const repo = { owner: event.repo.owner, name: event.repo.name };
      const failedRuns = await findFailedCheckRuns(client, repo, event.headSha);
      const redactor = new DefaultRedactor();
      const logs = await Promise.all(
        failedRuns.map((run) => fetchCheckLog({ client, repo, runId: run.id, maxBytes: 16_384, redactor }))
      );
      const fix = await runFixCiLoop({
        policy,
        logs,
        maxAttempts: config.fixCi.maxAttempts,
        maxRuntimeMs: parseDurationMs(config.fixCi.maxRuntime),
        now: () => Date.now(),
        agent: {
          async run() {
            return {
              summary:
                "Diagnosed failed checks, but fix-ci mode is not wired to a real agent in this version; no fix was attempted." +
                " See docs/workflows.md for current mode support.",
              commandsRun: [],
              checks: failedRuns.map((run) => `${run.name}: ${run.conclusion}`),
              commits: []
            };
          }
        }
      });
      core.setOutput("summary", fix.summary);
      core.setOutput("result", JSON.stringify({ runId: withPolicy.runId, status: fix.status, mode, attempts: fix.attempts }));
      await writeWorkflowSummary(completeRunRecord(withPolicy, fix.status === "completed" ? "success" : "failure"));
      return;
    }

    core.setOutput("result", JSON.stringify({ runId: withPolicy.runId, status: "initialized", mode, trigger: withPolicy.trigger }));
    await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
  } catch (error) {
    withPolicy = recordError(withPolicy, error);
    await writeWorkflowSummary(completeRunRecord(withPolicy, "failure"));
    throw error;
  }
}

function createReviewDriver(agentId: AgentId): AgentDriver {
  if (agentId !== "claude-code") {
    throw new ConfigError(
      `agent "${agentId}" is not wired to a real driver in this version; only "claude-code" is supported`
    );
  }
  return createClaudeCodeDriver();
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

function triggerSha(event: BotEvent): string {
  if (event.kind === "pull_request") return event.pullRequest.headSha;
  if (event.kind === "workflow_dispatch" && typeof event.raw === "object" && event.raw !== null) {
    const ref = (event.raw as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return "HEAD";
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

function buildReviewSummary(findings: Parameters<typeof fallbackToSummary>[0][]): string {
  if (findings.length === 0) return "reviewbot found no summary-only findings.";
  return findings.map((finding) => fallbackToSummary(finding)).join("\n");
}
