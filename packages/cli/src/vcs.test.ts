import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRevisions,
  detectLocalVcs,
  resolveJjCommit,
  snapshotJjWorkingCopy,
  type LocalCommandRunner
} from "./vcs.ts";

const COMMIT = "a".repeat(40);
const ROOT_COMMIT = "0".repeat(40);

function recorder(reply: (args: readonly string[]) => string): {
  run: LocalCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return reply(args);
    }
  };
}

describe("review artifact isolation", () => {
  // Jujutsu records every file in the working-copy commit, so a review would
  // otherwise report on the artifacts the previous review wrote.
  test("the default ignore list excludes reviewbot's own artifacts", async () => {
    const { DEFAULT_CONFIG } = await import("../../core/src/config.ts");
    expect(DEFAULT_CONFIG.paths.ignore).toContain(".reviewbot/**");
  });

  test("a normalized config keeps artifacts ignored", async () => {
    const { normalizeConfig } = await import("../../core/src/config.ts");
    expect(normalizeConfig({}).paths.ignore).toContain(".reviewbot/**");
  });
});

describe("local VCS detection", () => {
  test("detects a Jujutsu workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-vcs-"));
    try {
      await mkdir(join(root, ".jj"));
      expect(await detectLocalVcs(root)).toBe("jj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects a colocated workspace as Jujutsu", async () => {
    // Git's HEAD is the parent of the working-copy commit, so a colocated
    // repository must be read through Jujutsu or the current change is skipped.
    const root = await mkdtemp(join(tmpdir(), "reviewbot-vcs-"));
    try {
      await mkdir(join(root, ".jj"));
      await mkdir(join(root, ".git"));
      expect(await detectLocalVcs(root)).toBe("jj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds the workspace from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-vcs-"));
    try {
      await mkdir(join(root, ".jj"));
      const nested = join(root, "packages", "deep");
      await mkdir(nested, { recursive: true });
      expect(await detectLocalVcs(nested)).toBe("jj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to Git without a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-vcs-"));
    try {
      expect(await detectLocalVcs(root)).toBe("git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores a .jj file that is not a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewbot-vcs-"));
    try {
      await writeFile(join(root, ".jj"), "not a workspace");
      expect(await detectLocalVcs(root)).toBe("git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("default review revisions", () => {
  test("git reviews a branch against main", async () => {
    const { run, calls } = recorder(() => "");
    expect(await defaultRevisions("git", "/repo", run)).toEqual({ base: "main", head: "HEAD" });
    expect(calls).toHaveLength(0);
  });

  test("jj reviews through the working-copy commit from the trunk fork point", async () => {
    const { run } = recorder(() => COMMIT);
    expect(await defaultRevisions("jj", "/repo", run)).toEqual({
      base: "fork_point(trunk() | @)",
      head: "@"
    });
  });

  test("jj falls back to the working-copy parent without a usable trunk", async () => {
    // `trunk()` resolves to the root commit when no remote bookmark exists.
    const { run } = recorder(() => ROOT_COMMIT);
    expect(await defaultRevisions("jj", "/repo", run)).toEqual({ base: "@-", head: "@" });
  });

  test("jj falls back to the working-copy parent when trunk cannot resolve", async () => {
    const failing: LocalCommandRunner = async () => {
      throw new Error("no trunk");
    };
    expect(await defaultRevisions("jj", "/repo", failing)).toEqual({ base: "@-", head: "@" });
  });

  test("jj head is always the working-copy commit", async () => {
    for (const reply of [COMMIT, ROOT_COMMIT]) {
      const { run } = recorder(() => reply);
      expect((await defaultRevisions("jj", "/repo", run)).head).toBe("@");
    }
  });
});

describe("jj revision resolution", () => {
  test("resolves a revision to its git commit id without snapshotting", async () => {
    const { run, calls } = recorder(() => `${COMMIT}\n`);
    expect(await resolveJjCommit("@", "/repo", run)).toBe(COMMIT);
    expect(calls[0]).toEqual([
      "log",
      "--no-graph",
      "--ignore-working-copy",
      "-r",
      "@",
      "-T",
      "commit_id"
    ]);
  });

  test("records the working copy before a review reads it", async () => {
    const { run, calls } = recorder(() => "");
    await snapshotJjWorkingCopy("/repo", run);
    expect(calls[0]).toEqual(["util", "snapshot"]);
  });
});
