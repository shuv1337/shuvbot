import { classifyDiffFile } from "./diff-filter.ts";
import { matchesGlob } from "node:path";
import type { ShuvbotConfig } from "../../core/src/config.ts";
import {
  DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS,
  classifyRisk,
  type RiskClassifierOverrides
} from "./risk.ts";
import {
  BUILT_IN_REVIEWER_IDS,
  type BuiltInReviewerId,
  type ChangedFileStatus,
  type FilteredDiff,
  type FilteredDiffEntry,
  type GeneratedRisk,
  type ReviewerAssignment,
  type ReviewExecutionPlan,
  type ReviewTier,
  type TierAssignment
} from "./types.ts";

export interface ReviewPlanFile {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  generatedRisk?: GeneratedRisk;
  patch?: string;
  content?: string;
}

export interface CreateReviewExecutionPlanInput {
  files: readonly ReviewPlanFile[];
  baseSha: string;
  headSha: string;
  maxConcurrency: number;
  risk?: RiskClassifierOverrides;
  reviewers?: Partial<Record<ReviewTier, readonly BuiltInReviewerId[]>>;
  paths?: {
    include: readonly string[];
    ignore: readonly string[];
  };
}

const DEFAULT_REVIEWERS: Record<ReviewTier, readonly BuiltInReviewerId[]> = {
  trivial: ["code-quality"],
  lite: ["code-quality", "tests", "performance", "documentation", "release"],
  full: ["code-quality", "security", "performance", "tests", "documentation", "release"]
};

export function createReviewExecutionPlan(
  input: CreateReviewExecutionPlanInput
): ReviewExecutionPlan {
  validateInput(input);
  const diff = buildFilteredDiff(input.files, input.paths);
  const included = diff.entries.filter((entry) => entry.included);
  const risk = classifyRisk(
    {
      changedLines: diff.includedChangedLines,
      files: included,
      generatedRiskAmbiguous: diff.generatedRiskAmbiguous
    },
    input.risk
  );
  const eligibleReviewers = input.reviewers?.[risk.tier] ?? DEFAULT_REVIEWERS[risk.tier];
  validateReviewers(risk.tier, eligibleReviewers);
  const reviewerIds = selectReviewers(
    risk.tier,
    eligibleReviewers,
    included.map((entry) => entry.path)
  );

  return deepFreeze({
    risk,
    diff,
    assignment: assignmentFor(risk.tier, reviewerIds),
    baseSha: input.baseSha,
    headSha: input.headSha,
    maxConcurrency: input.maxConcurrency
  });
}

export function createReviewExecutionPlanFromConfig(
  input: Omit<CreateReviewExecutionPlanInput, "maxConcurrency" | "risk" | "reviewers"> & {
    config: Pick<ShuvbotConfig, "review" | "paths">;
  }
): ReviewExecutionPlan {
  const { config, ...planInput } = input;
  return createReviewExecutionPlan({
    ...planInput,
    maxConcurrency: config.review.maxConcurrency,
    paths: config.paths,
    risk: {
      trivial: thresholdOverride(config.review.tiers.trivial),
      lite: thresholdOverride(config.review.tiers.lite),
      securitySensitivePathPatterns: [
        ...DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS,
        ...config.review.sensitivePaths
      ]
    },
    reviewers: {
      trivial: builtInReviewers(config.review.tiers.trivial.reviewers),
      lite: builtInReviewers(config.review.tiers.lite.reviewers),
      full: builtInReviewers(config.review.tiers.full.reviewers)
    }
  });
}

function buildFilteredDiff(
  files: readonly ReviewPlanFile[],
  paths?: CreateReviewExecutionPlanInput["paths"]
): FilteredDiff {
  const entries = files.map((file): FilteredDiffEntry => {
    const globallyIncluded =
      paths === undefined || paths.include.some((pattern) => matchesGlob(file.path, pattern));
    const globallyIgnored =
      paths !== undefined && paths.ignore.some((pattern) => matchesGlob(file.path, pattern));
    const decision = globallyIncluded && !globallyIgnored ? classifyDiffFile(file) : undefined;
    const changedLines = file.additions + file.deletions;
    const generatedRisk =
      file.generatedRisk ?? (decision?.reason === "generated_file" ? "reliable-noise" : "none");
    const filterReason = !globallyIncluded
      ? "path_not_included"
      : globallyIgnored
        ? "path_ignored"
        : decision?.reason;
    return {
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changedLines,
      binary: file.binary ?? false,
      generatedRisk,
      included: decision?.accepted ?? false,
      ...(filterReason === undefined ? {} : { filterReason }),
      ...(file.patch === undefined ? {} : { patch: file.patch })
    };
  });

  return {
    entries,
    changedLines: entries.reduce((total, entry) => total + entry.changedLines, 0),
    includedChangedLines: entries.reduce(
      (total, entry) => total + (entry.included ? entry.changedLines : 0),
      0
    ),
    generatedRiskAmbiguous: entries.some((entry) => entry.generatedRisk === "ambiguous")
  };
}

function assignmentFor(tier: ReviewTier, reviewers: readonly BuiltInReviewerId[]): TierAssignment {
  const assignments: ReviewerAssignment[] = reviewers.map((reviewer) => ({
    reviewer,
    modelTier: tier === "trivial" ? "light" : "standard",
    required: reviewer === "code-quality" || (tier === "full" && reviewer === "security"),
    reason: "tier-default"
  }));
  return {
    tier,
    coordinatorModelTier: tier === "trivial" ? "standard" : "reasoning",
    reviewers: assignments,
    minimumSuccessfulSpecialists: tier === "trivial" ? 1 : tier === "lite" ? 3 : 5,
    maximumSpecialists: assignments.length
  };
}

function selectReviewers(
  tier: ReviewTier,
  eligible: readonly BuiltInReviewerId[],
  paths: readonly string[]
): readonly BuiltInReviewerId[] {
  if (tier !== "lite") return eligible;
  const candidates = eligible.filter(
    (reviewer): reviewer is "security" | "performance" | "documentation" | "release" =>
      reviewer !== "code-quality" && reviewer !== "tests"
  );
  const preferred = contentReviewer(paths);
  const selected = candidates.includes(preferred) ? preferred : candidates[0];
  return selected === undefined ? ["code-quality", "tests"] : ["code-quality", "tests", selected];
}

function contentReviewer(paths: readonly string[]): "performance" | "documentation" | "release" {
  if (paths.every((path) => /(^|\/)(?:docs?|examples?)\/|\.(?:md|mdx|rst|txt)$/i.test(path))) {
    return "documentation";
  }
  if (
    paths.some((path) => /(^|\/)(?:changelog|changesets?|release-notes)(?:\/|\.|$)/i.test(path))
  ) {
    return "release";
  }
  return "performance";
}

function validateInput(input: CreateReviewExecutionPlanInput): void {
  if (input.baseSha.trim().length === 0 || input.headSha.trim().length === 0) {
    throw new TypeError("baseSha and headSha must be non-empty");
  }
  if (
    !Number.isInteger(input.maxConcurrency) ||
    input.maxConcurrency < 1 ||
    input.maxConcurrency > 6
  ) {
    throw new RangeError("maxConcurrency must be an integer from 1 to 6");
  }
  const paths = new Set<string>();
  for (const file of input.files) {
    if (file.path.length === 0 || paths.has(file.path))
      throw new TypeError(`invalid or duplicate changed path: ${file.path}`);
    paths.add(file.path);
    if (
      !Number.isInteger(file.additions) ||
      file.additions < 0 ||
      !Number.isInteger(file.deletions) ||
      file.deletions < 0
    ) {
      throw new RangeError(`changed-line counts must be non-negative integers: ${file.path}`);
    }
  }
}

function validateReviewers(tier: ReviewTier, reviewers: readonly BuiltInReviewerId[]): void {
  const known = new Set<string>(BUILT_IN_REVIEWER_IDS);
  if (reviewers.length === 0 || reviewers.some((reviewer) => !known.has(reviewer))) {
    throw new TypeError(`reviewers for ${tier} must contain known built-in reviewer IDs`);
  }
  if (new Set(reviewers).size !== reviewers.length)
    throw new TypeError(`reviewers for ${tier} must be unique`);
  if (!reviewers.includes("code-quality"))
    throw new TypeError(`${tier} reviews require code-quality`);
  if (tier === "lite" && !reviewers.includes("tests")) {
    throw new TypeError("lite reviews require tests");
  }
  if (tier === "full" && !reviewers.includes("security"))
    throw new TypeError("full reviews require security");
  const minimum = tier === "trivial" ? 1 : tier === "lite" ? 3 : 5;
  if (reviewers.length < minimum)
    throw new TypeError(`${tier} reviews require at least ${minimum} specialists`);
}

function builtInReviewers(reviewers: readonly string[]): BuiltInReviewerId[] {
  const known = new Set<string>(BUILT_IN_REVIEWER_IDS);
  if (reviewers.some((reviewer) => !known.has(reviewer))) {
    throw new TypeError("review configuration contains an unknown reviewer");
  }
  return reviewers as BuiltInReviewerId[];
}

function thresholdOverride(tier: { maxLines?: number; maxFiles?: number }): {
  maxChangedLines?: number;
  maxFiles?: number;
} {
  return {
    ...(tier.maxLines === undefined ? {} : { maxChangedLines: tier.maxLines }),
    ...(tier.maxFiles === undefined ? {} : { maxFiles: tier.maxFiles })
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
