import type { CoordinatorPostingPolicy } from "../../review/src/posting-policy.ts";
import type { CoordinatorReportJson } from "../../review/src/report.ts";
import type { CoordinatedFinding } from "../../review/src/results.ts";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

const SEVERITY_BADGE: Record<(typeof SEVERITY_ORDER)[number], { icon: string; label: string }> = {
  critical: { icon: "🔴", label: "Critical" },
  high: { icon: "🟠", label: "High" },
  medium: { icon: "🟡", label: "Medium" },
  low: { icon: "⚪", label: "Low" },
  info: { icon: "🔵", label: "Info" }
};

export function severityBadge(severity: CoordinatedFinding["severity"]): string {
  const badge = SEVERITY_BADGE[severity];
  return `${badge.icon} **${badge.label}**`;
}

/** Inline finding comment: severity first, then the evidence the reviewer used. */
export function renderFindingComment(finding: CoordinatedFinding): string {
  const parts = [
    `${severityBadge(finding.severity)} — ${finding.title}`,
    "",
    finding.body,
    "",
    `_Evidence:_ ${finding.evidence}`,
    `_Reviewer:_ \`${finding.reviewer}\` · confidence ${finding.confidence}`
  ];
  if (finding.suggestedFix !== undefined) {
    parts.push("", "```suggestion", finding.suggestedFix, "```");
  }
  return parts.join("\n");
}

/**
 * GitHub review body shown to the author.
 *
 * The coordinator report stays the operator-facing record (CLI, artifacts,
 * workflow summary). This is the human verdict plus a compact finding list,
 * previous-feedback status, and coverage that cannot be mistaken for approval.
 */
export function buildPostedReviewBody(input: {
  readonly report: CoordinatorReportJson;
  readonly summaryOnly: readonly CoordinatedFinding[];
  readonly posting: CoordinatorPostingPolicy;
}): string {
  const sections = [verdictLine(input.report, input.posting)];
  const previous = previousFeedback(input.report);
  if (previous.length > 0) {
    sections.push("", "### Previous feedback", "", ...previous);
  }
  const grouped = groupActiveFindings(input.report);
  if (grouped.length === 0) {
    sections.push("", "No active findings.");
  } else {
    sections.push("", ...grouped);
  }
  if (input.summaryOnly.length > 0) {
    sections.push(
      "",
      "### Findings without a commentable diff line",
      "",
      "These have no valid inline position on this diff, so they are reported here instead of being dropped.",
      "",
      ...input.summaryOnly.map((finding) => {
        const line = finding.line ?? finding.endLine;
        const location = line === undefined ? finding.path : `${finding.path}:${line}`;
        return `- ${severityBadge(finding.severity)} ${finding.title} (\`${location}\`)\n  ${finding.body}`;
      })
    );
  }
  sections.push("", coverageDetails(input.report, input.posting));
  return sections.join("\n");
}

function verdictLine(report: CoordinatorReportJson, posting: CoordinatorPostingPolicy): string {
  if (posting.degraded || report.degraded || report.decision === "degraded") {
    return `**Verdict: incomplete** — ${posting.reason}`;
  }
  switch (report.decision) {
    case "clean":
      return `**Verdict: no blocking issues** — ${posting.reason}`;
    case "significant_concerns":
      return posting.reviewEvent === "REQUEST_CHANGES"
        ? `**Verdict: changes requested** — ${posting.reason}`
        : `**Verdict: commented** — ${posting.reason}`;
    case "comments":
    case "minor_issues":
      return `**Verdict: commented** — ${posting.reason}`;
    default: {
      const _exhaustive: never = report.decision;
      return _exhaustive;
    }
  }
}

function previousFeedback(report: CoordinatorReportJson): string[] {
  const { fixed, unresolved, userResolved } = report.counts;
  if (fixed === 0 && unresolved === 0 && userResolved === 0) return [];
  const lines: string[] = [];
  if (fixed > 0) {
    lines.push(`- ${countLabel(fixed, "finding")} from an earlier review look fixed`);
  }
  if (unresolved > 0) {
    lines.push(`- ${countLabel(unresolved, "finding")} still open`);
  }
  if (userResolved > 0) {
    lines.push(`- ${countLabel(userResolved, "finding")} marked resolved in the review discussion`);
  }
  return lines;
}

function groupActiveFindings(report: CoordinatorReportJson): string[] {
  const lines: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const findings = report.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) continue;
    const badge = SEVERITY_BADGE[severity];
    lines.push(`### ${badge.icon} ${badge.label}`, "");
    for (const finding of findings) {
      const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
      lines.push(`- \`${location}\` — ${finding.title}`);
    }
    lines.push("");
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function coverageDetails(report: CoordinatorReportJson, posting: CoordinatorPostingPolicy): string {
  const { coverage } = report;
  const lines = [
    "<details>",
    `<summary>Coverage · ${coverage.completed.length}/${coverage.scheduled.length} reviewers · quorum ${coverage.quorumMet ? "met" : "not met"}</summary>`,
    "",
    posting.reason,
    ""
  ];
  if (coverage.failed.length > 0) lines.push(`Failed: ${coverage.failed.join(", ")}`);
  if (coverage.timedOut.length > 0) lines.push(`Timed out: ${coverage.timedOut.join(", ")}`);
  lines.push("</details>");
  return lines.join("\n");
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
