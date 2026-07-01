import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRunRecord, recordError } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";

describe("writeWorkflowSummary", () => {
  let dir: string;
  let summaryPath: string;
  let previousSummaryPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reviewbot-summary-"));
    summaryPath = join(dir, "summary.md");
    await writeFile(summaryPath, "");
    previousSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
  });

  afterEach(async () => {
    if (previousSummaryPath === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummaryPath;
    await rm(dir, { recursive: true, force: true });
  });

  test("redacts secrets embedded in recorded errors", async () => {
    const record = recordError(
      createRunRecord({ event: "pull_request", actor: "maintainer", mode: "review", agent: "claude-code", model: "claude/sonnet" }),
      new Error("Claude exited with auth failure: ANTHROPIC_API_KEY=sk-live-verysecretvalue1234")
    );

    await writeWorkflowSummary(record);

    const written = await readFile(summaryPath, "utf8");
    expect(written).not.toContain("sk-live-verysecretvalue1234");
    expect(written).toContain("[REDACTED]");
  });
});
