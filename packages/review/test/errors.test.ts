import { describe, expect, test } from "bun:test";
import {
  MAX_RETRIES_PER_SESSION,
  MINIMUM_RETRY_BUDGET_MS,
  REVIEW_ERROR_CODES,
  classifyReviewError,
  reviewRetryEligibility,
  type ReviewErrorCategory
} from "../src/errors.ts";

describe("review error classification", () => {
  test.each([
    ["provider", REVIEW_ERROR_CODES.provider],
    ["rateLimit", REVIEW_ERROR_CODES.rateLimit],
    ["service", REVIEW_ERROR_CODES.service]
  ] as const)("classifies %s failures as retryable", (category, code) => {
    expect(classifyReviewError({ category, message: "failed" })).toEqual({
      category,
      code,
      message: "failed",
      retryable: true
    });
  });

  test.each([
    "auth",
    "context",
    "schema",
    "policy",
    "cancellation",
    "config"
  ] satisfies readonly ReviewErrorCategory[])(
    "classifies %s failures as non-retryable",
    (category) => {
      const result = classifyReviewError({ category, message: "failed" });

      expect(result.code).toBe(REVIEW_ERROR_CODES[category]);
      expect(result.retryable).toBe(false);
    }
  );

  test("allows one retry with at least 90 seconds remaining", () => {
    const error = classifyReviewError({ category: "service", message: "unavailable" });

    expect(
      reviewRetryEligibility(error, {
        retriesUsed: 0,
        remainingMs: MINIMUM_RETRY_BUDGET_MS
      })
    ).toEqual({ eligible: true, reason: "RETRY_ALLOWED" });
  });

  test("rejects retry after the one-retry limit", () => {
    const error = classifyReviewError({ category: "provider", message: "failed" });

    expect(
      reviewRetryEligibility(error, {
        retriesUsed: MAX_RETRIES_PER_SESSION,
        remainingMs: MINIMUM_RETRY_BUDGET_MS
      })
    ).toEqual({ eligible: false, reason: "RETRY_LIMIT_REACHED" });
  });

  test("rejects retry below the remaining budget", () => {
    const error = classifyReviewError({ category: "rateLimit", message: "slow down" });

    expect(
      reviewRetryEligibility(error, {
        retriesUsed: 0,
        remainingMs: MINIMUM_RETRY_BUDGET_MS - 1
      })
    ).toEqual({ eligible: false, reason: "INSUFFICIENT_REMAINING_BUDGET" });
  });

  test("never retries a non-retryable error regardless of budget", () => {
    const error = classifyReviewError({ category: "auth", message: "denied" });

    expect(reviewRetryEligibility(error, { retriesUsed: 0, remainingMs: 1_000_000 })).toEqual({
      eligible: false,
      reason: "ERROR_NOT_RETRYABLE"
    });
  });
});
