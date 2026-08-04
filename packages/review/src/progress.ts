import { evaluateQuorum } from "./quorum.ts";
import type { BuiltInReviewerId, ReviewTier } from "./types.ts";

export type ReviewerProgressStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface ScheduledReviewerProgress {
  readonly reviewer: BuiltInReviewerId;
  readonly required: boolean;
  readonly deadlineAtMs: number;
}

export interface ReviewerProgress extends ScheduledReviewerProgress {
  readonly status: ReviewerProgressStatus;
  readonly queuedAtMs: number;
  readonly startedAtMs?: number;
  readonly lastHeartbeatAtMs?: number;
  readonly finishedAtMs?: number;
}

export interface ReviewProgress {
  readonly tier: ReviewTier;
  readonly startedAtMs: number;
  readonly reviewers: readonly ReviewerProgress[];
}

export interface ProgressCoverage {
  readonly completed: number;
  readonly scheduled: number;
  readonly percent: number;
  readonly requiredCompleted: number;
  readonly required: number;
  readonly status: "pending" | "met" | "degraded";
}

export interface CreateProgressInput {
  readonly tier: ReviewTier;
  readonly startedAtMs: number;
  readonly reviewers: readonly ScheduledReviewerProgress[];
}

const TERMINAL_STATUSES = new Set<ReviewerProgressStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled"
]);

export function createReviewProgress(input: CreateProgressInput): ReviewProgress {
  requireTimestamp(input.startedAtMs, "startedAtMs");
  const seen = new Set<BuiltInReviewerId>();
  const reviewers = input.reviewers.map((reviewer) => {
    if (seen.has(reviewer.reviewer)) {
      throw new TypeError(`duplicate scheduled reviewer: ${reviewer.reviewer}`);
    }
    seen.add(reviewer.reviewer);
    requireTimestamp(reviewer.deadlineAtMs, `${reviewer.reviewer} deadlineAtMs`);
    if (reviewer.deadlineAtMs < input.startedAtMs) {
      throw new RangeError(`${reviewer.reviewer} deadline precedes review start`);
    }
    return { ...reviewer, status: "queued" as const, queuedAtMs: input.startedAtMs };
  });
  return { tier: input.tier, startedAtMs: input.startedAtMs, reviewers };
}

export function setReviewerProgress(
  progress: ReviewProgress,
  reviewer: BuiltInReviewerId,
  status: Exclude<ReviewerProgressStatus, "queued">,
  atMs: number
): ReviewProgress {
  requireTimestamp(atMs, "atMs");
  return updateReviewer(progress, reviewer, (current) => {
    if (!isAllowedTransition(current.status, status)) {
      throw new TypeError(`invalid reviewer progress transition: ${current.status} -> ${status}`);
    }
    const previousAt = current.lastHeartbeatAtMs ?? current.startedAtMs ?? current.queuedAtMs;
    if (atMs < previousAt) throw new RangeError("reviewer progress cannot move backwards in time");
    if (status === "running") return { ...current, status, startedAtMs: atMs };
    return { ...current, status, finishedAtMs: atMs };
  });
}

export function recordReviewerHeartbeat(
  progress: ReviewProgress,
  reviewer: BuiltInReviewerId,
  atMs: number
): ReviewProgress {
  requireTimestamp(atMs, "atMs");
  return updateReviewer(progress, reviewer, (current) => {
    if (current.status !== "running") {
      throw new TypeError("heartbeats are only valid for running reviewers");
    }
    if (atMs < (current.lastHeartbeatAtMs ?? current.startedAtMs ?? current.queuedAtMs)) {
      throw new RangeError("reviewer heartbeat cannot move backwards in time");
    }
    // Deliberately update only liveness; deadlineAtMs remains the original budget boundary.
    return { ...current, lastHeartbeatAtMs: atMs };
  });
}

export function getProgressCoverage(progress: ReviewProgress): ProgressCoverage {
  const completedReviewers = progress.reviewers
    .filter((reviewer) => reviewer.status === "completed")
    .map((reviewer) => reviewer.reviewer);
  const quorum = evaluateQuorum({
    tier: progress.tier,
    coordinatorSucceeded: true,
    scheduledReviewers: progress.reviewers.map((reviewer) => reviewer.reviewer),
    successfulReviewers: completedReviewers
  });
  const terminal = progress.reviewers.every((reviewer) => TERMINAL_STATUSES.has(reviewer.status));
  const required = progress.reviewers.filter((reviewer) => reviewer.required);
  return {
    completed: completedReviewers.length,
    scheduled: progress.reviewers.length,
    percent:
      progress.reviewers.length === 0
        ? 100
        : Math.floor((completedReviewers.length / progress.reviewers.length) * 100),
    requiredCompleted: required.filter((reviewer) => reviewer.status === "completed").length,
    required: required.length,
    status: quorum.status === "complete" ? "met" : terminal ? "degraded" : "pending"
  };
}

export function renderReviewProgress(progress: ReviewProgress, nowMs: number): string {
  requireTimestamp(nowMs, "nowMs");
  const coverage = getProgressCoverage(progress);
  const coverageLabel =
    coverage.status === "degraded"
      ? "DEGRADED COVERAGE"
      : coverage.status === "met"
        ? "coverage met"
        : "coverage pending";
  const lines = [
    `Review ${progress.tier} | elapsed ${formatDuration(nowMs - progress.startedAtMs)} | ${coverageLabel}`,
    `Coverage ${coverage.completed}/${coverage.scheduled} (${coverage.percent}%) | required ${coverage.requiredCompleted}/${coverage.required}`
  ];
  for (const reviewer of progress.reviewers) {
    const details: string[] = [];
    if (reviewer.status === "running") {
      details.push(`heartbeat ${formatAge(nowMs, reviewer.lastHeartbeatAtMs)}`);
      details.push(
        nowMs > reviewer.deadlineAtMs
          ? `deadline exceeded by ${formatDuration(nowMs - reviewer.deadlineAtMs)}`
          : `deadline in ${formatDuration(reviewer.deadlineAtMs - nowMs)}`
      );
    }
    if (reviewer.required) details.push("required");
    lines.push(
      `[${displayStatus(reviewer.status)}] ${reviewer.reviewer}${details.length ? ` | ${details.join(" | ")}` : ""}`
    );
  }
  return lines.join("\n");
}

function updateReviewer(
  progress: ReviewProgress,
  reviewer: BuiltInReviewerId,
  update: (current: ReviewerProgress) => ReviewerProgress
): ReviewProgress {
  let found = false;
  const reviewers = progress.reviewers.map((current) => {
    if (current.reviewer !== reviewer) return current;
    found = true;
    return update(current);
  });
  if (!found) throw new TypeError(`reviewer is not scheduled: ${reviewer}`);
  return { ...progress, reviewers };
}

function isAllowedTransition(
  from: ReviewerProgressStatus,
  to: Exclude<ReviewerProgressStatus, "queued">
): boolean {
  if (from === "queued") return ["running", "failed", "timed_out", "cancelled"].includes(to);
  return from === "running" && TERMINAL_STATUSES.has(to);
}

function displayStatus(status: ReviewerProgressStatus): string {
  return status.replace("_", "-");
}

function formatAge(nowMs: number, atMs: number | undefined): string {
  return atMs === undefined ? "waiting" : `${formatDuration(nowMs - atMs)} ago`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function requireTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be non-negative`);
}
