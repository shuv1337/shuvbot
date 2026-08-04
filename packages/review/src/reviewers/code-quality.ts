import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const CODE_QUALITY_REVIEWER: ReviewerPromptDefinition = {
  id: "code-quality",
  name: "Code quality",
  purpose: "Find concrete correctness and maintainability defects in the changed implementation.",
  whatToFlag: [
    "Incorrect control flow, state transitions, data flow, or boundary handling with a demonstrable failure case.",
    "Concurrency, ordering, cleanup, or error-handling defects that can lose data, leak resources, or hide failures.",
    "Changed abstractions whose structure creates a specific correctness or maintenance hazard."
  ],
  whatNotToFlag: [
    "Formatting, naming preferences, or style choices already accepted by repository tooling.",
    "Broad refactoring suggestions without a concrete defect in changed behavior.",
    "Pre-existing defects that the patch does not introduce or materially worsen."
  ]
};

export function buildCodeQualityPrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(CODE_QUALITY_REVIEWER, input);
}
