import type { ToolSpec } from "../tool-spec.ts";
import { checksTools } from "./checks.ts";
import { commentTools } from "./comment.ts";
import { filesTools } from "./files.ts";
import { issueTools } from "./issue.ts";
import { labelsTools } from "./labels.ts";
import { outputTools } from "./output.ts";
import { prTools } from "./pr.ts";
import { reviewTools } from "./review.ts";

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
  ...writeGithubTools
] satisfies readonly ToolSpec<unknown, unknown>[];
