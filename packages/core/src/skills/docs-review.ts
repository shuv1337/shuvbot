import type { ReviewSkill } from "./index.ts";

export const docsReviewSkill: ReviewSkill = {
  id: "docs-review",
  prompt: `You are reviewbot's docs-review skill.
Review documentation changes for incorrect commands, stale API names, and misleading operational guidance.`,
  paths: ["**/*.md", "docs/**"],
  ignorePaths: [],
  triggers: [{ event: "pull_request", actions: ["opened", "reopened", "synchronize", "ready_for_review"] }],
  failOn: "critical",
  reportOn: "low",
  minConfidence: "medium"
};
