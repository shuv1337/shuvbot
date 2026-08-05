import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunRecord } from "../../core/src/run-record.ts";
import type { ReviewFinding } from "../../core/src/review-schema.ts";
import type { ContextManifest } from "../../core/src/context/manifest.ts";
import type { ReviewSessionLogEvent } from "../../review/src/session-log.ts";
import { DefaultRedactor, type Redactor } from "../../core/src/redaction.ts";

export const ACTION_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const ACTION_ARTIFACT_MAX_EVENTS = 10_000;
export const ACTION_ARTIFACT_MAX_FIELD_BYTES = 256 * 1024;
const MAX_STRUCTURED_ITEMS = 10_000;

export interface ReviewArtifactsInput {
  runnerTemp?: string;
  runRecord: RunRecord;
  findings: ReviewFinding[];
  contextManifest: ContextManifest;
  sessionLog?: readonly ReviewSessionLogEvent[];
  redactor?: Redactor;
}

export interface ReviewArtifacts {
  dir: string;
  runPath: string;
  findingsPath: string;
  contextManifestPath: string;
  reviewSessionsPath?: string;
  eventsPath?: string;
}

interface PendingArtifact {
  path: string;
  contents: string;
  temporary?: string;
}

export async function writeReviewArtifacts(input: ReviewArtifactsInput): Promise<ReviewArtifacts> {
  const redactor = input.redactor ?? new DefaultRedactor();
  const dir = join(input.runnerTemp ?? process.env.RUNNER_TEMP ?? process.cwd(), "shuvbot");
  const runPath = join(dir, "shuvbot-run.json");
  const findingsPath = join(dir, "shuvbot-findings.json");
  const contextManifestPath = join(dir, "shuvbot-context-manifest.json");
  const reviewSessionsPath =
    input.runRecord.review === undefined ? undefined : join(dir, "shuvbot-review-sessions.json");
  const eventsPath = input.sessionLog === undefined ? undefined : join(dir, "shuvbot-events.jsonl");

  assertCount("findings", input.findings.length, MAX_STRUCTURED_ITEMS);
  assertCount(
    "context manifest sections",
    input.contextManifest.sections.length,
    MAX_STRUCTURED_ITEMS
  );
  assertCount(
    "review sessions",
    input.runRecord.review?.sessions.length ?? 0,
    MAX_STRUCTURED_ITEMS
  );
  assertCount("session events", input.sessionLog?.length ?? 0, ACTION_ARTIFACT_MAX_EVENTS);

  const pending: PendingArtifact[] = [];
  try {
    pending.push(
      prepareJson(runPath, { ...input.runRecord, contextManifestPath }, redactor),
      prepareJson(findingsPath, input.findings, redactor),
      prepareJson(contextManifestPath, input.contextManifest, redactor)
    );
    if (reviewSessionsPath !== undefined && input.runRecord.review !== undefined) {
      pending.push(prepareJson(reviewSessionsPath, input.runRecord.review.sessions, redactor));
    }
    if (eventsPath !== undefined && input.sessionLog !== undefined) {
      pending.push(prepareJsonLines(eventsPath, input.sessionLog, redactor));
    }
  } catch (error) {
    throw sanitizedError("Unable to prepare review artifacts", error, redactor);
  }

  await commitArtifacts(dir, pending, redactor);

  return {
    dir,
    runPath,
    findingsPath,
    contextManifestPath,
    ...(reviewSessionsPath === undefined ? {} : { reviewSessionsPath }),
    ...(eventsPath === undefined ? {} : { eventsPath })
  };
}

export interface CoordinatorArtifactsInput {
  /** Directory to write into; already the run's artifact directory. */
  runnerTemp: string;
  runRecord: RunRecord;
  /** Coordinator report JSON, the coordinator equivalent of findings. */
  report: unknown;
  sessionLog?: readonly ReviewSessionLogEvent[];
  redactor?: Redactor;
}

export interface CoordinatorArtifacts {
  dir: string;
  runPath: string;
  findingsPath: string;
  reviewSessionsPath?: string;
  eventsPath?: string;
}

/**
 * Persists coordinator review artifacts.
 *
 * Separate from `writeReviewArtifacts` because a coordinator run has no
 * legacy-pipeline findings array and no context manifest: its reviewers read a
 * workspace rather than an assembled prompt context, and its findings carry
 * coverage and lifecycle that the legacy shape cannot express.
 */
export async function writeCoordinatorArtifacts(
  input: CoordinatorArtifactsInput
): Promise<CoordinatorArtifacts> {
  const redactor = input.redactor ?? new DefaultRedactor();
  const dir = input.runnerTemp;
  const runPath = join(dir, "shuvbot-run.json");
  const findingsPath = join(dir, "shuvbot-findings.json");
  const reviewSessionsPath =
    input.runRecord.review === undefined ? undefined : join(dir, "shuvbot-review-sessions.json");
  const eventsPath = input.sessionLog === undefined ? undefined : join(dir, "shuvbot-events.jsonl");

  assertCount(
    "review sessions",
    input.runRecord.review?.sessions.length ?? 0,
    MAX_STRUCTURED_ITEMS
  );
  assertCount("session events", input.sessionLog?.length ?? 0, ACTION_ARTIFACT_MAX_EVENTS);

  const pending: PendingArtifact[] = [];
  try {
    pending.push(
      prepareJson(runPath, input.runRecord, redactor),
      prepareJson(findingsPath, input.report ?? { findings: [] }, redactor)
    );
    if (reviewSessionsPath !== undefined && input.runRecord.review !== undefined) {
      pending.push(prepareJson(reviewSessionsPath, input.runRecord.review.sessions, redactor));
    }
    if (eventsPath !== undefined && input.sessionLog !== undefined) {
      pending.push(prepareJsonLines(eventsPath, input.sessionLog, redactor));
    }
  } catch (error) {
    throw sanitizedError("Unable to prepare review artifacts", error, redactor);
  }

  await commitArtifacts(dir, pending, redactor);

  return {
    dir,
    runPath,
    findingsPath,
    ...(reviewSessionsPath === undefined ? {} : { reviewSessionsPath }),
    ...(eventsPath === undefined ? {} : { eventsPath })
  };
}

/**
 * Persist agent/review failure diagnostics so an opaque "Claude exited with 1"
 * leaves an inspectable trace in the uploaded `$RUNNER_TEMP/shuvbot` artifacts
 * (the review pipeline throws before the normal artifacts are written). The
 * caller is responsible for redacting `message` before it reaches here.
 */
export async function writeFailureDiagnostics(input: {
  runnerTemp?: string;
  message: string;
}): Promise<string> {
  const dir = join(input.runnerTemp ?? process.env.RUNNER_TEMP ?? process.cwd(), "shuvbot");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "shuvbot-agent-error.txt");
  await writeFile(path, `${input.message.trimEnd()}\n`);
  return path;
}

async function commitArtifacts(
  dir: string,
  pending: PendingArtifact[],
  redactor: Redactor
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const artifact of pending) {
      artifact.temporary = `${artifact.path}.${randomUUID()}.tmp`;
      await writeFile(artifact.temporary, artifact.contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
    }

    // Renames are deterministic but not transactional as a group. On failure, any committed prefix
    // contains complete files; later finals remain untouched and all uncommitted temps are removed.
    for (const artifact of pending) {
      await rename(artifact.temporary!, artifact.path);
      delete artifact.temporary;
    }
  } catch (error) {
    throw sanitizedError("Unable to commit review artifacts", error, redactor);
  } finally {
    await Promise.all(
      pending.map(async ({ temporary }) => {
        if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
      })
    );
  }
}

function prepareJson(path: string, value: unknown, redactor: Redactor): PendingArtifact {
  preflightValue(path, value);
  const contents = `${JSON.stringify(redactor.redact(value), null, 2)}\n`;
  assertArtifactBytes(path, Buffer.byteLength(contents, "utf8"));
  return { path, contents };
}

function prepareJsonLines(
  path: string,
  values: readonly unknown[],
  redactor: Redactor
): PendingArtifact {
  preflightValue(path, values);
  const lines: string[] = [];
  let bytes = 0;
  for (const value of redactor.redact(values)) {
    const line = `${JSON.stringify(value)}\n`;
    bytes += Buffer.byteLength(line, "utf8");
    assertArtifactBytes(path, bytes);
    lines.push(line);
  }
  return { path, contents: lines.join("") };
}

function preflightValue(path: string, value: unknown): void {
  const seen = new Set<object>();
  let scalarBytes = 0;
  let items = 0;

  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      const fieldBytes = Buffer.byteLength(current, "utf8");
      if (fieldBytes > ACTION_ARTIFACT_MAX_FIELD_BYTES) {
        throw new RangeError(
          `Artifact ${basename(path)} contains a field exceeding the ${ACTION_ARTIFACT_MAX_FIELD_BYTES}-byte limit; reduce model-derived text and retry.`
        );
      }
      scalarBytes += fieldBytes;
    } else if (typeof current === "object" && current !== null) {
      if (seen.has(current)) throw new TypeError("structured artifact data must not be circular");
      seen.add(current);
      for (const [key, nested] of Object.entries(current)) {
        items += 1;
        scalarBytes += Buffer.byteLength(key, "utf8");
        if (items > MAX_STRUCTURED_ITEMS * 100) {
          throw new RangeError("structured artifact data has too many fields");
        }
        visit(nested);
      }
      seen.delete(current);
    }
    if (scalarBytes > ACTION_ARTIFACT_MAX_BYTES) {
      throw artifactLimitError(path);
    }
  };

  visit(value);
}

function assertCount(label: string, count: number, limit: number): void {
  if (count > limit) throw new RangeError(`${label} exceed the ${limit}-item artifact limit`);
}

function assertArtifactBytes(path: string, bytes: number): void {
  if (bytes > ACTION_ARTIFACT_MAX_BYTES) throw artifactLimitError(path);
}

function artifactLimitError(path: string): RangeError {
  return new RangeError(
    `Artifact ${basename(path)} exceeds the ${ACTION_ARTIFACT_MAX_BYTES}-byte limit; reduce its structured data and retry.`
  );
}

function sanitizedError(prefix: string, error: unknown, redactor: Redactor): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix}: ${redactor.redactString(message)}`);
}
