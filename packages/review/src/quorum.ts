import type { BuiltInReviewerId, ReviewTier } from "./types.ts";

const FULL_OPTIONAL_REVIEWERS = ["performance", "tests", "documentation", "release"] as const;

export type QuorumStatus = "complete" | "degraded";
export type QuorumReason =
  | "QUORUM_COMPLETE"
  | "COORDINATOR_FAILED"
  | "REQUIRED_REVIEWER_MISSING"
  | "INSUFFICIENT_SPECIALISTS";

export type CoordinatorDecision =
  | "clean"
  | "comments"
  | "minor_issues"
  | "significant_concerns"
  | "degraded";

export interface QuorumInput {
  readonly tier: ReviewTier;
  readonly coordinatorSucceeded: boolean;
  readonly scheduledReviewers: readonly BuiltInReviewerId[];
  readonly successfulReviewers: readonly BuiltInReviewerId[];
}

export interface QuorumResult {
  readonly status: QuorumStatus;
  readonly reason: QuorumReason;
  readonly coordinatorSucceeded: boolean;
  readonly successfulScheduledReviewers: readonly BuiltInReviewerId[];
  readonly missingRequiredReviewers: readonly BuiltInReviewerId[];
  readonly additionalSuccessfulReviewersRequired: number;
  readonly canClaimClean: boolean;
  readonly canBlock: boolean;
}

export interface QuorumDecisionResult {
  readonly decision: CoordinatorDecision;
  readonly canClaimClean: boolean;
  readonly canBlock: boolean;
}

export function evaluateQuorum(input: QuorumInput): QuorumResult {
  const scheduled = new Set(input.scheduledReviewers);
  const successful = new Set(
    input.successfulReviewers.filter((reviewer) => scheduled.has(reviewer))
  );
  const required = input.tier === "full" ? ["code-quality", "security"] : ["code-quality"];
  const missingRequiredReviewers = required.filter(
    (reviewer): reviewer is BuiltInReviewerId => !successful.has(reviewer as BuiltInReviewerId)
  );

  const eligibleAdditionalReviewers =
    input.tier === "full"
      ? FULL_OPTIONAL_REVIEWERS.filter((reviewer) => scheduled.has(reviewer))
      : input.scheduledReviewers.filter((reviewer) => reviewer !== "code-quality");
  const requiredAdditionalReviewers = input.tier === "trivial" ? 0 : input.tier === "lite" ? 2 : 3;
  const successfulAdditionalReviewers = [...new Set(eligibleAdditionalReviewers)].filter(
    (reviewer) => successful.has(reviewer)
  ).length;
  const additionalSuccessfulReviewersRequired = Math.max(
    0,
    requiredAdditionalReviewers - successfulAdditionalReviewers
  );

  const reason: QuorumReason = !input.coordinatorSucceeded
    ? "COORDINATOR_FAILED"
    : missingRequiredReviewers.length > 0
      ? "REQUIRED_REVIEWER_MISSING"
      : additionalSuccessfulReviewersRequired > 0
        ? "INSUFFICIENT_SPECIALISTS"
        : "QUORUM_COMPLETE";
  const complete = reason === "QUORUM_COMPLETE";

  return {
    status: complete ? "complete" : "degraded",
    reason,
    coordinatorSucceeded: input.coordinatorSucceeded,
    successfulScheduledReviewers: [...successful],
    missingRequiredReviewers,
    additionalSuccessfulReviewersRequired,
    canClaimClean: complete,
    canBlock: complete
  };
}

export function applyQuorumToDecision(
  decision: CoordinatorDecision,
  quorum: QuorumResult
): QuorumDecisionResult {
  if (quorum.status === "degraded") {
    return { decision: "degraded", canClaimClean: false, canBlock: false };
  }

  return {
    decision,
    canClaimClean: decision === "clean",
    canBlock: decision === "significant_concerns"
  };
}
