import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, basename } from "node:path";
import type { GitHubClient } from "../../../github/src/octokit.ts";
import { ToolExecutionError } from "../../../core/src/errors.ts";
import type { ToolContext, ToolSchema } from "../tool-spec.ts";

export const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false
} satisfies ToolSchema;

export const LABEL_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    color: { type: "string" },
    description: { type: "string" }
  },
  additionalProperties: true
} satisfies ToolSchema;

export function requireClient(context: ToolContext): GitHubClient {
  if (!context.client) throw new ToolExecutionError("MCP tool requires a GitHub client");
  return context.client;
}

export function requireRepo(context: ToolContext): { owner: string; name: string } {
  if (!context.repo) throw new ToolExecutionError("MCP tool requires repository context");
  return context.repo;
}

export function requireCwd(context: ToolContext): string {
  if (!context.cwd) throw new ToolExecutionError("MCP tool requires workspace cwd");
  return context.cwd;
}

export function boundedString(value: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false, bytes: buffer.byteLength };
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[reviewbot:truncated maxBytes=${maxBytes}]`,
    truncated: true,
    bytes: buffer.byteLength
  };
}

export async function readWorkspaceFile(
  context: ToolContext,
  filePath: string,
  maxBytes: number
): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
  const cwd = resolve(requireCwd(context));
  if (isAbsolute(filePath)) throw new ToolExecutionError("read_file path must be relative to the workspace");
  const resolved = resolve(cwd, filePath);
  const relativePath = relative(cwd, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ToolExecutionError("read_file path escapes the workspace");
  }
  assertWorkspaceReadAllowed(relativePath);
  const realCwd = await realpath(cwd);
  const realResolved = await realpath(resolved);
  const realRelativePath = relative(realCwd, realResolved);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw new ToolExecutionError("read_file path escapes the workspace");
  }
  assertWorkspaceReadAllowed(realRelativePath);
  const content = await readFile(realResolved, "utf8");
  const bounded = boundedString(content, maxBytes);
  return {
    path: relativePath,
    content: bounded.text,
    truncated: bounded.truncated,
    bytes: bounded.bytes
  };
}

function assertWorkspaceReadAllowed(relativePath: string): void {
  const segments = relativePath.split(sep).filter(Boolean);
  const fileName = basename(relativePath).toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (
    lowerSegments.includes(".git") ||
    lowerSegments.includes(".aws") ||
    lowerSegments.includes(".ssh") ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === ".npmrc" ||
    fileName === ".netrc" ||
    fileName.includes("credentials")
  ) {
    throw new ToolExecutionError(`read_file refuses credential-bearing path: ${relativePath}`);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

export function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : false;
}

export function labelsValue(record: Record<string, unknown>): Array<{ name: string; color?: string; description?: string }> {
  return asArray(record.labels).map((label) => {
    const labelRecord = asRecord(label);
    const result: { name: string; color?: string; description?: string } = {
      name: stringValue(labelRecord, "name")
    };
    const color = stringValue(labelRecord, "color");
    const description = stringValue(labelRecord, "description");
    if (color) result.color = color;
    if (description) result.description = description;
    return result;
  });
}

export const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" }
} satisfies ToolSchema;
