import { REVIEW_TIERS, type ReviewerId, type ReviewTier } from "../types.ts";
import {
  READ_ONLY_REVIEW_TOOLS,
  type ModelRef,
  type PromptSection,
  type ResolvedReviewPluginConfig,
  type ReviewConfigureContext,
  type ReviewerDefinition,
  type ReviewPlugin,
  type ReviewPluginFailure,
  type ReviewPluginRunResult,
  type ReviewProviderDefinition,
  type ReviewToolId
} from "./types.ts";

export interface RunReviewPluginsOptions {
  readonly plugins: readonly ReviewPlugin[];
  readonly tierAssignments?: Partial<Record<ReviewTier, readonly ReviewerId[]>>;
}

interface Contributions {
  reviewers: ReviewerDefinition[];
  providers: ReviewProviderDefinition[];
  promptSections: PromptSection[];
  models: Array<{ reviewer: ReviewerId; model: ModelRef }>;
  toolRestrictions: Array<{ reviewer: ReviewerId; tools: readonly string[] }>;
}

export async function runReviewPlugins(
  options: RunReviewPluginsOptions
): Promise<ReviewPluginRunResult> {
  rejectDuplicatePluginIds(options.plugins);
  const failures: ReviewPluginFailure[] = [];

  await Promise.all(
    options.plugins.map(async (plugin) => {
      if (!plugin.bootstrap) return;
      try {
        await plugin.bootstrap(deepFreeze({ pluginId: plugin.id }));
      } catch (error) {
        failures.push({
          pluginId: plugin.id,
          phase: "bootstrap",
          critical: false,
          error: describeError(error)
        });
      }
    })
  );

  const contributions: Contributions = {
    reviewers: [],
    providers: [],
    promptSections: [],
    models: [],
    toolRestrictions: []
  };
  const context = createConfigureContext(contributions);
  for (const plugin of options.plugins) await plugin.configure?.(context);

  const config = assembleConfig(contributions, options.tierAssignments ?? {});
  for (const plugin of options.plugins) {
    if (!plugin.postConfigure) continue;
    try {
      await plugin.postConfigure(deepFreeze({ config }));
    } catch (error) {
      const critical = plugin.postConfigureCritical ?? false;
      if (critical) throw error;
      failures.push({
        pluginId: plugin.id,
        phase: "postConfigure",
        critical,
        error: describeError(error)
      });
    }
  }

  return deepFreeze({ config, failures: [...failures] });
}

function createConfigureContext(contributions: Contributions): ReviewConfigureContext {
  return Object.freeze({
    registerReviewer(reviewer: ReviewerDefinition) {
      contributions.reviewers.push(clone(reviewer));
    },
    registerProvider(provider: ReviewProviderDefinition) {
      contributions.providers.push(clone(provider));
    },
    addPromptSection(section: PromptSection) {
      contributions.promptSections.push(clone(section));
    },
    setReviewerModel(reviewer: ReviewerId, model: ModelRef) {
      contributions.models.push({ reviewer, model });
    },
    restrictReviewerTools(reviewer: ReviewerId, tools: readonly string[]) {
      contributions.toolRestrictions.push({ reviewer, tools: [...tools] });
    }
  });
}

function assembleConfig(
  contributions: Contributions,
  tierAssignments: Partial<Record<ReviewTier, readonly ReviewerId[]>>
): ResolvedReviewPluginConfig {
  rejectDuplicates(contributions.reviewers, "reviewer");
  rejectDuplicates(contributions.providers, "provider");
  rejectDuplicates(contributions.promptSections, "prompt section");

  const reviewerIds = new Set(contributions.reviewers.map(({ id }) => id));
  const providers = new Map(contributions.providers.map((provider) => [provider.id, provider]));
  const models = new Map<ReviewerId, ModelRef>();
  for (const assignment of contributions.models) {
    requireReviewer(reviewerIds, assignment.reviewer, "model assignment");
    if (models.has(assignment.reviewer)) {
      throw new Error(`Duplicate model assignment for reviewer: ${assignment.reviewer}`);
    }
    validateModel(providers, assignment.model);
    models.set(assignment.reviewer, assignment.model);
  }

  const tools = new Map<ReviewerId, Set<ReviewToolId>>();
  for (const restriction of contributions.toolRestrictions) {
    requireReviewer(reviewerIds, restriction.reviewer, "tool restriction");
    const current = tools.get(restriction.reviewer) ?? new Set(READ_ONLY_REVIEW_TOOLS);
    const requested = new Set(restriction.tools);
    for (const tool of requested) {
      if (!current.has(tool as ReviewToolId)) {
        throw new Error(`Tool restriction for ${restriction.reviewer} attempts to grant ${tool}`);
      }
    }
    tools.set(restriction.reviewer, new Set([...current].filter((tool) => requested.has(tool))));
  }

  for (const section of contributions.promptSections) {
    requireReviewer(reviewerIds, section.reviewer, "prompt section");
  }

  const tiers = Object.fromEntries(
    REVIEW_TIERS.map((tier) => {
      const assigned = [...(tierAssignments[tier] ?? [])];
      for (const reviewer of assigned) requireReviewer(reviewerIds, reviewer, `${tier} tier`);
      if (new Set(assigned).size !== assigned.length) {
        throw new Error(`Duplicate reviewer assignment in ${tier} tier`);
      }
      return [tier, assigned];
    })
  ) as Record<ReviewTier, ReviewerId[]>;

  const reviewers = contributions.reviewers.map((reviewer) => {
    const model = models.get(reviewer.id);
    if (!model) throw new Error(`Missing model assignment for reviewer: ${reviewer.id}`);
    return {
      ...clone(reviewer),
      model,
      tools: [...(tools.get(reviewer.id) ?? READ_ONLY_REVIEW_TOOLS)],
      promptSections: contributions.promptSections
        .filter((section) => section.reviewer === reviewer.id)
        .map(clone)
    };
  });

  return deepFreeze({ reviewers, providers: clone(contributions.providers), tiers });
}

function validateModel(
  providers: ReadonlyMap<string, ReviewProviderDefinition>,
  modelRef: ModelRef
): void {
  const separator = modelRef.indexOf("/");
  const providerId = modelRef.slice(0, separator);
  const model = modelRef.slice(separator + 1);
  const provider = providers.get(providerId);
  if (!provider) throw new Error(`Unknown provider in model assignment: ${providerId}`);
  if (!provider.models.includes(model)) {
    throw new Error(`Unknown model for provider ${providerId}: ${model}`);
  }
}

function requireReviewer(ids: ReadonlySet<ReviewerId>, id: ReviewerId, source: string): void {
  if (!ids.has(id)) throw new Error(`Unknown reviewer in ${source}: ${id}`);
}

function rejectDuplicatePluginIds(plugins: readonly ReviewPlugin[]): void {
  rejectDuplicates(plugins, "plugin");
}

function rejectDuplicates(values: readonly { readonly id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const { id } of values) {
    if (seen.has(id)) throw new Error(`Duplicate ${kind} ID: ${id}`);
    seen.add(id);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
