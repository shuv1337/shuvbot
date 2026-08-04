import { describe, expect, test } from "bun:test";
import { applyQuorumToDecision, evaluateQuorum } from "../src/quorum.ts";
import type { BuiltInReviewerId, ReviewTier } from "../src/types.ts";

const allReviewers: readonly BuiltInReviewerId[] = [
  "code-quality",
  "security",
  "performance",
  "tests",
  "documentation",
  "release"
];

describe("tier-aware quorum", () => {
  test.each([
    ["trivial", ["code-quality"]],
    ["lite", ["code-quality", "tests", "documentation"]],
    ["full", ["code-quality", "security", "performance", "tests", "release"]]
  ] as const)("%s is complete at its minimum coverage", (tier, successfulReviewers) => {
    const result = quorum(tier, successfulReviewers);

    expect(result.status).toBe("complete");
    expect(result.reason).toBe("QUORUM_COMPLETE");
    expect(result.canClaimClean).toBe(true);
    expect(result.canBlock).toBe(true);
  });

  test.each([
    ["trivial", []],
    ["lite", ["code-quality", "tests"]],
    ["full", ["code-quality", "security", "performance", "tests"]]
  ] as const)("%s is degraded below minimum coverage", (tier, successfulReviewers) => {
    const result = quorum(tier, successfulReviewers);

    expect(result.status).toBe("degraded");
    expect(result.canClaimClean).toBe(false);
    expect(result.canBlock).toBe(false);
  });

  test("requires coordinator success for every tier", () => {
    for (const tier of ["trivial", "lite", "full"] as const) {
      expect(quorum(tier, allReviewers, false).reason).toBe("COORDINATOR_FAILED");
    }
  });

  test("full quorum cannot substitute another reviewer for security", () => {
    const result = quorum("full", [
      "code-quality",
      "performance",
      "tests",
      "documentation",
      "release"
    ]);

    expect(result.status).toBe("degraded");
    expect(result.missingRequiredReviewers).toEqual(["security"]);
  });

  test("counts only scheduled successful specialists", () => {
    const result = evaluateQuorum({
      tier: "lite",
      coordinatorSucceeded: true,
      scheduledReviewers: ["code-quality", "tests"],
      successfulReviewers: ["code-quality", "tests", "documentation"]
    });

    expect(result.status).toBe("degraded");
    expect(result.additionalSuccessfulReviewersRequired).toBe(1);
    expect(result.successfulScheduledReviewers).toEqual(["code-quality", "tests"]);
  });

  test("degraded coverage overrides clean and blocking decisions", () => {
    const degraded = quorum("full", ["code-quality", "security"]);

    expect(applyQuorumToDecision("clean", degraded)).toEqual({
      decision: "degraded",
      canClaimClean: false,
      canBlock: false
    });
    expect(applyQuorumToDecision("significant_concerns", degraded)).toEqual({
      decision: "degraded",
      canClaimClean: false,
      canBlock: false
    });
  });
});

function quorum(
  tier: ReviewTier,
  successfulReviewers: readonly BuiltInReviewerId[],
  coordinatorSucceeded = true
) {
  return evaluateQuorum({
    tier,
    coordinatorSucceeded,
    scheduledReviewers: allReviewers,
    successfulReviewers
  });
}
