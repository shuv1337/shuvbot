export const REVIEW_TIERS = ["trivial", "lite", "full"] as const;
export type ReviewTier = (typeof REVIEW_TIERS)[number];

export const BUILT_IN_REVIEWER_IDS = [
  "code-quality",
  "security",
  "performance",
  "tests",
  "documentation",
  "release"
] as const;
export type BuiltInReviewerId = (typeof BUILT_IN_REVIEWER_IDS)[number];
export type ReviewerId = BuiltInReviewerId;

export type ReviewerModelTier = "light" | "standard" | "reasoning";

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";
export type GeneratedRisk = "none" | "reliable-noise" | "behavioral" | "ambiguous";
export type DiffFilterReason =
  | "path_not_included"
  | "path_ignored"
  | "lockfile"
  | "vendored_dependency"
  | "minified_or_bundled_asset"
  | "source_map"
  | "generated_file";

export interface FilteredDiffEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly changedLines: number;
  readonly binary: boolean;
  readonly generatedRisk: GeneratedRisk;
  readonly included: boolean;
  readonly filterReason?: DiffFilterReason;
  readonly patch?: string;
  /** Post-change file content, when the caller could source it. */
  readonly content?: string;
}

export interface FilteredDiff {
  readonly entries: readonly FilteredDiffEntry[];
  readonly changedLines: number;
  readonly includedChangedLines: number;
  readonly generatedRiskAmbiguous: boolean;
}

export interface RiskTierThreshold {
  readonly maxChangedLines: number;
  readonly maxFiles: number;
}

export interface RiskClassifierConfig {
  readonly trivial: RiskTierThreshold;
  readonly lite: RiskTierThreshold;
  readonly securitySensitivePathPatterns: readonly string[];
}

export interface RiskAssessmentInput {
  readonly changedLines: number;
  readonly files: readonly Pick<FilteredDiffEntry, "path">[];
  readonly generatedRiskAmbiguous?: boolean;
}

export type RiskAssessmentReason =
  | "within-trivial-thresholds"
  | "within-lite-thresholds"
  | "exceeds-lite-thresholds"
  | "security-sensitive-path"
  | "generated-risk-ambiguity";

export interface RiskAssessment {
  readonly tier: ReviewTier;
  readonly reason: RiskAssessmentReason;
  readonly changedLines: number;
  readonly changedFiles: number;
  readonly securitySensitive: boolean;
  readonly sensitivePaths: readonly string[];
  readonly generatedRiskAmbiguous: boolean;
}

export interface ReviewerAssignment {
  readonly reviewer: ReviewerId;
  readonly modelTier: ReviewerModelTier;
  readonly required: boolean;
  readonly reason: "tier-default" | "content-relevant" | "coordinator-requested";
}

export interface TierAssignment {
  readonly tier: ReviewTier;
  readonly coordinatorModelTier: ReviewerModelTier;
  readonly reviewers: readonly ReviewerAssignment[];
  readonly minimumSuccessfulSpecialists: number;
  readonly maximumSpecialists: number;
}

export interface ReviewExecutionPlan {
  readonly risk: RiskAssessment;
  readonly diff: FilteredDiff;
  readonly assignment: TierAssignment;
  readonly baseSha: string;
  readonly headSha: string;
  readonly maxConcurrency: number;
}
