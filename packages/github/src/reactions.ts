import type { BotEvent } from "../../core/src/events.ts";
import { GitHubRequestError, type GitHubClient } from "./octokit.ts";

export type CommentReaction = "eyes" | "rocket" | "confused";
export type MentionReactionPhase = "start" | "success" | "failure";
export type CommentReactionTargetKind = "issue_comment" | "pull_request_review_comment";

export interface CommentReactionTarget {
  readonly kind: CommentReactionTargetKind;
  readonly commentId: number;
}

export interface MentionReactionInput {
  readonly client: GitHubClient;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly target: CommentReactionTarget;
  readonly botLogin: string;
}

/**
 * The comment a mention was typed into, if this event has one.
 *
 * Pull-request events and other ambient triggers have no comment to react on.
 * Mention UX lives on the triggering comment only: a rocket on the pull request
 * itself can read as endorsing the change.
 */
export function triggerCommentFromEvent(event: BotEvent): CommentReactionTarget | undefined {
  switch (event.kind) {
    case "issue_comment":
      return event.comment.id > 0
        ? { kind: "issue_comment", commentId: event.comment.id }
        : undefined;
    case "pull_request_review_comment":
      return event.comment.id > 0
        ? { kind: "pull_request_review_comment", commentId: event.comment.id }
        : undefined;
    case "pull_request":
    case "issues":
    case "workflow_dispatch":
    case "workflow_run":
    case "schedule":
      return undefined;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Eyes while the mention is in flight, then rocket or confused when it ends.
 *
 * Cosmetic: a GitHub failure here never fails the run. Duplicate reactions are
 * treated as already applied.
 */
export async function signalMentionLifecycle(
  input: MentionReactionInput & { readonly phase: MentionReactionPhase }
): Promise<"applied" | "skipped"> {
  try {
    await applyMentionLifecycle(input);
    return "applied";
  } catch {
    return "skipped";
  }
}

export async function applyMentionLifecycle(
  input: MentionReactionInput & { readonly phase: MentionReactionPhase }
): Promise<void> {
  switch (input.phase) {
    case "start":
      await addCommentReaction(input, "eyes");
      return;
    case "success":
      await removeOwnCommentReaction(input, "eyes");
      await addCommentReaction(input, "rocket");
      return;
    case "failure":
      await removeOwnCommentReaction(input, "eyes");
      await addCommentReaction(input, "confused");
      return;
    default: {
      const _exhaustive: never = input.phase;
      throw new Error(`unhandled mention reaction phase: ${_exhaustive}`);
    }
  }
}

export async function addCommentReaction(
  input: MentionReactionInput,
  content: CommentReaction
): Promise<void> {
  try {
    await input.client.request(`POST ${reactionCollectionPath(input.target)}`, {
      params: reactionParams(input),
      body: { content }
    });
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 422) return;
    throw error;
  }
}

export async function removeOwnCommentReaction(
  input: MentionReactionInput,
  content: CommentReaction
): Promise<void> {
  let reactions: unknown;
  try {
    const response = await input.client.request(`GET ${reactionCollectionPath(input.target)}`, {
      params: reactionParams(input)
    });
    reactions = response.data;
  } catch {
    return;
  }
  if (!Array.isArray(reactions)) return;
  const bot = input.botLogin.toLowerCase();
  for (const reaction of reactions) {
    if (typeof reaction !== "object" || reaction === null) continue;
    const record = reaction as Record<string, unknown>;
    if (record.content !== content) continue;
    const user = record.user;
    const login =
      typeof user === "object" && user !== null && "login" in user
        ? String((user as { login?: unknown }).login ?? "")
        : "";
    if (login.toLowerCase() !== bot) continue;
    const id = record.id;
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    try {
      await input.client.request(`DELETE ${reactionCollectionPath(input.target)}/{reaction_id}`, {
        params: { ...reactionParams(input), reaction_id: id }
      });
    } catch {
      // A leftover eyes reaction is noisy, not a failed review.
    }
  }
}

function reactionCollectionPath(target: CommentReactionTarget): string {
  switch (target.kind) {
    case "issue_comment":
      return "/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions";
    case "pull_request_review_comment":
      return "/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions";
    default: {
      const _exhaustive: never = target.kind;
      throw new Error(`unhandled comment reaction target: ${_exhaustive}`);
    }
  }
}

function reactionParams(input: MentionReactionInput): Record<string, string | number> {
  return {
    owner: input.repo.owner,
    repo: input.repo.name,
    comment_id: input.target.commentId
  };
}
