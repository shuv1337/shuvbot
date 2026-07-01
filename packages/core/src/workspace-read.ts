import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ToolExecutionError } from "./errors.ts";

export interface SafeWorkspaceReadResult {
  relativePath: string;
  realPath: string;
  content: string;
}

export async function readSafeWorkspaceFile(cwd: string, filePath: string): Promise<SafeWorkspaceReadResult> {
  const workspaceRoot = resolve(cwd);
  if (isAbsolute(filePath)) throw new ToolExecutionError("workspace file path must be relative to the workspace");

  const resolved = resolve(workspaceRoot, filePath);
  const relativePath = relative(workspaceRoot, resolved);
  if (pathEscapesWorkspace(relativePath)) {
    throw new ToolExecutionError("workspace file path escapes the workspace");
  }
  assertWorkspaceReadAllowed(relativePath);

  const realWorkspaceRoot = await realpath(workspaceRoot);
  const realResolved = await realpath(resolved);
  const realRelativePath = relative(realWorkspaceRoot, realResolved);
  if (pathEscapesWorkspace(realRelativePath)) {
    throw new ToolExecutionError("workspace file path escapes the workspace");
  }
  assertWorkspaceReadAllowed(realRelativePath);

  return {
    relativePath,
    realPath: realResolved,
    content: await readFile(realResolved, "utf8")
  };
}

export function assertWorkspaceReadAllowed(relativePath: string): void {
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
    throw new ToolExecutionError(`workspace file read refuses credential-bearing path: ${relativePath}`);
  }
}

function pathEscapesWorkspace(relativePath: string): boolean {
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}
