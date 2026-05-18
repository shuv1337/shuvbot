import type { PermissionLevel } from "./types.ts";

export type ActorPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface RuntimePolicy {
  actor: string;
  actorPermission: ActorPermission;
  event: string;
  isFork: boolean;
  isPrivateRepo: boolean;
  shell: PermissionLevel;
  push: PermissionLevel;
  canCreatePr: boolean;
  canComment: boolean;
  canReview: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReadChecks: boolean;
  canReadSecrets: boolean;
  canAddLabels: boolean;
  canUpdateIssue: boolean;
  canUpdatePullRequest: boolean;
}

export interface PolicyInput {
  actor: string;
  actorPermission: ActorPermission;
  event: string;
  isFork: boolean;
  isPrivateRepo: boolean;
}

const WRITE_LEVELS: ActorPermission[] = ["write", "maintain", "admin"];
const MAINTAIN_LEVELS: ActorPermission[] = ["maintain", "admin"];

export function defaultRuntimePolicy(input: PolicyInput): RuntimePolicy {
  const hasWrite = WRITE_LEVELS.includes(input.actorPermission);
  const hasMaintain = MAINTAIN_LEVELS.includes(input.actorPermission);
  const isTrusted = hasWrite && !input.isFork;
  const canComment = input.actorPermission !== "none";

  return {
    ...input,
    shell: isTrusted ? "restricted" : "disabled",
    push: isTrusted ? "restricted" : "disabled",
    canCreatePr: isTrusted,
    canComment,
    canReview: canComment && !input.isFork,
    canApprove: false,
    canRequestChanges: isTrusted,
    canReadChecks: canComment,
    canReadSecrets: hasMaintain && !input.isFork && input.isPrivateRepo,
    canAddLabels: hasWrite && !input.isFork,
    canUpdateIssue: hasWrite && !input.isFork,
    canUpdatePullRequest: hasWrite && !input.isFork
  };
}

export function applyRuntimeCaps(
  policy: RuntimePolicy,
  caps: Partial<Pick<RuntimePolicy, "shell" | "push">>
): RuntimePolicy {
  return {
    ...policy,
    shell: capPermission(policy.shell, caps.shell),
    push: capPermission(policy.push, caps.push)
  };
}

function capPermission(current: PermissionLevel, requested: PermissionLevel | undefined): PermissionLevel {
  if (requested === undefined) return current;
  const rank: Record<PermissionLevel, number> = { disabled: 0, restricted: 1, enabled: 2 };
  return rank[requested] < rank[current] ? requested : current;
}
