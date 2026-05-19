import type { DiffPosition } from "../../github/src/diff.ts";
import { isCommentableLine } from "../../github/src/diff.ts";
import type { ReviewFinding } from "./review-schema.ts";

export interface ReviewPipelineConfig {
  minConfidence: ReviewFinding["confidence"];
  reportOn: ReviewFinding["severity"][];
  maxFindings: number;
  maxInlineFindings: number;
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
}): ReviewPipelineResult {
  const dropped: ReviewPipelineResult["dropped"] = [];
  const seen = new Set<string>();
  const findings: PipelineFinding[] = [];

  for (const finding of input.candidates) {
    if (CONFIDENCE_RANK[finding.confidence] < CONFIDENCE_RANK[input.config.minConfidence]) {
      dropped.push({ finding, reason: "below minConfidence" });
      continue;
    }
    if (!input.config.reportOn.includes(finding.severity)) {
      dropped.push({ finding, reason: "below reportOn severity" });
      continue;
    }
    const dedupeKey = normalizeFindingKey(finding);
    if (seen.has(dedupeKey)) {
      dropped.push({ finding, reason: "duplicate" });
      continue;
    }
    seen.add(dedupeKey);
    const pipelineFinding: PipelineFinding = {
      ...finding,
      markerKey: `finding:${hashKey(dedupeKey)}`
    };
    const line = finding.line ?? finding.startLine;
    const side = finding.side ?? "RIGHT";
    const position = line === undefined ? undefined : isCommentableLine(input.diffPositions, finding.path, line, side);
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

  return { findings, inlineFindings, summaryFindings, dropped };
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

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
