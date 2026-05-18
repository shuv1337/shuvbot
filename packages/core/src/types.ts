export const MODES = ["auto", "review", "implement", "fix-ci", "triage", "release-notes"] as const;
export type ReviewbotMode = (typeof MODES)[number];

export type ActorPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export const ACTOR_PERMISSIONS: readonly ActorPermission[] = [
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin"
] as const;

export const AGENTS = ["claude-code", "anthropic-sdk", "openai", "codex-cli", "aider"] as const;
export type AgentId = (typeof AGENTS)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PERMISSION_LEVELS = ["disabled", "restricted", "enabled"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}
