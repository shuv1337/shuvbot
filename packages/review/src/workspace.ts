import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceChangedFile {
  path: string;
  patch: string;
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
  sharedContextPath: string;
  manifestPath: string;
  previousFindingsPath: string;
  manifest: ReviewWorkspaceManifest;
  cleanup(): Promise<void>;
}

export interface ScopedReviewWorkspace {
  manifestPath: string;
  patchesDir: string;
  manifest: ReviewWorkspaceManifest;
}

export async function createReviewWorkspace(
  input: CreateReviewWorkspaceInput
): Promise<ReviewWorkspace> {
  validateChangedFiles(input.files);

  const requestedRoot = resolve(input.tempRoot ?? tmpdir());
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const tempRoot = await realpath(requestedRoot);
  const root = await mkdtemp(join(tempRoot, "reviewbot-review-"));

  try {
    assertInside(tempRoot, root);
    const patchesDir = join(root, "patches");
    await mkdir(patchesDir, { mode: 0o700 });

    const files: ReviewWorkspaceFile[] = [];
    for (const file of input.files) {
      const patchPath = join(patchesDir, encodePatchPath(file.path));
      assertInside(root, patchPath);
      await writeFile(patchPath, file.patch, { encoding: "utf8", flag: "wx", mode: 0o600 });
      files.push({ path: file.path, patchPath: relative(root, patchPath) });
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
  const manifestPath = join(root, "manifest.json");
  assertInside(workspace.root, root);
  await mkdir(patchesDir, { recursive: true, mode: 0o700 });

  const files: ReviewWorkspaceFile[] = [];
  for (const file of workspace.manifest.files) {
    if (!selected.has(file.path)) continue;
    const patchName = basename(file.patchPath);
    const patchPath = join(patchesDir, patchName);
    await link(join(workspace.root, file.patchPath), patchPath);
    files.push({ path: file.path, patchPath: join("patches", patchName) });
  }
  const manifest: ReviewWorkspaceManifest = {
    ...workspace.manifest,
    sharedContextPath: relative(root, workspace.sharedContextPath),
    previousFindingsPath: relative(root, workspace.previousFindingsPath),
    files
  };
  await writeJson(manifestPath, manifest);
  return { manifestPath, patchesDir, manifest };
}

/** Produces a fixed-length filename that cannot contain path separators. */
export function encodePatchPath(path: string): string {
  validateRepositoryPath(path);
  return `${createHash("sha256").update(path, "utf8").digest("hex")}.patch`;
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
