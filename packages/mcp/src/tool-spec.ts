import { PolicyDeniedError, ReviewbotError, StructuredOutputError } from "../../core/src/errors.ts";
import type { Redactor } from "../../core/src/redaction.ts";
import type { RuntimePolicy } from "../../core/src/policy.ts";
import type { ReviewbotMode } from "../../core/src/types.ts";
import type { RunLogger } from "../../core/src/observability.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import type { ReviewbotStatePlaceholder } from "../../core/src/state.ts";
import { createToolAuditRecord, type ToolAuditRecord, type ToolAuditSink } from "./audit.ts";

export type { ToolAuditRecord, ToolAuditSink, ToolAuditSnapshot, ToolAuditSummary } from "./audit.ts";

export type ToolSchema =
  | { type: "object"; required?: readonly string[]; properties: Record<string, ToolSchema>; additionalProperties?: boolean }
  | { type: "array"; items: ToolSchema }
  | { type: "string"; enum?: readonly string[]; minLength?: number }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "null" };

export interface ToolSpec<Input, Output> {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  requiredPolicy?: ToolPolicyRequirement;
  handler(input: Input, context: ToolContext): Promise<Output> | Output;
}

export interface ToolContext {
  repo?: {
    owner: string;
    name: string;
  };
  runId: string;
  actor: string;
  mode: ReviewbotMode;
  policy: RuntimePolicy;
  client?: GitHubClient;
  cwd?: string;
  redactor: Redactor;
  audit: ToolAuditSink;
  logger?: RunLogger;
  state?: ReviewbotStatePlaceholder;
  now?: () => number;
}

export interface ToolPolicyRequirement {
  shell?: "restricted" | "enabled";
  push?: "restricted" | "enabled";
  canCreatePr?: true;
  canComment?: true;
  canReview?: true;
  canRequestChanges?: true;
  canReadChecks?: true;
  canReadSecrets?: true;
  canAddLabels?: true;
  canUpdateIssue?: true;
  canUpdatePullRequest?: true;
}

export async function executeTool<Input, Output>(
  spec: ToolSpec<Input, Output>,
  rawInput: unknown,
  context: ToolContext
): Promise<Output> {
  const startedAt = context.now?.() ?? Date.now();
  let policyDecision: ToolAuditRecord["policyDecision"] = "allowed";

  try {
    const input = validateToolInput<Input>(spec, rawInput);
    assertToolPolicy(spec, context.policy);
    const output = await spec.handler(input, context);
    validateToolOutput(spec, output);
    await context.audit.record(createToolAuditRecord({
      runId: context.runId,
      toolName: spec.name,
      actor: context.actor,
      mode: context.mode,
      status: "success",
      durationMs: elapsedMs(startedAt, context),
      policyDecision,
      input: rawInput,
      output
    }, context.redactor));
    return output;
  } catch (error) {
    if (error instanceof PolicyDeniedError) policyDecision = "denied";
    const recordInput = {
      runId: context.runId,
      toolName: spec.name,
      actor: context.actor,
      mode: context.mode,
      status: "failure",
      durationMs: elapsedMs(startedAt, context),
      policyDecision,
      input: rawInput,
      error
    } as const;
    await context.audit.record(createToolAuditRecord(
      error instanceof ReviewbotError ? { ...recordInput, errorCode: error.code } : recordInput,
      context.redactor
    ));
    throw error;
  }
}

export function validateToolInput<Input>(spec: ToolSpec<Input, unknown>, input: unknown): Input {
  const errors = validateSchema(spec.inputSchema, input, "input");
  if (errors.length > 0) throw new StructuredOutputError(`${spec.name} input schema failed: ${errors.join("; ")}`);
  return input as Input;
}

export function validateToolOutput<Output>(spec: ToolSpec<unknown, Output>, output: unknown): Output {
  const errors = validateSchema(spec.outputSchema, output, "output");
  if (errors.length > 0) throw new StructuredOutputError(`${spec.name} output schema failed: ${errors.join("; ")}`);
  return output as Output;
}

export function assertToolPolicy(spec: Pick<ToolSpec<unknown, unknown>, "name" | "requiredPolicy">, policy: RuntimePolicy): void {
  const required = spec.requiredPolicy;
  if (!required) return;

  const failures: string[] = [];
  if (required.shell && !allowsLevel(policy.shell, required.shell)) failures.push(`shell:${policy.shell}`);
  if (required.push && !allowsLevel(policy.push, required.push)) failures.push(`push:${policy.push}`);
  for (const key of BOOLEAN_POLICY_KEYS) {
    if (required[key] && !policy[key]) failures.push(`${key}:false`);
  }

  if (failures.length > 0) {
    throw new PolicyDeniedError(`Tool ${spec.name} denied by runtime policy: ${failures.join(", ")}`);
  }
}

function validateSchema(schema: ToolSchema, value: unknown, path: string): string[] {
  switch (schema.type) {
    case "object":
      return validateObjectSchema(schema, value, path);
    case "array":
      return validateArraySchema(schema, value, path);
    case "string":
      return validateStringSchema(schema, value, path);
    case "number":
    case "integer":
      return validateNumberSchema(schema, value, path);
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be boolean`];
    case "null":
      return value === null ? [] : [`${path} must be null`];
  }
}

function validateObjectSchema(
  schema: Extract<ToolSchema, { type: "object" }>,
  value: unknown,
  path: string
): string[] {
  if (!isPlainObject(value)) return [`${path} must be object`];
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
  for (const [key, entryValue] of Object.entries(value)) {
    const property = schema.properties[key];
    if (!property) {
      if (schema.additionalProperties !== true) errors.push(`${path}.${key} is not allowed`);
      continue;
    }
    errors.push(...validateSchema(property, entryValue, `${path}.${key}`));
  }
  return errors;
}

function validateArraySchema(
  schema: Extract<ToolSchema, { type: "array" }>,
  value: unknown,
  path: string
): string[] {
  if (!Array.isArray(value)) return [`${path} must be array`];
  return value.flatMap((item, index) => validateSchema(schema.items, item, `${path}[${index}]`));
}

function validateStringSchema(
  schema: Extract<ToolSchema, { type: "string" }>,
  value: unknown,
  path: string
): string[] {
  if (typeof value !== "string") return [`${path} must be string`];
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return [`${path} must be at least ${schema.minLength} characters`];
  }
  if (schema.enum && !schema.enum.includes(value)) return [`${path} must be one of ${schema.enum.join(", ")}`];
  return [];
}

function validateNumberSchema(
  schema: Extract<ToolSchema, { type: "number" | "integer" }>,
  value: unknown,
  path: string
): string[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be ${schema.type}`];
  if (schema.type === "integer" && !Number.isInteger(value)) return [`${path} must be integer`];
  if (schema.minimum !== undefined && value < schema.minimum) return [`${path} must be >= ${schema.minimum}`];
  if (schema.maximum !== undefined && value > schema.maximum) return [`${path} must be <= ${schema.maximum}`];
  return [];
}

function allowsLevel(actual: RuntimePolicy["shell"], required: "restricted" | "enabled"): boolean {
  if (required === "restricted") return actual === "restricted" || actual === "enabled";
  return actual === "enabled";
}

function elapsedMs(startedAt: number, context: ToolContext): number {
  return Math.max(0, (context.now?.() ?? Date.now()) - startedAt);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOOLEAN_POLICY_KEYS = [
  "canCreatePr",
  "canComment",
  "canReview",
  "canRequestChanges",
  "canReadChecks",
  "canReadSecrets",
  "canAddLabels",
  "canUpdateIssue",
  "canUpdatePullRequest"
] as const;
