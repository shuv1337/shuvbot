import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../../core/src/run-record.ts";
import type { ReviewFinding } from "../../core/src/review-schema.ts";
import type { ContextManifest } from "../../core/src/context/manifest.ts";

export interface ReviewArtifactsInput {
  runnerTemp?: string;
  runRecord: RunRecord;
  findings: ReviewFinding[];
  contextManifest: ContextManifest;
}

export interface ReviewArtifacts {
  dir: string;
  runPath: string;
  findingsPath: string;
  contextManifestPath: string;
}

export async function writeReviewArtifacts(input: ReviewArtifactsInput): Promise<ReviewArtifacts> {
  const dir = join(input.runnerTemp ?? process.env.RUNNER_TEMP ?? process.cwd(), "reviewbot");
  await mkdir(dir, { recursive: true });
  const runPath = join(dir, "reviewbot-run.json");
  const findingsPath = join(dir, "reviewbot-findings.json");
  const contextManifestPath = join(dir, "reviewbot-context-manifest.json");
  await writeJson(runPath, { ...input.runRecord, contextManifestPath });
  await writeJson(findingsPath, input.findings);
  await writeJson(contextManifestPath, input.contextManifest);
  return { dir, runPath, findingsPath, contextManifestPath };
}

/**
 * Persist agent/review failure diagnostics so an opaque "Claude exited with 1"
 * leaves an inspectable trace in the uploaded `$RUNNER_TEMP/reviewbot` artifacts
 * (the review pipeline throws before the normal artifacts are written). The
 * caller is responsible for redacting `message` before it reaches here.
 */
export async function writeFailureDiagnostics(input: {
  runnerTemp?: string;
  message: string;
}): Promise<string> {
  const dir = join(input.runnerTemp ?? process.env.RUNNER_TEMP ?? process.cwd(), "reviewbot");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "reviewbot-agent-error.txt");
  await writeFile(path, `${input.message.trimEnd()}\n`);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
