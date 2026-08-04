import { describe, expect, test } from "bun:test";
import { completeProgress, createProgressBody, shouldUpdateProgress } from "../src/progress.ts";

describe("progress comments", () => {
  test("create, debounce, complete, and retain failure state", () => {
    const body = createProgressBody({ requestedTask: "fix it", status: "running", runId: "run-1" });
    expect(body).toContain("Requested task: fix it");
    expect(body).toContain("<!-- shuvbot:progress -->");
    expect(shouldUpdateProgress({ nowMs: 0, debounceMs: 10_000 })).toBe(true);
    expect(
      shouldUpdateProgress({ previous: { body, updatedAtMs: 0 }, nowMs: 1000, debounceMs: 10_000 })
    ).toBe(false);
    expect(
      shouldUpdateProgress({
        previous: { body, updatedAtMs: 0 },
        nowMs: 1000,
        debounceMs: 10_000,
        force: true
      })
    ).toBe(true);

    const failed = completeProgress({
      previous: { id: 1, body, updatedAtMs: 0 },
      body: "failed",
      nowMs: 10,
      failed: true
    });
    expect(failed.failed).toBe(true);
    expect(failed.body).toBe("failed");
  });
});
