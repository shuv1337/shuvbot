import { access, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  MAX_WORKSPACE_CONTENT_BYTES,
  MAX_WORKSPACE_CONTENT_TOTAL_BYTES,
  createReviewWorkspace,
  createScopedReviewWorkspace,
  encodeContentPath,
  encodePatchPath
} from "../src/workspace.ts";

describe("shared review workspace", () => {
  test("writes patches and shared files in a run-scoped directory", async () => {
    const workspace = await createReviewWorkspace({
      files: [
        { path: "src/a.ts", patch: "diff for a" },
        { path: "src/nested/a.ts", patch: "diff for nested a" }
      ],
      sharedContext: "untrusted review context",
      previousFindings: [{ id: "prior-1" }]
    });

    try {
      expect(relative(tmpdir(), workspace.root)).not.toStartWith("..");
      expect(workspace.manifest.files).toHaveLength(2);
      expect(workspace.manifest.files[0]?.patchPath).not.toBe(
        workspace.manifest.files[1]?.patchPath
      );
      expect(await readFile(workspace.sharedContextPath, "utf8")).toBe("untrusted review context");
      expect(JSON.parse(await readFile(workspace.previousFindingsPath, "utf8"))).toEqual([
        { id: "prior-1" }
      ]);
      expect(JSON.parse(await readFile(workspace.manifestPath, "utf8"))).toEqual(
        workspace.manifest
      );
      await expect(
        readFile(join(workspace.root, workspace.manifest.files[0]!.patchPath), "utf8")
      ).resolves.toBe("diff for a");
    } finally {
      await workspace.cleanup();
    }

    await expect(access(workspace.root)).rejects.toThrow();
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });

  test.each([
    "../outside.ts",
    "src/../../outside.ts",
    "/absolute.ts",
    "src\\outside.ts",
    "src//a.ts"
  ])("rejects traversal or ambiguous path %s before creating a workspace", async (path) => {
    await expect(
      createReviewWorkspace({ files: [{ path, patch: "diff" }], sharedContext: "context" })
    ).rejects.toThrow("Invalid repository-relative path");
  });

  test("rejects duplicate paths and encodes paths as separator-free fixed-length names", async () => {
    expect(encodePatchPath("src/a.ts")).toMatch(/^[a-f0-9]{64}\.patch$/);
    await expect(
      createReviewWorkspace({
        files: [
          { path: "src/a.ts", patch: "one" },
          { path: "src/a.ts", patch: "two" }
        ],
        sharedContext: "context"
      })
    ).rejects.toThrow("Duplicate changed file path");
  });

  test("materialises post-change content as inert, non-executable data files", async () => {
    const workspace = await createReviewWorkspace({
      files: [
        { path: "src/helpers.ts", patch: "diff", content: "export function added(): void {}\n" },
        { path: "src/untouched.ts", patch: "diff" }
      ],
      sharedContext: "context"
    });

    try {
      const [helpers, untouched] = workspace.manifest.files;
      expect(helpers?.contentPath).toBe(`contents/${encodeContentPath("src/helpers.ts")}`);
      expect(helpers?.contentPath).toEndWith(".txt");
      expect(helpers?.contentTruncated).toBeUndefined();
      // A file with no supplied content must not claim to have any: an empty
      // content file reads as "this file is empty in the pull request".
      expect(untouched?.contentPath).toBeUndefined();

      const contentPath = join(workspace.root, helpers!.contentPath!);
      expect(await readFile(contentPath, "utf8")).toBe("export function added(): void {}\n");
      expect((await stat(contentPath)).mode & 0o777).toBe(0o600);
      expect(relative(workspace.contentsDir, contentPath)).not.toStartWith("..");
    } finally {
      await workspace.cleanup();
    }
  });

  test("truncates oversized content with a visible marker and skips binary content", async () => {
    const workspace = await createReviewWorkspace({
      files: [
        { path: "src/big.ts", patch: "diff", content: "a".repeat(MAX_WORKSPACE_CONTENT_BYTES + 1) },
        { path: "src/binary.bin", patch: "diff", content: "text\0more" }
      ],
      sharedContext: "context"
    });

    try {
      const byPath = new Map(workspace.manifest.files.map((file) => [file.path, file]));
      const big = byPath.get("src/big.ts")!;
      expect(big.contentTruncated).toBe(true);
      expect(await readFile(join(workspace.root, big.contentPath!), "utf8")).toEndWith(
        `[shuvbot:truncated maxBytes=${MAX_WORKSPACE_CONTENT_BYTES}]`
      );
      // Content carrying NUL is not text; the patch already says it is binary.
      expect(byPath.get("src/binary.bin")?.contentPath).toBeUndefined();
    } finally {
      await workspace.cleanup();
    }
  });

  test("stops materialising content once the whole-workspace budget is spent", async () => {
    const perFile = "a".repeat(MAX_WORKSPACE_CONTENT_BYTES);
    const fileCount = Math.ceil(MAX_WORKSPACE_CONTENT_TOTAL_BYTES / MAX_WORKSPACE_CONTENT_BYTES);
    const workspace = await createReviewWorkspace({
      files: [
        ...Array.from({ length: fileCount }, (_unused, index) => ({
          path: `src/large-${index}.ts`,
          patch: "diff",
          content: perFile
        })),
        { path: "src/after-budget.ts", patch: "diff", content: "still small" }
      ],
      sharedContext: "context"
    });

    try {
      const byPath = new Map(workspace.manifest.files.map((file) => [file.path, file]));
      expect(byPath.get("src/large-0.ts")?.contentPath).toBeDefined();
      expect(byPath.get("src/after-budget.ts")?.contentPath).toBeUndefined();
      // The patch is never budgeted away; only the content extra is bounded.
      expect(byPath.get("src/after-budget.ts")?.patchPath).toBeDefined();
    } finally {
      await workspace.cleanup();
    }
  });

  test("links content into a scoped workspace without copying it", async () => {
    const workspace = await createReviewWorkspace({
      files: [
        { path: "src/a.ts", patch: "patch a", content: "content a" },
        { path: "docs/a.md", patch: "patch docs", content: "content docs" }
      ],
      sharedContext: "context"
    });
    try {
      const scoped = await createScopedReviewWorkspace(workspace, "tests", ["src/a.ts"]);
      const scopedFile = scoped.manifest.files[0]!;
      expect(scopedFile.contentPath).toBe(`contents/${encodeContentPath("src/a.ts")}`);
      const scopedContentPath = join(scoped.manifestPath, "..", scopedFile.contentPath!);
      expect(await readFile(scopedContentPath, "utf8")).toBe("content a");
      expect((await stat(scopedContentPath)).ino).toBe(
        (await stat(join(workspace.root, workspace.manifest.files[0]!.contentPath!))).ino
      );
      // Scoping is a confidentiality boundary: an out-of-scope file's content
      // must not appear in the reviewer's own directory.
      await expect(
        access(join(scoped.contentsDir, encodeContentPath("docs/a.md")))
      ).rejects.toThrow();
    } finally {
      await workspace.cleanup();
    }
  });

  test("creates an empty or filtered scoped manifest without copying patch content", async () => {
    const workspace = await createReviewWorkspace({
      files: [
        { path: "src/a.ts", patch: "patch a" },
        { path: "docs/a.md", patch: "patch docs" }
      ],
      sharedContext: "context"
    });
    try {
      const scoped = await createScopedReviewWorkspace(workspace, "tests", ["src/a.ts"]);
      const empty = await createScopedReviewWorkspace(workspace, "security", []);
      expect(scoped.manifest.files.map(({ path }) => path)).toEqual(["src/a.ts"]);
      expect(empty.manifest.files).toEqual([]);
      const original = await stat(join(workspace.root, workspace.manifest.files[0]!.patchPath));
      const reference = await stat(
        join(scoped.manifestPath, "..", scoped.manifest.files[0]!.patchPath)
      );
      expect(reference.ino).toBe(original.ino);
    } finally {
      await workspace.cleanup();
    }
  });
});
