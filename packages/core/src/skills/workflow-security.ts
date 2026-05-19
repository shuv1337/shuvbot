import type { ReviewSkill } from "./index.ts";

export const workflowSecuritySkill: ReviewSkill = {
  id: "workflow-security",
  prompt: `You are reviewbot's workflow-security skill.
Review CI, release, and automation changes for token exposure, unsafe pull_request_target use, and untrusted script execution.`,
  paths: [".github/**", "**/*.yml", "**/*.yaml"],
  ignorePaths: [],
  triggers: [{ event: "pull_request", actions: ["opened", "reopened", "synchronize", "ready_for_review"] }],
  failOn: "high",
  reportOn: "medium",
  minConfidence: "medium"
};
