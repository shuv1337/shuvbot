import type { ToolSpec } from "../tool-spec.ts";
import { checksTools } from "./checks.ts";
import { filesTools } from "./files.ts";
import { issueTools } from "./issue.ts";
import { prTools } from "./pr.ts";

export const readContextTools = [
  ...prTools,
  ...issueTools,
  ...checksTools,
  ...filesTools
] satisfies readonly ToolSpec<unknown, unknown>[];
