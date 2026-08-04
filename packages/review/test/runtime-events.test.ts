import { describe, expect, test } from "bun:test";
import {
  ShuvcodeSessionEventAccumulator,
  classifyShuvcodeFailure,
  type ShuvcodeSessionEventContext
} from "../src/runtime/events.ts";
import type { ShuvcodeEvent } from "../src/runtime/shuvcode.ts";
import type { ReviewErrorCode } from "../src/errors.ts";

const context: ShuvcodeSessionEventContext = {
  sessionId: "review-1",
  role: "specialist",
  reviewer: "security",
  model: "subscription/default-coding",
  attempt: 1,
  startedAtMs: 1_000,
  hardDeadlineAtMs: 10_000
};

describe("shuvcode event aggregation", () => {
  test("extracts cumulative usage and a structured completion", () => {
    const subject = new ShuvcodeSessionEventAccumulator(context);
    subject.ingest(event("session.usage.updated", { tokens: tokens(12, 4), cost: 0.02 }), 2_000);
    subject.ingest(event("session.usage.updated", { tokens: tokens(20, 7), cost: 0.03 }), 3_000);

    const emitted = subject.ingest(
      event("session.structured.completed", {
        assistantMessageID: "message-1",
        value: { reviewer: "security", findings: [] }
      }),
      4_000
    );

    expect(emitted).toEqual([
      {
        event: "session.completed",
        sessionId: "review-1",
        role: "specialist",
        reviewer: "security",
        model: "subscription/default-coding",
        attempt: 1,
        durationMs: 3_000,
        usage: { inputTokens: 20, outputTokens: 7, cost: 0.03 }
      }
    ]);
    expect(subject.snapshot().outcome).toEqual({
      status: "completed",
      usage: { inputTokens: 20, outputTokens: 7, cost: 0.03 }
    });

    subject.ingest(event("session.usage.updated", { tokens: tokens(21, 8), cost: 0.04 }), 4_001);
    expect(subject.snapshot().outcome).toMatchObject({
      status: "completed",
      usage: { inputTokens: 21, outputTokens: 8, cost: 0.04 }
    });
  });

  test("requires structured completion and keeps the hard deadline fixed across quiet heartbeats", () => {
    const subject = new ShuvcodeSessionEventAccumulator(context);
    expect(subject.ingest(event("session.execution.started"), 2_000)).toEqual([]);
    expect(subject.ingest(event("session.step.started"), 9_999)).toEqual([]);
    expect(subject.heartbeatIfQuiet(39_998)).toEqual([]);
    expect(subject.heartbeatIfQuiet(39_999)[0]).toMatchObject({
      event: "session.heartbeat",
      durationMs: 38_999
    });
    expect(subject.isHardDeadlineExceeded(9_999)).toBe(false);
    expect(subject.isHardDeadlineExceeded(10_000)).toBe(true);
    expect(subject.snapshot()).toMatchObject({
      hardDeadlineAtMs: 10_000,
      activityCount: 2,
      heartbeatCount: 1,
      lastActivityAtMs: 9_999
    });

    expect(subject.ingest(event("session.idle"), 10_001)).toEqual([]);
    expect(subject.snapshot().outcome.status).toBe("running");
  });

  test("classifies stable provider failures without retaining source messages", () => {
    const fixtures: Array<[ShuvcodeEvent, ReviewErrorCode]> = [
      [failure("APIError", "provider exploded"), "REVIEW_PROVIDER_FAILURE"],
      [failure("APIError", "too many requests", 429), "REVIEW_RATE_LIMITED"],
      [failure("APIError", "upstream unavailable", 503), "REVIEW_SERVICE_UNAVAILABLE"],
      [failure("ProviderAuthError", "bad credential", 401), "REVIEW_AUTH_FAILED"],
      [failure("ContextOverflowError", "context too long"), "REVIEW_CONTEXT_OVERFLOW"],
      [failure("StructuredOutputError", "invalid schema"), "REVIEW_SCHEMA_INVALID"],
      [failure("ContentFilterError", "blocked by policy"), "REVIEW_POLICY_DENIED"]
    ];

    for (const [fixture, code] of fixtures) {
      const subject = new ShuvcodeSessionEventAccumulator(context);
      const emitted = subject.ingest(fixture, 2_000);
      expect(emitted[0]?.error?.code).toBe(code);
      expect(JSON.stringify(subject.snapshot())).not.toContain("provider exploded");
      expect(JSON.stringify(subject.snapshot())).not.toContain("bad credential");
    }

    expect(
      classifyShuvcodeFailure(event("session.execution.interrupted", { reason: "user" }))
    ).toBe("cancellation");
  });

  test("drops text and tool payloads, unknown payloads, and secret strings", () => {
    const secret = "CLAUDE_CODE_OAUTH_TOKEN=private-token-value";
    const subject = new ShuvcodeSessionEventAccumulator(context);
    const fixtures = [
      event("session.text.delta", { delta: `raw prompt ${secret}` }),
      event("session.text.ended", { text: `private response ${secret}` }),
      event("session.tool.input.delta", { delta: `tool input ${secret}` }),
      event("session.tool.input.ended", { text: `tool input ${secret}` }),
      event("future.event", { arbitrary: { nested: secret } })
    ];

    const emitted = fixtures.flatMap((fixture, index) => subject.ingest(fixture, 2_000 + index));
    const retained = JSON.stringify({ emitted, summary: subject.snapshot() });
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("raw prompt");
    expect(retained).not.toContain("tool input");
    expect(subject.snapshot()).toMatchObject({
      activityCount: 4,
      heartbeatCount: 0,
      ignoredEventCount: 1
    });
  });

  test("ignores other sessions and keeps the first terminal outcome deterministic", () => {
    const subject = new ShuvcodeSessionEventAccumulator(context);
    expect(
      subject.ingest({ type: "session.idle", data: { sessionID: "another-session" } }, 2_000)
    ).toEqual([]);
    subject.ingest(event("session.execution.interrupted", { reason: "shutdown" }), 3_000);
    expect(subject.ingest(event("session.idle"), 4_000)).toEqual([]);
    expect(subject.snapshot().outcome).toMatchObject({
      status: "cancelled",
      error: { code: "REVIEW_CANCELLED", retryable: false }
    });
  });

  test("classifies a structurally incomplete completion as schema failure", () => {
    const subject = new ShuvcodeSessionEventAccumulator(context);
    const emitted = subject.ingest(event("session.structured.completed"), 2_000);

    expect(emitted[0]).toMatchObject({
      event: "session.failed",
      error: { code: "REVIEW_SCHEMA_INVALID", retryable: false }
    });
    expect(subject.snapshot().outcome).toMatchObject({
      status: "failed",
      error: { category: "schema" }
    });
  });
});

function event(type: string, data: Record<string, unknown> = {}): ShuvcodeEvent {
  return { type, data: { sessionID: "review-1", ...data } };
}

function failure(name: string, message: string, statusCode?: number): ShuvcodeEvent {
  return event("session.error", {
    error: {
      name,
      data: { message, ...(statusCode === undefined ? {} : { statusCode }) }
    }
  });
}

function tokens(input: number, output: number): Record<string, unknown> {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } };
}
