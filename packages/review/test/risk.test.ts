import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS,
  classifyRisk,
  isSecuritySensitivePath
} from "../src/risk.ts";

describe("risk classifier", () => {
  test("classifies exact default boundaries", () => {
    expect(classifyRisk(input(10, 20)).tier).toBe("trivial");
    expect(classifyRisk(input(11, 20)).tier).toBe("lite");
    expect(classifyRisk(input(100, 20)).tier).toBe("lite");
    expect(classifyRisk(input(101, 20)).tier).toBe("full");
    expect(classifyRisk(input(10, 21)).tier).toBe("full");
  });

  test("security-sensitive files always force full review", () => {
    for (const path of [
      "src/auth/session.ts",
      ".github/workflows/release.yml",
      "package.json",
      "db/migrations/001-users.sql",
      "ops/deploy/production.toml"
    ]) {
      const result = classifyRisk({ changedLines: 1, files: [{ path }] });
      expect(result.tier).toBe("full");
      expect(result.reason).toBe("security-sensitive-path");
      expect(result.sensitivePaths).toEqual([path]);
    }
  });

  test("generated-risk ambiguity forces full review", () => {
    const result = classifyRisk({
      ...input(1, 1),
      generatedRiskAmbiguous: true
    });

    expect(result.tier).toBe("full");
    expect(result.reason).toBe("generated-risk-ambiguity");
  });

  test("supports replacement sensitive-path patterns and threshold overrides", () => {
    const result = classifyRisk(
      { changedLines: 3, files: [{ path: "infra/policy.rego" }] },
      {
        trivial: { maxChangedLines: 2 },
        securitySensitivePathPatterns: ["infra/**/*.rego"]
      }
    );

    expect(result.tier).toBe("full");
    expect(result.securitySensitive).toBe(true);
    expect(isSecuritySensitivePath("src/auth/session.ts", ["infra/**/*.rego"])).toBe(false);
  });

  test("default sensitive patterns cover nested and root manifests", () => {
    expect(DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(isSecuritySensitivePath("services/api/package.json")).toBe(true);
    expect(isSecuritySensitivePath("Cargo.toml")).toBe(true);
    expect(isSecuritySensitivePath("src/author.ts")).toBe(false);
  });

  test("rejects invalid counts and inverted thresholds", () => {
    expect(() => classifyRisk(input(-1, 1))).toThrow("changedLines");
    expect(() =>
      classifyRisk(input(1, 1), {
        trivial: { maxChangedLines: 101 }
      })
    ).toThrow("trivial risk thresholds");
  });
});

function input(changedLines: number, fileCount: number) {
  return {
    changedLines,
    files: Array.from({ length: fileCount }, (_, index) => ({ path: `src/file-${index}.ts` }))
  };
}
