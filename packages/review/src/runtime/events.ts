import { classifyReviewError, type ClassifiedReviewError } from "../errors.ts";
import type { Usage } from "../results.ts";
import type { ReviewSessionLogEvent } from "../session-log.ts";
import type { ReviewerId } from "../types.ts";
import type { ShuvcodeEvent } from "./shuvcode.ts";

type LogEvent = Omit<ReviewSessionLogEvent, "time">;

export interface ShuvcodeSessionEventContext {
  readonly sessionId: string;
  readonly role: "coordinator" | "specialist";
  readonly reviewer?: ReviewerId;
  readonly model: string;
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly hardDeadlineAtMs: number;
}

export type ShuvcodeSessionOutcome =
  | { readonly status: "running"; readonly usage?: Usage }
  | { readonly status: "completed"; readonly usage?: Usage }
  | {
      readonly status: "failed" | "cancelled";
      readonly error: ClassifiedReviewError;
      readonly usage?: Usage;
    };

export interface ShuvcodeSessionEventSummary {
  readonly outcome: ShuvcodeSessionOutcome;
  readonly activityCount: number;
  readonly heartbeatCount: number;
  readonly ignoredEventCount: number;
  readonly lastActivityAtMs?: number;
  readonly hardDeadlineAtMs: number;
}

const ACTIVITY_EVENTS = new Set([
  "session.execution.started",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.completed",
  "session.tool.failed",
  "session.retry.scheduled"
]);

const IGNORED_CONTENT_EVENTS = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "message.updated",
  "message.part.updated"
]);

const NON_STRUCTURED_TERMINAL_EVENTS = new Set(["session.idle", "session.execution.succeeded"]);

const FAILURE_EVENTS = new Set([
  "session.error",
  "session.execution.failed",
  "session.structured.failed"
]);

/**
 * Reduces public shuvcode events to reviewbot-owned lifecycle metadata. Source events are
 * inspected synchronously and are never retained.
 */
export class ShuvcodeSessionEventAccumulator {
  private terminal: ShuvcodeSessionOutcome | undefined;
  private usage: Usage | undefined;
  private activityCount = 0;
  private heartbeatCount = 0;
  private ignoredEventCount = 0;
  private lastActivityAtMs: number | undefined;
  private lastHeartbeatAtMs: number | undefined;

  constructor(private readonly context: ShuvcodeSessionEventContext) {
    if (!context.sessionId.trim() || !context.model.trim()) {
      throw new TypeError("sessionId and model must be non-empty");
    }
    if (!Number.isFinite(context.startedAtMs) || !Number.isFinite(context.hardDeadlineAtMs)) {
      throw new TypeError("session timestamps must be finite");
    }
    if (context.hardDeadlineAtMs < context.startedAtMs) {
      throw new RangeError("hard deadline cannot precede session start");
    }
    if (context.role === "specialist" && context.reviewer === undefined) {
      throw new TypeError("specialist sessions require a reviewer");
    }
    if (context.role === "coordinator" && context.reviewer !== undefined) {
      throw new TypeError("coordinator sessions cannot identify a specialist reviewer");
    }
  }

  ingest(event: ShuvcodeEvent, observedAtMs = Date.now()): LogEvent[] {
    if (!Number.isFinite(observedAtMs)) throw new TypeError("observedAtMs must be finite");
    if (sessionId(event) !== this.context.sessionId) return [];

    const usage = extractUsage(event);
    if (usage !== undefined) this.usage = mergeCumulativeUsage(this.usage, usage);

    if (event.type === "session.usage.updated" || event.type === "session.usage.recorded") {
      return [];
    }
    if (IGNORED_CONTENT_EVENTS.has(event.type)) {
      this.recordActivity(observedAtMs);
      return [];
    }
    if (ACTIVITY_EVENTS.has(event.type)) {
      this.recordActivity(observedAtMs);
      return [];
    }
    if (event.type === "session.structured.completed") {
      if (event.data === undefined || !("value" in event.data) || event.data.value === undefined) {
        return this.finishFailure("schema", observedAtMs);
      }
      this.recordActivity(observedAtMs);
      if (this.terminal !== undefined) return [];
      this.terminal = {
        status: "completed",
        ...(this.usage === undefined ? {} : { usage: this.usage })
      };
      return [
        this.logEvent("session.completed", {
          durationMs: elapsed(this.context.startedAtMs, observedAtMs),
          ...(this.usage === undefined ? {} : { usage: toLogUsage(this.usage) })
        })
      ];
    }
    if (NON_STRUCTURED_TERMINAL_EVENTS.has(event.type)) {
      this.recordActivity(observedAtMs);
      return [];
    }
    if (event.type === "session.execution.interrupted") {
      return this.finishFailure("cancellation", observedAtMs);
    }
    if (FAILURE_EVENTS.has(event.type)) {
      return this.finishClassifiedFailure(event, observedAtMs);
    }

    this.ignoredEventCount += 1;
    return [];
  }

  isHardDeadlineExceeded(nowMs = Date.now()): boolean {
    return nowMs >= this.context.hardDeadlineAtMs;
  }

  heartbeatIfQuiet(observedAtMs = Date.now(), quietPeriodMs = 30_000): LogEvent[] {
    if (!Number.isFinite(observedAtMs)) throw new TypeError("observedAtMs must be finite");
    if (!Number.isFinite(quietPeriodMs) || quietPeriodMs <= 0) {
      throw new RangeError("quietPeriodMs must be positive");
    }
    if (this.terminal !== undefined) return [];
    const visibleAtMs = Math.max(
      this.context.startedAtMs,
      this.lastActivityAtMs ?? this.context.startedAtMs,
      this.lastHeartbeatAtMs ?? this.context.startedAtMs
    );
    if (observedAtMs - visibleAtMs < quietPeriodMs) return [];
    this.lastHeartbeatAtMs = observedAtMs;
    this.heartbeatCount += 1;
    return [
      this.logEvent("session.heartbeat", {
        durationMs: elapsed(this.context.startedAtMs, observedAtMs)
      })
    ];
  }

  snapshot(): ShuvcodeSessionEventSummary {
    const outcome =
      this.terminal === undefined
        ? {
            status: "running" as const,
            ...(this.usage === undefined ? {} : { usage: this.usage })
          }
        : {
            ...this.terminal,
            ...(this.usage === undefined ? {} : { usage: this.usage })
          };
    return structuredClone({
      outcome,
      activityCount: this.activityCount,
      heartbeatCount: this.heartbeatCount,
      ignoredEventCount: this.ignoredEventCount,
      ...(this.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: this.lastActivityAtMs }),
      hardDeadlineAtMs: this.context.hardDeadlineAtMs
    });
  }

  private recordActivity(observedAtMs: number): void {
    this.activityCount += 1;
    this.lastActivityAtMs = observedAtMs;
  }

  private finishClassifiedFailure(event: ShuvcodeEvent, observedAtMs: number): LogEvent[] {
    const category = classifyShuvcodeFailure(event);
    return this.finishFailure(category, observedAtMs);
  }

  private finishFailure(
    category: Parameters<typeof classifyReviewError>[0]["category"],
    observedAtMs: number
  ): LogEvent[] {
    this.recordActivity(observedAtMs);
    if (this.terminal !== undefined) return [];
    const error = classifyReviewError({ category, message: safeErrorMessage(category) });
    const status = category === "cancellation" ? "cancelled" : "failed";
    this.terminal = {
      status,
      error,
      ...(this.usage === undefined ? {} : { usage: this.usage })
    };
    return [
      this.logEvent(status === "cancelled" ? "session.cancelled" : "session.failed", {
        durationMs: elapsed(this.context.startedAtMs, observedAtMs),
        ...(this.usage === undefined ? {} : { usage: toLogUsage(this.usage) }),
        error: { code: error.code, message: error.message, retryable: error.retryable }
      })
    ];
  }

  private logEvent(event: LogEvent["event"], extra: Partial<LogEvent> = {}): LogEvent {
    return {
      event,
      sessionId: this.context.sessionId,
      role: this.context.role,
      ...(this.context.reviewer === undefined ? {} : { reviewer: this.context.reviewer }),
      model: this.context.model,
      attempt: this.context.attempt,
      ...extra
    };
  }
}

export function classifyShuvcodeFailure(
  event: ShuvcodeEvent
): Parameters<typeof classifyReviewError>[0]["category"] {
  if (event.type === "session.execution.interrupted") return "cancellation";
  if (event.type === "session.structured.failed") return "schema";

  const error = record(event.data?.error);
  const data = record(error?.data);
  const status = number(error?.status) ?? number(data?.statusCode);
  const signature = [
    string(error?.type),
    string(error?.name),
    string(error?.message),
    string(data?.message)
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /auth|credential|unauthori[sz]ed|forbidden/.test(signature)
  ) {
    return "auth";
  }
  if (status === 429 || /rate.?limit|quota|too many requests/.test(signature)) return "rateLimit";
  if (/context|output.?length|token.?limit|too long/.test(signature)) return "context";
  if (/schema|structured.?output|invalid.?json|validation/.test(signature)) return "schema";
  if (/policy|permission|content.?filter|safety|denied|blocked/.test(signature)) return "policy";
  if (status !== undefined && (status === 408 || status >= 500)) return "service";
  if (/unavailable|overload|timeout|timed out|connection|network/.test(signature)) return "service";
  if (/abort|cancel|interrupt|shutdown|superseded/.test(signature)) return "cancellation";
  return "provider";
}

function safeErrorMessage(category: Parameters<typeof classifyReviewError>[0]["category"]): string {
  const messages = {
    provider: "Provider request failed",
    rateLimit: "Provider rate limit reached",
    service: "Provider service unavailable",
    auth: "Provider authentication failed",
    context: "Model context limit exceeded",
    schema: "Structured response was invalid",
    policy: "Runtime policy denied the operation",
    cancellation: "Review session was cancelled",
    config: "Configured review model is not routable by the runtime"
  } as const;
  return messages[category];
}

function extractUsage(event: ShuvcodeEvent): Usage | undefined {
  const data = record(event.data);
  const direct = record(data?.usage);
  const tokens = record(data?.tokens) ?? record(direct?.tokens);
  const inputTokens = nonNegativeInteger(direct?.inputTokens) ?? nonNegativeInteger(tokens?.input);
  const outputTokens =
    nonNegativeInteger(direct?.outputTokens) ?? nonNegativeInteger(tokens?.output);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cost = nonNegativeNumber(direct?.cost) ?? nonNegativeNumber(data?.cost);
  return { inputTokens, outputTokens, ...(cost === undefined ? {} : { cost }) };
}

function mergeCumulativeUsage(current: Usage | undefined, next: Usage): Usage {
  if (current === undefined) return next;
  const costs = [current.cost, next.cost].filter((value): value is number => value !== undefined);
  return {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
    ...(costs.length === 0 ? {} : { cost: Math.max(...costs) })
  };
}

function toLogUsage(usage: Usage): NonNullable<ReviewSessionLogEvent["usage"]> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cost === undefined ? {} : { cost: usage.cost })
  };
}

function sessionId(event: ShuvcodeEvent): string | undefined {
  return typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined;
}

function elapsed(startedAtMs: number, observedAtMs: number): number {
  return Math.max(0, observedAtMs - startedAtMs);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}
