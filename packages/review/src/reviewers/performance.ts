import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const PERFORMANCE_REVIEWER: ReviewerPromptDefinition = {
  id: "performance",
  name: "Performance",
  purpose: "Find measurable performance and resource regressions in changed execution paths.",
  whatToFlag: [
    "Algorithmic blowups or repeated I/O on inputs that can realistically grow.",
    "Resource leaks, unbounded retention, or missing backpressure and cleanup.",
    "Regressions on established hot paths where the patch adds material latency, allocation, or network cost."
  ],
  whatNotToFlag: [
    "Micro-optimizations without evidence that the path is performance-sensitive.",
    "Claims based only on syntax or intuition without a realistic workload and cost mechanism.",
    "Readability tradeoffs that have no material runtime or resource impact."
  ]
};

export function buildPerformancePrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(PERFORMANCE_REVIEWER, input);
}
