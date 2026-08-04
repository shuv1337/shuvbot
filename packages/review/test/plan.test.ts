import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../../core/src/config.ts";
import {
  createReviewExecutionPlan,
  createReviewExecutionPlanFromConfig,
  type ReviewPlanFile
} from "../src/plan.ts";

describe("review execution plan", () => {
  test("filters noise before risk assessment and assigns a trivial roster", () => {
    const plan = createReviewExecutionPlan({
      files: [file("src/a.ts", 4, 2), file("bun.lock", 500, 500)],
      baseSha: "base",
      headSha: "head",
      maxConcurrency: 3
    });

    expect(plan.diff.changedLines).toBe(1006);
    expect(plan.diff.includedChangedLines).toBe(6);
    expect(plan.diff.entries.find((entry) => entry.path === "bun.lock")).toMatchObject({
      included: false,
      filterReason: "lockfile"
    });
    expect(plan.risk.tier).toBe("trivial");
    expect(plan.assignment.reviewers.map((entry) => entry.reviewer)).toEqual(["code-quality"]);
    expect(plan.assignment.reviewers[0]?.modelTier).toBe("light");
    expect(plan.assignment.coordinatorModelTier).toBe("standard");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.diff.entries)).toBe(true);
    expect(() => (plan.assignment.reviewers as unknown[]).push({})).toThrow();
  });

  test("forces full review and quorum assignments for sensitive files", () => {
    const plan = createReviewExecutionPlan({
      files: [file("src/auth/session.ts", 1, 0)],
      baseSha: "base",
      headSha: "head",
      maxConcurrency: 3
    });

    expect(plan.risk.tier).toBe("full");
    expect(plan.assignment.minimumSuccessfulSpecialists).toBe(5);
    expect(plan.assignment.reviewers.every(({ modelTier }) => modelTier === "standard")).toBe(true);
    expect(
      plan.assignment.reviewers.filter((entry) => entry.required).map((entry) => entry.reviewer)
    ).toEqual(["code-quality", "security"]);
  });

  test("selects a deterministic content-relevant lite specialist", () => {
    const code = createReviewExecutionPlan({
      files: [file("src/worker.ts", 20, 0)],
      baseSha: "base",
      headSha: "head",
      maxConcurrency: 3
    });
    const docs = createReviewExecutionPlan({
      files: [file("docs/usage.md", 20, 0)],
      baseSha: "base",
      headSha: "head",
      maxConcurrency: 3
    });
    expect(code.assignment.reviewers.map((entry) => entry.reviewer)).toEqual([
      "code-quality",
      "tests",
      "performance"
    ]);
    expect(docs.assignment.reviewers.map((entry) => entry.reviewer)).toEqual([
      "code-quality",
      "tests",
      "documentation"
    ]);
  });

  test("preserves behavioral generated files and escalates ambiguous generation", () => {
    const generated = {
      ...file("generated/api/client.ts", 1, 0),
      generatedRisk: "ambiguous" as const
    };
    const plan = createReviewExecutionPlan({
      files: [generated],
      baseSha: "base",
      headSha: "head",
      maxConcurrency: 1
    });

    expect(plan.diff.entries[0]).toMatchObject({ included: true, generatedRisk: "ambiguous" });
    expect(plan.risk.reason).toBe("generated-risk-ambiguity");
  });

  test("rejects tier overrides that violate required coverage", () => {
    expect(() =>
      createReviewExecutionPlan({
        files: [file("src/a.ts", 20, 0)],
        baseSha: "base",
        headSha: "head",
        maxConcurrency: 3,
        reviewers: { lite: ["code-quality", "tests"] }
      })
    ).toThrow("at least 3 specialists");
  });

  test("builds from normalized coordinator configuration", () => {
    const config = normalizeConfig({
      review: { max_concurrency: 2, sensitive_paths: ["infra/policy/**"] }
    });
    const plan = createReviewExecutionPlanFromConfig({
      files: [file("infra/policy/access.rego", 1, 0)],
      baseSha: "base",
      headSha: "head",
      config
    });

    expect(plan.maxConcurrency).toBe(2);
    expect(plan.risk).toMatchObject({ tier: "full", reason: "security-sensitive-path" });

    const builtInSensitive = createReviewExecutionPlanFromConfig({
      files: [file("src/auth/session.ts", 1, 0)],
      baseSha: "base",
      headSha: "head",
      config
    });
    expect(builtInSensitive.risk.tier).toBe("full");
  });

  test("applies global include and ignore paths before risk classification", () => {
    const config = normalizeConfig({
      paths: { include: ["src/**"], ignore: ["src/generated/**"] },
      review: { sensitive_paths: ["secrets/**"] }
    });
    const plan = createReviewExecutionPlanFromConfig({
      files: [
        file("src/index.ts", 2, 0),
        file("src/generated/client.ts", 500, 0),
        file("secrets/key.ts", 500, 0)
      ],
      baseSha: "base",
      headSha: "head",
      config
    });

    expect(plan.diff.entries).toEqual([
      expect.objectContaining({ path: "src/index.ts", included: true }),
      expect.objectContaining({
        path: "src/generated/client.ts",
        included: false,
        filterReason: "path_ignored"
      }),
      expect.objectContaining({
        path: "secrets/key.ts",
        included: false,
        filterReason: "path_not_included"
      })
    ]);
    expect(plan.risk).toMatchObject({ tier: "trivial", changedFiles: 1, securitySensitive: false });
  });
});

function file(path: string, additions: number, deletions: number): ReviewPlanFile {
  return {
    path,
    additions,
    deletions,
    status: "modified",
    patch: `diff --git a/${path} b/${path}`
  };
}
