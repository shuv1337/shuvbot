import { describe, expect, test } from "bun:test";
import { builtInReviewSkills, getReviewSkill } from "../src/skills/index.ts";

describe("review skills", () => {
  test("registers the built-in code-review skill", () => {
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("code-review");
    expect(getReviewSkill("code-review")?.prompt).toContain("JSON array");
  });
});
