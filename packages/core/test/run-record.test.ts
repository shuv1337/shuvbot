import { describe, expect, test } from "bun:test";
import { AuthError } from "../src/errors.ts";
import { createRunRecord, recordError, recordToolAudit } from "../src/run-record.ts";

describe("run record", () => {
  test("attaches tool audit summaries", () => {
    const record = createRunRecord({
      event: "pull_request",
      actor: "maintainer",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    });

    const updated = recordToolAudit(record, {
      total: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
      totalDurationMs: 15,
      byTool: {
        get_pr: {
          total: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          totalDurationMs: 5
        },
        write_comment: {
          total: 1,
          succeeded: 0,
          failed: 1,
          denied: 1,
          totalDurationMs: 10
        }
      }
    });

    expect(updated.toolAudit).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
      totalDurationMs: 15,
      byTool: {
        get_pr: {
          total: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          totalDurationMs: 5
        },
        write_comment: {
          total: 1,
          succeeded: 0,
          failed: 1,
          denied: 1,
          totalDurationMs: 10
        }
      }
    });
    expect(record.toolAudit).toBeUndefined();
  });

  test("appends structured errors without mutating the original record", () => {
    const record = createRunRecord({
      event: "pull_request",
      actor: "maintainer",
      mode: "review",
      agent: "claude-code",
      model: "claude/sonnet"
    });

    const updated = recordError(record, new AuthError("Claude auth missing"));

    expect(updated.errors).toEqual([{ class: "AuthError", message: "Claude auth missing" }]);
    expect(record.errors).toEqual([]);

    const again = recordError(updated, "plain string failure");
    expect(again.errors).toEqual([
      { class: "AuthError", message: "Claude auth missing" },
      { class: "Error", message: "plain string failure" }
    ]);
  });
});
