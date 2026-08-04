import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const RELEASE_REVIEWER: ReviewerPromptDefinition = {
  id: "release",
  name: "Release and compatibility",
  purpose: "Find compatibility, migration, deployment-order, versioning, and rollback hazards.",
  whatToFlag: [
    "Breaking public or persisted-data changes without the required compatibility or migration strategy.",
    "Deployment ordering or mixed-version behavior that can fail during rollout or rollback.",
    "Packaging, versioning, feature-gate, or release configuration changes that ship incomplete or unusable artifacts."
  ],
  whatNotToFlag: [
    "Release-process preferences that are not established repository requirements.",
    "Potential breakage without identifying a concrete consumer, persisted format, or rollout sequence.",
    "Ordinary implementation defects better owned by another specialist unless they create release-specific risk."
  ]
};

export function buildReleasePrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(RELEASE_REVIEWER, input);
}
