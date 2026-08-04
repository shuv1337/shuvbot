import { classifyReviewError, type ClassifiedReviewError } from "../errors.ts";
import type { ModelRef } from "../plugins/types.ts";
import type { ShuvcodeModel } from "./shuvcode.ts";

const SUBSCRIPTION_PREFIX = "subscription/";
const VARIANT_SEPARATOR = "@";

export interface CuratedReviewModel {
  readonly providerID: string;
  readonly id: string;
  /**
   * Reasoning efforts the runtime accepts for this model. The runtime derives a
   * variant per effort from its model catalog, but accepts an unknown variant at
   * selection time and only rejects it when the session is prompted, so the
   * accepted set is curated here to fail fast instead.
   */
  readonly efforts: readonly string[];
}

/**
 * The curated set of models a review may select, kept short on purpose.
 *
 * Reviewbot names models in its own `subscription/…` namespace so repository
 * configuration never names a provider or carries credentials, and the runtime
 * cannot route those names. This table is the mapping, maintained by hand.
 *
 * Add an entry when a model has actually been used for a review.
 */
export const CURATED_REVIEW_MODELS: Readonly<Record<string, CuratedReviewModel>> = Object.freeze({
  "gpt-5.6-luna": {
    providerID: "openai",
    id: "gpt-5.6-luna",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"]
  },
  "gpt-5.6-sol": {
    providerID: "openai",
    id: "gpt-5.6-sol",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"]
  },
  "claude-opus-5": {
    providerID: "anthropic",
    id: "claude-opus-5",
    efforts: ["low", "medium", "high", "xhigh", "max"]
  },
  "claude-fable-5": {
    providerID: "anthropic",
    id: "claude-fable-5",
    efforts: ["low", "medium", "high", "xhigh", "max"]
  },
  "grok-4.5": { providerID: "xai", id: "grok-4.5", efforts: ["low", "medium", "high"] }
});

/**
 * Role defaults, so the configured names stay stable while the model and effort
 * behind a role change in one place.
 */
export const REVIEW_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "default-reasoning": "claude-opus-5@medium",
  "default-coding": "grok-4.5@high",
  "default-fast": "gpt-5.6-luna@max"
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
  return resolveName(name, ref);
}

function resolveName(name: string, ref: ModelRef): ShuvcodeModel {
  const { base, variant } = splitVariant(name, ref);

  // `<provider>:<model>` bypasses the curated table, so a new model or effort can
  // be tried without a code change. Its variant cannot be checked here.
  const provider = base.indexOf(":");
  if (provider !== -1) {
    const providerID = base.slice(0, provider);
    const id = base.slice(provider + 1);
    if (providerID.length === 0 || id.length === 0) {
      throw modelConfigError(
        `Review model must name both a provider and a model as subscription/<provider>:<model>: ${ref}`
      );
    }
    return variant === undefined ? { providerID, id } : { providerID, id, variant };
  }

  const alias = REVIEW_MODEL_ALIASES[base];
  if (alias !== undefined) {
    // An alias carries its own effort, which an explicit effort overrides.
    const resolved = resolveName(alias, ref);
    return variant === undefined ? resolved : { ...resolved, variant };
  }

  const curated = CURATED_REVIEW_MODELS[base];
  if (curated === undefined) {
    throw modelConfigError(
      `Unknown review model ${base}. Curated models: ${curatedModelNames().join(", ")}. ` +
        `Use subscription/<provider>:${base} to select an uncurated model.`
    );
  }
  if (variant !== undefined && !curated.efforts.includes(variant)) {
    throw modelConfigError(
      `Unknown reasoning effort ${variant} for ${base}. ` +
        `Accepted efforts: ${curated.efforts.join(", ")}.`
    );
  }
  return variant === undefined
    ? { providerID: curated.providerID, id: curated.id }
    : { providerID: curated.providerID, id: curated.id, variant };
}

function splitVariant(name: string, ref: ModelRef): { base: string; variant?: string } {
  const separator = name.indexOf(VARIANT_SEPARATOR);
  if (separator === -1) return { base: name };
  const base = name.slice(0, separator);
  const variant = name.slice(separator + 1);
  if (base.length === 0 || variant.length === 0) {
    throw modelConfigError(
      `Review model must name both a model and an effort as <model>@<effort>: ${ref}`
    );
  }
  return { base, variant };
}

function modelConfigError(message: string): Error & ClassifiedReviewError {
  const classified = classifyReviewError({ category: "config", message });
  return Object.assign(new Error(message), classified);
}
