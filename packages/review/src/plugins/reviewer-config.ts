import type { ReviewbotConfig } from "../../../core/src/config.ts";
import { BUILT_IN_REVIEWER_IDS, REVIEW_TIERS, type ReviewerId, type ReviewTier } from "../types.ts";
import type { ModelRef, ReviewPlugin } from "./types.ts";

const REVIEWER_NAMES: Record<ReviewerId, string> = {
  "code-quality": "Code quality",
  security: "Security",
  performance: "Performance",
  tests: "Tests",
  documentation: "Documentation",
  release: "Release and compatibility"
};

/**
 * The known set is the code-owned default names plus the models this
 * configuration selects for its three roles. A reviewer override may therefore
 * only reuse a model the configuration already selects, while the operator can
 * still name a model the runtime actually routes. Whether the runtime can route
 * a name is settled later, against the runtime's own catalog.
 */
export function createReviewerConfigPlugin(
  config: ReviewbotConfig["review"],
  knownModels?: readonly ModelRef[]
): ReviewPlugin {
  return {
    id: "reviewer-config",
    async configure(ctx) {
      const known = knownModels ?? [
        "subscription/default-reasoning" as ModelRef,
        "subscription/default-coding" as ModelRef,
        "subscription/default-fast" as ModelRef,
        ...Object.values(config.models).map(asModelRef)
      ];
      const modelRefs = new Set(known.map(asModelRef));

      const providers = new Map<string, Set<string>>();
      for (const modelRef of modelRefs) {
        const separator = modelRef.indexOf("/");
        const provider = modelRef.slice(0, separator);
        // A trailing `@<effort>` selects a reasoning effort on the same model, so
        // the catalog records the model alone. Whether the effort is supported is
        // settled by model resolution, which can report the accepted efforts.
        const name = modelRef.slice(separator + 1);
        const effort = name.indexOf("@");
        const model = effort === -1 ? name : name.slice(0, effort);
        const models = providers.get(provider) ?? new Set<string>();
        models.add(model);
        providers.set(provider, models);
      }
      for (const [id, models] of providers) ctx.registerProvider({ id, models: [...models] });

      for (const configured of [
        ...Object.values(config.models),
        ...config.reviewers.flatMap((override) => (override.model ? [override.model] : []))
      ]) {
        if (!modelRefs.has(asModelRef(configured))) {
          throw new Error(`Unknown review model: ${configured}`);
        }
      }

      for (const id of BUILT_IN_REVIEWER_IDS) {
        const override = config.reviewers.find((item) => item.id === id);
        ctx.registerReviewer({
          id,
          name: REVIEWER_NAMES[id],
          description: `Reviews changes for ${REVIEWER_NAMES[id].toLowerCase()}.`,
          paths: override?.paths ?? ["**/*"],
          ignorePaths: override?.ignorePaths ?? [],
          modelOverride: override?.model !== undefined
        });
        ctx.setReviewerModel(id, asModelRef(override?.model ?? config.models.standard));
        if (override?.promptAppend) {
          ctx.addPromptSection({
            id: `repository-${id}`,
            reviewer: id,
            content: override.promptAppend
          });
        }
      }
    }
  };
}

export function reviewerTierAssignments(
  config: ReviewbotConfig["review"]
): Record<ReviewTier, readonly ReviewerId[]> {
  const assignments = {} as Record<ReviewTier, readonly ReviewerId[]>;
  for (const tier of REVIEW_TIERS) {
    assignments[tier] = config.tiers[tier].reviewers.map((id) => {
      if (!(BUILT_IN_REVIEWER_IDS as readonly string[]).includes(id)) {
        throw new Error(`Unknown reviewer in ${tier} tier: ${id}`);
      }
      return id as ReviewerId;
    });
  }
  return assignments;
}

function asModelRef(value: string): ModelRef {
  if (!/^subscription\/[^/\s]+$/.test(value)) {
    throw new Error(`Review model must use the subscription provider: ${value}`);
  }
  return value as ModelRef;
}
