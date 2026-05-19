import type { ReviewbotConfig } from "./config.ts";
import type { PullRequestEvent } from "./events.ts";
import type { RuntimePolicy } from "./policy.ts";
import { assembleReviewContext, loadRepoInstructions } from "./context/assembler.ts";
import { mapDiffPositions, parseUnifiedDiff } from "../../github/src/diff.ts";
import { parseFindings, type ReviewFinding } from "./review-schema.ts";
import { runReviewPipeline, type ReviewPipelineResult } from "./review-pipeline.ts";
import { builtInReviewSkills } from "./skills/index.ts";

export interface ReviewAgent {
  run(input: { prompt: string; skillPrompt: string }): Promise<unknown>;
}

export interface RunReviewInput {
  cwd: string;
  repo: string;
  event: PullRequestEvent;
  diff: string;
  files: unknown[];
  config: Pick<ReviewbotConfig, "minConfidence" | "reportOn">;
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
  const skill = builtInReviewSkills[0];
  const rawFindings = await input.agent.run({ prompt: context.prompt, skillPrompt: skill.prompt });
  const parsed = parseFindings(rawFindings);
  const hunks = parseUnifiedDiff(input.diff);
  const pipeline = runReviewPipeline({
    candidates: parsed.findings,
    diffPositions: mapDiffPositions(hunks),
    config: {
      minConfidence: input.config.minConfidence,
      reportOn: severitiesAtOrAbove(input.config.reportOn),
      maxFindings: 25,
      maxInlineFindings: 10
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
    }
  };
}

function severitiesAtOrAbove(minimum: ReviewFinding["severity"]): ReviewFinding["severity"][] {
  const index = SEVERITY_ORDER.indexOf(minimum);
  return SEVERITY_ORDER.slice(0, index + 1);
}
