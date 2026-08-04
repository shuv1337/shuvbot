import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const TESTS_REVIEWER: ReviewerPromptDefinition = {
  id: "tests",
  name: "Tests",
  purpose: "Find incorrect tests and specific missing regression coverage for changed behavior.",
  whatToFlag: [
    "Tests that assert the wrong behavior, cannot exercise the claimed path, or can pass while the implementation is broken.",
    "Missing coverage for a concrete changed edge case or regression-prone contract.",
    "Flaky, order-dependent, or environment-dependent test behavior introduced by the patch."
  ],
  whatNotToFlag: [
    "A generic request for more tests without naming the behavior and failure the test must catch.",
    "Coverage of unchanged implementation details or exhaustive permutations with low regression value.",
    "Test style preferences that do not affect correctness or reliability."
  ]
};

export function buildTestsPrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(TESTS_REVIEWER, input);
}
