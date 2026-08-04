import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Redactor } from "../../core/src/redaction.ts";
import type { ReviewErrorCode } from "./errors.ts";
import type { ReviewerId } from "./types.ts";

export type ReviewSessionEventType =
  | "session.queued"
  | "session.started"
  | "session.heartbeat"
  | "session.retrying"
  | "session.completed"
  | "session.failed"
  | "session.timed_out"
  | "session.cancelled";

export interface ReviewSessionLogEvent {
  time: string;
  event: ReviewSessionEventType;
  sessionId: string;
  role: "coordinator" | "specialist";
  reviewer?: ReviewerId;
  model: string;
  attempt: number;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
  error?: {
    code: ReviewErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface ReviewSessionLogOptions {
  redactor: Redactor;
  maxEvents?: number;
  now?: () => Date;
}

export class ReviewSessionLog {
  private readonly events: ReviewSessionLogEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(private readonly options: ReviewSessionLogOptions) {
    this.maxEvents = options.maxEvents ?? 10_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new RangeError("maxEvents must be a positive integer");
    }
  }

  append(event: Omit<ReviewSessionLogEvent, "time">): void {
    validateEvent(event);
    if (this.events.length >= this.maxEvents) {
      throw new RangeError(`session log exceeded its ${this.maxEvents}-event limit`);
    }
    this.events.push(
      this.options.redactor.redact({
        ...structuredClone(event),
        time: this.now().toISOString()
      })
    );
  }

  snapshot(): ReviewSessionLogEvent[] {
    return structuredClone(this.events);
  }

  toJsonLines(): string {
    return (
      this.events.map((event) => JSON.stringify(event)).join("\n") +
      (this.events.length ? "\n" : "")
    );
  }

  async flush(
    path: string,
    options: {
      mkdir?: typeof mkdir;
      rename?: typeof rename;
      rm?: typeof rm;
      writeFile?: typeof writeFile;
      deadlineAtMs?: number;
    } = {}
  ): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const deadlineAtMs = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;
    const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
      if (!Number.isFinite(deadlineAtMs)) return operation;
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) throw new Error("session log flush exceeded the overall deadline");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("session log flush exceeded the overall deadline")),
              remaining
            );
          })
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    let writeOperation: ReturnType<typeof writeFile> | undefined;
    try {
      await withinDeadline(
        (options.mkdir ?? mkdir)(dirname(path), { recursive: true, mode: 0o700 })
      );
      writeOperation = (options.writeFile ?? writeFile)(temporary, this.toJsonLines(), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await withinDeadline(writeOperation);
      await withinDeadline((options.rename ?? rename)(temporary, path));
    } finally {
      if (writeOperation !== undefined) {
        void writeOperation
          .finally(() => (options.rm ?? rm)(temporary, { force: true }))
          .catch(() => undefined);
      }
      await Promise.race([
        (options.rm ?? rm)(temporary, { force: true }).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 100))
      ]);
    }
  }
}

function validateEvent(event: Omit<ReviewSessionLogEvent, "time">): void {
  if (!event.sessionId.trim() || !event.model.trim()) {
    throw new TypeError("sessionId and model must be non-empty");
  }
  if (!Number.isInteger(event.attempt) || event.attempt < 1 || event.attempt > 2) {
    throw new RangeError("attempt must be 1 or 2");
  }
  if (event.role === "specialist" && event.reviewer === undefined) {
    throw new TypeError("specialist events require a reviewer");
  }
  if (event.role === "coordinator" && event.reviewer !== undefined) {
    throw new TypeError("coordinator events cannot identify a specialist reviewer");
  }
  if (
    event.error !== undefined &&
    !["session.failed", "session.timed_out", "session.cancelled"].includes(event.event)
  ) {
    throw new TypeError("errors are only valid on terminal failure events");
  }
}
