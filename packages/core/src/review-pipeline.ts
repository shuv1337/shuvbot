import type { DiffPosition } from "../../github/src/diff.ts";
import { isCommentableLine } from "../../github/src/diff.ts";
import type { ReviewFinding } from "./review-schema.ts";

export interface ReviewPipelineConfig {
  minConfidence: ReviewFinding["confidence"];
  reportOn: ReviewFinding["severity"][];
  failOn?: ReviewFinding["severity"];
  maxFindings: number;
  maxInlineFindings: number;
  requestChanges?: boolean;
  failCheck?: boolean;
}

export interface PipelineFinding extends ReviewFinding {
  markerKey: string;
  inline?: {
    path: string;
    line: number;
    side: "RIGHT" | "LEFT";
    position: number;
  };
  fallbackReason?: string;
}

export interface ReviewPipelineResult {
  findings: PipelineFinding[];
  inlineFindings: PipelineFinding[];
  summaryFindings: PipelineFinding[];
  dropped: Array<{ finding: ReviewFinding; reason: string }>;
  reviewEvent: "COMMENT" | "REQUEST_CHANGES";
  failCheck: boolean;
}

const CONFIDENCE_RANK: Record<ReviewFinding["confidence"], number> = {
  low: 1,
  medium: 2,
  high: 3
};

export function runReviewPipeline(input: {
  candidates: ReviewFinding[];
  config: ReviewPipelineConfig;
  diffPositions: ReadonlyMap<string, readonly DiffPosition[]>;
  verifiedFindingIds?: ReadonlySet<string>;
  acknowledgedText?: string;
}): ReviewPipelineResult {
  const dropped: ReviewPipelineResult["dropped"] = [];
  const seen = new Set<string>();
  const findings: PipelineFinding[] = [];
  const acknowledgedText = input.acknowledgedText?.toLowerCase() ?? "";

  for (const finding of input.candidates) {
    if (input.verifiedFindingIds && !input.verifiedFindingIds.has(finding.id)) {
      dropped.push({ finding, reason: "not verified" });
      continue;
    }
    const calibrated = calibrateFinding(finding);
    if (isNoise(calibrated, acknowledgedText)) {
      dropped.push({ finding, reason: "noise filter" });
      continue;
    }
    if (!isActionable(calibrated)) {
      dropped.push({ finding, reason: "not actionable" });
      continue;
    }
    if (!isSuggestedFixValid(calibrated)) {
      dropped.push({ finding, reason: "invalid suggested fix" });
      continue;
    }
    if (CONFIDENCE_RANK[calibrated.confidence] < CONFIDENCE_RANK[input.config.minConfidence]) {
      dropped.push({ finding: calibrated, reason: "below minConfidence" });
      continue;
    }
    if (!input.config.reportOn.includes(calibrated.severity)) {
      dropped.push({ finding: calibrated, reason: "below reportOn severity" });
      continue;
    }
    const dedupeKey = normalizeFindingKey(calibrated);
    if (seen.has(dedupeKey)) {
      dropped.push({ finding: calibrated, reason: "duplicate" });
      continue;
    }
    seen.add(dedupeKey);
    const pipelineFinding: PipelineFinding = {
      ...calibrated,
      markerKey: `finding:${hashKey(dedupeKey)}`
    };
    const line = calibrated.line ?? calibrated.startLine;
    const side = calibrated.side ?? "RIGHT";
    const position = line === undefined ? undefined : isCommentableLine(input.diffPositions, calibrated.path, line, side);
    if (position) {
      pipelineFinding.inline = {
        path: finding.path,
        line: position.line,
        side,
        position: position.position
      };
    } else {
      pipelineFinding.fallbackReason = "line is not commentable in the pull request diff";
    }
    findings.push(pipelineFinding);
    if (findings.length >= input.config.maxFindings) break;
  }

  const inlineFindings: PipelineFinding[] = [];
  const summaryFindings: PipelineFinding[] = [];
  for (const finding of findings) {
    if (finding.inline && inlineFindings.length < input.config.maxInlineFindings) inlineFindings.push(finding);
    else summaryFindings.push(finding.inline ? { ...finding, fallbackReason: "inline budget exceeded" } : finding);
  }

  return {
    findings,
    inlineFindings,
    summaryFindings,
    dropped,
    reviewEvent: shouldRequestChanges(findings, input.config) ? "REQUEST_CHANGES" : "COMMENT",
    failCheck: shouldFailCheck(findings, input.config)
  };
}

export function calibrateFinding(finding: ReviewFinding): ReviewFinding {
  const text = `${finding.title} ${finding.body}`.toLowerCase();
  if (!/\b(might|maybe|possibly|could|seems|appears)\b/.test(text)) return finding;
  return {
    ...finding,
    severity: downgradeSeverity(finding.severity),
    confidence: downgradeConfidence(finding.confidence)
  };
}

export function isSuggestedFixValid(finding: ReviewFinding): boolean {
  if (!finding.suggestedFix) return true;
  if (finding.path.includes("\n")) return false;
  const start = finding.startLine ?? finding.line;
  const end = finding.endLine ?? finding.line;
  if (start === undefined || end === undefined || end < start || end - start > 10) return false;
  const lines = finding.suggestedFix.split("\n");
  return lines.every((line) => line.trim().length === 0 || line.startsWith(" ") || line.startsWith("\t") || !/^\s/.test(line));
}

function normalizeFindingKey(finding: ReviewFinding): string {
  return [
    finding.path,
    finding.line ?? finding.startLine ?? 0,
    finding.endLine ?? finding.line ?? finding.startLine ?? 0,
    finding.skill,
    finding.title.trim().toLowerCase().replace(/\s+/g, " ")
  ].join(":");
}

function isActionable(finding: ReviewFinding): boolean {
  if (finding.tags?.some((tag) => ["correctness", "security", "regression", "test", "docs", "ci"].includes(tag))) {
    return true;
  }
  return /\b(crash|bug|security|vulnerab|secret|token|regression|test|docs|incorrect|failing|data loss)\b/i.test(
    `${finding.title} ${finding.body}`
  );
}

function isNoise(finding: ReviewFinding, acknowledgedText: string): boolean {
  const text = `${finding.title} ${finding.body}`.toLowerCase();
  if (finding.tags?.some((tag) => ["style", "nit", "formatting"].includes(tag))) return true;
  if (/\b(style|nit|formatting|rename only)\b/.test(text)) return true;
  return acknowledgedText.length > 0 && acknowledgedText.includes(finding.title.toLowerCase());
}

function shouldRequestChanges(findings: readonly PipelineFinding[], config: ReviewPipelineConfig): boolean {
  return Boolean(config.requestChanges && thresholdMet(findings, config.failOn));
}

function shouldFailCheck(findings: readonly PipelineFinding[], config: ReviewPipelineConfig): boolean {
  return Boolean(config.failCheck && thresholdMet(findings, config.failOn));
}

function thresholdMet(findings: readonly PipelineFinding[], failOn: ReviewFinding["severity"] | undefined): boolean {
  if (!failOn) return false;
  const threshold = severityRank(failOn);
  return findings.some((finding) => severityRank(finding.severity) <= threshold);
}

function severityRank(severity: ReviewFinding["severity"]): number {
  return ["critical", "high", "medium", "low", "info"].indexOf(severity);
}

function downgradeSeverity(severity: ReviewFinding["severity"]): ReviewFinding["severity"] {
  const order: ReviewFinding["severity"][] = ["critical", "high", "medium", "low", "info"];
  return order[Math.min(order.indexOf(severity) + 1, order.length - 1)] ?? severity;
}

function downgradeConfidence(confidence: ReviewFinding["confidence"]): ReviewFinding["confidence"] {
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return confidence;
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
