import type { ReviewerId, ReviewTier } from "../types.ts";

export const READ_ONLY_REVIEW_TOOLS = ["filesystem.read", "repository.read", "git.diff"] as const;

export type ReviewToolId = (typeof READ_ONLY_REVIEW_TOOLS)[number];
export type ModelRef = `${string}/${string}`;

export interface ReviewerDefinition {
  readonly id: ReviewerId;
  readonly name: string;
  readonly description: string;
  readonly paths?: readonly string[];
  readonly ignorePaths?: readonly string[];
  readonly modelOverride?: boolean;
}

export interface ReviewProviderDefinition {
  readonly id: string;
  readonly models: readonly string[];
}

export interface PromptSection {
  readonly id: string;
  readonly reviewer: ReviewerId;
  readonly content: string;
}

export interface ReviewBootstrapContext {
  readonly pluginId: string;
}

export interface ReviewConfigureContext {
  registerReviewer(reviewer: ReviewerDefinition): void;
  registerProvider(provider: ReviewProviderDefinition): void;
  addPromptSection(section: PromptSection): void;
  setReviewerModel(reviewer: ReviewerId, model: ModelRef): void;
  restrictReviewerTools(reviewer: ReviewerId, tools: readonly string[]): void;
}

export interface ReviewPostConfigureContext {
  readonly config: ResolvedReviewPluginConfig;
}

export interface ReviewPlugin {
  readonly id: string;
  readonly postConfigureCritical?: boolean;
  bootstrap?(ctx: ReviewBootstrapContext): Promise<void>;
  configure?(ctx: ReviewConfigureContext): Promise<void>;
  postConfigure?(ctx: ReviewPostConfigureContext): Promise<void>;
}

export interface ResolvedReviewerDefinition extends ReviewerDefinition {
  readonly model: ModelRef;
  readonly tools: readonly ReviewToolId[];
  readonly promptSections: readonly PromptSection[];
}

export interface ResolvedReviewPluginConfig {
  readonly reviewers: readonly ResolvedReviewerDefinition[];
  readonly providers: readonly ReviewProviderDefinition[];
  readonly tiers: Readonly<Record<ReviewTier, readonly ReviewerId[]>>;
}

export interface ReviewPluginFailure {
  readonly pluginId: string;
  readonly phase: "bootstrap" | "postConfigure";
  readonly critical: boolean;
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}

export interface ReviewPluginRunResult {
  readonly config: ResolvedReviewPluginConfig;
  readonly failures: readonly ReviewPluginFailure[];
}
