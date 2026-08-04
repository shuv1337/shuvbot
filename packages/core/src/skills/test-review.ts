import type { ReviewSkill } from "./index.ts";

export const testReviewSkill: ReviewSkill = {
  id: "test-review",
  prompt: `You are shuvbot's test-review skill.
Find missing or broken tests only when the changed behavior is concrete and user-visible or security-relevant.`,
  paths: ["**/*"],
  ignorePaths: ["**/*.md"],
  triggers: [
    { event: "pull_request", actions: ["opened", "reopened", "synchronize", "ready_for_review"] }
  ],
  failOn: "high",
  reportOn: "medium",
  minConfidence: "medium"
};
