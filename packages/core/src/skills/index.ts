import type { ReviewFinding } from "../review-schema.ts";
import type { PullRequestEvent } from "../events.ts";
import type { ReviewbotConfig } from "../config.ts";
import { codeReviewSkill } from "./code-review.ts";
import { docsReviewSkill } from "./docs-review.ts";
import { securityReviewSkill } from "./security-review.ts";
import { testReviewSkill } from "./test-review.ts";
import { workflowSecuritySkill } from "./workflow-security.ts";

export interface ReviewSkill {
  id: string;
  prompt: string;
  paths: string[];
  ignorePaths: string[];
  triggers: Array<{ event: PullRequestEvent["kind"]; actions: string[] }>;
  failOn: ReviewFinding["severity"];
  reportOn: ReviewFinding["severity"];
  minConfidence: ReviewFinding["confidence"];
}

export const builtInReviewSkills: readonly ReviewSkill[] = [
  codeReviewSkill,
  securityReviewSkill,
  workflowSecuritySkill,
  testReviewSkill,
  docsReviewSkill
];

export function runnableReviewSkills(input: {
  event: PullRequestEvent;
  files: readonly { filename?: string }[];
  config: Pick<ReviewbotConfig, "paths" | "failOn" | "reportOn" | "minConfidence">;
  skills?: readonly ReviewSkill[];
}): ReviewSkill[] {
  const changedPaths = input.files.map((file) => file.filename).filter((filename): filename is string => Boolean(filename));
  return [...(input.skills ?? builtInReviewSkills)].filter((skill) => {
    const trigger = skill.triggers.some((candidate) =>
      candidate.event === input.event.kind && candidate.actions.includes(input.event.action)
    );
    if (!trigger) return false;
    return changedPaths.some((path) =>
      matchesAny(path, input.config.paths.include)
        && !matchesAny(path, input.config.paths.ignore, false)
        && matchesAny(path, skill.paths)
        && !matchesAny(path, skill.ignorePaths, false)
    );
  });
}

export function getReviewSkill(id: string, skills: readonly ReviewSkill[] = builtInReviewSkills): ReviewSkill | undefined {
  return skills.find((skill) => skill.id === id);
}

export function matchesAny(path: string, patterns: readonly string[], emptyResult = true): boolean {
  return patterns.length === 0 ? emptyResult : patterns.some((pattern) => matchesPattern(path, pattern));
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "**/*" || pattern === path) return true;
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith("**/*.")) return path.endsWith(pattern.slice(4));
  if (pattern.startsWith("**/")) return path.endsWith(pattern.slice(3));
  if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
  return false;
}
