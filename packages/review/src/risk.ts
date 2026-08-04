import type {
  RiskAssessment,
  RiskAssessmentInput,
  RiskClassifierConfig,
  RiskTierThreshold
} from "./types.ts";

export const DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS = [
  "**/auth/**",
  "**/auth.*",
  "**/authentication/**",
  "**/authentication.*",
  "**/authorization/**",
  "**/authorization.*",
  "**/crypto/**",
  "**/crypto.*",
  "**/cryptography/**",
  "**/cryptography.*",
  "**/secrets/**",
  "**/secrets.*",
  "**/permissions/**",
  "**/permissions.*",
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "package.json",
  "**/package.json",
  "pyproject.toml",
  "**/pyproject.toml",
  "Cargo.toml",
  "**/Cargo.toml",
  "go.mod",
  "**/go.mod",
  "Gemfile",
  "**/Gemfile",
  "requirements*.txt",
  "**/requirements*.txt",
  "pom.xml",
  "**/pom.xml",
  "build.gradle*",
  "**/build.gradle*",
  "composer.json",
  "**/composer.json",
  "**/migrations/**",
  "Dockerfile",
  "**/Dockerfile",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "**/deploy/**",
  "**/deployment/**",
  "**/release/**",
  "**/release.config.*"
] as const;

export const DEFAULT_RISK_CONFIG: RiskClassifierConfig = {
  trivial: { maxChangedLines: 10, maxFiles: 20 },
  lite: { maxChangedLines: 100, maxFiles: 20 },
  securitySensitivePathPatterns: DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS
};

export type RiskClassifierOverrides = Partial<Omit<RiskClassifierConfig, "trivial" | "lite">> & {
  readonly trivial?: Partial<RiskTierThreshold>;
  readonly lite?: Partial<RiskTierThreshold>;
};

export function classifyRisk(
  input: RiskAssessmentInput,
  overrides: RiskClassifierOverrides = {}
): RiskAssessment {
  const config = resolveConfig(overrides);
  validateInput(input);
  validateConfig(config);

  const sensitivePaths = input.files
    .map((file) => file.path)
    .filter((path) =>
      config.securitySensitivePathPatterns.some((pattern) => matchesGlob(path, pattern))
    );
  const common = {
    changedLines: input.changedLines,
    changedFiles: input.files.length,
    securitySensitive: sensitivePaths.length > 0,
    sensitivePaths,
    generatedRiskAmbiguous: input.generatedRiskAmbiguous ?? false
  } as const;

  if (sensitivePaths.length > 0) {
    return { tier: "full", reason: "security-sensitive-path", ...common };
  }
  if (input.generatedRiskAmbiguous === true) {
    return { tier: "full", reason: "generated-risk-ambiguity", ...common };
  }
  if (withinThreshold(input, config.trivial)) {
    return { tier: "trivial", reason: "within-trivial-thresholds", ...common };
  }
  if (withinThreshold(input, config.lite)) {
    return { tier: "lite", reason: "within-lite-thresholds", ...common };
  }
  return { tier: "full", reason: "exceeds-lite-thresholds", ...common };
}

export function isSecuritySensitivePath(
  path: string,
  patterns: readonly string[] = DEFAULT_SECURITY_SENSITIVE_PATH_PATTERNS
): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function withinThreshold(input: RiskAssessmentInput, threshold: RiskTierThreshold): boolean {
  return (
    input.changedLines <= threshold.maxChangedLines && input.files.length <= threshold.maxFiles
  );
}

function resolveConfig(overrides: RiskClassifierOverrides): RiskClassifierConfig {
  return {
    trivial: { ...DEFAULT_RISK_CONFIG.trivial, ...overrides.trivial },
    lite: { ...DEFAULT_RISK_CONFIG.lite, ...overrides.lite },
    securitySensitivePathPatterns:
      overrides.securitySensitivePathPatterns ?? DEFAULT_RISK_CONFIG.securitySensitivePathPatterns
  };
}

function validateInput(input: RiskAssessmentInput): void {
  assertNonNegativeInteger(input.changedLines, "changedLines");
  for (const file of input.files) {
    if (file.path.length === 0) {
      throw new TypeError("file paths must not be empty");
    }
  }
}

function validateConfig(config: RiskClassifierConfig): void {
  assertNonNegativeInteger(config.trivial.maxChangedLines, "trivial.maxChangedLines");
  assertNonNegativeInteger(config.trivial.maxFiles, "trivial.maxFiles");
  assertNonNegativeInteger(config.lite.maxChangedLines, "lite.maxChangedLines");
  assertNonNegativeInteger(config.lite.maxFiles, "lite.maxFiles");
  if (
    config.trivial.maxChangedLines > config.lite.maxChangedLines ||
    config.trivial.maxFiles > config.lite.maxFiles
  ) {
    throw new RangeError("trivial risk thresholds must not exceed lite thresholds");
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  let expression = "^";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        index += 1;
        if (normalizedPattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegularExpression(character ?? "");
    }
  }

  return new RegExp(`${expression}$`, "u").test(normalizedPath);
}

function escapeRegularExpression(value: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(value) ? `\\${value}` : value;
}
