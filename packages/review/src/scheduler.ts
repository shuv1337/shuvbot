import {
  classifyReviewError,
  reviewRetryEligibility,
  type ClassifiedReviewError
} from "./errors.ts";
import type { Usage } from "./results.ts";

export type SessionTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface SessionTaskContext {
  readonly attempt: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  heartbeat(): void;
}

export type SessionTaskAttemptResult<T> =
  | { readonly status: "completed"; readonly value: T; readonly usage?: Usage }
  | {
      readonly status: "failed";
      readonly error: ClassifiedReviewError;
      readonly usage?: Usage;
    };

export interface SessionTask<T> {
  readonly id: string;
  run(context: SessionTaskContext): Promise<SessionTaskAttemptResult<T>>;
  interrupt?(): Promise<void> | void;
}

export interface SessionTaskTransition {
  readonly status: SessionTaskStatus;
  readonly at: number;
  readonly attempt: number;
}

export interface SessionTaskAttempt {
  readonly attempt: number;
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly usage?: Usage;
  readonly error?: ClassifiedReviewError;
}

export interface SessionTaskRecord<T> {
  readonly id: string;
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly attempts: readonly SessionTaskAttempt[];
  readonly transitions: readonly SessionTaskTransition[];
  readonly usage?: Usage;
  readonly error?: ClassifiedReviewError;
  readonly value?: T;
}

export interface SessionTaskRunnerOptions {
  readonly maxConcurrency?: number;
  readonly taskTimeoutMs: number;
  readonly interruptTimeoutMs?: number;
  readonly signal?: AbortSignal;
  onHeartbeat?(taskId: string, attempt: number): void;
  onTransition?(taskId: string, transition: SessionTaskTransition): void;
}

const DEFAULT_MAX_CONCURRENCY = 3;

function sumUsage(attempts: readonly SessionTaskAttempt[]): Usage | undefined {
  const usages = attempts.flatMap((attempt) =>
    attempt.usage === undefined ? [] : [attempt.usage]
  );
  if (usages.length === 0) return undefined;

  const inputTokens = usages.reduce((total, usage) => total + usage.inputTokens, 0);
  const outputTokens = usages.reduce((total, usage) => total + usage.outputTokens, 0);
  const costs = usages.flatMap((usage) => (usage.cost === undefined ? [] : [usage.cost]));
  return costs.length === 0
    ? { inputTokens, outputTokens }
    : { inputTokens, outputTokens, cost: costs.reduce((total, cost) => total + cost, 0) };
}

function asReviewError(error: unknown): ClassifiedReviewError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "category" in error &&
    "message" in error &&
    "retryable" in error
  ) {
    return error as ClassifiedReviewError;
  }
  return classifyReviewError({
    category: "config",
    message: error instanceof Error ? error.message : "Session task failed"
  });
}

export async function runSessionTasks<T>(
  tasks: readonly SessionTask<T>[],
  options: SessionTaskRunnerOptions
): Promise<readonly SessionTaskRecord<T>[]> {
  if (
    new Set(tasks.map((task) => task.id)).size !== tasks.length ||
    tasks.some((task) => !task.id.trim())
  ) {
    throw new Error("session task IDs must be non-empty and unique");
  }
  if (!Number.isFinite(options.taskTimeoutMs) || options.taskTimeoutMs <= 0) {
    throw new Error("taskTimeoutMs must be a positive finite number");
  }
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 5_000;
  if (!Number.isFinite(interruptTimeoutMs) || interruptTimeoutMs <= 0) {
    throw new Error("interruptTimeoutMs must be a positive finite number");
  }
  const requestedConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency <= 0) {
    throw new Error("maxConcurrency must be a positive integer");
  }
  const concurrency = Math.min(requestedConcurrency, DEFAULT_MAX_CONCURRENCY, tasks.length);
  const records: Array<SessionTaskRecord<T> | undefined> = new Array(tasks.length);
  const transitions = tasks.map<SessionTaskTransition[]>(() => []);
  let nextIndex = 0;
  let cleanupCompromised = false;

  const transition = (index: number, status: SessionTaskStatus, attempt: number): void => {
    const event = { status, at: Date.now(), attempt };
    transitions[index]?.push(event);
    const task = tasks[index];
    if (task !== undefined) options.onTransition?.(task.id, event);
  };

  for (let index = 0; index < tasks.length; index += 1) transition(index, "queued", 0);

  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      if (cleanupCompromised) return;
      const index = nextIndex++;
      const task = tasks[index];
      if (task === undefined) continue;
      if (options.signal?.aborted === true) {
        const error = classifyReviewError({
          category: "cancellation",
          message: "Session task cancelled"
        });
        transition(index, "cancelled", 0);
        records[index] = {
          id: task.id,
          status: "cancelled",
          attempts: [],
          transitions: transitions[index] ?? [],
          error
        };
        continue;
      }

      const deadline = Date.now() + options.taskTimeoutMs;
      const attempts: SessionTaskAttempt[] = [];
      let attempt = 1;
      let value: T | undefined;
      let finalStatus: SessionTaskRecord<T>["status"] = "failed";
      let finalError: ClassifiedReviewError | undefined;

      while (true) {
        transition(index, "running", attempt);
        const controller = new AbortController();
        const remainingMs = Math.max(0, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        let removeCancellation = (): void => {};
        const terminal = new Promise<"timed_out" | "cancelled">((resolve) => {
          timer = setTimeout(() => resolve("timed_out"), remainingMs);
          if (options.signal !== undefined) {
            const cancel = (): void => resolve("cancelled");
            if (options.signal.aborted) {
              cancel();
            } else {
              options.signal.addEventListener("abort", cancel, { once: true });
              removeCancellation = () => options.signal?.removeEventListener("abort", cancel);
            }
          }
        });
        const execution = Promise.resolve()
          .then(() =>
            task.run({
              attempt,
              deadline,
              signal: controller.signal,
              heartbeat: () => options.onHeartbeat?.(task.id, attempt)
            })
          )
          .catch(
            (error): SessionTaskAttemptResult<T> => ({
              status: "failed",
              error: asReviewError(error)
            })
          );
        const outcome = await Promise.race([execution, terminal]);
        if (timer !== undefined) clearTimeout(timer);
        removeCancellation();

        if (outcome === "timed_out" || outcome === "cancelled") {
          controller.abort();
          const interrupted = await interruptTask(task, interruptTimeoutMs);
          if (!interrupted) cleanupCompromised = true;
          finalStatus = outcome;
          finalError = classifyReviewError({
            category: outcome === "cancelled" ? "cancellation" : "service",
            message: outcome === "cancelled" ? "Session task cancelled" : "Session task timed out"
          });
          attempts.push({ attempt, status: outcome, error: finalError });
          transition(index, outcome, attempt);
          break;
        }

        if (outcome.status === "completed") {
          value = outcome.value;
          attempts.push(
            outcome.usage === undefined
              ? { attempt, status: "completed" }
              : { attempt, status: "completed", usage: outcome.usage }
          );
          finalStatus = "completed";
          transition(index, "completed", attempt);
          break;
        }

        finalError = outcome.error;
        attempts.push(
          outcome.usage === undefined
            ? { attempt, status: "failed", error: outcome.error }
            : { attempt, status: "failed", error: outcome.error, usage: outcome.usage }
        );
        transition(index, "failed", attempt);
        const eligibility = reviewRetryEligibility(outcome.error, {
          retriesUsed: attempt - 1,
          remainingMs: Math.max(0, deadline - Date.now())
        });
        if (!eligibility.eligible) break;
        attempt += 1;
      }

      const usage = sumUsage(attempts);
      records[index] = {
        id: task.id,
        status: finalStatus,
        attempts,
        transitions: transitions[index] ?? [],
        ...(usage === undefined ? {} : { usage }),
        ...(finalError === undefined || finalStatus === "completed" ? {} : { error: finalError }),
        ...(finalStatus === "completed" ? { value: value as T } : {})
      };
      if (cleanupCompromised) return;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  for (let index = 0; index < tasks.length; index += 1) {
    if (records[index] !== undefined) continue;
    const task = tasks[index]!;
    const error = classifyReviewError({
      category: "cancellation",
      message: "Session task cancelled"
    });
    transition(index, "cancelled", 0);
    records[index] = {
      id: task.id,
      status: "cancelled",
      attempts: [],
      transitions: transitions[index] ?? [],
      error
    };
  }
  return records.filter((record): record is SessionTaskRecord<T> => record !== undefined);
}

async function interruptTask<T>(task: SessionTask<T>, timeoutMs: number): Promise<boolean> {
  if (task.interrupt === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const interrupted = Promise.resolve()
    .then(() => task.interrupt?.())
    .then(() => true as const)
    .catch(() => false as const);
  const result = await Promise.race([interrupted, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
