import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { labelContextBlock } from "./labels.ts";
import { buildContextManifest, type ContextManifest, type ContextSection } from "./manifest.ts";

export interface AssembleReviewContextInput {
  event: unknown;
  repo: string;
  diff: string;
  files: unknown[];
  repoInstructions: ContextSection[];
  prSummary?: string;
  learnings?: string;
}

export interface ReviewContext {
  prompt: string;
  sections: ContextSection[];
  manifest: ContextManifest;
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md"
] as const;

export async function loadRepoInstructions(cwd: string): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];
  for (const relativePath of INSTRUCTION_FILES) {
    const content = await readOptional(join(cwd, relativePath));
    if (content !== undefined) {
      sections.push({
        id: `repo-instructions:${relativePath}`,
        title: `Repository instructions: ${relativePath}`,
        content,
        untrusted: false
      });
    }
  }
  for (const relativePath of await listCursorRuleFiles(cwd)) {
    const content = await readOptional(join(cwd, relativePath));
    if (content !== undefined) {
      sections.push({
        id: `repo-instructions:${relativePath}`,
        title: `Repository instructions: ${relativePath}`,
        content,
        untrusted: false
      });
    }
  }
  return sections;
}

export function assembleReviewContext(input: AssembleReviewContextInput): ReviewContext {
  const sections: ContextSection[] = [
    {
      id: "L0:repo",
      title: "Repository",
      content: input.repo,
      untrusted: false
    },
    ...input.repoInstructions,
    {
      id: "L3:event",
      title: "GitHub event",
      content: JSON.stringify(input.event, null, 2),
      untrusted: true
    },
    {
      id: "L4:files",
      title: "Changed files",
      content: JSON.stringify(input.files, null, 2),
      untrusted: true
    },
    {
      id: "L5:diff",
      title: "Pull request diff",
      content: input.diff,
      untrusted: true
    }
  ];
  if (input.prSummary) {
    sections.push({
      id: "L6:pr-summary",
      title: "Previous PR summary",
      content: input.prSummary,
      untrusted: true
    });
  }
  if (input.learnings) {
    sections.push({
      id: "L7:repo-learnings",
      title: "Repository learnings",
      content: input.learnings,
      untrusted: true
    });
  }

  return {
    sections,
    manifest: buildContextManifest(sections),
    prompt: sections.map((section) => labelContextBlock(section)).join("\n\n")
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function listCursorRuleFiles(cwd: string): Promise<string[]> {
  const root = join(cwd, ".cursor", "rules");
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(".cursor", "rules", relative(root, join(entry.parentPath, entry.name))))
      .sort();
  } catch {
    return [];
  }
}
