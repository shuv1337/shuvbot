import { describe, expect, test } from "bun:test";
import { AuthError } from "../src/errors.ts";
import {
  createRunRecord,
  recordError,
  recordReview,
  recordToolAudit
} from "../src/run-record.ts";

describe("run record", () => {
  test("attaches tool audit summaries", () => {
    const record = createRunRecord({
      event: "pull_request",
      actor: "maintainer",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    });

    const updated = recordToolAudit(record, {
      total: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
      totalDurationMs: 15,
      byTool: {
        get_pr: {
          total: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          totalDurationMs: 5
        },
        write_comment: {
          total: 1,
          succeeded: 0,
          failed: 1,
          denied: 1,
          totalDurationMs: 10
        }
      }
    });

    expect(updated.toolAudit).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
      totalDurationMs: 15,
      byTool: {
        get_pr: {
          total: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          totalDurationMs: 5
        },
        write_comment: {
          total: 1,
          succeeded: 0,
          failed: 1,
          denied: 1,
          totalDurationMs: 10
        }
      }
    });
    expect(record.toolAudit).toBeUndefined();
  });

  test("appends structured errors without mutating the original record", () => {
    const record = createRunRecord({
      event: "pull_request",
      actor: "maintainer",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    });

    const updated = recordError(record, new AuthError("Claude auth missing"));

    expect(updated.errors).toEqual([{ class: "AuthError", message: "Claude auth missing" }]);
    expect(record.errors).toEqual([]);

    const again = recordError(updated, "plain string failure");
    expect(again.errors).toEqual([
      { class: "AuthError", message: "Claude auth missing" },
      { class: "Error", message: "plain string failure" }
    ]);
  });

  test("attaches coordinator coverage and session summaries", () => {
    const record = createRunRecord({
      event: "pull_request",
      actor: "alice",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    });
    const review = recordReview(record, {
      engine: "coordinator",
      tier: "full",
      decision: "degraded",
      quorumMet: false,
      requiredReviewers: ["code-quality", "security"],
      successfulReviewers: ["code-quality"],
      missingReviewers: ["security"],
      retries: 1,
      sessions: [
        {
          sessionId: "session-1",
          role: "specialist",
          reviewer: "security",
          model: "subscription/default-coding",
          status: "failed",
          retryCount: 1,
          error: { code: "provider_unavailable", message: "unavailable", retryable: true }
        }
      ]
    });

    expect(review.review).toMatchObject({
      engine: "coordinator",
      tier: "full",
      decision: "degraded",
      quorumMet: false,
      retries: 1
    });
    expect(review.review?.sessions[0]).toMatchObject({ reviewer: "security", status: "failed" });
  });
});
