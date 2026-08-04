import { z } from "zod";
import { createHash } from "node:crypto";
import { REVIEW_ERROR_CODES } from "./errors.ts";
import { BUILT_IN_REVIEWER_IDS } from "./types.ts";

const nonEmptyString = z.string().trim().min(1);
const reviewerIdSchema = z.enum(BUILT_IN_REVIEWER_IDS);
const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
const confidenceSchema = z.enum(["high", "medium", "low"]);
const dispositionSchema = z.enum(["new", "unresolved", "fixed", "user_resolved", "dismissed"]);

export const reviewFindingCandidateSchema = z
  .object({
    id: nonEmptyString,
    reviewer: reviewerIdSchema,
    skill: nonEmptyString,
    title: nonEmptyString,
    body: nonEmptyString,
    evidence: nonEmptyString,
    severity: severitySchema,
    confidence: confidenceSchema,
    path: nonEmptyString,
    line: z.number().int().positive().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    side: z.enum(["RIGHT", "LEFT"]).optional(),
    suggestedFix: nonEmptyString.optional(),
    tags: z.array(nonEmptyString).optional(),
    disposition: dispositionSchema.optional(),
    priorFindingId: nonEmptyString.optional()
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (finding.startLine !== undefined && finding.endLine === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "endLine is required with startLine",
        path: ["endLine"]
      });
    }
    if (
      finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.startLine > finding.endLine
    ) {
      ctx.addIssue({
        code: "custom",
        message: "startLine must not exceed endLine",
        path: ["startLine"]
      });
    }
  });

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional()
  })
  .strict();

export const classifiedReviewErrorSchema = z
  .object({
    code: z.enum(REVIEW_ERROR_CODES),
    category: z.enum([
      "provider",
      "rateLimit",
      "service",
      "auth",
      "context",
      "schema",
      "policy",
      "cancellation",
      "config"
    ]),
    message: nonEmptyString,
    retryable: z.boolean()
  })
  .strict()
  .superRefine((error, ctx) => {
    if (error.code !== REVIEW_ERROR_CODES[error.category]) {
      ctx.addIssue({
        code: "custom",
        message: "error code must match its category",
        path: ["code"]
      });
    }
    const expectedRetryable = ["provider", "rateLimit", "service"].includes(error.category);
    if (error.retryable !== expectedRetryable) {
      ctx.addIssue({
        code: "custom",
        message: "retryable must match the error category",
        path: ["retryable"]
      });
    }
  });

export const reviewerResultSchema = z
  .object({
    reviewer: reviewerIdSchema,
    status: z.enum(["completed", "failed", "timed_out"]),
    summary: nonEmptyString,
    findings: z.array(reviewFindingCandidateSchema),
    usage: usageSchema.optional(),
    error: classifiedReviewErrorSchema.optional()
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "completed" && result.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "completed results cannot contain an error",
        path: ["error"]
      });
    }
    if (result.status !== "completed" && result.error === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "failed or timed-out results require an error",
        path: ["error"]
      });
    }
    for (const [index, finding] of result.findings.entries()) {
      if (finding.reviewer !== result.reviewer) {
        ctx.addIssue({
          code: "custom",
          message: "finding reviewer must match result reviewer",
          path: ["findings", index, "reviewer"]
        });
      }
    }
  });

export const coordinatedFindingSchema = reviewFindingCandidateSchema
  .safeExtend({
    fingerprint: nonEmptyString.optional(),
    disposition: dispositionSchema
  })
  .strict()
  .transform((finding): Omit<typeof finding, "fingerprint"> & { fingerprint: string } => ({
    ...finding,
    fingerprint: fingerprintFinding(finding)
  }));

export const droppedFindingSchema = z
  .object({
    id: nonEmptyString,
    reviewer: reviewerIdSchema,
    disposition: z.literal("dismissed"),
    reason: nonEmptyString
  })
  .strict();

export const reviewCoverageSchema = z
  .object({
    scheduled: z.array(reviewerIdSchema),
    completed: z.array(reviewerIdSchema),
    failed: z.array(reviewerIdSchema),
    timedOut: z.array(reviewerIdSchema),
    required: z.array(reviewerIdSchema),
    quorumMet: z.boolean()
  })
  .strict();

export const coordinatorResultSchema = z
  .object({
    decision: z.enum(["clean", "comments", "minor_issues", "significant_concerns", "degraded"]),
    findings: z.array(coordinatedFindingSchema),
    dropped: z.array(droppedFindingSchema),
    coverage: reviewCoverageSchema,
    summary: nonEmptyString
  })
  .strict()
  .superRefine((result, ctx) => {
    if (!result.coverage.quorumMet && result.decision !== "degraded") {
      ctx.addIssue({
        code: "custom",
        message: "a result below quorum must be degraded",
        path: ["decision"]
      });
    }
    if (result.decision === "clean" && result.findings.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "a clean result cannot contain findings",
        path: ["findings"]
      });
    }
  });

export type ReviewFindingCandidate = z.infer<typeof reviewFindingCandidateSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ClassifiedReviewError = z.infer<typeof classifiedReviewErrorSchema>;
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;
export type CoordinatedFinding = z.infer<typeof coordinatedFindingSchema>;
export type DroppedFinding = z.infer<typeof droppedFindingSchema>;
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>;
export type CoordinatorResult = z.infer<typeof coordinatorResultSchema>;

export function parseReviewerResult(value: unknown): ReviewerResult {
  return reviewerResultSchema.parse(value);
}

export function parseCoordinatorResult(value: unknown): CoordinatorResult {
  return coordinatorResultSchema.parse(value);
}

export function fingerprintFinding(finding: {
  title: string;
  body?: string | undefined;
  evidence?: string | undefined;
  path: string;
  line?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}): string {
  const rootCause = [finding.body ?? finding.title, finding.evidence ?? ""]
    .map(canonicalizeFindingText)
    .join("\0");
  const line = finding.line ?? finding.startLine;
  const locationBucket = line === undefined ? "file" : Math.floor((line - 1) / 20);
  const location = [canonicalizePath(finding.path), locationBucket].join(":");
  const digest = createHash("sha256")
    .update([rootCause, location].join("\0"), "utf8")
    .digest("hex");
  return `finding:v1:${digest}`;
}

export function disambiguateFindingFingerprint(
  fingerprint: string,
  finding: Pick<
    ReviewFindingCandidate,
    "body" | "evidence" | "path" | "line" | "startLine" | "endLine" | "title"
  >
): string {
  const identity = [
    canonicalizeFindingText(finding.body),
    canonicalizeFindingText(finding.evidence),
    canonicalizeFindingText(finding.title),
    canonicalizePath(finding.path),
    finding.line ?? finding.startLine ?? "file",
    finding.endLine ?? ""
  ].join("\0");
  return `${fingerprint}:collision:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function canonicalizeFindingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:^|\s)[^\s:]+:\d+(?=\s|$|[,.;])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizePath(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
