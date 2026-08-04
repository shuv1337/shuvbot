import { describe, expect, test } from "bun:test";
import {
  finalizeCoordinator,
  prepareCoordinator,
  type PrepareCoordinatorInput
} from "../src/coordinator.ts";

const workspace = "/tmp/reviewbot-review-coordinator";
const securityFinding = {
  id: "security-1",
  reviewer: "security",
  skill: "security",
  title: "Authorization bypass",
  body: "The changed route does not authorize its caller.",
  evidence: "src/route.ts:12 calls update before authorize.",
  severity: "high",
  confidence: "high",
  path: "src/route.ts",
  line: 12
} as const;

describe("coordinator preparation and finalization", () => {
  test("validates and finalizes supported synthesis with deterministic coverage", async () => {
    const prepared = prepareCoordinator(
      coordinatorInput([completed("code-quality"), completed("security", [securityFinding])])
    );
    const finalized = await finalizeCoordinator({
      prepared,
      output: coordinatorOutput({
        decision: "significant_concerns",
        findings: [coordinated(securityFinding)]
      })
    });

    expect(finalized.result.decision).toBe("significant_concerns");
    expect(finalized.coverage).toEqual({
      scheduled: ["code-quality", "security"],
      completed: ["code-quality", "security"],
      failed: [],
      timedOut: [],
      required: ["code-quality"],
      quorumMet: true
    });
    expect(finalized.sessions.map(({ reviewer, status }) => ({ reviewer, status }))).toEqual([
      { reviewer: "code-quality", status: "completed" },
      { reviewer: "security", status: "completed" }
    ]);
  });

  test("allows exactly one caller-supplied repair after schema failure", async () => {
    const prepared = prepareCoordinator(coordinatorInput([completed("code-quality")]));
    let repairs = 0;
    const finalized = await finalizeCoordinator({
      prepared,
      output: { invalid: true },
      repair: () => {
        repairs += 1;
        return coordinatorOutput({ decision: "clean" });
      }
    });

    expect(repairs).toBe(1);
    expect(finalized.repairAttempted).toBe(true);
    expect(finalized.result.decision).toBe("clean");
  });

  test("rejects a failed repair without attempting another", async () => {
    const prepared = prepareCoordinator(coordinatorInput([completed("code-quality")]));
    let repairs = 0;
    await expect(
      finalizeCoordinator({
        prepared,
        output: null,
        repair: () => {
          repairs += 1;
          return { still: "invalid" };
        }
      })
    ).rejects.toThrow();
    expect(repairs).toBe(1);
  });

  test.each(["clean", "significant_concerns"] as const)(
    "forces below-quorum %s output to degraded and non-blocking",
    async (decision) => {
      const prepared = prepareCoordinator(
        coordinatorInput([completed("code-quality"), failed("security")], "full")
      );
      const finalized = await finalizeCoordinator({
        prepared,
        output: coordinatorOutput({ decision })
      });

      expect(finalized.result.decision).toBe("degraded");
      expect(finalized.quorum.canClaimClean).toBe(false);
      expect(finalized.quorum.canBlock).toBe(false);
      expect(finalized.coverage.quorumMet).toBe(false);
    }
  );

  test("rejects specialist envelope reviewer mismatches", () => {
    const input = coordinatorInput([completed("security", [securityFinding])]);
    input.specialistResults[0] = {
      ...input.specialistResults[0]!,
      reviewer: "code-quality"
    };

    expect(() => prepareCoordinator({ ...input, scheduledReviewers: ["code-quality"] })).toThrow(
      "reviewer mismatch"
    );
  });

  test("prompt references validated files without embedding diffs or specialist findings", () => {
    const prepared = prepareCoordinator(
      coordinatorInput([completed("code-quality"), completed("security", [securityFinding])])
    );

    expect(prepared.prompt).toContain(`${workspace}/manifest.json`);
    expect(prepared.prompt).toContain(`${workspace}/results/security.json`);
    expect(prepared.prompt).not.toContain(securityFinding.body);
    expect(prepared.prompt).not.toContain("diff --git");
  });

  test("rejects unsupported coordinator findings and accepts explicit sourced synthesis", async () => {
    const prepared = prepareCoordinator(
      coordinatorInput([completed("code-quality"), completed("security", [securityFinding])])
    );
    const unsupported = {
      ...coordinated(securityFinding),
      id: "coordinator-new",
      fingerprint: "coordinator-new"
    };
    await expect(
      finalizeCoordinator({
        prepared,
        output: coordinatorOutput({ decision: "comments", findings: [unsupported] })
      })
    ).rejects.toThrow("unsupported");

    const finalized = await finalizeCoordinator({
      prepared,
      output: coordinatorOutput({
        decision: "comments",
        findings: [
          {
            ...unsupported,
            tags: ["synthesized"],
            evidence: "Consolidated evidence from source:security:security-1."
          }
        ]
      })
    });
    expect(finalized.result.findings[0]?.id).toBe("coordinator-new");
  });

  test("repairs provenance-invalid coordinator output exactly once", async () => {
    const prepared = prepareCoordinator(
      coordinatorInput([completed("code-quality"), completed("security", [securityFinding])])
    );
    let repairs = 0;
    const unsupported = {
      ...coordinated(securityFinding),
      id: "invented",
      fingerprint: "invented"
    };

    const finalized = await finalizeCoordinator({
      prepared,
      output: coordinatorOutput({ decision: "comments", findings: [unsupported] }),
      repair: ({ validationError }) => {
        repairs += 1;
        expect(String(validationError)).toContain("unsupported");
        return coordinatorOutput({
          decision: "comments",
          findings: [coordinated(securityFinding)]
        });
      }
    });

    expect(repairs).toBe(1);
    expect(finalized.repairAttempted).toBe(true);
    expect(finalized.result.findings[0]?.id).toBe("security-1");
  });
});

function coordinatorInput(
  results: ReturnType<typeof completed | typeof failed>[],
  tier: "trivial" | "lite" | "full" = "trivial"
): PrepareCoordinatorInput & {
  specialistResults: Array<PrepareCoordinatorInput["specialistResults"][number]>;
} {
  const scheduledReviewers = results.map((result) => result.reviewer);
  return {
    tier,
    workspaceRoot: workspace,
    manifestPath: `${workspace}/manifest.json`,
    sharedContextPath: `${workspace}/shared-review-context.txt`,
    previousFindingsPath: `${workspace}/previous-findings.json`,
    scheduledReviewers,
    specialistResults: results.map((result) => ({
      reviewer: result.reviewer,
      resultPath: `${workspace}/results/${result.reviewer}.json`,
      result
    }))
  };
}

function completed(reviewer: "code-quality" | "security", findings: readonly unknown[] = []) {
  return { reviewer, status: "completed", summary: "Completed.", findings } as const;
}

function failed(reviewer: "security") {
  return {
    reviewer,
    status: "failed",
    summary: "Provider failed.",
    findings: [],
    error: {
      code: "REVIEW_PROVIDER_FAILURE",
      category: "provider",
      message: "Provider failed.",
      retryable: true
    }
  } as const;
}

function coordinated(finding: typeof securityFinding) {
  return { ...finding, fingerprint: finding.id, disposition: "new" } as const;
}

function coordinatorOutput({
  decision,
  findings = []
}: {
  decision: "clean" | "comments" | "significant_concerns";
  findings?: readonly unknown[];
}) {
  return {
    decision,
    findings,
    dropped: [],
    coverage: {
      scheduled: ["code-quality"],
      completed: ["code-quality"],
      failed: [],
      timedOut: [],
      required: ["code-quality"],
      quorumMet: true
    },
    summary: "Coordinator summary."
  };
}
