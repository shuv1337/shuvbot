import { normalizeEvent, type BotEvent, type PullRequestEvent } from "../../core/src/events.ts";
import type { GitHubClient } from "./octokit.ts";

export interface ReviewTarget {
  pullNumber: number;
  isFork: boolean;
  draft: boolean;
  state: "open" | "closed";
  /**
   * A `pull_request`-shaped event for the review pipeline. Review skills
   * trigger on `pull_request` actions, and context assembly reads the raw
   * payload, so a comment-triggered run is presented as the pull request it
   * refers to rather than as the comment.
   */
  event: PullRequestEvent;
  /** Whether a human asked for this by commenting, or the event itself fired. */
  trigger: "event" | "comment";
}

/** The action a synthesized event reports: "review the pull request as it stands". */
const SYNTHETIC_ACTION = "synchronize";

/**
 * Resolve which pull request a run should act on.
 *
 * `pull_request` payloads are already the right shape. A
 * `pull_request_review_comment` carries the full pull request in its raw
 * payload. An `issue_comment` carries neither, so the pull request is fetched;
 * see `detectFork`, which reports the restrictive answer until this runs.
 *
 * Returns `null` when the event does not refer to a pull request.
 */
export async function resolveReviewTarget(input: {
  event: BotEvent;
  client?: GitHubClient;
}): Promise<ReviewTarget | null> {
  const { event, client } = input;

  switch (event.kind) {
    case "pull_request":
      return fromEvent(event, "event");

    case "pull_request_review_comment":
      return fromEvent(synthesize(event.raw, SYNTHETIC_ACTION), "comment");

    case "issue_comment": {
      if (!event.issue.isPullRequest || !client) return null;

      const response = await client.request<Record<string, unknown>>(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          params: {
            owner: event.repo.owner,
            repo: event.repo.name,
            pull_number: event.issue.number
          }
        }
      );
      if (!response.data || typeof response.data !== "object") return null;

      return fromEvent(
        synthesize(event.raw, SYNTHETIC_ACTION, { pull_request: response.data }),
        "comment"
      );
    }

    default:
      return null;
  }
}

function fromEvent(event: PullRequestEvent, trigger: "event" | "comment"): ReviewTarget {
  return {
    pullNumber: event.pullRequest.number,
    isFork: event.pullRequest.isFork,
    draft: event.pullRequest.draft,
    state: event.pullRequest.state,
    event,
    trigger
  };
}

/**
 * Re-normalize a raw payload as a `pull_request` event so fork status, draft
 * state, and head/base all come from `parsePullRequest` rather than a second,
 * drifting implementation.
 */
function synthesize(
  raw: unknown,
  action: string,
  extra: Record<string, unknown> = {}
): PullRequestEvent {
  const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const payload = { ...base, ...extra, action };
  const normalized = normalizeEvent({ eventName: "pull_request", payload });
  if (normalized.kind !== "pull_request") {
    throw new Error("synthesized payload did not normalize to a pull_request event");
  }
  return normalized;
}
