import { classifyReviewError, type ClassifiedReviewError } from "../errors.ts";
import type { ModelRef } from "../plugins/types.ts";
import type { ShuvcodeModel, ShuvcodeModelCatalog } from "./shuvcode.ts";

const SUBSCRIPTION_PREFIX = "subscription/";

/**
 * Reviewbot names review models in its own `subscription/…` namespace so that
 * repository configuration never has to name a provider or carry provider
 * credentials. The runtime cannot route those names, so every configured name
 * must be resolved against the runtime's own catalog before a session model is
 * selected. Passing an unresolved name through produces a `provider.no-route`
 * failure at prompt time, which is far harder to diagnose than failing here.
 *
 * `subscription/default-*` names resolve to the runtime's default model. Any
 * other name resolves to a catalog model with the same model id, choosing
 * deterministically when several providers offer it.
 */
export function resolveReviewModels(
  refs: Iterable<ModelRef>,
  catalog: ShuvcodeModelCatalog
): ReadonlyMap<ModelRef, ShuvcodeModel> {
  const resolved = new Map<ModelRef, ShuvcodeModel>();
  for (const ref of refs) {
    if (resolved.has(ref)) continue;
    resolved.set(ref, resolveReviewModel(ref, catalog));
  }
  return resolved;
}

export function resolveReviewModel(ref: ModelRef, catalog: ShuvcodeModelCatalog): ShuvcodeModel {
  if (!ref.startsWith(SUBSCRIPTION_PREFIX)) {
    throw modelConfigError(`Review model must use the subscription provider: ${ref}`);
  }
  const name = ref.slice(SUBSCRIPTION_PREFIX.length);
  if (name.length === 0) throw modelConfigError(`Review model is missing a name: ${ref}`);

  // `subscription/<provider>:<model>` names the runtime provider explicitly. The
  // runtime does not always publish a model list, so this is the only form that
  // can be resolved when the catalog is empty.
  const separator = name.indexOf(":");
  if (separator !== -1) {
    const providerID = name.slice(0, separator);
    const id = name.slice(separator + 1);
    if (providerID.length === 0 || id.length === 0) {
      throw modelConfigError(
        `Review model must name both a provider and a model as subscription/<provider>:<model>: ${ref}`
      );
    }
    const known = catalog.models.some(
      (model) => model.providerID === providerID && model.id === id
    );
    if (!known && catalog.models.length > 0) {
      throw modelConfigError(
        `The runtime does not route ${providerID}/${id} for ${ref}. ` +
          `Available models: ${describeCatalog(catalog)}.`
      );
    }
    return { providerID, id };
  }

  if (name.startsWith("default-")) {
    if (catalog.default === undefined) {
      throw modelConfigError(
        `The runtime reported no default model, so ${ref} cannot be resolved. ` +
          "Configure a default model in the shuvcode profile, or set review.models to a model the runtime lists."
      );
    }
    return catalog.default;
  }

  const matches = catalog.models
    .filter((model) => model.id === name)
    .sort((left, right) => left.providerID.localeCompare(right.providerID));
  const match = matches[0];
  if (match === undefined) {
    throw modelConfigError(
      `The runtime does not route a model named ${name} for ${ref}. ` +
        `Available models: ${describeCatalog(catalog)}. ` +
        `Name the provider explicitly as subscription/<provider>:${name} if the runtime does not publish a model list.`
    );
  }
  return match;
}

function describeCatalog(catalog: ShuvcodeModelCatalog): string {
  const names = [...new Set(catalog.models.map((model) => model.id))].sort();
  if (names.length === 0) {
    return catalog.default === undefined
      ? "none reported by the runtime"
      : `none listed; the runtime default is ${catalog.default.id}`;
  }
  const shown = names.slice(0, 20);
  return names.length > shown.length ? `${shown.join(", ")}, …` : shown.join(", ");
}

function modelConfigError(message: string): Error & ClassifiedReviewError {
  const classified = classifyReviewError({ category: "config", message });
  return Object.assign(new Error(message), classified);
}
