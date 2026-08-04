import type { ReviewPlugin } from "./types.ts";

// Local diff loading and finding-state persistence are added by later milestones.
export function createLocalReviewPlugin(): ReviewPlugin {
  return { id: "local" };
}
