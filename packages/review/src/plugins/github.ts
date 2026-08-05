import type { ReviewPlugin } from "./types.ts";

/**
 * Identifies the GitHub review surface during plugin assembly.
 *
 * Deliberately contributes no reviewers, models, or prompt sections: GitHub
 * specifics that do exist - diff collection, posting, finding-thread state -
 * are deterministic shuvbot code outside the agent trust boundary, and inventing
 * prompt content here would put platform text in front of the reviewers without
 * any behaviour behind it. Peer of `createLocalReviewPlugin`.
 */
export function createGitHubReviewPlugin(): ReviewPlugin {
  return { id: "github" };
}
