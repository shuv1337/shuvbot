import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const DOCUMENTATION_REVIEWER: ReviewerPromptDefinition = {
  id: "documentation",
  name: "Documentation",
  purpose: "Find user-facing contract drift and missing operational guidance caused by the change.",
  whatToFlag: [
    "Public API, CLI, configuration, or behavior changes that contradict existing documentation or examples.",
    "Migration, deployment, or operator steps required for safe use but absent from the change.",
    "Examples changed into invalid or misleading instructions."
  ],
  whatNotToFlag: [
    "Internal implementation details that users and operators do not need.",
    "Copy-editing, tone, formatting, or optional explanatory improvements.",
    "Requests to document behavior that is unchanged and already discoverable through the established interface."
  ]
};

export function buildDocumentationPrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(DOCUMENTATION_REVIEWER, input);
}
