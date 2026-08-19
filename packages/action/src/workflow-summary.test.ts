import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { createRunRecord, recordError, recordReview } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";

// @actions/core's `core.summary` is a process-wide singleton that memoizes
// GITHUB_STEP_SUMMARY's file path on first use and ignores later env changes
// (see node_modules/@actions/core/lib/summary.js). Any test file that points
// GITHUB_STEP_SUMMARY at a fresh per-test temp dir and then deletes that dir
// poisons every later summary-writing test in the same process with an ENOENT.
// Use one fixed, never-deleted path for the whole process instead.
const SUMMARY_PATH = join(tmpdir(), "shuvbot-tests-github-step-summary.md");

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

  test("states coverage so a degraded review cannot read as a clean one", async () => {
    const record = recordReview(
      createRunRecord({
        event: "pull_request",
        actor: "maintainer",
        mode: "review",
        agent: "claude-code",
        model: "claude/sonnet"
      }),
      {
        engine: "coordinator",
        tier: "full",
        decision: "degraded",
        quorumMet: false,
        requiredReviewers: ["code-quality", "security"],
        successfulReviewers: ["code-quality"],
        missingReviewers: ["security"],
        retries: 1,
        usage: { inputTokens: 1200, outputTokens: 340, cost: 1.5 },
        sessions: [
          {
            sessionId: "session-security",
            role: "specialist",
            reviewer: "security",
            model: "subscription/claude-fable-5@high",
            status: "timed_out",
            retryCount: 0,
            usage: { inputTokens: 900, outputTokens: 300, cost: 1.25 }
          }
        ],
        findingAccounting: {
          active: 2,
          new: 2,
          unresolved: 0,
          fixed: 3,
          userResolved: 1,
          dismissed: 0
        }
      }
    );

    await writeWorkflowSummary(record);

    const written = await readFile(SUMMARY_PATH, "utf8");
    expect(written).toContain("coordinator");
    expect(written).toContain("degraded");
    expect(written).toContain("Reviewers missing");
    expect(written).toContain("security");
    expect(written).toContain("User-resolved");
    expect(written).toContain("Input tokens");
    expect(written).toContain("1200");
    expect(written).toContain("$1.50");
    expect(written).toContain("Sessions");
    expect(written).toContain("timed_out");
  });
});
