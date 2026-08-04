import { describe, expect, test } from "bun:test";
import {
  buildCoordinatorReport,
  renderCoordinatorReport,
  stringifyCoordinatorReport
} from "../src/report.ts";

describe("local coordinator report", () => {
  test("renders concise findings and incremental dispositions", () => {
    const result = coordinatorResult({
      findings: [
        finding("new-1", "new", "New authorization defect"),
        finding("old-1", "unresolved", "Existing authorization defect"),
        finding("fixed-1", "fixed", "Fixed authorization defect"),
        finding("resolved-1", "user_resolved", "Accepted authorization behavior")
      ]
    });
    const human = renderCoordinatorReport(result);

    expect(human).toContain("Decision: COMMENTS");
    expect(human).toContain("Active findings: 2");
    expect(human).toContain("1 new, 1 unresolved, 1 fixed, 1 user-resolved, 1 dismissed");
    expect(human).not.toContain("[high/fixed] Fixed authorization defect");
    expect(human).not.toContain("private raw prompt");
    expect(human).not.toContain("Detailed evidence");
  });

  test("uses a stable JSON projection without raw bodies, evidence, or secrets", () => {
    const secret = `ghp_${"a".repeat(24)}`;
    const json = stringifyCoordinatorReport(
      coordinatorResult({ findings: [finding("new-1", "new", `Leaked ${secret}`)] })
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      "version",
      "decision",
      "degraded",
      "coverage",
      "counts",
      "findings",
      "lifecycle",
      "dropped"
    ]);
    expect(json).toContain("[REDACTED]");
    expect(json).not.toContain(secret);
    expect(json).not.toContain("private raw prompt");
    expect(json).not.toContain("Detailed evidence");
  });

  test("never presents a below-quorum result as clean", () => {
    const degraded = coordinatorResult({
      decision: "degraded",
      quorumMet: false,
      completed: [],
      failed: ["code-quality"]
    });

    expect(buildCoordinatorReport(degraded).decision).toBe("degraded");
    expect(renderCoordinatorReport(degraded)).toContain("DEGRADED - REVIEW INCOMPLETE");
    expect(renderCoordinatorReport(degraded)).not.toContain("Decision: CLEAN");
  });

  test("rejects unvalidated coordinator output", () => {
    expect(() => buildCoordinatorReport({ decision: "clean" })).toThrow();
  });

  test("reports lifecycle transitions separately from active findings", () => {
    const report = buildCoordinatorReport(
      coordinatorResult({
        findings: [
          finding("new-1", "new", "Active defect"),
          finding("resolved-input", "user_resolved", "Resolved defect")
        ]
      }),
      {
        lifecycle: {
          fixedFingerprints: ["fixed-from-reconciliation"],
          userResolvedFingerprints: ["resolved-from-reconciliation"]
        }
      }
    );

    expect(report.counts).toMatchObject({ total: 1, active: 1, new: 1, fixed: 1, userResolved: 2 });
    expect(report.findings.map(({ title }) => title)).toEqual(["Active defect"]);
    expect(report.lifecycle).toEqual({
      fixed: ["fixed-from-reconciliation"],
      userResolved: expect.arrayContaining([
        "resolved-from-reconciliation",
        expect.stringMatching(/^finding:v1:/)
      ])
    });
  });

  test("redacts lifecycle transition inputs", () => {
    const secret = `ghp_${"z".repeat(24)}`;
    const report = stringifyCoordinatorReport(coordinatorResult(), {
      lifecycle: { fixedFingerprints: [secret] }
    });
    expect(report).toContain("[REDACTED]");
    expect(report).not.toContain(secret);
  });
});

function finding(id: string, disposition: string, title: string) {
  return {
    id,
    reviewer: "security",
    skill: "security",
    title,
    body: "private raw prompt",
    evidence: "Detailed evidence that is intentionally not presented.",
    severity: "high",
    confidence: "high",
    path: "src/auth.ts",
    line: 42,
    disposition
  };
}

function coordinatorResult({
  decision = "comments",
  findings = [],
  quorumMet = true,
  completed = ["code-quality"],
  failed = []
}: {
  decision?: "comments" | "degraded";
  findings?: readonly unknown[];
  quorumMet?: boolean;
  completed?: readonly string[];
  failed?: readonly string[];
} = {}) {
  return {
    decision,
    findings,
    dropped: [
      {
        id: "dismissed-1",
        reviewer: "tests",
        disposition: "dismissed",
        reason: "Not actionable."
      }
    ],
    coverage: {
      scheduled: ["code-quality"],
      completed,
      failed,
      timedOut: [],
      required: ["code-quality"],
      quorumMet
    },
    summary: "Coordinator summary contains no presentation contract."
  };
}
