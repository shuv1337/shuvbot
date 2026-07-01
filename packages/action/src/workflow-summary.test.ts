import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { createRunRecord, recordError } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";

// @actions/core's `core.summary` is a process-wide singleton that memoizes
// GITHUB_STEP_SUMMARY's file path on first use and ignores later env changes
// (see node_modules/@actions/core/lib/summary.js). Any test file that points
// GITHUB_STEP_SUMMARY at a fresh per-test temp dir and then deletes that dir
// poisons every later summary-writing test in the same process with an ENOENT.
// Use one fixed, never-deleted path for the whole process instead.
const SUMMARY_PATH = join(tmpdir(), "reviewbot-tests-github-step-summary.md");

describe("writeWorkflowSummary", () => {
  beforeEach(async () => {
    await writeFile(SUMMARY_PATH, "");
    process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
  });

  test("redacts secrets embedded in recorded errors", async () => {
    const record = recordError(
      createRunRecord({
        event: "pull_request",
        actor: "maintainer",
        mode: "review",
        agent: "claude-code",
        model: "claude/sonnet"
      }),
      new Error("Claude exited with auth failure: ANTHROPIC_API_KEY=sk-live-verysecretvalue1234")
    );

    await writeWorkflowSummary(record);

    const written = await readFile(SUMMARY_PATH, "utf8");
    expect(written).not.toContain("sk-live-verysecretvalue1234");
    expect(written).toContain("[REDACTED]");
  });
});
