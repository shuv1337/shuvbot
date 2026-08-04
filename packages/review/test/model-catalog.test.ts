import { describe, expect, test } from "bun:test";
import { resolveReviewModel, resolveReviewModels } from "../src/runtime/model-catalog.ts";
import type { ModelRef } from "../src/plugins/types.ts";

const catalog = {
  models: [
    { providerID: "zeta", id: "shared-model" },
    { providerID: "acme", id: "shared-model" },
    { providerID: "acme", id: "fast-model" }
  ],
  default: { providerID: "acme", id: "house-default" }
};

describe("review model resolution", () => {
  test("resolves default names to the runtime default model", () => {
    for (const ref of ["subscription/default-reasoning", "subscription/default-fast"] as const) {
      expect(resolveReviewModel(ref, catalog)).toEqual({
        providerID: "acme",
        id: "house-default"
      });
    }
  });

  test("resolves a named model from the runtime catalog", () => {
    expect(resolveReviewModel("subscription/fast-model" as ModelRef, catalog)).toEqual({
      providerID: "acme",
      id: "fast-model"
    });
  });

  test("chooses deterministically when several providers offer the same model", () => {
    expect(resolveReviewModel("subscription/shared-model" as ModelRef, catalog)).toEqual({
      providerID: "acme",
      id: "shared-model"
    });
  });

  test("resolves default names when the runtime lists no models", () => {
    expect(
      resolveReviewModel("subscription/default-coding" as ModelRef, {
        models: [],
        default: { providerID: "solo", id: "only-model" }
      })
    ).toEqual({ providerID: "solo", id: "only-model" });
  });

  test("fails with a configuration error when the runtime reports no default", () => {
    expect(() =>
      resolveReviewModel("subscription/default-coding" as ModelRef, { models: [] })
    ).toThrow(/reported no default model/);
  });

  test("fails with a configuration error naming the unroutable model", () => {
    let caught: unknown;
    try {
      resolveReviewModel("subscription/missing-model" as ModelRef, catalog);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("missing-model");
    expect((caught as { code?: string }).code).toBe("REVIEW_CONFIG_INVALID");
    expect((caught as { retryable?: boolean }).retryable).toBe(false);
  });

  test("lists available models in the diagnostic", () => {
    expect(() => resolveReviewModel("subscription/missing-model" as ModelRef, catalog)).toThrow(
      /fast-model/
    );
  });

  test("resolves an explicitly named provider when the runtime lists no models", () => {
    expect(
      resolveReviewModel("subscription/anthropic:claude-sonnet-4-5" as ModelRef, { models: [] })
    ).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" });
  });

  test("validates an explicitly named provider against a published catalog", () => {
    expect(resolveReviewModel("subscription/acme:fast-model" as ModelRef, catalog)).toEqual({
      providerID: "acme",
      id: "fast-model"
    });
    expect(() => resolveReviewModel("subscription/acme:absent" as ModelRef, catalog)).toThrow(
      /does not route acme\/absent/
    );
  });

  test("rejects an incomplete provider-qualified name", () => {
    expect(() => resolveReviewModel("subscription/anthropic:" as ModelRef, catalog)).toThrow(
      /must name both a provider and a model/
    );
  });

  test("suggests the provider-qualified form when the catalog is empty", () => {
    expect(() =>
      resolveReviewModel("subscription/claude-sonnet-4-5" as ModelRef, { models: [] })
    ).toThrow(/subscription\/<provider>:claude-sonnet-4-5/);
  });

  test("rejects a reference outside the subscription namespace", () => {
    expect(() => resolveReviewModel("anthropic/claude" as ModelRef, catalog)).toThrow(
      /must use the subscription provider/
    );
  });

  test("resolves each distinct reference once", () => {
    const resolved = resolveReviewModels(
      [
        "subscription/fast-model",
        "subscription/fast-model",
        "subscription/default-reasoning"
      ] as ModelRef[],
      catalog
    );
    expect(resolved.size).toBe(2);
    expect(resolved.get("subscription/fast-model" as ModelRef)).toEqual({
      providerID: "acme",
      id: "fast-model"
    });
  });
});
