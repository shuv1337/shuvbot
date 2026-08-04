import { describe, expect, test } from "bun:test";
import {
  createReviewProgress,
  getProgressCoverage,
  recordReviewerHeartbeat,
  renderReviewProgress,
  setReviewerProgress
} from "../src/progress.ts";

describe("local coordinator progress", () => {
  test("renders deterministic tier, states, elapsed time, heartbeat, and coverage", () => {
    let progress = createReviewProgress({
      tier: "trivial",
      startedAtMs: 1_000,
      reviewers: [
        { reviewer: "code-quality", required: true, deadlineAtMs: 61_000 },
        { reviewer: "tests", required: false, deadlineAtMs: 61_000 }
      ]
    });
    progress = setReviewerProgress(progress, "code-quality", "running", 2_000);
    progress = recordReviewerHeartbeat(progress, "code-quality", 10_000);
    progress = setReviewerProgress(progress, "tests", "cancelled", 11_000);

    expect(renderReviewProgress(progress, 15_000)).toBe(
      [
        "Review trivial | elapsed 14s | coverage pending",
        "Coverage 0/2 (0%) | required 0/1",
        "[running] code-quality | heartbeat 5s ago | deadline in 46s | required",
        "[cancelled] tests"
      ].join("\n")
    );
  });

  test("heartbeats never extend the fixed deadline", () => {
    const initial = createReviewProgress({
      tier: "trivial",
      startedAtMs: 0,
      reviewers: [{ reviewer: "code-quality", required: true, deadlineAtMs: 10_000 }]
    });
    const running = setReviewerProgress(initial, "code-quality", "running", 1_000);
    const heartbeat = recordReviewerHeartbeat(running, "code-quality", 12_000);

    expect(heartbeat.reviewers[0]?.deadlineAtMs).toBe(10_000);
    expect(renderReviewProgress(heartbeat, 15_000)).toContain("deadline exceeded by 5s");
  });

  test("makes terminal below-quorum coverage obvious", () => {
    let progress = createReviewProgress({
      tier: "full",
      startedAtMs: 0,
      reviewers: [
        { reviewer: "code-quality", required: true, deadlineAtMs: 10_000 },
        { reviewer: "security", required: true, deadlineAtMs: 10_000 },
        { reviewer: "tests", required: false, deadlineAtMs: 10_000 }
      ]
    });
    progress = setReviewerProgress(progress, "code-quality", "running", 1_000);
    progress = setReviewerProgress(progress, "code-quality", "completed", 2_000);
    progress = setReviewerProgress(progress, "security", "running", 1_000);
    progress = setReviewerProgress(progress, "security", "timed_out", 10_000);
    progress = setReviewerProgress(progress, "tests", "running", 1_000);
    progress = setReviewerProgress(progress, "tests", "failed", 3_000);

    expect(getProgressCoverage(progress).status).toBe("degraded");
    expect(renderReviewProgress(progress, 10_000)).toContain("DEGRADED COVERAGE");
    expect(renderReviewProgress(progress, 10_000)).toContain("[timed-out] security");
  });

  test("rejects invalid transitions and non-running heartbeats", () => {
    const progress = createReviewProgress({
      tier: "trivial",
      startedAtMs: 0,
      reviewers: [{ reviewer: "code-quality", required: true, deadlineAtMs: 10_000 }]
    });
    expect(() => recordReviewerHeartbeat(progress, "code-quality", 1_000)).toThrow();
    const running = setReviewerProgress(progress, "code-quality", "running", 1_000);
    const completed = setReviewerProgress(running, "code-quality", "completed", 2_000);
    expect(() => setReviewerProgress(completed, "code-quality", "running", 3_000)).toThrow();
  });
});
