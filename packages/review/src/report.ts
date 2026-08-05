import { parseCoordinatorResult, type CoordinatorResult } from "./results.ts";

export interface CoordinatorReportOptions {
  readonly redact?: (value: string) => string;
  readonly lifecycle?: {
    readonly fixedFingerprints?: readonly string[];
    readonly userResolvedFingerprints?: readonly string[];
  };
}

export interface CoordinatorReportFinding {
  readonly id: string;
  readonly fingerprint: string;
  readonly reviewer: string;
  readonly severity: string;
  readonly confidence: string;
  readonly disposition: string;
  readonly title: string;
  readonly path: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface CoordinatorReportJson {
  readonly version: 1;
  readonly decision: CoordinatorResult["decision"];
  readonly degraded: boolean;
  readonly coverage: {
    readonly quorumMet: boolean;
    readonly scheduled: readonly string[];
    readonly completed: readonly string[];
    readonly failed: readonly string[];
    readonly timedOut: readonly string[];
    readonly required: readonly string[];
  };
  readonly counts: {
    readonly total: number;
    readonly active: number;
    readonly new: number;
    readonly unresolved: number;
    readonly fixed: number;
    readonly userResolved: number;
    readonly dismissed: number;
  };
  readonly findings: readonly CoordinatorReportFinding[];
  readonly lifecycle: {
    readonly fixed: readonly string[];
    readonly userResolved: readonly string[];
  };
  readonly dropped: readonly {
    readonly id: string;
    readonly reviewer: string;
    readonly disposition: "dismissed";
  }[];
}

export function buildCoordinatorReport(
  value: unknown,
  options: CoordinatorReportOptions = {}
): CoordinatorReportJson {
  const result = parseCoordinatorResult(value);
  const clean = (text: string) => sanitize(text, options.redact);
  const projectedFindings = result.findings.map((finding) => ({
    id: clean(finding.id),
    fingerprint: finding.fingerprint,
    reviewer: finding.reviewer,
    severity: finding.severity,
    confidence: finding.confidence,
    disposition: finding.disposition,
    title: clean(finding.title),
    path: clean(finding.path),
    line: finding.line ?? null,
    startLine: finding.startLine ?? null,
    endLine: finding.endLine ?? null
  }));
  const findings = projectedFindings.filter(
    (finding) => finding.disposition === "new" || finding.disposition === "unresolved"
  );
  const fixed = unique(
    [
      ...projectedFindings
        .filter((finding) => finding.disposition === "fixed")
        .map((finding) => finding.fingerprint),
      ...(options.lifecycle?.fixedFingerprints ?? [])
    ].map(clean)
  );
  const userResolved = unique(
    [
      ...projectedFindings
        .filter((finding) => finding.disposition === "user_resolved")
        .map((finding) => finding.fingerprint),
      ...(options.lifecycle?.userResolvedFingerprints ?? [])
    ].map(clean)
  );
  const dispositions = findings.map((finding) => finding.disposition);
  const degraded = !result.coverage.quorumMet || result.decision === "degraded";
  return {
    version: 1,
    decision: degraded ? "degraded" : result.decision,
    degraded,
    coverage: {
      quorumMet: result.coverage.quorumMet,
      scheduled: [...result.coverage.scheduled],
      completed: [...result.coverage.completed],
      failed: [...result.coverage.failed],
      timedOut: [...result.coverage.timedOut],
      required: [...result.coverage.required]
    },
    counts: {
      total: findings.length,
      active: findings.length,
      new: count(dispositions, "new"),
      unresolved: count(dispositions, "unresolved"),
      fixed: fixed.length,
      userResolved: userResolved.length,
      dismissed:
        projectedFindings.filter((finding) => finding.disposition === "dismissed").length +
        result.dropped.length
    },
    findings,
    lifecycle: { fixed, userResolved },
    dropped: result.dropped.map((finding) => ({
      id: clean(finding.id),
      reviewer: finding.reviewer,
      disposition: finding.disposition
    }))
  };
}

export function renderCoordinatorReport(
  value: unknown,
  options: CoordinatorReportOptions = {}
): string {
  const report = buildCoordinatorReport(value, options);
  const lines = [
    `Decision: ${report.decision === "degraded" ? "DEGRADED - REVIEW INCOMPLETE" : report.decision.replaceAll("_", " ").toUpperCase()}`,
    `Coverage: ${report.coverage.completed.length}/${report.coverage.scheduled.length} reviewers | quorum ${report.coverage.quorumMet ? "met" : "NOT MET"}`,
    `Active findings: ${report.counts.active} (${report.counts.new} new, ${report.counts.unresolved} unresolved, ${report.counts.fixed} fixed, ${report.counts.userResolved} user-resolved, ${report.counts.dismissed} dismissed)`
  ];
  if (report.coverage.failed.length > 0) lines.push(`Failed: ${report.coverage.failed.join(", ")}`);
  if (report.coverage.timedOut.length > 0) {
    lines.push(`Timed out: ${report.coverage.timedOut.join(", ")}`);
  }
  for (const finding of report.findings) {
    const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    lines.push(
      `- [${finding.severity}/${finding.disposition}] ${finding.title} (${location}, ${finding.reviewer})`
    );
  }
  return lines.join("\n");
}

export function stringifyCoordinatorReport(
  value: unknown,
  options: CoordinatorReportOptions = {}
): string {
  return `${JSON.stringify(buildCoordinatorReport(value, options), null, 2)}\n`;
}

/** The revision range a report describes, plus the report itself. */
export interface CoordinatorFindingsArtifact extends CoordinatorReportJson {
  readonly baseSha: string;
  readonly headSha: string;
}

/**
 * Builds the canonical `shuvbot-findings.json` payload.
 *
 * Both the CLI and the Action write a file under that name, and they used to
 * write different shapes: the local one carried `baseSha`/`headSha` but dropped
 * `coverage` and `degraded`, and the Action's did the reverse. Anything reading
 * the artifact - a script, a later run, a person diffing local against CI - hit
 * two schemas behind one filename. This is the single shape both now emit.
 */
export function buildCoordinatorFindingsArtifact(input: {
  readonly report: CoordinatorReportJson;
  readonly baseSha: string;
  readonly headSha: string;
}): CoordinatorFindingsArtifact {
  return { ...input.report, baseSha: input.baseSha, headSha: input.headSha };
}

function count(values: readonly string[], expected: string): number {
  return values.filter((value) => value === expected).length;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sanitize(value: string, redact?: (value: string) => string): string {
  const withoutControls = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("");
  const withoutCommonSecrets = withoutControls
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/((?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
  return redact ? redact(withoutCommonSecrets) : withoutCommonSecrets;
}
