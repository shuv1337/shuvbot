import { classifyReviewError, type ClassifiedReviewError } from "../errors.ts";
import type { ModelRef } from "../plugins/types.ts";
import type { ShuvcodeModel } from "./shuvcode.ts";

const SUBSCRIPTION_PREFIX = "subscription/";

/**
 * The curated set of models a review may select, kept short on purpose.
 *
 * Reviewbot names models in its own `subscription/…` namespace so repository
 * configuration never names a provider or carries credentials, and the runtime
 * cannot route those names. This table is the mapping, maintained by hand: the
 * runtime does not reliably publish a model list, and a curated set is easier to
 * reason about than whatever a profile happens to expose.
 *
 * Add an entry when a model has actually been used for a review.
 */
export const CURATED_REVIEW_MODELS: Readonly<Record<string, ShuvcodeModel>> = Object.freeze({
  "gpt-5.6-luna": { providerID: "openai", id: "gpt-5.6-luna" },
  "gpt-5.6-sol": { providerID: "openai", id: "gpt-5.6-sol" },
  "claude-opus-5": { providerID: "anthropic", id: "claude-opus-5" },
  "claude-fable-5": { providerID: "anthropic", id: "claude-fable-5" },
  "grok-4.5": { providerID: "xai", id: "grok-4.5" }
});

/**
 * Role defaults, so the configured names stay stable while the model behind a
 * role can change in one place.
 */
export const REVIEW_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "default-reasoning": "claude-opus-5",
  "default-coding": "gpt-5.6-sol",
  "default-fast": "gpt-5.6-luna"
});

/** Every name this build accepts, for configuration validation and diagnostics. */
export function curatedModelNames(): readonly string[] {
  return [...Object.keys(REVIEW_MODEL_ALIASES), ...Object.keys(CURATED_REVIEW_MODELS)];
}

export function resolveReviewModels(
  refs: Iterable<ModelRef>
): ReadonlyMap<ModelRef, ShuvcodeModel> {
  const resolved = new Map<ModelRef, ShuvcodeModel>();
  for (const ref of refs) {
    if (!resolved.has(ref)) resolved.set(ref, resolveReviewModel(ref));
  }
  return resolved;
}

export function resolveReviewModel(ref: ModelRef): ShuvcodeModel {
  if (!ref.startsWith(SUBSCRIPTION_PREFIX)) {
    throw modelConfigError(`Review model must use the subscription provider: ${ref}`);
  }
  const name = ref.slice(SUBSCRIPTION_PREFIX.length);
  if (name.length === 0) throw modelConfigError(`Review model is missing a name: ${ref}`);

  // `subscription/<provider>:<model>` bypasses the curated table, so a new model
  // can be tried without a code change before it is curated.
  const separator = name.indexOf(":");
  if (separator !== -1) {
    const providerID = name.slice(0, separator);
    const id = name.slice(separator + 1);
    if (providerID.length === 0 || id.length === 0) {
      throw modelConfigError(
        `Review model must name both a provider and a model as subscription/<provider>:<model>: ${ref}`
      );
    }
    return { providerID, id };
  }

  const curated = CURATED_REVIEW_MODELS[REVIEW_MODEL_ALIASES[name] ?? name];
  if (curated === undefined) {
    throw modelConfigError(
      `Unknown review model ${name}. Curated models: ${curatedModelNames().join(", ")}. ` +
        `Use subscription/<provider>:${name} to select an uncurated model.`
    );
  }
  return curated;
}

function modelConfigError(message: string): Error & ClassifiedReviewError {
  const classified = classifyReviewError({ category: "config", message });
  return Object.assign(new Error(message), classified);
}
