import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toRuntimeJsonSchema } from "../src/engine.ts";
import { coordinatorResultSchema, reviewerResultSchema } from "../src/results.ts";
import {
  CURATED_REVIEW_MODELS,
  REVIEW_MODEL_ALIASES,
  curatedModelNames,
  resolveReviewModel,
  resolveReviewModels
} from "../src/runtime/model-catalog.ts";
import type { ModelRef } from "../src/plugins/types.ts";

describe("runtime structured output schema", () => {
  // The runtime rejects a dialect declaration with `structured_output.schema`,
  // which failed every structured prompt before any model was reached.
  test("carries no dialect declaration for either result schema", () => {
    for (const schema of [
      z.toJSONSchema(reviewerResultSchema),
      z.toJSONSchema(coordinatorResultSchema, { io: "input" })
    ]) {
      expect(schema).toHaveProperty("$schema");
      expect(toRuntimeJsonSchema(schema)).not.toHaveProperty("$schema");
    }
  });

  test("keeps the rest of the schema intact", () => {
    const prepared = toRuntimeJsonSchema(z.toJSONSchema(reviewerResultSchema));
    expect(prepared.type).toBe("object");
    expect(prepared.properties).toBeDefined();
  });
});

describe("review model resolution", () => {
  test("resolves every role alias to a curated model", () => {
    for (const [alias, target] of Object.entries(REVIEW_MODEL_ALIASES)) {
      expect(CURATED_REVIEW_MODELS[target]).toBeDefined();
      expect(resolveReviewModel(`subscription/${alias}` as ModelRef)).toEqual(
        CURATED_REVIEW_MODELS[target]!
      );
    }
  });

  test("resolves every curated model by name", () => {
    for (const [name, model] of Object.entries(CURATED_REVIEW_MODELS)) {
      expect(resolveReviewModel(`subscription/${name}` as ModelRef)).toEqual(model);
    }
  });

  test("curated models name a provider and a model id", () => {
    for (const model of Object.values(CURATED_REVIEW_MODELS)) {
      expect(model.providerID.length).toBeGreaterThan(0);
      expect(model.id.length).toBeGreaterThan(0);
    }
  });

  test("resolves an explicit provider without curating it", () => {
    expect(resolveReviewModel("subscription/anthropic:claude-sonnet-4-5" as ModelRef)).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5"
    });
  });

  test("rejects an incomplete provider-qualified name", () => {
    expect(() => resolveReviewModel("subscription/anthropic:" as ModelRef)).toThrow(
      /must name both a provider and a model/
    );
  });

  test("fails with a configuration error that lists the curated models", () => {
    let caught: unknown;
    try {
      resolveReviewModel("subscription/not-curated" as ModelRef);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("not-curated");
    expect((caught as Error).message).toContain("claude-opus-5");
    expect((caught as { code?: string }).code).toBe("REVIEW_CONFIG_INVALID");
    expect((caught as { retryable?: boolean }).retryable).toBe(false);
  });

  test("suggests the provider-qualified escape hatch", () => {
    expect(() => resolveReviewModel("subscription/some-new-model" as ModelRef)).toThrow(
      /subscription\/<provider>:some-new-model/
    );
  });

  test("rejects a reference outside the subscription namespace", () => {
    expect(() => resolveReviewModel("anthropic/claude" as ModelRef)).toThrow(
      /must use the subscription provider/
    );
  });

  test("reports every accepted name", () => {
    expect(curatedModelNames()).toContain("default-reasoning");
    expect(curatedModelNames()).toContain("grok-4.5");
  });

  test("resolves each distinct reference once", () => {
    const resolved = resolveReviewModels([
      "subscription/default-fast",
      "subscription/default-fast",
      "subscription/grok-4.5"
    ] as ModelRef[]);
    expect(resolved.size).toBe(2);
    expect(resolved.get("subscription/grok-4.5" as ModelRef)).toEqual({
      providerID: "xai",
      id: "grok-4.5"
    });
  });
});
