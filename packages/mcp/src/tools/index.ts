import type { ToolSpec } from "../tool-spec.ts";
import { checksTools } from "./checks.ts";
import { commentTools } from "./comment.ts";
import { filesTools } from "./files.ts";
import { gitTools } from "./git.ts";
import { issueTools } from "./issue.ts";
import { labelsTools } from "./labels.ts";
import { memoryTools } from "./memory.ts";
import { outputTools } from "./output.ts";
import { prTools } from "./pr.ts";
import { reviewTools } from "./review.ts";
import { shellTools } from "./shell.ts";

export const readContextTools = [
  ...prTools,
  ...issueTools,
  ...checksTools,
  ...filesTools
] satisfies readonly ToolSpec<unknown, unknown>[];

export const writeGithubTools = [
  ...commentTools,
  ...reviewTools,
  ...labelsTools,
  ...outputTools
] satisfies readonly ToolSpec<unknown, unknown>[];

export const allMcpTools = [
  ...readContextTools,
  ...writeGithubTools,
  ...gitTools,
  ...shellTools,
  ...memoryTools
] satisfies readonly ToolSpec<unknown, unknown>[];
