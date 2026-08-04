export const MINIMUM_RETRY_BUDGET_MS = 90_000;
export const MAX_RETRIES_PER_SESSION = 1;

export const REVIEW_ERROR_CODES = {
  provider: "REVIEW_PROVIDER_FAILURE",
  rateLimit: "REVIEW_RATE_LIMITED",
  service: "REVIEW_SERVICE_UNAVAILABLE",
  auth: "REVIEW_AUTH_FAILED",
  context: "REVIEW_CONTEXT_OVERFLOW",
  schema: "REVIEW_SCHEMA_INVALID",
  policy: "REVIEW_POLICY_DENIED",
  cancellation: "REVIEW_CANCELLED",
  config: "REVIEW_CONFIG_INVALID"
} as const;

export type ReviewErrorCategory = keyof typeof REVIEW_ERROR_CODES;
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[ReviewErrorCategory];

export interface ReviewErrorInput {
  readonly category: ReviewErrorCategory;
  readonly message: string;
}

export interface ClassifiedReviewError {
  readonly code: ReviewErrorCode;
  readonly category: ReviewErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export type RetryEligibilityReason =
  | "RETRY_ALLOWED"
  | "ERROR_NOT_RETRYABLE"
  | "RETRY_LIMIT_REACHED"
  | "INSUFFICIENT_REMAINING_BUDGET";

export interface RetryBudget {
  readonly retriesUsed: number;
  readonly remainingMs: number;
}

export interface RetryEligibility {
  readonly eligible: boolean;
  readonly reason: RetryEligibilityReason;
}

const RETRYABLE_CATEGORIES: ReadonlySet<ReviewErrorCategory> = new Set([
  "provider",
  "rateLimit",
  "service"
]);

export function classifyReviewError(input: ReviewErrorInput): ClassifiedReviewError {
  return {
    code: REVIEW_ERROR_CODES[input.category],
    category: input.category,
    message: input.message,
    retryable: RETRYABLE_CATEGORIES.has(input.category)
  };
}

export function reviewRetryEligibility(
  error: ClassifiedReviewError,
  budget: RetryBudget
): RetryEligibility {
  if (!error.retryable) {
    return { eligible: false, reason: "ERROR_NOT_RETRYABLE" };
  }
  if (budget.retriesUsed >= MAX_RETRIES_PER_SESSION) {
    return { eligible: false, reason: "RETRY_LIMIT_REACHED" };
  }
  if (budget.remainingMs < MINIMUM_RETRY_BUDGET_MS) {
    return { eligible: false, reason: "INSUFFICIENT_REMAINING_BUDGET" };
  }
  return { eligible: true, reason: "RETRY_ALLOWED" };
}
