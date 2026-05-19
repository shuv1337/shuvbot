export interface ReviewFinding {
  id: string;
  skill: string;
  title: string;
  body: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: "high" | "medium" | "low";
  path: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  startLine?: number;
  endLine?: number;
  suggestedFix?: string;
  tags?: string[];
}

export const REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const REVIEW_FINDING_CONFIDENCES = ["high", "medium", "low"] as const;

export interface ParseFindingsResult {
  findings: ReviewFinding[];
  errors: string[];
}

export function parseFindings(raw: unknown): ParseFindingsResult {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { findings: [], errors: ["findings must be an array"] };
  const findings: ReviewFinding[] = [];
  raw.forEach((value, index) => {
    const finding = parseFinding(value, index, errors);
    if (finding) findings.push(finding);
  });
  return { findings, errors };
}

function parseFinding(value: unknown, index: number, errors: string[]): ReviewFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`findings[${index}] must be an object`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const required = ["id", "skill", "title", "body", "severity", "confidence", "path"] as const;
  for (const key of required) {
    if (typeof record[key] !== "string" || String(record[key]).trim() === "") {
      errors.push(`findings[${index}].${key} must be a non-empty string`);
    }
  }
  if (!REVIEW_FINDING_SEVERITIES.includes(record.severity as ReviewFinding["severity"])) {
    errors.push(`findings[${index}].severity is invalid`);
  }
  if (!REVIEW_FINDING_CONFIDENCES.includes(record.confidence as ReviewFinding["confidence"])) {
    errors.push(`findings[${index}].confidence is invalid`);
  }
  if (errors.some((error) => error.startsWith(`findings[${index}]`))) return undefined;

  const finding: ReviewFinding = {
    id: String(record.id),
    skill: String(record.skill),
    title: String(record.title),
    body: String(record.body),
    severity: record.severity as ReviewFinding["severity"],
    confidence: record.confidence as ReviewFinding["confidence"],
    path: String(record.path)
  };
  setOptionalNumber(finding, "line", record.line);
  setOptionalNumber(finding, "startLine", record.startLine);
  setOptionalNumber(finding, "endLine", record.endLine);
  if (record.side === "RIGHT" || record.side === "LEFT") finding.side = record.side;
  if (typeof record.suggestedFix === "string") finding.suggestedFix = record.suggestedFix;
  if (Array.isArray(record.tags)) finding.tags = record.tags.filter((tag): tag is string => typeof tag === "string");
  return finding;
}

function setOptionalNumber(target: ReviewFinding, key: "line" | "startLine" | "endLine", value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value)) target[key] = value;
}
