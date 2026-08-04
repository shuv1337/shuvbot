import { access, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  createReviewWorkspace,
  createScopedReviewWorkspace,
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
