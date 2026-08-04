import type { CoordinatorResult } from "./results.ts";

export interface CoordinatorPostingPolicyInput {
  result: CoordinatorResult;
  canReview: boolean;
  requestChanges: boolean;
  failCheck: boolean;
  failOn?: "critical" | "high" | "medium" | "low" | "info";
}

export interface CoordinatorPostingPolicy {
  localStatus: "clean" | "findings" | "blocked" | "incomplete";
  reviewEvent: "COMMENT" | "REQUEST_CHANGES";
  failCheck: boolean;
  degraded: boolean;
  reason: string;
}

export function coordinatorPostingPolicy(
  input: CoordinatorPostingPolicyInput
): CoordinatorPostingPolicy {
  const degraded = input.result.decision === "degraded" || !input.result.coverage.quorumMet;
  const thresholdMet = findingThresholdMet(input.result, input.failOn);
  if (degraded) {
    return {
      localStatus: "incomplete",
      reviewEvent: "COMMENT",
      failCheck: input.failCheck && thresholdMet,
      degraded: true,
      reason: thresholdMet
        ? "Review coverage is incomplete; verified findings still meet the configured check threshold."
        : "Review coverage is incomplete and cannot claim clean or request changes."
    };
  }

  const significant = input.result.decision === "significant_concerns";
  const requestChanges = significant && thresholdMet && input.requestChanges && input.canReview;
  return {
    localStatus:
      input.result.decision === "clean" ? "clean" : requestChanges ? "blocked" : "findings",
    reviewEvent: requestChanges ? "REQUEST_CHANGES" : "COMMENT",
    failCheck: input.failCheck && thresholdMet,
    degraded: false,
    reason: requestChanges
      ? "Significant concerns meet the configured threshold and review policy permits changes requests."
      : input.result.decision === "clean"
        ? "Validated coordinator result is clean with complete coverage."
        : "Findings are reported as comments under deterministic posting policy."
  };
}

function findingThresholdMet(
  result: CoordinatorResult,
  failOn: CoordinatorPostingPolicyInput["failOn"]
): boolean {
  if (failOn === undefined) return false;
  const rank = severityRank(failOn);
  return result.findings.some((finding) => severityRank(finding.severity) <= rank);
}

function severityRank(severity: NonNullable<CoordinatorPostingPolicyInput["failOn"]>): number {
  return ["critical", "high", "medium", "low", "info"].indexOf(severity);
}
