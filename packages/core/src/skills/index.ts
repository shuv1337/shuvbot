import { codeReviewSkill } from "./code-review.ts";

export const builtInReviewSkills = [codeReviewSkill] as const;

export function getReviewSkill(id: string): typeof codeReviewSkill | undefined {
  return builtInReviewSkills.find((skill) => skill.id === id);
}
