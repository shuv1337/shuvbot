import type { BotEvent } from "../../core/src/events.ts";
import type { ActorPermission } from "../../core/src/types.ts";
import type { GitHubClient } from "./octokit.ts";

export interface ActorContext {
  login: string;
  actorPermission: ActorPermission;
  isFork: boolean;
  isPrivateRepo: boolean;
}

export interface DeriveActorContextInput {
  event: BotEvent;
  client?: GitHubClient;
  /**
   * Optional explicit override for actor permission. Useful for tests or when
   * the workflow already knows the actor permission (e.g., from action context).
   */
  actorPermission?: ActorPermission;
  /**
   * Explicit fork status, for events whose payload cannot answer it. Supply
   * this after fetching the pull request; see `detectFork`.
   */
  isFork?: boolean;
}

/**
 * Fork status drives hard policy restrictions, so an unknown answer must be the
 * restrictive one. `pull_request` and `pull_request_review_comment` payloads
 * carry the head repository and can answer precisely. An `issue_comment`
 * payload does not: it has an `issue`, not a pull request, and nothing in it
 * identifies the head repo. For a comment on a pull request that is genuinely
 * unknowable here, so it reports `true` (treat as a fork) and callers that need
 * the real answer must fetch the pull request and pass `isFork` explicitly.
 *
 * Reporting `false` for that case would silently exempt every comment-triggered
 * run on a fork pull request from the fork restrictions in `buildRuntimePolicy`.
 */
export function detectFork(event: BotEvent): boolean {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_review_comment":
      return event.pullRequest.isFork;
    case "issue_comment":
      return event.issue.isPullRequest;
    default:
      return false;
  }
}

export function detectPrivateRepo(event: BotEvent): boolean {
  return Boolean(event.repo.isPrivate);
}

export function resolveActorLogin(event: BotEvent): string {
  switch (event.kind) {
    case "issue_comment":
    case "pull_request_review_comment":
      return event.comment.user.login || event.sender.login;
    case "issues":
      return event.issue.user.login || event.sender.login;
    case "pull_request":
      return event.pullRequest.user.login || event.sender.login;
    default:
      return event.sender.login;
  }
}

export async function deriveActorContext(input: DeriveActorContextInput): Promise<ActorContext> {
  const login = resolveActorLogin(input.event);
  const isFork = input.isFork ?? detectFork(input.event);
  const isPrivateRepo = detectPrivateRepo(input.event);

  const explicit = input.actorPermission;
  if (explicit) {
    return { login, actorPermission: explicit, isFork, isPrivateRepo };
  }

  if (!input.client || !login || !input.event.repo.owner || !input.event.repo.name) {
    return { login, actorPermission: "none", isFork, isPrivateRepo };
  }

  const actorPermission = await fetchActorPermission({
    client: input.client,
    owner: input.event.repo.owner,
    repo: input.event.repo.name,
    username: login
  });
  return { login, actorPermission, isFork, isPrivateRepo };
}

export interface FetchActorPermissionInput {
  client: GitHubClient;
  owner: string;
  repo: string;
  username: string;
}

const PERMISSION_MAP: Record<string, ActorPermission> = {
  none: "none",
  read: "read",
  triage: "triage",
  write: "write",
  maintain: "maintain",
  admin: "admin"
};

interface CollaboratorPermissionPayload {
  permission?: string;
  role_name?: string;
}

export async function fetchActorPermission(
  input: FetchActorPermissionInput
): Promise<ActorPermission> {
  try {
    const response = await input.client.request<CollaboratorPermissionPayload>(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { params: { owner: input.owner, repo: input.repo, username: input.username } }
    );
    const role = response.data.role_name?.toLowerCase();
    if (role && PERMISSION_MAP[role]) return PERMISSION_MAP[role];
    const permission = response.data.permission?.toLowerCase();
    if (permission && PERMISSION_MAP[permission]) return PERMISSION_MAP[permission];
    return "none";
  } catch {
    return "none";
  }
}
