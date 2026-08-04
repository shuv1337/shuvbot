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
  test("every role alias resolves to a curated model and an accepted effort", () => {
    for (const [alias, target] of Object.entries(REVIEW_MODEL_ALIASES)) {
      const [name, effort] = target.split("@");
      const curated = CURATED_REVIEW_MODELS[name!];
      expect(curated).toBeDefined();
      if (effort !== undefined) expect(curated!.efforts).toContain(effort);
      expect(resolveReviewModel(`subscription/${alias}` as ModelRef)).toEqual({
        providerID: curated!.providerID,
        id: curated!.id,
        ...(effort === undefined ? {} : { variant: effort })
      });
    }
  });

  test("resolves every curated model by name without an effort", () => {
    for (const [name, model] of Object.entries(CURATED_REVIEW_MODELS)) {
      expect(resolveReviewModel(`subscription/${name}` as ModelRef)).toEqual({
        providerID: model.providerID,
        id: model.id
      });
    }
  });

  test("resolves each curated model at each of its accepted efforts", () => {
    for (const [name, model] of Object.entries(CURATED_REVIEW_MODELS)) {
      for (const effort of model.efforts) {
        expect(resolveReviewModel(`subscription/${name}@${effort}` as ModelRef)).toEqual({
          providerID: model.providerID,
          id: model.id,
          variant: effort
        });
      }
    }
  });

  test("rejects an effort the model does not accept", () => {
    expect(() => resolveReviewModel("subscription/grok-4.5@xhigh" as ModelRef)).toThrow(
      /Unknown reasoning effort xhigh for grok-4\.5/
    );
    expect(() => resolveReviewModel("subscription/grok-4.5@xhigh" as ModelRef)).toThrow(
      /low, medium, high/
    );
  });

  test("an explicit effort overrides the one a role alias carries", () => {
    expect(resolveReviewModel("subscription/default-fast@low" as ModelRef)).toEqual({
      providerID: "openai",
      id: "gpt-5.6-luna",
      variant: "low"
    });
  });

  test("rejects an incomplete effort suffix", () => {
    expect(() => resolveReviewModel("subscription/grok-4.5@" as ModelRef)).toThrow(
      /both a model and an effort/
    );
  });

  test("curated models name a provider, a model id, and at least one effort", () => {
    for (const model of Object.values(CURATED_REVIEW_MODELS)) {
      expect(model.providerID.length).toBeGreaterThan(0);
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.efforts.length).toBeGreaterThan(0);
    }
  });

  test("resolves an explicit provider without curating it", () => {
    expect(resolveReviewModel("subscription/anthropic:claude-sonnet-4-5" as ModelRef)).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5"
    });
  });

  test("carries an effort through the uncurated escape hatch", () => {
    expect(resolveReviewModel("subscription/anthropic:claude-sonnet-4-5@high" as ModelRef)).toEqual(
      {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
        variant: "high"
      }
    );
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
