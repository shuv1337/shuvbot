import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { useTemporaryDirectories } from "../../test-support/temp-directories.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import {
  FileReviewStateStore,
  parsePersistedReviewState,
  type PersistedReviewState
} from "../src/state.ts";

const mkdtemp = useTemporaryDirectories();

describe("incremental review state", () => {
  test("writes and reads redacted state using a hashed change ID", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-review-state-"));
    const redactor = new DefaultRedactor();
    const store = new FileReviewStateStore(cwd, redactor);
    await store.writeReviewState(
      "repo:main:feature/../safe",
      state("CLAUDE_CODE_OAUTH_TOKEN=secret-value")
    );

    const stored = await store.readReviewState("repo:main:feature/../safe");
    expect(stored?.findings[0]?.evidence).toBe("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]");
    await access(join(cwd, ".shuvbot", "state", "reviews"));
    expect(await store.readReviewState("missing-change")).toBeNull();
  });

  test("rejects mismatched and malformed lifecycle state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-review-state-"));
    const store = new FileReviewStateStore(cwd, new DefaultRedactor());
    await expect(store.writeReviewState("expected", state("evidence"))).rejects.toThrow(
      "does not match"
    );
    await expect(store.readReviewState("\0")).rejects.toThrow("changeId");
    expect(() => parsePersistedReviewState({ ...state("evidence"), unexpected: true })).toThrow(
      "not allowed"
    );
    expect(() =>
      parsePersistedReviewState({
        ...state("evidence"),
        findings: [{ ...state("evidence").findings[0], unexpected: true }]
      })
    ).toThrow("not allowed");
  });

  test("bounds a delayed atomic write without replacing prior state or leaking a temp file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shuvbot-review-state-"));
    const redactor = new DefaultRedactor();
    const original = new FileReviewStateStore(cwd, redactor);
    await original.writeReviewState("repo:main:feature/../safe", state("original"));
    const hanging = new FileReviewStateStore(cwd, redactor, {
      mkdir,
      readFile,
      rename,
      rm,
      writeFile: (async (...args: Parameters<typeof writeFile>) => {
        await (writeFile as (...values: unknown[]) => Promise<void>)(...args);
        await new Promise<void>(() => undefined);
      }) as typeof writeFile
    });

    await expect(
      hanging.writeReviewState(
        "repo:main:feature/../safe",
        { ...state("replacement"), headSha: "replacement" },
        { deadlineAtMs: Date.now() + 10 }
      )
    ).rejects.toThrow("overall deadline");

    expect((await original.readReviewState("repo:main:feature/../safe"))?.headSha).toBe("head");
    expect(
      (await readdir(join(cwd, ".shuvbot", "state", "reviews"))).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toEqual([]);
  });
});

function state(evidence: string): PersistedReviewState {
  return {
    version: 1,
    changeId: "repo:main:feature/../safe",
    baseSha: "base",
    headSha: "head",
    updatedAt: "2026-08-03T00:00:00.000Z",
    degraded: false,
    findings: [
      {
        fingerprint: "fingerprint",
        reviewer: "security",
        title: "Finding",
        path: "src/a.ts",
        line: 1,
        severity: "high",
        evidence,
        status: "unresolved",
        userReplies: []
      }
    ]
  };
}
