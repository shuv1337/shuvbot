import { ConfigError } from "../../core/src/errors.ts";
import type { ShuvbotConfig } from "../../core/src/config.ts";
import type { Redactor } from "../../core/src/redaction.ts";
import type { ReviewRunSummary } from "../../core/src/run-record.ts";
import {
  executeCoordinatorEngine,
  type CoordinatorEngineProgressEvent,
  type CoordinatorEngineResult
} from "./engine.ts";
import { createReviewExecutionPlanFromConfig, type ReviewPlanFile } from "./plan.ts";
import {
  createReviewerConfigPlugin,
  reviewerTierAssignments,
  runReviewPlugins,
  type ReviewPlugin
} from "./plugins/index.ts";
import { buildCoordinatorReport } from "./report.ts";
import { reconcileReviewState, type ReconcileReviewStateResult } from "./reconcile.ts";
import type { CoordinatorResult } from "./results.ts";
import type { ModelRef } from "./plugins/types.ts";
import type { ShuvcodeRuntime, StartShuvcodeRuntimeOptions } from "./runtime/shuvcode.ts";
import type { ReviewStateStore } from "./state.ts";
import type { ReviewExecutionPlan } from "./types.ts";
import { createReviewWorkspace } from "./workspace.ts";

export const REVIEW_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

export type CoordinatorRunStatus = "completed" | "degraded" | "failed" | "timed_out" | "cancelled";

export interface ReviewDeadline {
  readonly signal: AbortSignal;
  readonly atMs: number;
  remaining(): number;
  assertRemaining(stage: string): void;
  race<T>(operation: Promise<T>, stage: string): Promise<T>;
  cleanupRemaining(graceMs: number): number;
  dispose(): void;
}

export interface CoordinatorReviewDependencies {
  executeCoordinator: typeof executeCoordinatorEngine;
  startRuntime(options: StartShuvcodeRuntimeOptions): Promise<ShuvcodeRuntime>;
  now(): Date;
}

export interface CoordinatorReviewIncremental {
  readonly changeId: string;
  readonly store: ReviewStateStore;
  /** Platform callers may persist only after their report is published. */
  readonly deferWrite?: boolean;
}

export interface RunCoordinatorReviewInput {
  readonly config: ShuvbotConfig;
  readonly cwd: string;
  readonly files: readonly ReviewPlanFile[];
  readonly baseSha: string;
  readonly headSha: string;
  readonly redactor: Redactor;
  readonly deadline: ReviewDeadline;
  readonly artifactDirectory: string;
  readonly dependencies: CoordinatorReviewDependencies;
  readonly credential?: StartShuvcodeRuntimeOptions["credential"];
  readonly incremental?: CoordinatorReviewIncremental;
  /** Extra platform plugins, appended after the repository-config plugin. */
  readonly plugins?: readonly ReviewPlugin[];
  /** Header line of the shared reviewer context; names the review surface. */
  readonly contextHeader: string;
  readonly onPlan?: (plan: ReviewExecutionPlan) => void;
  readonly onProgress?: (event: CoordinatorEngineProgressEvent) => void | Promise<void>;
}

export interface CoordinatorReviewReportOptions {
  readonly lifecycle: {
    readonly fixedFingerprints: readonly string[];
    readonly userResolvedFingerprints: readonly string[];
  };
}

export type CoordinatorReviewRun =
  | {
      readonly kind: "no_reviewable_changes";
      readonly plan: ReviewExecutionPlan;
    }
  | {
      readonly kind: "reviewed";
      readonly status: CoordinatorRunStatus;
      readonly plan: ReviewExecutionPlan;
      readonly execution: CoordinatorEngineResult;
      /** Findings after lifecycle reconciliation; what a caller should report. */
      readonly reportedResult: CoordinatorResult;
      readonly report: ReturnType<typeof buildCoordinatorReport>;
      readonly reportOptions?: CoordinatorReviewReportOptions;
      readonly reconciliation?: ReconcileReviewStateResult;
      readonly engineMs: number;
    };

/**
 * Runs the coordinator review from a collected diff through to a reconciled,
 * reportable result.
 *
 * Everything platform-specific stays with the caller: where the diff came from,
 * where state is persisted, how progress is displayed, and how the result is
 * published. Everything that decides *what the review says* lives here, so a
 * GitHub review and a local review cannot drift into judging the same change
 * differently.
 */
export async function runCoordinatorReview(
  input: RunCoordinatorReviewInput
): Promise<CoordinatorReviewRun> {
  const { config, deadline, redactor, dependencies } = input;
  const plan = createReviewExecutionPlanFromConfig({
    files: input.files,
    baseSha: input.baseSha,
    headSha: input.headSha,
    config
  });
  if (!plan.diff.entries.some((file) => file.included)) {
    deadline.assertRemaining("final output");
    return { kind: "no_reviewable_changes", plan };
  }
  input.onPlan?.(plan);

  const pluginResult = await runReviewPlugins({
    plugins: [createReviewerConfigPlugin(config.review), ...(input.plugins ?? [])],
    tierAssignments: reviewerTierAssignments(config.review)
  });

  const previous =
    input.incremental === undefined
      ? null
      : await deadline.race(
          input.incremental.store.readReviewState(input.incremental.changeId, {
            deadlineAtMs: deadline.atMs
          }),
          "incremental state read"
        );

  const workspaceOperation = createReviewWorkspace({
    files: plan.diff.entries
      .filter((file) => file.included)
      .map((file) => ({ path: file.path, patch: file.patch ?? "" })),
    sharedContext: renderSharedReviewContext(plan, input.contextHeader),
    ...(previous === null ? {} : { previousFindings: previous.findings })
  });
  let workspace: Awaited<typeof workspaceOperation> | undefined;
  try {
    workspace = Object.freeze(await deadline.race(workspaceOperation, "workspace preparation"));
  } catch (error) {
    // The workspace may still land after the deadline fired; clean it up rather
    // than leaving a directory of patches behind.
    void workspaceOperation
      .then((late) => boundedReviewCleanup(late.cleanup, REVIEW_CLEANUP_TIMEOUT_MS))
      .catch(() => undefined);
    throw error;
  }

  try {
    const sessionTimeoutMs = parseReviewDurationMs(config.activityTimeout, "activity_timeout");
    const engineStartedAt = Date.now();
    const remainingMs = deadline.remaining();
    if (remainingMs <= 0) throw reviewTimeoutError("preprocessing");

    const execution = await deadline.race(
      dependencies.executeCoordinator({
        plan,
        workspace,
        pluginConfig: pluginResult.config,
        models: {
          coordinator: asModelRef(config.review.models.coordinator),
          standard: asModelRef(config.review.models.standard),
          light: asModelRef(config.review.models.light)
        },
        runtimeFactory: ({ signal }) =>
          dependencies.startRuntime({
            packageName: config.review.shuvcode.package,
            version: config.review.shuvcode.version,
            cwd: input.cwd,
            ...(input.credential === undefined ? {} : { credential: input.credential }),
            signal
          }),
        redactor,
        signal: deadline.signal,
        overallTimeoutMs: remainingMs,
        specialistTimeoutMs: Math.min(remainingMs, sessionTimeoutMs),
        coordinatorTimeoutMs: Math.min(remainingMs, sessionTimeoutMs),
        artifactDirectory: input.artifactDirectory,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress })
      }),
      "coordinator execution"
    );
    const engineMs = Date.now() - engineStartedAt;

    let reconciliation: ReconcileReviewStateResult | undefined;
    if (input.incremental !== undefined) {
      reconciliation = reconcileReviewState({
        changeId: input.incremental.changeId,
        baseSha: input.baseSha,
        headSha: input.headSha,
        findings: execution.result.findings,
        previous,
        degraded: execution.result.decision === "degraded" || !execution.coverage.quorumMet,
        now: dependencies.now
      });
      if (!input.incremental.deferWrite) {
        await deadline.race(
          input.incremental.store.writeReviewState(
            input.incremental.changeId,
            reconciliation.state,
            { deadlineAtMs: deadline.atMs }
          ),
          "incremental state write"
        );
      }
    }

    const reportedResult =
      reconciliation === undefined
        ? execution.result
        : { ...execution.result, findings: reconciliation.activeFindings };
    const reportOptions =
      reconciliation === undefined
        ? undefined
        : {
            lifecycle: {
              fixedFingerprints: reconciliation.fixedFingerprints,
              userResolvedFingerprints: reconciliation.preservedResolvedFingerprints
            }
          };

    return {
      kind: "reviewed",
      status: coordinatorRunStatus(execution),
      plan,
      execution,
      reportedResult,
      report: buildCoordinatorReport(reportedResult, reportOptions),
      ...(reportOptions === undefined ? {} : { reportOptions }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      engineMs
    };
  } finally {
    if (workspace !== undefined) {
      await boundedReviewCleanup(
        workspace.cleanup,
        deadline.cleanupRemaining(REVIEW_CLEANUP_TIMEOUT_MS)
      );
    }
  }
}

/**
 * Projects an engine execution onto the run record's review summary.
 *
 * Shared so a coordinator run is described identically in local artifacts and
 * in the Action's artifacts; the two used to be one inline literal in the CLI.
 */
export function buildReviewRunSummary(input: {
  readonly plan: ReviewExecutionPlan;
  readonly execution: CoordinatorEngineResult;
  readonly report: ReturnType<typeof buildCoordinatorReport>;
}): ReviewRunSummary {
  const usage = input.execution.sessions.reduce(
    (total, session) => ({
      inputTokens: total.inputTokens + (session.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (session.usage?.outputTokens ?? 0),
      cost: total.cost + (session.usage?.cost ?? 0)
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0 }
  );
  return {
    engine: "coordinator",
    tier: input.plan.risk.tier,
    decision: input.report.decision,
    quorumMet: input.execution.coverage.quorumMet,
    requiredReviewers: [...input.execution.coverage.required],
    successfulReviewers: [...input.execution.coverage.completed],
    missingReviewers: input.execution.coverage.required.filter(
      (reviewer) => !input.execution.coverage.completed.includes(reviewer)
    ),
    sessions: input.execution.sessions.map((session) => ({
      sessionId: session.sessionId,
      role: session.role,
      ...(session.reviewer === undefined ? {} : { reviewer: session.reviewer }),
      model: session.model,
      status: session.status,
      retryCount: session.retryCount,
      ...(session.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: session.usage.inputTokens,
              outputTokens: session.usage.outputTokens,
              ...(session.usage.cost === undefined ? {} : { cost: session.usage.cost })
            }
          }),
      ...(session.error === undefined
        ? {}
        : {
            error: {
              code: session.error.code,
              message: session.error.message,
              retryable: session.error.retryable
            }
          })
    })),
    retries: input.execution.retries,
    usage,
    findingAccounting: {
      active: input.report.counts.active,
      new: input.report.counts.new,
      unresolved: input.report.counts.unresolved,
      fixed: input.report.counts.fixed,
      userResolved: input.report.counts.userResolved,
      dismissed: input.report.counts.dismissed
    }
  };
}

/** Maps engine execution onto the status a caller reports. */
export function coordinatorRunStatus(execution: CoordinatorEngineResult): CoordinatorRunStatus {
  if (execution.status !== "completed") return execution.status;
  return execution.result.decision === "degraded" || !execution.coverage.quorumMet
    ? "degraded"
    : "completed";
}

/**
 * Renders the shared context every reviewer reads. The header names the review
 * surface and is supplied by the caller, because it is prompt content: changing
 * it changes what the reviewers were told.
 */
export function renderSharedReviewContext(plan: ReviewExecutionPlan, header: string): string {
  return [
    header,
    `Base SHA: ${plan.baseSha}`,
    `Head SHA: ${plan.headSha}`,
    `Risk tier: ${plan.risk.tier}`,
    `Changed lines: ${plan.diff.changedLines}`,
    "Changed files:",
    ...plan.diff.entries.map(
      (file) =>
        `- ${file.status} ${file.path} (+${file.additions} -${file.deletions})${file.included ? "" : ` [filtered: ${file.filterReason}]`}`
    )
  ].join("\n");
}

/**
 * A deadline shared by every stage of a review, so a run cannot exceed
 * `review.overall_timeout` by stacking per-stage timeouts, and an external
 * cancellation (a cancelled workflow run, Ctrl-C) reaches every stage at once.
 */
export function createReviewDeadline(
  timeoutMs: number,
  source?: AbortSignal,
  label = "Coordinator review"
): ReviewDeadline {
  const controller = new AbortController();
  const startedAt = Date.now();
  const atMs = startedAt + timeoutMs;
  const cancel = () => controller.abort(source?.reason ?? "cancelled");
  if (source?.aborted) cancel();
  else source?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort("timed_out"), timeoutMs);
  const failure = (stage: string, cause?: unknown): ConfigError =>
    controller.signal.reason === "timed_out"
      ? reviewTimeoutError(stage, cause, label)
      : new ConfigError(
          `${label} was cancelled during ${stage}.`,
          cause === undefined ? undefined : { cause }
        );

  return {
    signal: controller.signal,
    atMs,
    remaining: () => Math.max(0, timeoutMs - (Date.now() - startedAt)),
    assertRemaining(stage) {
      if (!controller.signal.aborted && Date.now() >= atMs) controller.abort("timed_out");
      if (controller.signal.aborted) throw failure(stage);
    },
    async race<T>(operation: Promise<T>, stage: string): Promise<T> {
      if (!controller.signal.aborted && Date.now() >= atMs) controller.abort("timed_out");
      if (controller.signal.aborted) {
        void operation.catch(() => undefined);
        throw failure(stage);
      }
      let remove = (): void => {};
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => reject(failure(stage));
        controller.signal.addEventListener("abort", abort, { once: true });
        remove = () => controller.signal.removeEventListener("abort", abort);
      });
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        remove();
      }
    },
    cleanupRemaining(graceMs) {
      return Math.max(0, atMs + graceMs - Date.now());
    },
    dispose() {
      clearTimeout(timer);
      source?.removeEventListener("abort", cancel);
    }
  };
}

export function reviewTimeoutError(
  stage: string,
  cause?: unknown,
  label = "Coordinator review"
): ConfigError {
  return new ConfigError(
    `${label} exceeded review.overall_timeout during ${stage}.`,
    cause === undefined ? undefined : { cause }
  );
}

export async function boundedReviewCleanup(
  cleanup: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
  } catch {
    // Engine cleanup status is authoritative; this fallback must remain bounded.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function parseReviewDurationMs(value: string, field = "duration"): number {
  const source = value.trim();
  const pattern = /(\d+)(ms|s|m|h)/g;
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  let consumed = "";
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    consumed += match[0];
    const amount = Number(match[1]);
    const unit = match[2] as keyof typeof multipliers;
    total += amount * multipliers[unit];
  }
  if (consumed !== source || total <= 0 || !Number.isSafeInteger(total) || total > MAX_TIMER_MS) {
    throw new ConfigError(
      `${field} must be a positive duration no greater than ${MAX_TIMER_MS}ms.`
    );
  }
  return total;
}

function asModelRef(value: string): ModelRef {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new ConfigError(`Invalid model reference: ${value}`);
  return value as ModelRef;
}
