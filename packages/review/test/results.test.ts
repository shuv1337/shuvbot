import { describe, expect, test } from "bun:test";
import { fingerprintFinding, parseCoordinatorResult, parseReviewerResult } from "../src/results.ts";

const finding = {
  id: "run-finding-1",
  reviewer: "security",
  skill: "security",
  title: "Authorization check is bypassed",
  body: "The new route reaches the privileged operation without checking the caller.",
  evidence: "src/routes.ts:42 calls updateAccount before authorizeAccount.",
  severity: "high",
  confidence: "high",
  path: "src/routes.ts",
  line: 42
} as const;

describe("typed review results", () => {
  test("accepts a valid reviewer result", () => {
    expect(
      parseReviewerResult({
        reviewer: "security",
        status: "completed",
        summary: "One concrete authorization defect.",
        findings: [finding]
      }).findings
    ).toHaveLength(1);
  });

  test("rejects malformed, mismatched, and unknown reviewer fields", () => {
    expect(() =>
      parseReviewerResult({
        reviewer: "unknown",
        status: "completed",
        summary: "none",
        findings: []
      })
    ).toThrow();
    expect(() =>
      parseReviewerResult({
        reviewer: "tests",
        status: "completed",
        summary: "bad result",
        findings: [finding],
        extra: true
      })
    ).toThrow();
    expect(() =>
      parseReviewerResult({ ...validReviewerResult(), findings: [{ ...finding, evidence: "" }] })
    ).toThrow();
  });

  test("requires classified errors for unsuccessful reviewer results", () => {
    expect(() =>
      parseReviewerResult({
        reviewer: "security",
        status: "timed_out",
        summary: "Timed out",
        findings: []
      })
    ).toThrow();
    expect(
      parseReviewerResult({
        reviewer: "security",
        status: "failed",
        summary: "Provider failed.",
        findings: [],
        error: {
          code: "REVIEW_PROVIDER_FAILURE",
          category: "provider",
          message: "Provider failed.",
          retryable: true
        }
      }).status
    ).toBe("failed");
    expect(() =>
      parseReviewerResult({
        reviewer: "security",
        status: "failed",
        summary: "Auth failed.",
        findings: [],
        error: {
          code: "REVIEW_AUTH_FAILED",
          category: "auth",
          message: "Auth failed.",
          retryable: true
        }
      })
    ).toThrow();
  });

  test("validates coordinator decisions, dispositions, coverage, and fingerprints", () => {
    const result = parseCoordinatorResult({
      decision: "significant_concerns",
      findings: [{ ...finding, fingerprint: "stable-root-cause", disposition: "new" }],
      dropped: [
        {
          id: "run-finding-2",
          reviewer: "tests",
          disposition: "dismissed",
          reason: "No changed behavior."
        }
      ],
      coverage: {
        scheduled: ["security"],
        completed: ["security"],
        failed: [],
        timedOut: [],
        required: ["security"],
        quorumMet: true
      },
      summary: "One significant concern."
    });
    expect(result.findings[0]?.disposition).toBe("new");
  });

  test("replaces model-provided fingerprints deterministically", () => {
    const first = parseCoordinatorResult({
      ...validCoordinatorResult(),
      findings: [{ ...finding, disposition: "new", fingerprint: "model-controlled" }]
    });
    const second = parseCoordinatorResult({
      ...validCoordinatorResult(),
      findings: [{ ...finding, disposition: "new", fingerprint: "different-model-value" }]
    });
    const stableFingerprint = first.findings[0]!.fingerprint;
    expect(stableFingerprint).toBe(second.findings[0]!.fingerprint);
    expect(stableFingerprint).toBe(fingerprintFinding(finding));
    expect(stableFingerprint).not.toBe("model-controlled");
    const reassigned = { ...finding, reviewer: "tests", skill: "tests" };
    expect(fingerprintFinding(reassigned)).toBe(stableFingerprint);
    expect(fingerprintFinding({ ...finding, line: 48 })).toBe(
      fingerprintFinding({ ...finding, line: 42 })
    );
    expect(fingerprintFinding({ ...finding, line: 62 })).not.toBe(stableFingerprint);
  });

  test("uses stable root-cause semantics rather than title or reviewer wording", () => {
    const original = fingerprintFinding(finding);
    expect(
      fingerprintFinding({
        ...finding,
        title: "Privileged route can skip authorization",
        line: 48
      })
    ).toBe(original);
    expect(original).toStartWith("finding:v1:");
  });

  test("distinguishes unrelated root causes with the same title and location bucket", () => {
    const first = fingerprintFinding({ ...finding, title: "Incorrect behavior" });
    const second = fingerprintFinding({
      ...finding,
      title: "Incorrect behavior",
      body: "The route writes an unbounded response into the process cache.",
      evidence: "src/routes.ts:43 stores every response without eviction."
    });
    expect(first).not.toBe(second);
  });

  test("rejects clean findings and non-degraded below-quorum output", () => {
    const coverage = {
      scheduled: ["security"],
      completed: [],
      failed: ["security"],
      timedOut: [],
      required: ["security"],
      quorumMet: false
    };
    expect(() =>
      parseCoordinatorResult({
        decision: "clean",
        findings: [],
        dropped: [],
        coverage,
        summary: "Clean."
      })
    ).toThrow();
    expect(() =>
      parseCoordinatorResult({
        decision: "clean",
        findings: [{ ...finding, fingerprint: "fingerprint", disposition: "new" }],
        dropped: [],
        coverage: { ...coverage, completed: ["security"], failed: [], quorumMet: true },
        summary: "Clean."
      })
    ).toThrow();
  });
});

function validReviewerResult() {
  return {
    reviewer: "security",
    status: "completed",
    summary: "One finding.",
    findings: [finding]
  } as const;
}

function validCoordinatorResult() {
  return {
    decision: "comments",
    findings: [],
    dropped: [],
    coverage: {
      scheduled: ["security"],
      completed: ["security"],
      failed: [],
      timedOut: [],
      required: ["security"],
      quorumMet: true
    },
    summary: "One concern."
  } as const;
}
