import { describe, expect, test } from "bun:test";
import { coordinatorPostingPolicy } from "../../review/src/posting-policy.ts";
import { buildCoordinatorReport } from "../../review/src/report.ts";
import { parseCoordinatorResult, type CoordinatedFinding } from "../../review/src/results.ts";
import { buildPostedReviewBody, renderFindingComment, severityBadge } from "./review-body.ts";

describe("posted review body", () => {
  test("leads with a human verdict and never says approved", () => {
    const result = parseCoordinatorResult(coordinatorPayload({ decision: "clean" }));
    const report = buildCoordinatorReport(result);
    const posting = coordinatorPostingPolicy({
      result,
      canReview: true,
      requestChanges: true,
      failCheck: false
    });
    const body = buildPostedReviewBody({ report, summaryOnly: [], posting });
    expect(body).toContain("**Verdict: no blocking issues**");
    expect(body.toLowerCase()).not.toContain("approv");
    expect(body).toContain("No active findings.");
  });

  test("groups active findings by severity and reports previous feedback", () => {
    const result = parseCoordinatorResult(
      coordinatorPayload({
        decision: "significant_concerns",
        findings: [
          finding({ id: "new-1", disposition: "new", severity: "high", title: "Unsafe log" }),
          finding({
            id: "old-1",
            disposition: "unresolved",
            severity: "critical",
            title: "Auth bypass",
            path: "src/auth.ts",
            line: 12
          }),
          finding({ id: "fixed-1", disposition: "fixed", severity: "medium", title: "Stale cache" })
        ]
      })
    );
    const report = buildCoordinatorReport(result);
    const posting = coordinatorPostingPolicy({
      result,
      canReview: true,
      requestChanges: false,
      failCheck: false
    });
    const body = buildPostedReviewBody({ report, summaryOnly: [], posting });
    expect(body).toContain("**Verdict: commented**");
    expect(body).toContain("### Previous feedback");
    expect(body).toContain("1 finding from an earlier review look fixed");
    expect(body).toContain("1 finding still open");
    expect(body).toContain("### 🔴 Critical");
    expect(body).toContain("`src/auth.ts:12` — Auth bypass");
    expect(body).toContain("### 🟠 High");
    expect(body).not.toContain("Stale cache");
  });

  test("requests changes without claiming approval, and keeps unmappable findings", () => {
    const result = parseCoordinatorResult(
      coordinatorPayload({
        decision: "significant_concerns",
        findings: [finding({ id: "new-1", disposition: "new", severity: "critical" })]
      })
    );
    const report = buildCoordinatorReport(result);
    const posting = coordinatorPostingPolicy({
      result,
      canReview: true,
      requestChanges: true,
      failCheck: false,
      failOn: "high"
    });
    const unmapped = finding({
      id: "off-diff",
      disposition: "new",
      title: "Helper is unused",
      path: "src/helper.ts",
      line: 99
    }) as CoordinatedFinding;
    const body = buildPostedReviewBody({
      report,
      summaryOnly: [unmapped],
      posting
    });
    expect(body).toContain("**Verdict: changes requested**");
    expect(body).toContain("Findings without a commentable diff line");
    expect(body).toContain("Helper is unused");
    expect(body).toContain("`src/helper.ts:99`");
    expect(body.toLowerCase()).not.toContain("approv");
  });

  test("degraded coverage is an incomplete verdict", () => {
    const result = parseCoordinatorResult(
      coordinatorPayload({ decision: "degraded", quorumMet: false })
    );
    const report = buildCoordinatorReport(result);
    const posting = coordinatorPostingPolicy({
      result,
      canReview: true,
      requestChanges: true,
      failCheck: false,
      failOn: "high"
    });
    const body = buildPostedReviewBody({ report, summaryOnly: [], posting });
    expect(body).toContain("**Verdict: incomplete**");
    expect(body).toContain("quorum not met");
  });

  test("inline comments open with a severity badge", () => {
    const finding = {
      id: "unsafe-log-1",
      reviewer: "security",
      skill: "security",
      title: "Unsanitized input logged",
      body: "The request payload is logged without sanitizing it first.",
      evidence: "src/app.ts:3 logs `name` directly.",
      severity: "high",
      confidence: "high",
      path: "src/app.ts",
      line: 3,
      fingerprint: "finding:v1:abc",
      disposition: "new"
    } as CoordinatedFinding;
    expect(severityBadge("high")).toBe("🟠 **High**");
    expect(renderFindingComment(finding)).toContain("🟠 **High** — Unsanitized input logged");
    expect(renderFindingComment(finding)).toContain("_Evidence:_");
  });
});

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "unsafe-log-1",
    reviewer: "security",
    skill: "security",
    title: "Unsanitized input logged",
    body: "The request payload is logged without sanitizing it first.",
    evidence: "src/app.ts:3 logs `name` directly.",
    severity: "high",
    confidence: "high",
    path: "src/app.ts",
    line: 3,
    disposition: "new",
    ...overrides
  };
}

function coordinatorPayload(
  options: {
    findings?: unknown[];
    decision?: string;
    quorumMet?: boolean;
  } = {}
) {
  const quorumMet = options.quorumMet ?? true;
  return {
    decision: options.decision ?? (options.findings?.length ? "significant_concerns" : "clean"),
    findings: options.findings ?? [],
    dropped: [],
    coverage: {
      scheduled: ["code-quality", "security"],
      completed: quorumMet ? ["code-quality", "security"] : ["code-quality"],
      failed: quorumMet ? [] : ["security"],
      timedOut: [],
      required: ["code-quality", "security"],
      quorumMet
    },
    summary: "Coordinator result."
  };
}
