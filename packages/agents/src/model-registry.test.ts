import { describe, expect, test } from "bun:test";
import { resolveModel, resolveModelId } from "./model-registry.ts";

describe("model registry", () => {
  test("resolves minimal Claude aliases", () => {
    expect(resolveModelId("claude/sonnet").provider).toBe("anthropic");
    expect(resolveModelId("claude/opus").provider).toBe("anthropic");
  });

  test("allows direct model IDs", () => {
    expect(resolveModelId("provider/model-id")).toEqual({
      slug: "provider/model-id",
      provider: "direct",
      model: "provider/model-id"
    });
    expect(resolveModel("provider/model-id").model).toBe("provider/model-id");
  });
});
