import * as core from "@actions/core";
import { ConfigError } from "../../core/src/errors.ts";
import {
  AGENTS,
  MODES,
  PERMISSION_LEVELS,
  type AgentId,
  type PermissionLevel,
  type ShuvbotMode,
  isOneOf
} from "../../core/src/types.ts";

export interface ActionInputs {
  prompt?: string;
  mode?: ShuvbotMode;
  config?: string;
  model?: string;
  agent?: AgentId;
  timeout?: string;
  activityTimeout?: string;
  cwd?: string;
  push?: PermissionLevel;
  shell?: PermissionLevel;
  token?: string;
  /**
   * Review engine, opt-in only. The config default is `coordinator`, but the
   * Action must not adopt it silently: the coordinator needs a pinned shuvcode
   * runtime installed in the job and a non-interactive credential, neither of
   * which an existing workflow has. Selecting it here is the deliberate act.
   */
  engine?: ReviewEngine;
}

export const REVIEW_ENGINES = ["legacy", "coordinator"] as const;
export type ReviewEngine = (typeof REVIEW_ENGINES)[number];

export function readActionInputs(): ActionInputs {
  const inputs: ActionInputs = {};
  setOptional(inputs, "prompt", optionalInput("prompt"));
  setOptional(inputs, "mode", optionalEnumInput("mode", MODES));
  setOptional(inputs, "config", optionalInput("config"));
  setOptional(inputs, "model", optionalInput("model"));
  setOptional(inputs, "agent", optionalEnumInput("agent", AGENTS));
  setOptional(inputs, "timeout", optionalInput("timeout"));
  setOptional(inputs, "activityTimeout", optionalInput("activity_timeout"));
  setOptional(inputs, "cwd", optionalInput("cwd"));
  setOptional(inputs, "push", optionalEnumInput("push", PERMISSION_LEVELS));
  setOptional(inputs, "shell", optionalEnumInput("shell", PERMISSION_LEVELS));
  setOptional(inputs, "token", optionalInput("token"));
  setOptional(inputs, "engine", optionalEnumInput("engine", REVIEW_ENGINES));
  return inputs;
}

function setOptional<K extends keyof ActionInputs>(
  inputs: ActionInputs,
  key: K,
  value: ActionInputs[K] | undefined
): void {
  if (value !== undefined) inputs[key] = value;
}

function optionalInput(name: string): string | undefined {
  const value = core.getInput(name);
  return value.length > 0 ? value : undefined;
}

function optionalEnumInput<const T extends readonly string[]>(
  name: string,
  allowed: T
): T[number] | undefined {
  const value = optionalInput(name);
  if (value === undefined) return undefined;
  if (isOneOf(value, allowed)) return value;
  throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}`);
}
