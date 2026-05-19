import type { ReviewSkill } from "./index.ts";

export const securityReviewSkill: ReviewSkill = {
  id: "security-review",
  prompt: `You are reviewbot's security-review skill.
Return only security findings with concrete exploitability or data exposure risk.
Ignore speculative style or dependency-version complaints without a vulnerable code path.`,
  paths: ["**/*"],
  ignorePaths: ["**/*.md"],
  triggers: [{ event: "pull_request", actions: ["opened", "reopened", "synchronize", "ready_for_review"] }],
  failOn: "critical",
  reportOn: "medium",
  minConfidence: "medium"
};
