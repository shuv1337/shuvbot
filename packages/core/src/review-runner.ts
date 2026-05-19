import type { ReviewbotConfig } from "./config.ts";
import type { PullRequestEvent } from "./events.ts";
import type { RuntimePolicy } from "./policy.ts";
import { assembleReviewContext, loadRepoInstructions } from "./context/assembler.ts";
import { mapDiffPositions, parseUnifiedDiff } from "../../github/src/diff.ts";
import { parseFindings, type ReviewFinding } from "./review-schema.ts";
import { runReviewPipeline, type ReviewPipelineResult } from "./review-pipeline.ts";
import { runnableReviewSkills } from "./skills/index.ts";

export interface ReviewAgent {
  run(input: { prompt: string; skillPrompt: string }): Promise<unknown>;
  verify?(input: { prompt: string; findings: ReviewFinding[] }): Promise<readonly string[]>;
}

export interface RunReviewInput {
  cwd: string;
  repo: string;
  event: PullRequestEvent;
  diff: string;
  files: unknown[];
  config: Pick<ReviewbotConfig, "failCheck" | "paths" | "failOn" | "minConfidence" | "reportOn" | "requestChanges">;
  policy: RuntimePolicy;
  agent: ReviewAgent;
}

export interface RunReviewResult {
  context: ReturnType<typeof assembleReviewContext>;
  parseErrors: string[];
  pipeline: ReviewPipelineResult;
  findings: ReviewFinding[];
}

const SEVERITY_ORDER: ReviewFinding["severity"][] = ["critical", "high", "medium", "low", "info"];

export async function runReview(input: RunReviewInput): Promise<RunReviewResult> {
  const repoInstructions = await loadRepoInstructions(input.cwd);
  const context = assembleReviewContext({
    event: input.event.raw,
    repo: input.repo,
    diff: input.diff,
    files: input.files,
    repoInstructions
  });
  const skills = runnableReviewSkills({ event: input.event, files: input.files as Array<{ filename?: string }>, config: input.config });
  const rawFindings = await Promise.all(
    skills.map((skill) => input.agent.run({ prompt: context.prompt, skillPrompt: skill.prompt }))
  );
  const parsed = parseFindings(rawFindings.flat());
  const verifiedFindingIds = await verifyFindings(input.agent, context.prompt, parsed.findings);
  const hunks = parseUnifiedDiff(input.diff);
  const pipeline = runReviewPipeline({
    candidates: parsed.findings,
    diffPositions: mapDiffPositions(hunks),
    verifiedFindingIds,
    config: {
      minConfidence: input.config.minConfidence,
      reportOn: severitiesAtOrAbove(input.config.reportOn),
      failOn: input.config.failOn,
      maxFindings: 25,
      maxInlineFindings: 10,
      requestChanges: input.policy.canReview && input.config.requestChanges,
      failCheck: input.config.failCheck
    }
  });
  return {
    context,
    parseErrors: parsed.errors,
    pipeline,
    findings: pipeline.findings
  };
}

export function createFakeReviewAgent(findings: unknown[]): ReviewAgent {
  return {
    async run() {
      return findings;
    },
    async verify(_input) {
      return findings
        .filter((finding): finding is { id: string } =>
          typeof finding === "object" && finding !== null && "id" in finding && typeof finding.id === "string"
        )
        .map((finding) => finding.id);
    }
  };
}

async function verifyFindings(
  agent: ReviewAgent,
  prompt: string,
  findings: ReviewFinding[]
): Promise<ReadonlySet<string>> {
  const ids = agent.verify
    ? await agent.verify({ prompt, findings })
    : findings.map((finding) => finding.id);
  return new Set(ids);
}

function severitiesAtOrAbove(minimum: ReviewFinding["severity"]): ReviewFinding["severity"][] {
  const index = SEVERITY_ORDER.indexOf(minimum);
  return SEVERITY_ORDER.slice(0, index + 1);
}
