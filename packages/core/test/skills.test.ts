import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../src/config.ts";
import { builtInReviewSkills, getReviewSkill, runnableReviewSkills } from "../src/skills/index.ts";
import type { PullRequestEvent } from "../src/events.ts";

describe("review skills", () => {
  test("registers the built-in code-review skill", () => {
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("code-review");
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("security-review");
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("workflow-security");
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("test-review");
    expect(builtInReviewSkills.map((skill) => skill.id)).toContain("docs-review");
    expect(getReviewSkill("code-review")?.prompt).toContain("JSON array");
  });

  test("matches triggers and path filters", () => {
    const skills = runnableReviewSkills({
      event: pullRequestEvent("synchronize"),
      files: [{ filename: ".github/workflows/ci.yml" }, { filename: "docs/usage.md" }],
      config: normalizeConfig({ paths: { include: ["**/*"], ignore: [] } })
    }).map((skill) => skill.id);

    expect(skills).toContain("code-review");
    expect(skills).toContain("workflow-security");
    expect(skills).toContain("docs-review");
  });

  test("honors global ignore paths", () => {
    const skills = runnableReviewSkills({
      event: pullRequestEvent("synchronize"),
      files: [{ filename: "docs/usage.md" }],
      config: normalizeConfig({ paths: { include: ["**/*"], ignore: ["docs/**"] } })
    });

    expect(skills).toHaveLength(0);
  });
});

function pullRequestEvent(action: PullRequestEvent["action"]): PullRequestEvent {
  return {
    kind: "pull_request",
    name: "pull_request",
    action,
    repo: { owner: "octo", name: "repo", fullName: "octo/repo", isPrivate: false },
    sender: { login: "octo" },
    raw: {},
    pullRequest: {
      number: 1,
      title: "PR",
      body: "",
      state: "open",
      draft: false,
      user: { login: "octo" },
      baseRef: "main",
      baseSha: "base",
      headRef: "branch",
      headSha: "head",
      headRepoFullName: "octo/repo",
      isFork: false
    }
  };
}
