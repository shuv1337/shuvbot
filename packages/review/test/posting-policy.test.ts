import { describe, expect, test } from "bun:test";
import { coordinatorPostingPolicy } from "../src/posting-policy.ts";
import { parseCoordinatorResult, type CoordinatorResult } from "../src/results.ts";

describe("coordinator posting policy", () => {
  test("never exposes an approval event", () => {
    expect(coordinatorPostingPolicy(input(result("clean"))).reviewEvent).toBe("COMMENT");
  });

  test("requests changes only for significant threshold findings when policy permits", () => {
    const significant = result("significant_concerns", "critical");
    expect(coordinatorPostingPolicy(input(significant))).toMatchObject({
      localStatus: "blocked",
      reviewEvent: "REQUEST_CHANGES",
      failCheck: true
    });
    expect(
      coordinatorPostingPolicy(input(significant, { canReview: false, requestChanges: true }))
    ).toMatchObject({ localStatus: "findings", reviewEvent: "COMMENT" });
    expect(
      coordinatorPostingPolicy(input(significant, { canReview: true, requestChanges: false }))
    ).toMatchObject({ localStatus: "findings", reviewEvent: "COMMENT" });
  });

  test("degraded coverage cannot claim clean or request changes", () => {
    const degraded = result("degraded", "critical", false);
    expect(coordinatorPostingPolicy(input(degraded))).toMatchObject({
      localStatus: "incomplete",
      reviewEvent: "COMMENT",
      degraded: true,
      failCheck: true
    });
  });

  test("respects the configured severity threshold", () => {
    const comments = result("comments", "medium");
    expect(coordinatorPostingPolicy(input(comments, { failOn: "high" })).failCheck).toBe(false);
    expect(coordinatorPostingPolicy(input(comments, { failOn: "medium" })).failCheck).toBe(true);
  });
});

function input(
  value: CoordinatorResult,
  overrides: Partial<Omit<Parameters<typeof coordinatorPostingPolicy>[0], "result">> = {}
): Parameters<typeof coordinatorPostingPolicy>[0] {
  return {
    result: value,
    canReview: true,
    requestChanges: true,
    failCheck: true,
    failOn: "critical",
    ...overrides
  };
}

function result(
  decision: CoordinatorResult["decision"],
  severity?: "critical" | "high" | "medium" | "low" | "info",
  quorumMet = true
): CoordinatorResult {
  return parseCoordinatorResult({
    decision,
    findings:
      severity === undefined
        ? []
        : [
            {
              id: "finding-1",
              reviewer: "security",
              skill: "security",
              title: "Authorization bypass",
              body: "A privileged operation is reachable without authorization.",
              evidence: "src/auth.ts:42 reaches the operation before checking the caller.",
              severity,
              confidence: "high",
              path: "src/auth.ts",
              line: 42,
              disposition: "new"
            }
          ],
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
  });
}
