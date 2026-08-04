import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type LocalVcs = "git" | "jj";

/** The revision a review starts and ends at, named in the detected VCS. */
export interface LocalRevisions {
  readonly base: string;
  readonly head: string;
}

/**
 * Detects Jujutsu by walking up for a workspace directory.
 *
 * A colocated repository has both `.jj` and `.git`, and Jujutsu is authoritative
 * there: Git's `HEAD` is the *parent* of the working-copy commit, so a Git-only
 * review silently omits the change being worked on.
 */
export async function detectLocalVcs(cwd: string): Promise<LocalVcs> {
  let directory = resolve(cwd);
  while (true) {
    if (await isDirectory(join(directory, ".jj"))) return "jj";
    const parent = dirname(directory);
    if (parent === directory) return "git";
    directory = parent;
  }
}

/**
 * Default review range per VCS.
 *
 * Git reviews a branch against `main`. Jujutsu reviews everything from the trunk
 * through `@`, the working-copy commit, so work in progress is included rather
 * than skipped. `trunk()` needs a remote bookmark and otherwise resolves to the
 * root commit, so the parent of the working copy is used instead.
 */
export async function defaultRevisions(
  vcs: LocalVcs,
  cwd: string,
  jj: LocalCommandRunner,
  signal?: AbortSignal
): Promise<LocalRevisions> {
  if (vcs === "git") return { base: "main", head: "HEAD" };
  const trunk = await resolveJjCommit("trunk()", cwd, jj, signal).catch(() => undefined);
  const usable = trunk !== undefined && !/^0{40,}$/.test(trunk);
  return { base: usable ? "fork_point(trunk() | @)" : "@-", head: "@" };
}

export type LocalCommandRunner = (
  args: readonly string[],
  cwd: string,
  maxOutputBytes?: number,
  signal?: AbortSignal
) => Promise<string>;

/**
 * Resolves a Jujutsu revision to its Git commit id.
 *
 * Jujutsu writes a real Git commit for every revision it tracks, including the
 * working-copy commit, so once a revision is resolved the review reads it with
 * the normal Git machinery.
 */
export async function resolveJjCommit(
  revision: string,
  cwd: string,
  jj: LocalCommandRunner,
  signal?: AbortSignal
): Promise<string> {
  const output = await jj(
    ["log", "--no-graph", "--ignore-working-copy", "-r", revision, "-T", "commit_id"],
    cwd,
    undefined,
    signal
  );
  return output.trim();
}

/** Records the working copy into `@` so a review sees the current files. */
export async function snapshotJjWorkingCopy(
  cwd: string,
  jj: LocalCommandRunner,
  signal?: AbortSignal
): Promise<void> {
  await jj(["util", "snapshot"], cwd, undefined, signal);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
