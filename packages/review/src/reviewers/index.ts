import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";
import type { ReviewerId } from "../types.ts";
import { CODE_QUALITY_REVIEWER } from "./code-quality.ts";
import { DOCUMENTATION_REVIEWER } from "./documentation.ts";
import { PERFORMANCE_REVIEWER } from "./performance.ts";
import { RELEASE_REVIEWER } from "./release.ts";
import { SECURITY_REVIEWER } from "./security.ts";
import { TESTS_REVIEWER } from "./tests.ts";

export { buildCodeQualityPrompt, CODE_QUALITY_REVIEWER } from "./code-quality.ts";
export { buildDocumentationPrompt, DOCUMENTATION_REVIEWER } from "./documentation.ts";
export { buildPerformancePrompt, PERFORMANCE_REVIEWER } from "./performance.ts";
export { buildReleasePrompt, RELEASE_REVIEWER } from "./release.ts";
export { buildSecurityPrompt, SECURITY_REVIEWER } from "./security.ts";
export { buildTestsPrompt, TESTS_REVIEWER } from "./tests.ts";

export const REVIEWER_PROMPTS: Readonly<Record<ReviewerId, ReviewerPromptDefinition>> = {
  "code-quality": CODE_QUALITY_REVIEWER,
  security: SECURITY_REVIEWER,
  performance: PERFORMANCE_REVIEWER,
  tests: TESTS_REVIEWER,
  documentation: DOCUMENTATION_REVIEWER,
  release: RELEASE_REVIEWER
};

export function buildSpecialistPrompt(reviewer: ReviewerId, input: ReviewerPromptInput): string {
  return buildReviewerPrompt(REVIEWER_PROMPTS[reviewer], input);
}
