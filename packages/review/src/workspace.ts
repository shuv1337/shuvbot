import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Per-file cap on materialised post-change content. Content exists to let a
 * reviewer confirm cross-file context, not to ship the repository into a
 * prompt, and every byte here is untrusted input that a model may read.
 */
export const MAX_WORKSPACE_CONTENT_BYTES = 128 * 1024;
/** Whole-workspace cap, so a large pull request cannot fill the temp volume. */
export const MAX_WORKSPACE_CONTENT_TOTAL_BYTES = 8 * 1024 * 1024;

export interface WorkspaceChangedFile {
  path: string;
  patch: string;
  /**
   * Post-change content of the file, as inert data.
   *
   * Reviewers are scoped to this workspace, and in the GitHub Action the
   * checkout they can otherwise see is the trusted default branch rather than
   * the pull request. Without this, cross-file reasoning reads the base
   * revision and reports contradictions that the pull request already resolved.
   */
  content?: string;
}

export interface CreateReviewWorkspaceInput {
  files: readonly WorkspaceChangedFile[];
  sharedContext: string;
  previousFindings?: unknown;
  tempRoot?: string;
}

export interface ReviewWorkspaceFile {
  path: string;
  patchPath: string;
  /** Present only when post-change content was supplied and fit the budget. */
  contentPath?: string;
  contentTruncated?: boolean;
}

export interface ReviewWorkspaceManifest {
  version: 1;
  sharedContextPath: string;
  previousFindingsPath: string;
  files: ReviewWorkspaceFile[];
}

export interface ReviewWorkspace {
  root: string;
  patchesDir: string;
  contentsDir: string;
  sharedContextPath: string;
  manifestPath: string;
  previousFindingsPath: string;
  manifest: ReviewWorkspaceManifest;
  cleanup(): Promise<void>;
}

export interface ScopedReviewWorkspace {
  manifestPath: string;
  patchesDir: string;
  contentsDir: string;
  manifest: ReviewWorkspaceManifest;
}

export async function createReviewWorkspace(
  input: CreateReviewWorkspaceInput
): Promise<ReviewWorkspace> {
  validateChangedFiles(input.files);

  const requestedRoot = resolve(input.tempRoot ?? tmpdir());
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const tempRoot = await realpath(requestedRoot);
  const root = await mkdtemp(join(tempRoot, "shuvbot-review-"));

  try {
    assertInside(tempRoot, root);
    const patchesDir = join(root, "patches");
    const contentsDir = join(root, "contents");
    await mkdir(patchesDir, { mode: 0o700 });
    await mkdir(contentsDir, { mode: 0o700 });

    const files: ReviewWorkspaceFile[] = [];
    let contentBudget = MAX_WORKSPACE_CONTENT_TOTAL_BYTES;
    for (const file of input.files) {
      const patchPath = join(patchesDir, encodePatchPath(file.path));
      assertInside(root, patchPath);
      await writeFile(patchPath, file.patch, { encoding: "utf8", flag: "wx", mode: 0o600 });

      const bounded = boundContent(file.content, contentBudget);
      if (bounded === undefined) {
        files.push({ path: file.path, patchPath: relative(root, patchPath) });
        continue;
      }
      // Written with a neutral extension, never executable, and never inside
      // the reviewed repository: pull request content stays strictly data.
      const contentPath = join(contentsDir, encodeContentPath(file.path));
      assertInside(root, contentPath);
      await writeFile(contentPath, bounded.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      contentBudget -= Buffer.byteLength(bounded.text, "utf8");
      files.push({
        path: file.path,
        patchPath: relative(root, patchPath),
        contentPath: relative(root, contentPath),
        ...(bounded.truncated ? { contentTruncated: true } : {})
      });
    }

    const sharedContextPath = join(root, "shared-review-context.txt");
    const previousFindingsPath = join(root, "previous-findings.json");
    const manifestPath = join(root, "manifest.json");
    const manifest: ReviewWorkspaceManifest = {
      version: 1,
      sharedContextPath: basename(sharedContextPath),
      previousFindingsPath: basename(previousFindingsPath),
      files
    };

    await Promise.all([
      writeFile(sharedContextPath, input.sharedContext, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      }),
      writeJson(previousFindingsPath, input.previousFindings ?? []),
      writeJson(manifestPath, manifest)
    ]);

    let cleaned = false;
    return {
      root,
      patchesDir,
      contentsDir,
      sharedContextPath,
      manifestPath,
      previousFindingsPath,
      manifest,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createScopedReviewWorkspace(
  workspace: ReviewWorkspace,
  scope: string,
  paths: readonly string[]
): Promise<ScopedReviewWorkspace> {
  validateRepositoryPath(scope);
  const selected = new Set(paths);
  const available = new Map(workspace.manifest.files.map((file) => [file.path, file]));
  for (const path of selected) {
    if (!available.has(path)) throw new Error(`Scoped review path is not in the manifest: ${path}`);
  }

  const root = join(workspace.root, "scopes", scope);
  const patchesDir = join(root, "patches");
  const contentsDir = join(root, "contents");
  const manifestPath = join(root, "manifest.json");
  assertInside(workspace.root, root);
  await mkdir(patchesDir, { recursive: true, mode: 0o700 });
  await mkdir(contentsDir, { recursive: true, mode: 0o700 });

  const files: ReviewWorkspaceFile[] = [];
  for (const file of workspace.manifest.files) {
    if (!selected.has(file.path)) continue;
    const patchName = basename(file.patchPath);
    const patchPath = join(patchesDir, patchName);
    await link(join(workspace.root, file.patchPath), patchPath);
    if (file.contentPath === undefined) {
      files.push({ path: file.path, patchPath: join("patches", patchName) });
      continue;
    }
    const contentName = basename(file.contentPath);
    await link(join(workspace.root, file.contentPath), join(contentsDir, contentName));
    files.push({
      path: file.path,
      patchPath: join("patches", patchName),
      contentPath: join("contents", contentName),
      ...(file.contentTruncated === true ? { contentTruncated: true } : {})
    });
  }
  const manifest: ReviewWorkspaceManifest = {
    ...workspace.manifest,
    sharedContextPath: relative(root, workspace.sharedContextPath),
    previousFindingsPath: relative(root, workspace.previousFindingsPath),
    files
  };
  await writeJson(manifestPath, manifest);
  return { manifestPath, patchesDir, contentsDir, manifest };
}

/** Produces a fixed-length filename that cannot contain path separators. */
export function encodePatchPath(path: string): string {
  validateRepositoryPath(path);
  return `${createHash("sha256").update(path, "utf8").digest("hex")}.patch`;
}

/**
 * Names a materialised content file. The extension is deliberately inert: the
 * file holds untrusted pull request source, so nothing must be able to import,
 * execute, or type-check it by virtue of its name.
 */
export function encodeContentPath(path: string): string {
  validateRepositoryPath(path);
  return `${createHash("sha256").update(path, "utf8").digest("hex")}.txt`;
}

/**
 * Bounds one file's post-change content against the per-file cap and the
 * remaining workspace budget, or reports that it should not be materialised.
 *
 * Content carrying NUL is not text; materialising it would put binary noise in
 * front of a reviewer that the patch already describes as binary.
 */
function boundContent(
  content: string | undefined,
  remainingBudget: number
): { text: string; truncated: boolean } | undefined {
  if (content === undefined || content.includes("\0")) return undefined;
  const limit = Math.min(MAX_WORKSPACE_CONTENT_BYTES, remainingBudget);
  if (limit <= 0) return undefined;
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= limit) return { text: content, truncated: false };
  return {
    text: `${buffer.subarray(0, limit).toString("utf8")}\n[shuvbot:truncated maxBytes=${limit}]`,
    truncated: true
  };
}

function validateChangedFiles(files: readonly WorkspaceChangedFile[]): void {
  const paths = new Set<string>();
  const encodedPaths = new Set<string>();
  for (const file of files) {
    validateRepositoryPath(file.path);
    if (paths.has(file.path)) throw new Error(`Duplicate changed file path: ${file.path}`);
    paths.add(file.path);

    const encoded = encodePatchPath(file.path);
    if (encodedPaths.has(encoded)) throw new Error(`Patch filename collision for: ${file.path}`);
    encodedPaths.add(encoded);
  }
}

function validateRepositoryPath(path: string): void {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path) || path.includes("\\")) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
}

function assertInside(parent: string, candidate: string): void {
  const pathFromParent = relative(parent, candidate);
  if (pathFromParent === "" || pathFromParent === ".." || pathFromParent.startsWith(`..${sep}`)) {
    throw new Error(`Workspace path escapes its parent: ${candidate}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}
