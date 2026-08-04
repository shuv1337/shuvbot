import type { BotEvent } from "./events.ts";
import type { ShuvbotMode } from "./types.ts";
import type { ActorPermission, PermissionLevel } from "./types.ts";

export type { ActorPermission } from "./types.ts";

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
  /**
   * Human-readable trail of decisions that produced this policy. Useful for
   * workflow summaries and debugging.
   */
  reasons: readonly string[];
}

export interface PolicyInput {
  actor: string;
  actorPermission: ActorPermission;
  event: string;
  isFork: boolean;
  isPrivateRepo: boolean;
}

const WRITE_LEVELS: readonly ActorPermission[] = ["write", "maintain", "admin"];
const MAINTAIN_LEVELS: readonly ActorPermission[] = ["maintain", "admin"];

const LEVEL_RANK: Record<PermissionLevel, number> = {
  disabled: 0,
  restricted: 1,
  enabled: 2
};

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
    canUpdatePullRequest: hasWrite && !input.isFork,
    reasons: [`actor:${input.actorPermission}`, `fork:${input.isFork}`]
  };
}

export function applyRuntimeCaps(
  policy: RuntimePolicy,
  caps: Partial<Pick<RuntimePolicy, "shell" | "push">>
): RuntimePolicy {
  const reasons = [...policy.reasons];
  let { shell, push } = policy;
  if (caps.shell !== undefined) {
    const capped = capPermission(policy.shell, caps.shell);
    if (capped !== policy.shell) reasons.push(`cap:shell=${capped}`);
    shell = capped;
  }
  if (caps.push !== undefined) {
    const capped = capPermission(policy.push, caps.push);
    if (capped !== policy.push) reasons.push(`cap:push=${capped}`);
    push = capped;
  }
  return { ...policy, shell, push, reasons };
}

function capPermission(current: PermissionLevel, requested: PermissionLevel): PermissionLevel {
  return LEVEL_RANK[requested] < LEVEL_RANK[current] ? requested : current;
}

export interface BuildRuntimePolicyInput {
  event: BotEvent;
  mode: ShuvbotMode;
  actor: {
    login: string;
    actorPermission: ActorPermission;
    isFork: boolean;
    isPrivateRepo: boolean;
  };
  configCaps: {
    shell: PermissionLevel;
    push: PermissionLevel;
  };
  inputCaps?: {
    shell?: PermissionLevel;
    push?: PermissionLevel;
  };
}

/**
 * Construct the final runtime policy from event/mode/actor/config inputs.
 *
 * Resolution order (later wins for restrictions, never for escalation):
 *   1. context defaults derived from the actor + event
 *   2. config caps
 *   3. action input caps
 *   4. event/mode hard restrictions (fork PR forces disabled, etc.)
 */
export function buildRuntimePolicy(input: BuildRuntimePolicyInput): RuntimePolicy {
  const base = contextDefaults({
    actor: input.actor.login,
    actorPermission: input.actor.actorPermission,
    event: input.event.name,
    isFork: input.actor.isFork,
    isPrivateRepo: input.actor.isPrivateRepo
  });

  let policy = applyRuntimeCaps(base, input.configCaps);
  if (input.inputCaps) policy = applyRuntimeCaps(policy, input.inputCaps);

  policy = applyEventRestrictions(policy, input.event, input.mode);
  return policy;
}

/**
 * Default permission matrix from SPEC §9.2.
 */
function contextDefaults(input: PolicyInput): RuntimePolicy {
  const policy = defaultRuntimePolicy(input);
  const reasons = [...policy.reasons];

  const isPrEvent = input.event === "pull_request" || input.event === "pull_request_target";
  const isScheduled = input.event === "schedule";
  const isDispatch = input.event === "workflow_dispatch";
  const isCommentEvent =
    input.event === "issue_comment" ||
    input.event === "pull_request_review_comment" ||
    input.event === "issues";

  const hasWrite = WRITE_LEVELS.includes(input.actorPermission);
  const hasMaintain = MAINTAIN_LEVELS.includes(input.actorPermission);

  let shell: PermissionLevel = policy.shell;
  let push: PermissionLevel = policy.push;

  if (input.isFork) {
    shell = "disabled";
    push = "disabled";
    reasons.push("fork:shell=disabled", "fork:push=disabled");
  } else if (isPrEvent && !hasWrite) {
    shell = "restricted";
    push = "disabled";
    reasons.push("pr-non-collab:shell=restricted", "pr-non-collab:push=disabled");
  } else if (isCommentEvent && hasMaintain) {
    shell = "restricted";
    push = "restricted";
    reasons.push("maintainer-mention:default=restricted");
  } else if (isCommentEvent && hasWrite) {
    shell = "restricted";
    push = "restricted";
    reasons.push("collab-mention:default=restricted");
  } else if (isScheduled) {
    shell = "restricted";
    push = "restricted";
    reasons.push("schedule:default=restricted");
  } else if (isDispatch && hasWrite) {
    shell = "restricted";
    push = "restricted";
    reasons.push("dispatch:default=restricted");
  }

  return { ...policy, shell, push, reasons };
}

function applyEventRestrictions(
  policy: RuntimePolicy,
  event: BotEvent,
  mode: ShuvbotMode
): RuntimePolicy {
  const reasons = [...policy.reasons];
  let { shell, push, canReadSecrets, canApprove } = policy;

  if (policy.isFork) {
    if (shell !== "disabled") {
      shell = "disabled";
      reasons.push("hard:fork:shell=disabled");
    }
    if (push !== "disabled") {
      push = "disabled";
      reasons.push("hard:fork:push=disabled");
    }
    if (canReadSecrets) {
      canReadSecrets = false;
      reasons.push("hard:fork:no-secrets");
    }
  }

  if (mode === "review") {
    if (push !== "disabled") {
      push = "disabled";
      reasons.push("mode:review:push=disabled");
    }
  }

  if (mode === "release-notes" && push !== "disabled") {
    push = "disabled";
    reasons.push("mode:release-notes:push=disabled");
  }

  if (event.kind === "workflow_run" && event.conclusion !== "failure" && mode === "fix-ci") {
    reasons.push("warn:workflow_run-not-failed");
  }

  // AI approval is never permitted in v1 regardless of intent.
  if (canApprove) {
    canApprove = false;
    reasons.push("hard:no-ai-approval");
  }

  return { ...policy, shell, push, canReadSecrets, canApprove, reasons };
}
