import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Redactor } from "../../core/src/redaction.ts";
import {
  finalizeCoordinator,
  prepareCoordinator,
  type CoordinatorSpecialistResult,
  type FinalizedCoordinator
} from "./coordinator.ts";
import { classifyReviewError, type ClassifiedReviewError } from "./errors.ts";
import {
  READ_ONLY_REVIEW_TOOLS,
  type ModelRef,
  type ResolvedReviewPluginConfig
} from "./plugins/types.ts";
import { evaluateQuorum, type QuorumResult } from "./quorum.ts";
import {
  coordinatorResultSchema,
  parseCoordinatorResult,
  parseReviewerResult,
  reviewerResultSchema,
  type CoordinatorResult,
  type ReviewCoverage,
  type ReviewerResult,
  type Usage
} from "./results.ts";
import { buildSpecialistPrompt } from "./reviewers/index.ts";
import {
  runSessionTasks,
  type SessionTask,
  type SessionTaskRecord,
  type SessionTaskTransition
} from "./scheduler.ts";
import { ReviewSessionLog, type ReviewSessionLogEvent } from "./session-log.ts";
import {
  REVIEW_SESSION_POLICY,
  type ShuvcodeEvent,
  type ShuvcodeModel,
  type ShuvcodeRuntime,
  type ShuvcodeSessionPolicy
} from "./runtime/shuvcode.ts";
import { resolveReviewModels } from "./runtime/model-catalog.ts";
import { ShuvcodeSessionEventAccumulator } from "./runtime/events.ts";
import type { BuiltInReviewerId, ReviewExecutionPlan } from "./types.ts";
import {
  createScopedReviewWorkspace,
  type ReviewWorkspace,
  type ScopedReviewWorkspace
} from "./workspace.ts";

export interface CoordinatorEngineModels {
  readonly coordinator: ModelRef;
  readonly standard?: ModelRef;
  readonly light?: ModelRef;
}

export interface ExecuteCoordinatorEngineInput {
  readonly plan: ReviewExecutionPlan;
  readonly workspace: ReviewWorkspace;
  readonly pluginConfig: ResolvedReviewPluginConfig;
  readonly models: CoordinatorEngineModels;
  readonly runtimeFactory: (input: { readonly signal: AbortSignal }) => Promise<ShuvcodeRuntime>;
  readonly redactor: Redactor;
  readonly signal?: AbortSignal;
  readonly overallTimeoutMs: number;
  readonly specialistTimeoutMs: number;
  readonly coordinatorTimeoutMs: number;
  readonly interruptTimeoutMs?: number;
  readonly eventClock?: CoordinatorEngineEventClock;
  readonly onProgress?: (event: CoordinatorEngineProgressEvent) => void | Promise<void>;
  readonly artifactDirectory?: string;
  readonly fileSystem?: CoordinatorEngineFileSystem;
}

export interface CoordinatorEngineFileSystem {
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

/**
 * A structured result the review refused, kept so a rejection can actually be
 * diagnosed. Without it a rejected result is only ever reported as
 * `REVIEW_SCHEMA_INVALID`, with the offending value already discarded.
 */
export interface RejectedResultSample {
  /**
   * `result` is a structured value the review refused; `failure` is a session
   * that never produced one because the runtime call itself failed. They land
   * in one artifact because they answer the same operator question - why did
   * this reviewer contribute nothing - but they are not the same event.
   */
  readonly kind: "result" | "failure";
  readonly role: "specialist" | "coordinator";
  readonly reviewer?: BuiltInReviewerId;
  readonly sessionId?: string;
  readonly attempt: number;
  readonly repair: boolean;
  readonly reason: string;
  readonly sample: string;
}

const MAX_REJECTED_SAMPLES = 12;
const MAX_REJECTED_SAMPLE_BYTES = 8_000;

/** Records a refused result, redacted and bounded, for the run artifacts. */
function recordRejectedResult(
  samples: RejectedResultSample[],
  redactor: Redactor,
  entry: Omit<RejectedResultSample, "kind" | "reason" | "sample"> & {
    readonly error: unknown;
    readonly value: unknown;
  }
): void {
  if (samples.length >= MAX_REJECTED_SAMPLES) return;
  const { error, value, ...rest } = entry;
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  serialized ??= String(value);
  const bounded =
    serialized.length > MAX_REJECTED_SAMPLE_BYTES
      ? `${serialized.slice(0, MAX_REJECTED_SAMPLE_BYTES)}\n…truncated`
      : serialized;
  samples.push({
    kind: "result",
    ...rest,
    reason: redactor.redactString(error instanceof Error ? error.message : String(error)),
    sample: redactor.redactString(bounded)
  });
}

/**
 * The failure text a classified error carried, if any. Read structurally rather
 * than with `instanceof` so an injected or forwarded error is treated the same
 * as a `ShuvcodeSessionError`.
 */
function failureDetailOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { detail } = error as { detail?: unknown };
  return typeof detail === "string" && detail.length > 0 ? detail : undefined;
}

/**
 * Records why a session failed, redacted and bounded, so a provider failure is
 * diagnosable from the artifacts. Without it the run reports only a sanitised
 * category - `Provider request failed` - and the cause has to be inferred.
 */
function recordFailedSession(
  samples: RejectedResultSample[],
  redactor: Redactor,
  entry: Omit<RejectedResultSample, "kind" | "repair" | "reason" | "sample"> & {
    readonly error: unknown;
    readonly classified: ClassifiedReviewError;
  }
): void {
  if (samples.length >= MAX_REJECTED_SAMPLES) return;
  const { error, classified, ...rest } = entry;
  // A cancelled session explains nothing: shuvbot stopped it, so its detail
  // describes shuvbot's own interruption rather than a fault. Recording those
  // would let a timed-out full-tier run consume the whole bounded artifact and
  // crowd out the refusals an operator actually needs to read.
  if (classified.category === "cancellation") return;
  const detail = failureDetailOf(error);
  if (detail === undefined) return;
  const bounded =
    detail.length > MAX_REJECTED_SAMPLE_BYTES
      ? `${detail.slice(0, MAX_REJECTED_SAMPLE_BYTES)}\n…truncated`
      : detail;
  samples.push({
    kind: "failure",
    ...rest,
    repair: false,
    reason: classified.message,
    sample: redactor.redactString(bounded)
  });
}

export interface CoordinatorEngineEventClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CoordinatorEngineSessionSummary {
  readonly sessionId: string;
  readonly role: "coordinator" | "specialist";
  readonly reviewer?: BuiltInReviewerId;
  readonly model: string;
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly retryCount: number;
  readonly attempt?: number;
  readonly repairAttempted?: boolean;
  readonly usage?: Usage;
  readonly error?: ClassifiedReviewError;
}

export interface CoordinatorEngineProgressEvent {
  readonly status:
    | "queued"
    | "running"
    | "heartbeat"
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled";
  readonly sessionId: string;
  readonly role: "coordinator" | "specialist";
  readonly reviewer?: BuiltInReviewerId;
  readonly model: string;
  readonly attempt: number;
  readonly atMs: number;
  readonly deadlineAtMs?: number;
  readonly durationMs?: number;
  readonly usage?: Usage;
  readonly error?: ClassifiedReviewError;
  readonly coverage: {
    readonly scheduled: readonly BuiltInReviewerId[];
    readonly completed: readonly BuiltInReviewerId[];
    readonly failed: readonly BuiltInReviewerId[];
    readonly timedOut: readonly BuiltInReviewerId[];
    readonly cancelled: readonly BuiltInReviewerId[];
  };
}

export interface CoordinatorEngineArtifacts {
  readonly directory: string;
  readonly status: "written" | "failed";
  readonly error?: ClassifiedReviewError;
}

export interface CoordinatorEngineResult {
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly result: CoordinatorResult;
  readonly quorum: QuorumResult;
  readonly coverage: ReviewCoverage;
  readonly specialistResults: readonly ReviewerResult[];
  readonly sessions: readonly CoordinatorEngineSessionSummary[];
  readonly retries: number;
  readonly events: readonly ReviewSessionLogEvent[];
  readonly error?: ClassifiedReviewError;
  readonly repairAttempted: boolean;
  readonly artifacts?: CoordinatorEngineArtifacts;
  readonly cleanup?: CoordinatorEngineCleanup;
}

export interface CoordinatorEngineCleanup {
  readonly status: "failed";
  readonly errors: readonly ClassifiedReviewError[];
}

interface SessionCapture {
  id: string;
  role: "coordinator" | "specialist";
  reviewer?: BuiltInReviewerId;
  model: string;
  attempt: number;
  repairAttempted: boolean;
  startedAtMs: number;
  accumulator: ShuvcodeSessionEventAccumulator;
}

class CoordinatorExecutionError extends Error {
  override readonly name = "CoordinatorExecutionError";

  constructor(
    readonly status: "failed" | "timed_out" | "cancelled",
    readonly classified: ClassifiedReviewError,
    readonly repairAttempted: boolean,
    options?: ErrorOptions
  ) {
    super(classified.message, options);
  }
}

/**
 * Prepares a generated JSON Schema for the runtime's structured output contract.
 * The generator emits a `$schema` dialect declaration, which the runtime rejects
 * with `structured_output.schema` because it resolves neither the key nor the
 * ref. Sending it makes every structured prompt fail before the model is
 * reached, so the dialect declaration is removed here.
 */
export function toRuntimeJsonSchema(schema: unknown): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

const reviewerJsonSchema = toRuntimeJsonSchema(z.toJSONSchema(reviewerResultSchema));
const coordinatorJsonSchema = toRuntimeJsonSchema(
  z.toJSONSchema(coordinatorResultSchema, { io: "input" })
);
const HEARTBEAT_QUIET_MS = 30_000;
const HEARTBEAT_POLL_MS = 1_000;
const defaultEventClock: CoordinatorEngineEventClock = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};
const defaultFileSystem: CoordinatorEngineFileSystem = { mkdir, rename, rm, writeFile };

export async function executeCoordinatorEngine(
  input: ExecuteCoordinatorEngineInput
): Promise<CoordinatorEngineResult> {
  validateTimeout("overallTimeoutMs", input.overallTimeoutMs);
  validateTimeout("specialistTimeoutMs", input.specialistTimeoutMs);
  validateTimeout("coordinatorTimeoutMs", input.coordinatorTimeoutMs);
  if (input.interruptTimeoutMs !== undefined) {
    validateTimeout("interruptTimeoutMs", input.interruptTimeoutMs);
  }
  validateExecutionInputs(input);

  // Shuvbot's `subscription/…` names are not routable by the runtime, so they
  // are resolved through the curated catalog before any review work starts. A
  // misconfigured model or effort then fails once, with a message naming what is
  // accepted, instead of being reported as an incomplete review.
  const resolvedModels = resolveReviewModels(configuredModelRefs(input));
  const modelFor = (ref: ModelRef): ShuvcodeModel => {
    const model = resolvedModels.get(ref);
    if (model === undefined) throw new TypeError(`unresolved review model: ${ref}`);
    return model;
  };

  const log = new ReviewSessionLog({ redactor: input.redactor });
  const eventClock = input.eventClock ?? defaultEventClock;
  const progress = new EngineProgressEmitter(input);
  const overall = new AbortController();
  const overallDeadlineAtMs = Date.now() + input.overallTimeoutMs;
  const cleanupDeadlineAtMs = overallDeadlineAtMs + (input.interruptTimeoutMs ?? 5_000);
  let termination: "timed_out" | "cancelled" | undefined;
  const timeout = setTimeout(() => {
    termination = "timed_out";
    overall.abort("timed_out");
  }, input.overallTimeoutMs);
  const cancel = (): void => {
    termination = "cancelled";
    overall.abort("cancelled");
  };
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener("abort", cancel, { once: true });

  let runtime: ShuvcodeRuntime | undefined;
  let startingRuntime: Promise<ShuvcodeRuntime> | undefined;
  let unsubscribe = (): void => {};
  const captures = new Map<string, SessionCapture>();
  const allCaptures: SessionCapture[] = [];
  const rejectedSamples: RejectedResultSample[] = [];
  const heartbeatTimer = eventClock.setInterval(() => {
    const now = eventClock.now();
    for (const capture of captures.values()) {
      const events = capture.accumulator.heartbeatIfQuiet(now, HEARTBEAT_QUIET_MS);
      appendRuntimeEvents(log, events);
      for (const event of events) progress.emitLogEvent(event, now, capture);
    }
  }, HEARTBEAT_POLL_MS);
  const specialistSessionIds = new Map<BuiltInReviewerId, Map<number, string>>();
  let coordinatorSessionId = "coordinator";
  let specialistResults: ReviewerResult[] = [];
  let specialistRecords: readonly SessionTaskRecord<ReviewerResult>[] = [];
  let result: CoordinatorEngineResult;
  const cleanupErrors: ClassifiedReviewError[] = [];

  try {
    startingRuntime = input.runtimeFactory({ signal: overall.signal });
    runtime = await raceAbort(startingRuntime, overall.signal);
    unsubscribe = runtime.subscribe((event) =>
      captureRuntimeEvent(event, captures, log, eventClock)
    );

    const coordinator = await raceAbort(
      // No agent is selected: shuvbot supplies every instruction in its own
      // prompts, and tool authorization comes from the server-enforced session
      // policy. Naming an agent would require one to exist in the user's runtime
      // profile, which fails the whole review with `Agent not found`.
      runtime.createSession({
        title: "shuvbot coordinator",
        model: modelFor(input.models.coordinator),
        location: { directory: input.workspace.root }
      }),
      overall.signal
    );
    coordinatorSessionId = coordinator.id;

    const reviewers = input.plan.assignment.reviewers.map(({ reviewer }) => reviewer);
    const scopedWorkspaces = new Map(
      await Promise.all(
        reviewers.map(
          async (reviewer) => [reviewer, await createReviewerWorkspace(input, reviewer)] as const
        )
      )
    );
    const tasks = reviewers.map(
      (reviewer): SessionTask<ReviewerResult> =>
        createSpecialistTask({
          reviewer,
          input,
          runtime: runtime!,
          modelFor,
          rejectedSamples,
          captures,
          allCaptures,
          specialistSessionIds,
          log,
          eventClock,
          progress,
          scopedWorkspace: scopedWorkspaces.get(reviewer)!
        })
    );
    specialistRecords = await runSessionTasks(tasks, {
      maxConcurrency: input.plan.maxConcurrency,
      taskTimeoutMs: input.specialistTimeoutMs,
      ...(input.interruptTimeoutMs === undefined
        ? {}
        : { interruptTimeoutMs: input.interruptTimeoutMs }),
      signal: overall.signal,
      onTransition(reviewer, transition) {
        logSpecialistTransition(
          log,
          input,
          reviewer as BuiltInReviewerId,
          transition,
          specialistSessionIds,
          captures,
          progress
        );
      }
    });

    specialistResults = specialistRecords.map((record) => reviewerResultFromRecord(record));
    const specialistInputs = await persistSpecialistResults(
      input.workspace,
      specialistResults,
      input.fileSystem ?? defaultFileSystem,
      overallDeadlineAtMs
    );

    if (overall.signal.aborted) {
      result = degradedEngineResult({
        input,
        log,
        termination: termination ?? "cancelled",
        coordinatorSessionId,
        specialistRecords,
        specialistResults,
        specialistSessionIds,
        allCaptures
      });
    } else {
      const prepared = prepareCoordinator({
        tier: input.plan.risk.tier,
        workspaceRoot: input.workspace.root,
        manifestPath: input.workspace.manifestPath,
        sharedContextPath: input.workspace.sharedContextPath,
        previousFindingsPath: input.workspace.previousFindingsPath,
        scheduledReviewers: reviewers,
        specialistResults: specialistInputs
      });
      const finalized = await runCoordinator({
        input,
        runtime,
        sessionID: coordinator.id,
        prepared,
        log,
        rejectedSamples,
        captures,
        allCaptures,
        signal: overall.signal,
        eventClock,
        progress
      });
      const coordinatorUsage = sumCaptureUsage(
        allCaptures.filter(({ role }) => role === "coordinator")
      );
      const specialistRepairCount = countSpecialistRepairs(allCaptures);
      const sessions = sessionSummaries(
        input,
        specialistRecords,
        specialistSessionIds,
        allCaptures,
        coordinator.id,
        "completed",
        coordinatorUsage
      ).map((session) =>
        session.role === "coordinator" && finalized.repairAttempted
          ? { ...session, retryCount: 1, repairAttempted: true }
          : session
      );
      result = {
        status: "completed",
        result: finalized.result,
        quorum: finalized.quorum,
        coverage: finalized.coverage,
        specialistResults,
        sessions,
        retries:
          retryCount(specialistRecords) +
          specialistRepairCount +
          (finalized.repairAttempted ? 1 : 0),
        events: log.snapshot(),
        repairAttempted: specialistRepairCount > 0 || finalized.repairAttempted
      };
    }
  } catch (error) {
    const coordinatorError = error instanceof CoordinatorExecutionError ? error : undefined;
    const status = termination ?? coordinatorError?.status ?? "failed";
    const classified =
      coordinatorError?.classified ??
      classifyAndRedact(error, status, overall.signal, input.redactor);
    result = degradedEngineResult({
      input,
      log,
      termination: status,
      coordinatorSessionId,
      specialistRecords,
      specialistResults,
      specialistSessionIds,
      error: classified,
      coordinatorRepairAttempted: coordinatorError?.repairAttempted ?? false,
      allCaptures
    });
  } finally {
    eventClock.clearInterval(heartbeatTimer);
    input.signal?.removeEventListener("abort", cancel);
    unsubscribe();
    const cleanupError = await closeRuntimeWithinBudget(
      runtime,
      runtime === undefined ? startingRuntime : undefined,
      remainingMs(cleanupDeadlineAtMs),
      input.redactor
    );
    if (cleanupError !== undefined) cleanupErrors.push(cleanupError);
  }

  if (cleanupErrors.length > 0) result = withCleanupErrors(result, cleanupErrors);

  if (input.artifactDirectory !== undefined) {
    try {
      await flushEngineArtifacts(
        input.artifactDirectory,
        input.workspace.root,
        log,
        result,
        input,
        overallDeadlineAtMs,
        rejectedSamples
      );
      result = {
        ...result,
        artifacts: { directory: resolve(input.artifactDirectory), status: "written" }
      };
    } catch (error) {
      const artifactError = input.redactor.redact(
        classifyReviewError({
          category: termination === "timed_out" ? "service" : "config",
          message: `Review artifacts could not be written: ${error instanceof Error ? error.message : String(error)}`
        })
      );
      result = {
        ...result,
        artifacts: {
          directory: resolve(input.artifactDirectory),
          status: "failed",
          error: artifactError
        }
      };
    }
  }
  const workspaceCleanupError = await cleanupWorkspaceWithinBudget(
    input.workspace,
    remainingMs(cleanupDeadlineAtMs),
    input.redactor
  );
  if (workspaceCleanupError !== undefined) {
    cleanupErrors.push(workspaceCleanupError);
    result = withCleanupErrors(result, cleanupErrors);
  }
  if (termination === "timed_out" && result.status === "completed") {
    result = {
      ...result,
      status: "timed_out",
      error: input.redactor.redact(
        classifyReviewError({
          category: "service",
          message: "Coordinator review exceeded its overall deadline during persistence or cleanup"
        })
      )
    };
  }
  clearTimeout(timeout);
  return result;
}

function createSpecialistTask(options: {
  reviewer: BuiltInReviewerId;
  input: ExecuteCoordinatorEngineInput;
  runtime: ShuvcodeRuntime;
  modelFor: (ref: ModelRef) => ShuvcodeModel;
  rejectedSamples: RejectedResultSample[];
  captures: Map<string, SessionCapture>;
  allCaptures: SessionCapture[];
  specialistSessionIds: Map<BuiltInReviewerId, Map<number, string>>;
  log: ReviewSessionLog;
  eventClock: CoordinatorEngineEventClock;
  progress: EngineProgressEmitter;
  scopedWorkspace: ScopedReviewWorkspace;
}): SessionTask<ReviewerResult> {
  let activeSessionID: string | undefined;
  const definition = options.input.pluginConfig.reviewers.find(
    ({ id }) => id === options.reviewer
  )!;
  return {
    id: options.reviewer,
    async run(context) {
      try {
        const session = await options.runtime.createSession({
          title: `shuvbot ${options.reviewer}`,
          location: { directory: options.input.workspace.root },
          policy: specialistSessionPolicy(definition.tools)
        });
        activeSessionID = session.id;
        const reviewerSessions = options.specialistSessionIds.get(options.reviewer) ?? new Map();
        reviewerSessions.set(context.attempt, session.id);
        options.specialistSessionIds.set(options.reviewer, reviewerSessions);
        const startedAtMs = options.eventClock.now();
        const capture = createCapture({
          sessionId: session.id,
          role: "specialist",
          reviewer: options.reviewer,
          model: specialistModel(options.input, options.reviewer),
          attempt: context.attempt,
          startedAtMs,
          hardDeadlineAtMs: startedAtMs + Math.max(0, context.deadline - Date.now())
        });
        options.captures.set(session.id, capture);
        options.allCaptures.push(capture);
        if (context.attempt > 1) {
          appendLogEvent(options.log, capture, "session.retrying");
        }
        appendLogEvent(options.log, capture, "session.started");
        options.progress.emit("running", capture, startedAtMs);
        await options.runtime.configureSession(session.id, {
          model: options.modelFor(specialistModel(options.input, options.reviewer))
        });
        const prompt = buildSpecialistPrompt(options.reviewer, {
          manifestPath: options.scopedWorkspace.manifestPath,
          sharedContextPath: options.input.workspace.sharedContextPath,
          patchesDirectory: options.scopedWorkspace.patchesDir,
          contentsDirectory: options.scopedWorkspace.contentsDir,
          repositoryAdditions: definition.promptSections.map(({ content }) => content)
        });
        const runPrompt = async (text: string): Promise<unknown> => {
          await options.runtime.prompt({
            sessionID: session.id,
            text,
            output: { schema: reviewerJsonSchema, name: "ReviewerResult" },
            metadata: { reviewer: options.reviewer }
          });
          const event = await options.runtime.wait(session.id, { signal: context.signal });
          appendRuntimeEvents(
            options.log,
            capture.accumulator.ingest(event, options.eventClock.now())
          );
          return eventValue(event);
        };
        const firstOutput = await runPrompt(prompt);
        let parsed: ReviewerResult;
        try {
          parsed = parseSpecialistOutput(firstOutput, options.reviewer);
        } catch (validationError) {
          recordRejectedResult(options.rejectedSamples, options.input.redactor, {
            role: "specialist",
            reviewer: options.reviewer,
            sessionId: session.id,
            attempt: context.attempt,
            repair: false,
            error: validationError,
            value: firstOutput
          });
          capture.repairAttempted = true;
          appendLogEvent(options.log, capture, "session.retrying");
          const repairOutput = await runPrompt(
            `${prompt}\n\nYour previous JSON failed structured result validation: ${options.input.redactor.redactString(String(validationError))}\nReturn one corrected JSON value only.`
          );
          try {
            parsed = parseSpecialistOutput(repairOutput, options.reviewer);
          } catch (repairError) {
            recordRejectedResult(options.rejectedSamples, options.input.redactor, {
              role: "specialist",
              reviewer: options.reviewer,
              sessionId: session.id,
              attempt: context.attempt,
              repair: true,
              error: repairError,
              value: repairOutput
            });
            throw repairError;
          }
        }
        const value =
          parsed.usage === undefined && captureUsage(capture) !== undefined
            ? parseReviewerResult({ ...parsed, usage: captureUsage(capture) })
            : parsed;
        appendCompletedLog(options.log, capture, options.eventClock.now());
        return { status: "completed", value, ...(value.usage ? { usage: value.usage } : {}) };
      } catch (error) {
        const capture =
          activeSessionID === undefined ? undefined : options.captures.get(activeSessionID);
        const captured = captureError(capture);
        const usage = captureUsage(capture);
        const classified =
          captured ?? classifyAndRedact(error, "failed", context.signal, options.input.redactor);
        recordFailedSession(options.rejectedSamples, options.input.redactor, {
          role: "specialist",
          reviewer: options.reviewer,
          ...(activeSessionID === undefined ? {} : { sessionId: activeSessionID }),
          attempt: context.attempt,
          error,
          classified
        });
        if (capture !== undefined && captureOutcome(capture) !== "failed") {
          options.log.append({
            event: "session.failed",
            sessionId: capture.id,
            role: "specialist",
            reviewer: options.reviewer,
            model: capture.model,
            attempt: capture.attempt,
            ...(usage === undefined ? {} : { usage: toLogUsage(usage) }),
            error: {
              code: classified.code,
              message: classified.message,
              retryable: classified.retryable
            }
          });
        }
        return {
          status: "failed",
          error: classified,
          ...(usage === undefined ? {} : { usage })
        };
      }
    },
    async interrupt() {
      if (activeSessionID !== undefined) await options.runtime.interrupt(activeSessionID);
    }
  };
}

async function runCoordinator(options: {
  input: ExecuteCoordinatorEngineInput;
  runtime: ShuvcodeRuntime;
  sessionID: string;
  prepared: ReturnType<typeof prepareCoordinator>;
  log: ReviewSessionLog;
  rejectedSamples: RejectedResultSample[];
  captures: Map<string, SessionCapture>;
  allCaptures: SessionCapture[];
  signal: AbortSignal;
  eventClock: CoordinatorEngineEventClock;
  progress: EngineProgressEmitter;
}): Promise<FinalizedCoordinator> {
  const controller = new AbortController();
  const removeAbort = forwardAbort(options.signal, controller);
  const timer = setTimeout(() => controller.abort(), options.input.coordinatorTimeoutMs);
  const hardDeadlineAtMs = options.eventClock.now() + options.input.coordinatorTimeoutMs;
  const model = options.input.models.coordinator;
  let attempt = 1;
  const prompt = async (text: string): Promise<unknown> => {
    const capture = createCapture({
      sessionId: options.sessionID,
      role: "coordinator",
      model,
      attempt,
      startedAtMs: options.eventClock.now(),
      hardDeadlineAtMs
    });
    options.captures.set(options.sessionID, capture);
    options.allCaptures.push(capture);
    if (attempt > 1) appendLogEvent(options.log, capture, "session.retrying");
    appendLogEvent(options.log, capture, "session.started");
    options.progress.emit("running", capture, options.eventClock.now());
    await options.runtime.prompt({
      sessionID: options.sessionID,
      text,
      output: { schema: coordinatorJsonSchema, name: "CoordinatorResult" },
      metadata: { role: "coordinator" }
    });
    const event = await options.runtime.wait(options.sessionID, { signal: controller.signal });
    appendRuntimeEvents(options.log, capture.accumulator.ingest(event, options.eventClock.now()));
    return eventValue(event);
  };
  try {
    const output = await prompt(options.prepared.prompt);
    let repairedOutput: unknown;
    let repaired = false;
    let finalized: FinalizedCoordinator;
    try {
      finalized = await finalizeCoordinator({
        prepared: options.prepared,
        output,
        repair: async ({ validationError, invalidOutput }) => {
          recordRejectedResult(options.rejectedSamples, options.input.redactor, {
            role: "coordinator",
            sessionId: options.sessionID,
            attempt: 1,
            repair: false,
            error: validationError,
            value: invalidOutput
          });
          attempt = 2;
          repaired = true;
          repairedOutput = await prompt(
            `${options.prepared.prompt}\n\nYour previous JSON failed schema validation: ${options.input.redactor.redactString(String(validationError))}\nReturn one corrected JSON value only.`
          );
          return repairedOutput;
        }
      });
    } catch (finalizeError) {
      if (repaired) {
        recordRejectedResult(options.rejectedSamples, options.input.redactor, {
          role: "coordinator",
          sessionId: options.sessionID,
          attempt: 2,
          repair: true,
          error: finalizeError,
          value: repairedOutput
        });
      }
      throw finalizeError;
    }
    const capture = options.captures.get(options.sessionID);
    if (capture !== undefined) {
      const usage = captureUsage(capture);
      appendCompletedLog(options.log, capture, options.eventClock.now());
      options.progress.emit("completed", capture, options.eventClock.now(), {
        ...(usage === undefined ? {} : { usage })
      });
    }
    return finalized;
  } catch (error) {
    const timedOut =
      (controller.signal.aborted && !options.signal.aborted) ||
      (options.signal.aborted && options.signal.reason === "timed_out");
    await settleWithin(
      options.runtime.interrupt(options.sessionID),
      options.input.interruptTimeoutMs ?? 5_000
    );
    const classified =
      (!timedOut && captureError(options.captures.get(options.sessionID))) ||
      classifyAndRedact(
        error,
        timedOut ? "timed_out" : "failed",
        controller.signal,
        options.input.redactor
      );
    recordFailedSession(options.rejectedSamples, options.input.redactor, {
      role: "coordinator",
      sessionId: options.sessionID,
      attempt,
      error,
      classified
    });
    if (
      timedOut ||
      !["failed", "cancelled"].includes(captureOutcome(options.captures.get(options.sessionID)))
    ) {
      options.log.append({
        event: timedOut
          ? "session.timed_out"
          : options.signal.aborted
            ? "session.cancelled"
            : "session.failed",
        sessionId: options.sessionID,
        role: "coordinator",
        model,
        attempt,
        error: classified
      });
    }
    const status = timedOut ? "timed_out" : options.signal.aborted ? "cancelled" : "failed";
    const capture = options.captures.get(options.sessionID);
    if (capture !== undefined) {
      options.progress.emit(status, capture, options.eventClock.now(), { error: classified });
    }
    throw new CoordinatorExecutionError(status, classified, attempt > 1, { cause: error });
  } finally {
    clearTimeout(timer);
    removeAbort();
  }
}

async function persistSpecialistResults(
  workspace: ReviewWorkspace,
  results: readonly ReviewerResult[],
  fileSystem: CoordinatorEngineFileSystem,
  deadlineAtMs: number
): Promise<CoordinatorSpecialistResult[]> {
  const directory = join(workspace.root, "results");
  await runWithinDeadline(
    () => fileSystem.mkdir(directory, { recursive: true, mode: 0o700 }),
    deadlineAtMs,
    "specialist result directory creation"
  );
  return Promise.all(
    results.map(async (result) => {
      const validated = parseReviewerResult(result);
      const resultPath = join(directory, `${validated.reviewer}.json`);
      await runWithinDeadline(
        () =>
          fileSystem.writeFile(resultPath, `${JSON.stringify(validated, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
          }),
        deadlineAtMs,
        "specialist result write"
      );
      return { reviewer: validated.reviewer, resultPath, result: validated };
    })
  );
}

function reviewerResultFromRecord(record: SessionTaskRecord<ReviewerResult>): ReviewerResult {
  if (record.status === "completed") return parseReviewerResult(record.value);
  const error =
    record.error ?? classifyReviewError({ category: "service", message: "Session failed" });
  return parseReviewerResult({
    reviewer: record.id,
    status: record.status === "timed_out" ? "timed_out" : "failed",
    summary: error.message,
    findings: [],
    ...(record.usage === undefined ? {} : { usage: record.usage }),
    error
  });
}

function degradedEngineResult(options: {
  input: ExecuteCoordinatorEngineInput;
  log: ReviewSessionLog;
  termination: "failed" | "timed_out" | "cancelled";
  coordinatorSessionId: string;
  specialistRecords: readonly SessionTaskRecord<ReviewerResult>[];
  specialistResults: readonly ReviewerResult[];
  specialistSessionIds: ReadonlyMap<BuiltInReviewerId, ReadonlyMap<number, string>>;
  error?: ClassifiedReviewError;
  coordinatorRepairAttempted?: boolean;
  allCaptures?: readonly SessionCapture[];
}): CoordinatorEngineResult {
  const scheduled = options.input.plan.assignment.reviewers.map(({ reviewer }) => reviewer);
  const completed = options.specialistResults
    .filter(({ status }) => status === "completed")
    .map(({ reviewer }) => reviewer);
  const timedOut = options.specialistResults
    .filter(({ status }) => status === "timed_out")
    .map(({ reviewer }) => reviewer);
  const failed = scheduled.filter(
    (reviewer) => !completed.includes(reviewer) && !timedOut.includes(reviewer)
  );
  const quorum = evaluateQuorum({
    tier: options.input.plan.risk.tier,
    coordinatorSucceeded: false,
    scheduledReviewers: scheduled,
    successfulReviewers: completed
  });
  const coverage: ReviewCoverage = {
    scheduled,
    completed,
    failed,
    timedOut,
    required:
      options.input.plan.risk.tier === "full" ? ["code-quality", "security"] : ["code-quality"],
    quorumMet: false
  };
  const result = parseCoordinatorResult({
    decision: "degraded",
    findings: [],
    dropped: [],
    coverage,
    summary:
      "Coordinator review did not complete; specialist coverage is reported without claiming a clean review."
  });
  const error =
    options.error ??
    classifyReviewError({
      category: options.termination === "cancelled" ? "cancellation" : "service",
      message:
        options.termination === "timed_out"
          ? "Coordinator review exceeded its overall deadline"
          : options.termination === "cancelled"
            ? "Coordinator review was cancelled"
            : "Coordinator review failed"
    });
  const specialistRepairCount = countSpecialistRepairs(options.allCaptures ?? []);
  const coordinatorUsage = sumCaptureUsage(
    (options.allCaptures ?? []).filter(({ role }) => role === "coordinator")
  );
  return {
    status: options.termination,
    result,
    quorum,
    coverage,
    specialistResults: options.specialistResults,
    sessions: sessionSummaries(
      options.input,
      options.specialistRecords,
      options.specialistSessionIds,
      options.allCaptures ?? [],
      options.coordinatorSessionId,
      options.termination,
      coordinatorUsage,
      error
    ).map((session) =>
      session.role === "coordinator" && options.coordinatorRepairAttempted
        ? { ...session, retryCount: 1, repairAttempted: true }
        : session
    ),
    retries:
      retryCount(options.specialistRecords) +
      specialistRepairCount +
      (options.coordinatorRepairAttempted ? 1 : 0),
    events: options.log.snapshot(),
    error,
    repairAttempted: specialistRepairCount > 0 || options.coordinatorRepairAttempted === true
  };
}

function sessionSummaries(
  input: ExecuteCoordinatorEngineInput,
  records: readonly SessionTaskRecord<ReviewerResult>[],
  specialistSessionIds: ReadonlyMap<BuiltInReviewerId, ReadonlyMap<number, string>>,
  captures: readonly SessionCapture[],
  coordinatorSessionId: string,
  coordinatorStatus: "completed" | "failed" | "timed_out" | "cancelled",
  coordinatorUsage?: Usage,
  coordinatorError?: ClassifiedReviewError
): CoordinatorEngineSessionSummary[] {
  const summaries = records.flatMap((record): CoordinatorEngineSessionSummary[] => {
    const reviewer = record.id as BuiltInReviewerId;
    const model = specialistModel(input, reviewer);
    if (record.attempts.length === 0) {
      return [
        {
          sessionId: `specialist:${reviewer}`,
          role: "specialist",
          reviewer,
          model,
          status: record.status,
          retryCount: 0,
          ...(record.error === undefined ? {} : { error: record.error })
        }
      ];
    }
    return record.attempts.map((attempt) => {
      const sessionId =
        specialistSessionIds.get(reviewer)?.get(attempt.attempt) ??
        `specialist:${reviewer}:${attempt.attempt}`;
      const repairAttempted = captures.some(
        (capture) => capture.id === sessionId && capture.repairAttempted
      );
      // A timed-out or cancelled attempt never reports usage: the scheduler
      // abandons the losing side of the race, so whatever the task consumed
      // before it was cut off is discarded. The capture accumulated it anyway,
      // and those sessions are the expensive ones - trusting the attempt alone
      // understated a real run's cost by more than an order of magnitude.
      const usage =
        attempt.usage ?? captureUsage(captures.find((capture) => capture.id === sessionId));
      return {
        sessionId,
        role: "specialist",
        reviewer,
        model,
        status: attempt.status,
        retryCount: repairAttempted ? 1 : 0,
        attempt: attempt.attempt,
        ...(repairAttempted ? { repairAttempted: true } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(attempt.error === undefined ? {} : { error: attempt.error })
      };
    });
  });
  summaries.push({
    sessionId: coordinatorSessionId,
    role: "coordinator",
    model: input.models.coordinator,
    status: coordinatorStatus,
    retryCount: 0,
    ...(coordinatorUsage === undefined ? {} : { usage: coordinatorUsage }),
    ...(coordinatorError === undefined ? {} : { error: coordinatorError })
  });
  return summaries;
}

function logSpecialistTransition(
  log: ReviewSessionLog,
  input: ExecuteCoordinatorEngineInput,
  reviewer: BuiltInReviewerId,
  transition: SessionTaskTransition,
  specialistSessionIds: ReadonlyMap<BuiltInReviewerId, ReadonlyMap<number, string>>,
  captures: ReadonlyMap<string, SessionCapture>,
  progress: EngineProgressEmitter
): void {
  if (transition.status === "queued") {
    appendLog(log, input, reviewer, "session.queued", 1);
    progress.emitQueued(input, reviewer, progress.now());
    return;
  }
  if (transition.status === "running") return;
  const sessionId = specialistSessionIds.get(reviewer)?.get(Math.max(1, transition.attempt));
  const capture = sessionId === undefined ? undefined : captures.get(sessionId);
  if (capture !== undefined) {
    const usage = captureUsage(capture);
    const error = captureError(capture);
    progress.emit(transition.status, capture, progress.now(), {
      ...(usage === undefined ? {} : { usage }),
      ...(error === undefined ? {} : { error })
    });
  }
  if (captureOutcome(capture) !== "running") return;
  const event = `session.${transition.status}` as ReviewSessionLogEvent["event"];
  if (capture !== undefined) appendLogEvent(log, capture, event);
  else appendLog(log, input, reviewer, event, Math.max(1, transition.attempt));
}

function appendLog(
  log: ReviewSessionLog,
  input: ExecuteCoordinatorEngineInput,
  reviewer: BuiltInReviewerId,
  event: ReviewSessionLogEvent["event"],
  attempt: number
): void {
  log.append({
    event,
    sessionId: `specialist:${reviewer}`,
    role: "specialist",
    reviewer,
    model: specialistModel(input, reviewer),
    attempt
  });
}

function captureRuntimeEvent(
  event: ShuvcodeEvent,
  captures: ReadonlyMap<string, SessionCapture>,
  log: ReviewSessionLog,
  clock: CoordinatorEngineEventClock
): void {
  const sessionID = event.data?.sessionID;
  if (sessionID === undefined) return;
  const capture = captures.get(sessionID);
  if (capture === undefined) return;
  appendRuntimeEvents(log, capture.accumulator.ingest(event, clock.now()));
}

function eventValue(event: ShuvcodeEvent): unknown {
  if (
    event.type !== "session.structured.completed" ||
    event.data === undefined ||
    !("value" in event.data)
  ) {
    throw classifyReviewError({
      category: "schema",
      message: "Session completed without a structured result value"
    });
  }
  return event.data.value;
}

function createCapture(options: {
  sessionId: string;
  role: "coordinator" | "specialist";
  reviewer?: BuiltInReviewerId;
  model: string;
  attempt: number;
  startedAtMs: number;
  hardDeadlineAtMs: number;
}): SessionCapture {
  return {
    id: options.sessionId,
    role: options.role,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    model: options.model,
    attempt: options.attempt,
    repairAttempted: false,
    startedAtMs: options.startedAtMs,
    accumulator: new ShuvcodeSessionEventAccumulator({
      sessionId: options.sessionId,
      role: options.role,
      ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      model: options.model,
      attempt: options.attempt,
      startedAtMs: options.startedAtMs,
      hardDeadlineAtMs: options.hardDeadlineAtMs
    })
  };
}

function appendLogEvent(
  log: ReviewSessionLog,
  capture: SessionCapture,
  event: ReviewSessionLogEvent["event"]
): void {
  log.append({
    event,
    sessionId: capture.id,
    role: capture.role,
    ...(capture.reviewer === undefined ? {} : { reviewer: capture.reviewer }),
    model: capture.model,
    attempt: capture.attempt
  });
}

function appendRuntimeEvents(
  log: ReviewSessionLog,
  events: readonly Parameters<ReviewSessionLog["append"]>[0][]
): void {
  for (const event of events) {
    // Runtime structured completion is transport-level; validation/provenance decides success.
    if (event.event !== "session.completed") log.append(event);
  }
}

function appendCompletedLog(
  log: ReviewSessionLog,
  capture: SessionCapture,
  completedAtMs: number
): void {
  const usage = captureUsage(capture);
  log.append({
    event: "session.completed",
    sessionId: capture.id,
    role: capture.role,
    ...(capture.reviewer === undefined ? {} : { reviewer: capture.reviewer }),
    model: capture.model,
    attempt: capture.attempt,
    durationMs: Math.max(0, completedAtMs - capture.startedAtMs),
    ...(usage === undefined ? {} : { usage: toLogUsage(usage) })
  });
}

function captureUsage(capture: SessionCapture | undefined): Usage | undefined {
  return capture?.accumulator.snapshot().outcome.usage;
}

function toLogUsage(usage: Usage): NonNullable<ReviewSessionLogEvent["usage"]> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cost === undefined ? {} : { cost: usage.cost })
  };
}

function captureError(capture: SessionCapture | undefined): ClassifiedReviewError | undefined {
  const outcome = capture?.accumulator.snapshot().outcome;
  return outcome?.status === "failed" || outcome?.status === "cancelled"
    ? outcome.error
    : undefined;
}

function captureOutcome(
  capture: SessionCapture | undefined
): "running" | "completed" | "failed" | "cancelled" {
  return capture?.accumulator.snapshot().outcome.status ?? "running";
}

function parseSpecialistOutput(output: unknown, reviewer: BuiltInReviewerId): ReviewerResult {
  const parsed = parseReviewerResult(output);
  if (parsed.reviewer !== reviewer) {
    throw new TypeError(
      `specialist result reviewer mismatch: expected ${reviewer}, received ${parsed.reviewer}`
    );
  }
  return parsed;
}

function countSpecialistRepairs(captures: readonly SessionCapture[]): number {
  return captures.filter(({ role, repairAttempted }) => role === "specialist" && repairAttempted)
    .length;
}

function sumCaptureUsage(captures: readonly SessionCapture[]): Usage | undefined {
  const usages = captures.flatMap((capture) => {
    const usage = captureUsage(capture);
    return usage === undefined ? [] : [usage];
  });
  if (usages.length === 0) return undefined;
  const costs = usages.flatMap(({ cost }) => (cost === undefined ? [] : [cost]));
  return {
    inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
    outputTokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
    ...(costs.length === 0 ? {} : { cost: costs.reduce((total, cost) => total + cost, 0) })
  };
}

class EngineProgressEmitter {
  private readonly statuses = new Map<
    BuiltInReviewerId,
    CoordinatorEngineProgressEvent["status"]
  >();

  constructor(private readonly input: ExecuteCoordinatorEngineInput) {
    for (const { reviewer } of input.plan.assignment.reviewers) {
      this.statuses.set(reviewer, "queued");
    }
  }

  now(): number {
    return (this.input.eventClock ?? defaultEventClock).now();
  }

  emitQueued(
    input: ExecuteCoordinatorEngineInput,
    reviewer: BuiltInReviewerId,
    atMs: number
  ): void {
    this.emitValue({
      status: "queued",
      sessionId: `specialist:${reviewer}`,
      role: "specialist",
      reviewer,
      model: specialistModel(input, reviewer),
      attempt: 1,
      atMs
    });
  }

  emit(
    status: CoordinatorEngineProgressEvent["status"],
    capture: SessionCapture,
    atMs: number,
    extra: {
      readonly usage?: Usage;
      readonly error?: ClassifiedReviewError;
    } = {}
  ): void {
    const snapshot = capture.accumulator.snapshot();
    this.emitValue({
      status,
      sessionId: capture.id,
      role: capture.role,
      ...(capture.reviewer === undefined ? {} : { reviewer: capture.reviewer }),
      model: capture.model,
      attempt: capture.attempt,
      atMs,
      deadlineAtMs: snapshot.hardDeadlineAtMs,
      durationMs: Math.max(0, atMs - capture.startedAtMs),
      ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      ...(extra.error === undefined ? {} : { error: extra.error })
    });
  }

  emitLogEvent(
    event: Omit<ReviewSessionLogEvent, "time">,
    atMs: number,
    capture: SessionCapture
  ): void {
    if (event.event !== "session.heartbeat") return;
    this.emit("heartbeat", capture, atMs);
  }

  private emitValue(value: Omit<CoordinatorEngineProgressEvent, "coverage">): void {
    if (value.reviewer !== undefined && value.status !== "heartbeat") {
      this.statuses.set(value.reviewer, value.status);
    }
    const scheduled = [...this.statuses.keys()];
    const reviewersWith = (status: CoordinatorEngineProgressEvent["status"]): BuiltInReviewerId[] =>
      scheduled.filter((reviewer) => this.statuses.get(reviewer) === status);
    const event = this.input.redactor.redact({
      ...value,
      coverage: {
        scheduled,
        completed: reviewersWith("completed"),
        failed: reviewersWith("failed"),
        timedOut: reviewersWith("timed_out"),
        cancelled: reviewersWith("cancelled")
      }
    }) as CoordinatorEngineProgressEvent;
    try {
      const pending = this.input.onProgress?.(structuredClone(event));
      if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Presentation is deliberately isolated from review execution and deadlines.
    }
  }
}

async function flushEngineArtifacts(
  directory: string,
  workspaceRoot: string,
  log: ReviewSessionLog,
  result: CoordinatorEngineResult,
  input: ExecuteCoordinatorEngineInput,
  deadlineAtMs: number,
  rejectedSamples: readonly RejectedResultSample[] = []
): Promise<void> {
  const fileSystem = input.fileSystem ?? defaultFileSystem;
  const destination = resolve(directory);
  if (isInside(workspaceRoot, destination)) {
    throw new TypeError("artifact destination must be outside the temporary review workspace");
  }
  await runWithinDeadline(
    () => fileSystem.mkdir(destination, { recursive: true, mode: 0o700 }),
    deadlineAtMs,
    "artifact directory creation"
  );
  await log.flush(join(destination, "shuvbot-events.jsonl"), {
    ...fileSystem,
    deadlineAtMs
  });
  await writeAtomicJson(
    join(destination, "shuvbot-review-sessions.json"),
    input.redactor.redact({ version: 1, sessions: result.sessions }),
    fileSystem,
    deadlineAtMs
  );
  await writeAtomicJson(
    join(destination, "shuvbot-review-result.json"),
    input.redactor.redact({
      version: 1,
      status: result.status,
      decision: result.result.decision,
      coverage: result.coverage,
      quorum: result.quorum,
      retries: result.retries,
      repairAttempted: result.repairAttempted,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup })
    }),
    fileSystem,
    deadlineAtMs
  );
  if (rejectedSamples.length > 0) {
    await writeAtomicJson(
      join(destination, "shuvbot-rejected-results.json"),
      { version: 1, rejected: rejectedSamples },
      fileSystem,
      deadlineAtMs
    );
  }
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  fileSystem: CoordinatorEngineFileSystem,
  deadlineAtMs: number
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let writeOperation: ReturnType<CoordinatorEngineFileSystem["writeFile"]> | undefined;
  try {
    writeOperation = fileSystem.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await runWithinDeadline(() => writeOperation!, deadlineAtMs, "artifact write");
    await runWithinDeadline(
      () => fileSystem.rename(temporary, path),
      deadlineAtMs,
      "artifact rename"
    );
  } finally {
    if (writeOperation !== undefined) {
      void writeOperation
        .finally(() => fileSystem.rm(temporary, { force: true }))
        .catch(() => undefined);
    }
    await settleValueWithin(fileSystem.rm(temporary, { force: true }), 100).catch(() => undefined);
  }
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function parseModelRef(model: ModelRef): { id: string; providerID: string } {
  const separator = model.indexOf("/");
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
}

function specialistModel(
  input: ExecuteCoordinatorEngineInput,
  reviewer: BuiltInReviewerId
): ModelRef {
  const definition = input.pluginConfig.reviewers.find(({ id }) => id === reviewer)!;
  const assignment = input.plan.assignment.reviewers.find((item) => item.reviewer === reviewer)!;
  if (input.models.standard === undefined) return definition.model;
  if (definition.modelOverride === true) return definition.model;
  return assignment.modelTier === "light"
    ? (input.models.light ?? input.models.standard)
    : input.models.standard;
}

async function createReviewerWorkspace(
  input: ExecuteCoordinatorEngineInput,
  reviewer: BuiltInReviewerId
): Promise<ScopedReviewWorkspace> {
  const definition = input.pluginConfig.reviewers.find(({ id }) => id === reviewer)!;
  const included = new Set(
    input.plan.diff.entries.filter(({ included: keep }) => keep).map(({ path }) => path)
  );
  const paths = input.workspace.manifest.files
    .map(({ path }) => path)
    .filter((path) => included.has(path))
    .filter((path) => (definition.paths ?? ["**/*"]).some((pattern) => matchesGlob(path, pattern)))
    .filter(
      (path) => !(definition.ignorePaths ?? []).some((pattern) => matchesGlob(path, pattern))
    );
  return createScopedReviewWorkspace(input.workspace, reviewer, paths);
}

function classifyEngineError(
  error: unknown,
  status: "failed" | "timed_out" | "cancelled",
  signal: AbortSignal
): ClassifiedReviewError {
  const message = error instanceof Error ? error.message : String(error);
  if (status === "cancelled" || (signal.aborted && status !== "timed_out")) {
    return classifyReviewError({
      category: "cancellation",
      message: message || "Review cancelled"
    });
  }
  if (status === "timed_out") {
    return classifyReviewError({ category: "service", message: message || "Review timed out" });
  }
  if (isClassifiedError(error)) return error;
  if (
    error instanceof z.ZodError ||
    /schema|structured|validation|zod|reviewer mismatch|unsupported|source evidence|names unsuccessful/i.test(
      message
    )
  ) {
    return classifyReviewError({
      category: "schema",
      message: "Structured response was invalid"
    });
  }
  if (/auth|credential|unauthorized/i.test(message)) {
    return classifyReviewError({ category: "auth", message });
  }
  if (/rate.?limit|429/i.test(message)) {
    return classifyReviewError({ category: "rateLimit", message });
  }
  if (/context.*(?:overflow|length)|too many tokens/i.test(message)) {
    return classifyReviewError({ category: "context", message });
  }
  return classifyReviewError({
    category: "provider",
    message: message || "Review provider failed"
  });
}

function classifyAndRedact(
  error: unknown,
  status: "failed" | "timed_out" | "cancelled",
  signal: AbortSignal,
  redactor: Redactor
): ClassifiedReviewError {
  return redactor.redact(classifyEngineError(error, status, signal));
}

function isClassifiedError(value: unknown): value is ClassifiedReviewError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "category" in value &&
    "message" in value &&
    "retryable" in value
  );
}

function validateExecutionInputs(input: ExecuteCoordinatorEngineInput): void {
  if (!Object.isFrozen(input.plan)) throw new TypeError("review execution plan must be immutable");
  const configured = new Set(input.pluginConfig.reviewers.map(({ id }) => id));
  for (const { reviewer } of input.plan.assignment.reviewers) {
    if (!configured.has(reviewer))
      throw new TypeError(`missing resolved reviewer config: ${reviewer}`);
  }
  const readOnlyTools = new Set<string>(READ_ONLY_REVIEW_TOOLS);
  for (const reviewer of input.pluginConfig.reviewers) {
    if (reviewer.tools.some((tool) => !readOnlyTools.has(tool))) {
      throw new TypeError(`reviewer ${reviewer.id} has a non-read-only tool`);
    }
    validateConfiguredModel(input.pluginConfig, reviewer.model);
  }
  const configuredModels = [
    input.models.coordinator,
    ...(input.models.standard === undefined ? [] : [input.models.standard]),
    ...(input.models.light === undefined ? [] : [input.models.light])
  ];
  for (const model of configuredModels) validateConfiguredModel(input.pluginConfig, model);
}

/** Every review model reference that a session in this run could select. */
function configuredModelRefs(input: ExecuteCoordinatorEngineInput): readonly ModelRef[] {
  const refs = [input.models.coordinator];
  if (input.models.standard !== undefined) refs.push(input.models.standard);
  if (input.models.light !== undefined) refs.push(input.models.light);
  for (const { reviewer } of input.plan.assignment.reviewers) {
    refs.push(specialistModel(input, reviewer));
  }
  return [...new Set(refs)];
}

function validateConfiguredModel(config: ResolvedReviewPluginConfig, model: ModelRef): void {
  const parsed = parseModelRef(model);
  // A trailing `@<effort>` selects a reasoning effort rather than a different
  // model, so the catalog is matched on the model alone.
  const separator = parsed.id.indexOf("@");
  const id = separator === -1 ? parsed.id : parsed.id.slice(0, separator);
  const provider = config.providers.find(({ id: providerID }) => providerID === parsed.providerID);
  if (provider === undefined || !provider.models.includes(id)) {
    throw new TypeError(`review model is not in the configured provider catalog: ${model}`);
  }
}

function specialistSessionPolicy(tools: readonly string[]): ShuvcodeSessionPolicy {
  return tools.includes("filesystem.read") ? REVIEW_SESSION_POLICY : { tools: { allow: [] } };
}

function validateTimeout(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

function retryCount(records: readonly SessionTaskRecord<ReviewerResult>[]): number {
  return records.reduce((total, record) => total + Math.max(0, record.attempts.length - 1), 0);
}

function forwardAbort(source: AbortSignal, destination: AbortController): () => void {
  const abort = (): void => destination.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeRuntimeWithinBudget(
  runtime: ShuvcodeRuntime | undefined,
  startingRuntime: Promise<ShuvcodeRuntime> | undefined,
  timeoutMs: number,
  redactor: Redactor
): Promise<ClassifiedReviewError | undefined> {
  const deadline = Date.now() + timeoutMs;
  let target = runtime;
  if (target === undefined && startingRuntime !== undefined) {
    const startup = await settleValueWithin(startingRuntime, remainingMs(deadline));
    if (startup.status === "timed_out") {
      void startingRuntime.then((lateRuntime) => lateRuntime.close()).catch(() => undefined);
      return cleanupError("Review runtime startup cleanup timed out", redactor);
    }
    if (startup.status === "failed") return undefined;
    target = startup.value;
  }
  if (target === undefined) return undefined;
  const closed = await settleValueWithin(
    Promise.resolve().then(() => target!.close()),
    remainingMs(deadline)
  );
  if (closed.status === "completed") return undefined;
  return cleanupError(
    closed.status === "timed_out"
      ? "Review runtime cleanup timed out"
      : "Review runtime cleanup failed",
    redactor
  );
}

async function cleanupWorkspaceWithinBudget(
  workspace: ReviewWorkspace,
  timeoutMs: number,
  redactor: Redactor
): Promise<ClassifiedReviewError | undefined> {
  const cleaned = await settleValueWithin(
    Promise.resolve().then(() => workspace.cleanup()),
    timeoutMs
  );
  if (cleaned.status === "completed") return undefined;
  return cleanupError(
    cleaned.status === "timed_out"
      ? "Review workspace cleanup timed out"
      : "Review workspace cleanup failed",
    redactor
  );
}

async function settleValueWithin<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<
  { status: "completed"; value: T } | { status: "failed"; error: unknown } | { status: "timed_out" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ status: "completed", value }) as const,
        (error: unknown) => ({ status: "failed", error }) as const
      ),
      new Promise<{ status: "timed_out" }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ status: "timed_out" }), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function runWithinDeadline<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
  stage: string
): Promise<T> {
  const settled = await settleValueWithin(
    Promise.resolve().then(operation),
    remainingMs(deadlineAtMs)
  );
  if (settled.status === "completed") return settled.value;
  if (settled.status === "timed_out") throw new Error(`${stage} exceeded the overall deadline`);
  throw settled.error;
}

function cleanupError(message: string, redactor: Redactor): ClassifiedReviewError {
  return redactor.redact(classifyReviewError({ category: "service", message }));
}

function withCleanupErrors(
  result: CoordinatorEngineResult,
  errors: readonly ClassifiedReviewError[]
): CoordinatorEngineResult {
  return { ...result, cleanup: { status: "failed", errors: [...errors] } };
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Review cancelled");
  let remove = (): void => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new Error("Review cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    remove();
  }
}
