import { describe, expect, test } from "bun:test";
import { REVIEWER_MANDATORY_RULES } from "../src/prompts/reviewer-shared.ts";
import { buildSpecialistPrompt, REVIEWER_PROMPTS } from "../src/reviewers/index.ts";
import { BUILT_IN_REVIEWER_IDS } from "../src/types.ts";

describe("specialist prompts", () => {
  test("all six prompts define explicit positive and negative boundaries", () => {
    expect(Object.keys(REVIEWER_PROMPTS)).toEqual([...BUILT_IN_REVIEWER_IDS]);
    for (const definition of Object.values(REVIEWER_PROMPTS)) {
      expect(definition.whatToFlag.length).toBeGreaterThan(0);
      expect(definition.whatNotToFlag.length).toBeGreaterThan(0);
      const prompt = buildSpecialistPrompt(definition.id, workspaceInput());
      expect(prompt).toContain("## What to flag");
      expect(prompt).toContain("## What not to flag");
    }
  });

  test("references workspace files without embedding patches", () => {
    const prompt = buildSpecialistPrompt("security", workspaceInput());
    expect(prompt).toContain("/run/manifest.json");
    expect(prompt).toContain("/run/shared-review-context.txt");
    expect(prompt).toContain("/run/patches");
    expect(prompt).not.toContain("diff --git");
  });

  test("appends mandatory rules after bounded repository additions", () => {
    const prompt = buildSpecialistPrompt("tests", {
      ...workspaceInput(),
      repositoryAdditions: ["Repository guidance marker"]
    });
    expect(prompt.indexOf("Repository guidance marker")).toBeLessThan(
      prompt.indexOf(REVIEWER_MANDATORY_RULES)
    );
    expect(() =>
      buildSpecialistPrompt("tests", {
        ...workspaceInput(),
        repositoryAdditions: ["x".repeat(8_001)]
      })
    ).toThrow("exceed 8000 characters");
  });
});

function workspaceInput() {
  return {
    manifestPath: "/run/manifest.json",
    sharedContextPath: "/run/shared-review-context.txt",
    patchesDirectory: "/run/patches"
  } as const;
}
