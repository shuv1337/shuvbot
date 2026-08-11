import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@actions/core";
import { readActionInputs } from "./inputs.ts";
import { loadConfigFile, normalizeConfig } from "../../core/src/config.ts";
import { RunLogger } from "../../core/src/observability.ts";
import {
  completeRunRecord,
  createRunRecord,
  recordError,
  recordPolicy,
  recordReview,
  recordToolAudit
} from "../../core/src/run-record.ts";
import type { RunRecord } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";
import {
  writeCoordinatorArtifacts,
  writeFailureDiagnostics,
  writeReviewArtifacts
} from "./artifacts.ts";
import { isSupportedEventName, normalizeEvent, type BotEvent } from "../../core/src/events.ts";
import { findCommandInEvent } from "../../core/src/commands.ts";
import { resolveMode } from "../../core/src/modes.ts";
import { buildRuntimePolicy } from "../../core/src/policy.ts";
import { deriveActorContext, type ActorContext } from "../../github/src/permissions.ts";
import { createGitHubClient } from "../../github/src/octokit.ts";
import {
  signalMentionLifecycle,
  triggerCommentFromEvent,
  type MentionReactionInput
} from "../../github/src/reactions.ts";
import { ConfigError, UnsupportedRequestError } from "../../core/src/errors.ts";
import { MODES, type AgentId, type ShuvbotMode } from "../../core/src/types.ts";
import { fetchPullRequestDiff } from "../../github/src/diff.ts";
import { resolveReviewTarget } from "../../github/src/pull-requests.ts";
import { runReview } from "../../core/src/review-runner.ts";
import { fallbackToSummary, postReview } from "../../github/src/reviews.ts";
import { runImplement } from "../../core/src/implement-runner.ts";
import { createOrFastForwardShuvbotBranch } from "../../github/src/branches.ts";
import { parseDurationMs, runFixCiLoop } from "../../core/src/fix-ci.ts";
import { fetchCheckLog, findFailedCheckRuns } from "../../github/src/checks.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { AgentDriver } from "../../agents/src/driver.ts";
import { createClaudeCodeDriver } from "../../agents/src/claude-code.ts";
import { createDriverReviewAgent } from "../../agents/src/review-agent.ts";
import { startShuvbotMcpServer } from "../../mcp/src/server.ts";
import { readContextTools } from "../../mcp/src/tools/index.ts";
import { AuditLog } from "../../mcp/src/audit.ts";
import {
  runCoordinatorActionReview,
  type CoordinatorActionReviewInput
} from "./coordinator-review.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import type { RuntimePolicy } from "../../core/src/policy.ts";
import type { ShuvbotConfig } from "../../core/src/config.ts";

/** Same default config filename the CLI discovers. */
const DEFAULT_CONFIG_FILENAME = "shuvbot.toml";

export interface MainOverrides {
  /** Injected in tests to avoid spawning a real agent CLI subprocess. */
  driver?: AgentDriver;
  /** Injected in tests to point the GitHub client at a local stand-in server. */
  fetchImpl?: typeof fetch;
  /** Injected in tests to cancel a run deterministically. */
  signal?: AbortSignal;
  /** Injected in tests to avoid spawning a real shuvcode review runtime. */
  coordinator?: CoordinatorActionReviewInput["dependencies"];
}

export async function main(overrides: MainOverrides = {}): Promise<void> {
  const logger = new RunLogger();
  const inputs = readActionInputs();
  const cwd = inputs.cwd ?? process.cwd();

  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPayload = await readEventPayload();
  const event =
    isSupportedEventName(eventName) && eventPayload
      ? normalizeEvent({ eventName, payload: eventPayload })
      : null;

  const parsedCommand = findCommandInEvent(event);
  const command = isManualMentionCommand(event, parsedCommand) ? parsedCommand : null;
  const explicitMode = isExplicitMode(inputs.mode) ? inputs.mode : "auto";
  const resolved = resolveMode({
    explicit: explicitMode,
    event,
    command,
    promptText: inputs.prompt ?? ""
  });
  const mode: ShuvbotMode = resolved.mode;

  const actorLogin = process.env.GITHUB_ACTOR ?? event?.sender.login ?? "unknown";
  const client = inputs.token
    ? createGitHubClient({
        token: inputs.token,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
    })
    : undefined;
  const mentionSignal = mentionReactionInput({
    event,
    command: Boolean(command),
    client,
    botLogin: resolveBotLogin(inputs.botLogin)
  });
  if (mentionSignal) {
    await signalMentionLifecycle({ ...mentionSignal, phase: "start" });
  }

  let mentionPhase: "success" | "failure" = "success";
  let withPolicy: RunRecord | undefined;
  try {
    const fileConfig = await resolveActionConfig(inputs.config, cwd, logger);
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

    // Resolve the target before policy: an issue_comment cannot report fork
    // status from its payload, and policy depends on the real answer.
    const reviewTarget = event
      ? await resolveReviewTarget({ event, ...(client ? { client } : {}) })
      : null;

    const actor = event
      ? await deriveActorContext({
          event,
          ...(client ? { client } : {}),
          ...(reviewTarget ? { isFork: reviewTarget.isFork } : {})
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
      ...(eventSubject(event) === undefined ? {} : { subject: eventSubject(event) }),
      ...(command === null
        ? {}
        : { command: { name: command.command, args: command.args, source: command.source } }),
      ...(eventAction ? { eventAction } : {})
    });

    withPolicy = record;
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

    // A pull_request event asks for a review by firing. A comment asks only if
    // it actually mentioned the bot - otherwise every comment on every pull
    // request would start a review.
    const reviewRequested = reviewTarget?.trigger === "comment" && Boolean(command);

    if (mode === "review" && event && reviewTarget && reviewRequested && client && policy) {
      const repo = { owner: event.repo.owner, name: event.repo.name };
      const pullNumber = reviewTarget.pullNumber;

      // Opt-in only: the config default is `coordinator`, but adopting it here
      // silently would break every existing workflow, which has no runtime
      // installed and no non-interactive credential configured.
      if (inputs.engine === "coordinator") {
        withPolicy = await runCoordinatorReviewMode({
          client,
          repo,
          repoFullName: event.repo.fullName,
          pullNumber,
          reviewTarget,
          config,
          policy,
          actor,
          hasCommand: Boolean(command),
          record: withPolicy,
          logger,
          botLogin: resolveBotLogin(inputs.botLogin),
          cwd,
          ...(overrides.signal ? { signal: overrides.signal } : {}),
          ...(overrides.coordinator ? { dependencies: overrides.coordinator } : {})
        });
        if (withPolicy.status === "failure") mentionPhase = "failure";
        await writeWorkflowSummary(withPolicy);
        return;
      }
      const diff = await fetchPullRequestDiff(client, repo, pullNumber);
      const filesResponse = await client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          params: {
            owner: repo.owner,
            repo: repo.name,
            pull_number: pullNumber,
            per_page: 100
          }
        }
      );

      const redactor = new DefaultRedactor();
      const audit = new AuditLog(redactor);
      const mcpServer = await startShuvbotMcpServer({
        tools: readContextTools,
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
          event: reviewTarget.event,
          diff: diff.raw,
          files: Array.isArray(filesResponse.data) ? filesResponse.data : [],
          config,
          policy,
          agent
        });
      } catch (reviewError) {
        // The driver embeds a bounded, secret-scrubbed tail of Claude's
        // stdout+stderr in its error; redact again (defense in depth) before it
        // reaches the step log or an artifact so a failure is diagnosable and
        // never leaks a token value.
        const message = redactor.redactString(
          reviewError instanceof Error ? reviewError.message : String(reviewError)
        );
        core.error(`shuvbot review failed:\n${boundedLogTail(message)}`);
        await writeFailureDiagnostics({ message }).catch(() => undefined);
        throw reviewError;
      } finally {
        withPolicy = recordToolAudit(withPolicy, audit.snapshot().summary);
        await mcpServer.close();
      }

      let postedComments = 0;
      if (policy.canReview) {
        const posted = await postReview({
          client,
          repo,
          pullNumber,
          body: buildReviewSummary(review.pipeline.summaryFindings),
          event: review.pipeline.reviewEvent,
          comments: review.pipeline.inlineFindings
            .filter((finding) => finding.inline)
            .map((finding) => ({
              path: finding.inline!.path,
              position: finding.inline!.position,
              body: finding.body,
              markerKey: finding.markerKey
            })),
          botLogin: resolveBotLogin(inputs.botLogin)
        });
        postedComments = posted.postedComments;
      } else {
        // The review ran; policy refused to publish it. Say so - a silent skip
        // here looks identical to a review that found nothing.
        const why = actor.isFork
          ? "the pull request head is a fork, and shuvbot does not post reviews on fork pull requests"
          : `the triggering actor has no write access (permission: ${actor.actorPermission})`;
        const notice = `Review completed but was not posted: ${why}.`;
        logger.log("warn", "review.not_posted", {
          isFork: actor.isFork,
          permission: actor.actorPermission,
          findings: review.findings.length
        });
        // A human who typed `@shuvbot review` gets nothing on the pull request,
        // so make it a red annotation rather than a warning they will not read.
        if (command) core.error(notice);
        else core.warning(notice);
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
        cwd,
        runId: withPolicy.runId,
        command,
        policy,
        startPoint: triggerSha(event),
        prepareBranch: createOrFastForwardShuvbotBranch,
        agent: {
          async run() {
            return {
              workDone: [
                "Prepared shuvbot implementation branch and validated implement-mode policy."
              ],
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
        JSON.stringify({
          runId: withPolicy.runId,
          status: "implemented",
          mode,
          branch: implementation.branch
        })
      );
      await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
      return;
    }

    if (mode === "fix-ci" && event?.kind === "workflow_run" && client && policy) {
      const repo = { owner: event.repo.owner, name: event.repo.name };
      const failedRuns = await findFailedCheckRuns(client, repo, event.headSha);
      const redactor = new DefaultRedactor();
      const logs = await Promise.all(
        failedRuns.map((run) =>
          fetchCheckLog({ client, repo, runId: run.id, maxBytes: 16_384, redactor })
        )
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
      core.setOutput(
        "result",
        JSON.stringify({
          runId: withPolicy.runId,
          status: fix.status,
          mode,
          attempts: fix.attempts
        })
      );
      await writeWorkflowSummary(
        completeRunRecord(withPolicy, fix.status === "completed" ? "success" : "failure")
      );
      return;
    }

    // Nothing above matched. Distinguish a human asking for work and getting
    // none (a failure they must be told about) from an ambient event that
    // simply does not apply to this mode (a quiet, explained skip).
    const reason = explainUnhandledRun({
      mode,
      event,
      hasClient: Boolean(client),
      hasReviewTarget: Boolean(reviewTarget),
      commented: Boolean(command)
    });
    if (command) {
      throw new UnsupportedRequestError(
        `shuvbot could not run "@shuvbot ${command.command}": ${reason}`
      );
    }
    logger.log("info", "run.skipped", { mode, event: eventName, reason });
    core.warning(`shuvbot took no action: ${reason}`);
    core.setOutput(
      "result",
      JSON.stringify({
        runId: withPolicy.runId,
        status: "skipped",
        mode,
        trigger: withPolicy.trigger,
        reason
      })
    );
    await writeWorkflowSummary(completeRunRecord(withPolicy, "success"));
  } catch (error) {
    mentionPhase = "failure";
    if (withPolicy !== undefined) {
      withPolicy = recordError(withPolicy, error);
      await writeWorkflowSummary(completeRunRecord(withPolicy, "failure"));
    }
    throw error;
  } finally {
    if (mentionSignal) {
      await signalMentionLifecycle({ ...mentionSignal, phase: mentionPhase });
    }
  }
}

/**
 * Runs review mode through the multi-agent coordinator engine.
 *
 * Publishing stays under the same runtime policy as the legacy path: a review
 * runs regardless, but only `policy.canReview` decides whether it reaches the
 * pull request, and the engine itself never holds a write-capable tool.
 */
async function runCoordinatorReviewMode(input: {
  client: GitHubClient;
  repo: { owner: string; name: string };
  repoFullName: string;
  pullNumber: number;
  reviewTarget: NonNullable<Awaited<ReturnType<typeof resolveReviewTarget>>>;
  config: ShuvbotConfig;
  policy: RuntimePolicy;
  actor: ActorContext;
  hasCommand: boolean;
  record: RunRecord;
  logger: RunLogger;
  botLogin: string;
  cwd: string;
  signal?: AbortSignal;
  dependencies?: CoordinatorActionReviewInput["dependencies"];
}): Promise<RunRecord> {
  const artifactDirectory = join(process.env.RUNNER_TEMP ?? tmpdir(), "shuvbot");
  // A cancelled workflow run is delivered as a signal to this process. Without
  // forwarding it, the runner would kill the action while the spawned shuvcode
  // runtime and its sessions kept going.
  const cancellation = input.signal === undefined ? processCancellation() : undefined;
  const signal = input.signal ?? cancellation?.signal;
  try {
    return await executeCoordinatorReviewMode({
      ...input,
      artifactDirectory,
      ...(signal === undefined ? {} : { signal })
    });
  } finally {
    cancellation?.dispose();
  }
}

async function executeCoordinatorReviewMode(input: {
  client: GitHubClient;
  repo: { owner: string; name: string };
  repoFullName: string;
  pullNumber: number;
  reviewTarget: NonNullable<Awaited<ReturnType<typeof resolveReviewTarget>>>;
  config: ShuvbotConfig;
  policy: RuntimePolicy;
  actor: ActorContext;
  hasCommand: boolean;
  record: RunRecord;
  logger: RunLogger;
  botLogin: string;
  cwd: string;
  artifactDirectory: string;
  signal?: AbortSignal;
  dependencies?: CoordinatorActionReviewInput["dependencies"];
}): Promise<RunRecord> {
  let record = input.record;
  const artifactDirectory = input.artifactDirectory;
  const review = await runCoordinatorActionReview({
    client: input.client,
    repo: input.repo,
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    baseSha: input.reviewTarget.event.pullRequest.baseSha,
    headSha: input.reviewTarget.event.pullRequest.headSha,
    config: input.config,
    policy: input.policy,
    cwd: input.cwd,
    artifactDirectory,
    logger: input.logger,
    botLogin: input.botLogin,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {})
  });

  if (!review.posted && review.status !== "no_changes") {
    // The review ran; policy refused to publish it. Say so - a silent skip here
    // looks identical to a review that found nothing.
    const why = input.actor.isFork
      ? "the pull request head is a fork, and shuvbot does not post reviews on fork pull requests"
      : `the triggering actor has no write access (permission: ${input.actor.actorPermission})`;
    const notice = `Coordinator review completed but was not posted: ${why}.`;
    input.logger.log("warn", "review.not_posted", {
      isFork: input.actor.isFork,
      permission: input.actor.actorPermission,
      findings: review.findings.length
    });
    if (input.hasCommand) core.error(notice);
    else core.warning(notice);
  }

  record = { ...record, postedComments: review.postedComments };
  if (review.runSummary !== undefined) record = recordReview(record, review.runSummary);
  if (review.timings !== undefined) {
    record = {
      ...record,
      timings: {
        ...record.timings,
        preprocessingMs: review.timings.preprocessingMs,
        engineMs: review.timings.engineMs,
        totalMs: review.timings.preprocessingMs + review.timings.engineMs
      }
    };
  }

  const executionFailed = ["failed", "timed_out", "cancelled"].includes(review.status);
  if (review.failCheck || executionFailed) {
    record = recordError(
      record,
      new Error(
        review.failCheck
          ? `Review found findings at or above the configured fail_on threshold (${input.config.failOn}).`
          : `Coordinator review ended with status ${review.status}.`
      )
    );
  }
  record = completeRunRecord(record, review.failCheck || executionFailed ? "failure" : "success");

  // Artifacts are written even when posting was refused: a fork review that
  // cannot be published is exactly the run whose output someone needs to read.
  try {
    await writeCoordinatorArtifacts({
      runnerTemp: artifactDirectory,
      runRecord: record,
      report: review.report,
      redactor: review.redactor,
      ...(review.sessionLog === undefined ? {} : { sessionLog: review.sessionLog })
    });
  } catch (error) {
    core.warning(
      `shuvbot could not write review artifacts: ${review.redactor.redactString(
        error instanceof Error ? error.message : String(error)
      )}`
    );
  }

  core.setOutput("review_engine", "coordinator");
  core.setOutput("summary", review.summary);
  if (review.tier !== undefined) core.setOutput("review_tier", review.tier);
  if (review.coverage !== undefined) {
    core.setOutput("review_coverage", JSON.stringify(review.coverage));
  }
  core.setOutput("review_degraded", String(review.degraded));
  core.setOutput("review_findings", JSON.stringify(review.findings));
  core.setOutput(
    "result",
    JSON.stringify({
      runId: record.runId,
      status: review.failCheck ? "failed" : review.status,
      mode: "review",
      engine: "coordinator",
      ...(review.tier === undefined ? {} : { tier: review.tier }),
      degraded: review.degraded,
      findings: review.findings.length
    })
  );

  if (review.failCheck || executionFailed) {
    core.setFailed(
      review.failCheck
        ? `shuvbot review found findings at or above the configured fail_on threshold (${input.config.failOn}).`
        : `shuvbot coordinator review ended with status ${review.status}.`
    );
  }
  return record;
}

/**
 * Bridges job cancellation into the review's abort signal.
 *
 * Handlers are removed when the run finishes so a long-lived process (tests,
 * or any future in-process caller) does not accumulate them.
 */
function processCancellation(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort("cancelled");
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  return {
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  };
}

/** Login whose review comments own finding threads for lifecycle state. */
function resolveBotLogin(configured?: string): string {
  return configured ?? "github-actions[bot]";
}

function mentionReactionInput(input: {
  event: BotEvent | null;
  command: boolean;
  client: GitHubClient | undefined;
  botLogin: string;
}): MentionReactionInput | undefined {
  if (!input.command || !input.event || !input.client) return undefined;
  const target = triggerCommentFromEvent(input.event);
  if (target === undefined) return undefined;
  return {
    client: input.client,
    repo: { owner: input.event.repo.owner, name: input.event.repo.name },
    target,
    botLogin: input.botLogin
  };
}

function isManualMentionCommand(
  event: BotEvent | null,
  command: ReturnType<typeof findCommandInEvent>
): command is NonNullable<ReturnType<typeof findCommandInEvent>> {
  if (event === null || command === null) return false;
  return (
    (event.kind === "issue_comment" && command.source === "issue_comment") ||
    (event.kind === "pull_request_review_comment" && command.source === "review_comment")
  );
}

function eventSubject(event: BotEvent | null): RunRecord["subject"] {
  if (event === null) return undefined;
  switch (event.kind) {
    case "issue_comment":
      return {
        kind: event.issue.isPullRequest ? "pull_request" : "issue",
        number: event.issue.number,
        commentId: event.comment.id
      };
    case "pull_request_review_comment":
      return { kind: "pull_request", number: event.pullRequest.number, commentId: event.comment.id };
    default:
      return undefined;
  }
}

/**
 * Resolves configuration the same way the CLI does.
 *
 * An explicit `config:` input must load or fail. Otherwise a `shuvbot.toml` in
 * the working directory is used when it exists, and built-in defaults when it
 * does not. The Action previously skipped that discovery entirely, so a
 * repository's own committed config was silently ignored in CI while applying
 * locally - the settings were there, they just did nothing.
 */
async function resolveActionConfig(
  explicitPath: string | undefined,
  cwd: string,
  logger: RunLogger
): Promise<ShuvbotConfig> {
  if (explicitPath !== undefined) return loadConfigFile(explicitPath);

  const discovered = join(cwd, DEFAULT_CONFIG_FILENAME);
  if (!existsSync(discovered)) return normalizeConfig({});
  logger.log("info", "config.discovered", { path: DEFAULT_CONFIG_FILENAME });
  return loadConfigFile(discovered);
}

/** Keep the step-log annotation from ballooning if the driver tail is large. */
function boundedLogTail(message: string, max = 4000): string {
  return message.length <= max
    ? message
    : `…[${message.length - max} chars omitted]…\n${message.slice(-max)}`;
}

function createReviewDriver(agentId: AgentId): AgentDriver {
  if (agentId !== "claude-code") {
    throw new ConfigError(
      `agent "${agentId}" is not wired to a real driver in this version; only "claude-code" is supported`
    );
  }
  return createClaudeCodeDriver();
}

/**
 * Explain why no handler matched, in terms the person reading the workflow log
 * can act on. This mirrors the branch conditions in `main()`; keep them in step.
 */
function explainUnhandledRun(input: {
  mode: ShuvbotMode;
  event: BotEvent | null;
  hasClient: boolean;
  hasReviewTarget: boolean;
  commented: boolean;
}): string {
  const { mode, event, hasClient, hasReviewTarget, commented } = input;
  if (!event) return "no supported GitHub event payload was available for this run.";
  if (!hasClient) return "no GitHub token was supplied; set the action's `token` input.";

  switch (mode) {
    case "review":
      if (hasReviewTarget && !commented) {
        return "a comment only starts a review when it mentions `@shuvbot review`.";
      }
      return (
        `review needs a pull request, but this run saw \`${event.kind}\` ` +
        "that does not refer to one."
      );
    case "implement":
      return `implement requires an \`@shuvbot implement …\` mention; this run saw \`${event.kind}\` without one.`;
    case "fix-ci":
      return `fix-ci runs only on \`workflow_run\` events, but this run saw \`${event.kind}\`.`;
    default:
      return `mode \`${mode}\` is not wired to a handler in this version; see docs/workflows.md.`;
  }
}

function isExplicitMode(value: string | undefined): value is ShuvbotMode {
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
  if (findings.length === 0) return "shuvbot found no summary-only findings.";
  return findings.map((finding) => fallbackToSummary(finding)).join("\n");
}
