import type { GitHubClient } from "./octokit.ts";

export interface DiffHunk {
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "context" | "add" | "delete";
  content: string;
  oldLine?: number;
  newLine?: number;
  position: number;
}

export interface DiffPosition {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  position: number;
}

export async function fetchPullRequestDiff(
  client: GitHubClient,
  repo: { owner: string; name: string },
  pullNumber: number
): Promise<{ raw: string; hunks: DiffHunk[] }> {
  const response = await client.request<string>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    params: { owner: repo.owner, repo: repo.name, pull_number: pullNumber },
    headers: { accept: "application/vnd.github.v3.diff" },
    responseType: "text"
  });
  return { raw: response.data, hunks: parseUnifiedDiff(response.data) };
}

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentPath = "";
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      continue;
    }
    const header = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      position = 0;
      current = {
        path: currentPath,
        oldStart: oldLine,
        oldLines: Number(header[2] || "1"),
        newStart: newLine,
        newLines: Number(header[4] || "1"),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("diff --git") || line.startsWith("--- ")) continue;
    position += 1;
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", content: line.slice(1), newLine, position });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "delete", content: line.slice(1), oldLine, position });
      oldLine += 1;
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      current.lines.push({ kind: "context", content, oldLine, newLine, position });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

export function mapDiffPositions(hunks: readonly DiffHunk[]): Map<string, DiffPosition[]> {
  const positions = new Map<string, DiffPosition[]>();
  for (const hunk of hunks) {
    const entries = positions.get(hunk.path) ?? [];
    for (const line of hunk.lines) {
      if (line.newLine !== undefined && (line.kind === "add" || line.kind === "context")) {
        entries.push({ path: hunk.path, line: line.newLine, side: "RIGHT", position: line.position });
      }
      if (line.oldLine !== undefined && (line.kind === "delete" || line.kind === "context")) {
        entries.push({ path: hunk.path, line: line.oldLine, side: "LEFT", position: line.position });
      }
    }
    positions.set(hunk.path, entries);
  }
  return positions;
}

export function isCommentableLine(
  positions: ReadonlyMap<string, readonly DiffPosition[]>,
  path: string,
  line: number,
  side: "RIGHT" | "LEFT" = "RIGHT"
): DiffPosition | undefined {
  return positions.get(path)?.find((position) => position.line === line && position.side === side);
}
