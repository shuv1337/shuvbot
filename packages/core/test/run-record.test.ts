import { describe, expect, test } from "bun:test";
import { createRunRecord, recordToolAudit } from "../src/run-record.ts";

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
});
