import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Redactor } from "../../core/src/redaction.ts";
import type { ReviewerId } from "./types.ts";

export type FindingLifecycleStatus = "new" | "unresolved" | "fixed" | "user_resolved" | "dismissed";

export interface PersistedFindingState {
  fingerprint: string;
  reviewer: ReviewerId;
  title: string;
  path: string;
  line?: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
  evidence: string;
  status: FindingLifecycleStatus;
  priorCommentId?: string;
  userReplies: string[];
}

export interface PersistedReviewState {
  version: 1;
  changeId: string;
  baseSha: string;
  headSha: string;
  updatedAt: string;
  degraded: boolean;
  findings: PersistedFindingState[];
}

export interface ReviewStateStore {
  readReviewState(
    changeId: string,
    options?: ReviewStateOperationOptions
  ): Promise<PersistedReviewState | null>;
  writeReviewState(
    changeId: string,
    state: PersistedReviewState,
    options?: ReviewStateOperationOptions
  ): Promise<void>;
}

export interface ReviewStateOperationOptions {
  readonly deadlineAtMs?: number;
}

export interface ReviewStateFileSystem {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

const defaultFileSystem: ReviewStateFileSystem = { mkdir, readFile, rename, rm, writeFile };

export class FileReviewStateStore implements ReviewStateStore {
  private readonly root: string;

  constructor(
    cwd: string,
    private readonly redactor: Redactor,
    private readonly fileSystem: ReviewStateFileSystem = defaultFileSystem
  ) {
    this.root = resolve(cwd, ".shuvbot", "state", "reviews");
  }

  async readReviewState(
    changeId: string,
    options: ReviewStateOperationOptions = {}
  ): Promise<PersistedReviewState | null> {
    validateChangeId(changeId);
    try {
      const parsed: unknown = JSON.parse(
        await withinDeadline(
          this.fileSystem.readFile(this.path(changeId), "utf8"),
          options.deadlineAtMs,
          "review state read"
        )
      );
      return parsePersistedReviewState(parsed, changeId);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async writeReviewState(
    changeId: string,
    state: PersistedReviewState,
    options: ReviewStateOperationOptions = {}
  ): Promise<void> {
    validateChangeId(changeId);
    const validated = parsePersistedReviewState(state, changeId);
    const path = this.path(changeId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let writeOperation: ReturnType<ReviewStateFileSystem["writeFile"]> | undefined;
    try {
      await withinDeadline(
        this.fileSystem.mkdir(dirname(path), { recursive: true, mode: 0o700 }),
        options.deadlineAtMs,
        "review state directory creation"
      );
      writeOperation = this.fileSystem.writeFile(
        temporary,
        `${JSON.stringify(this.redactor.redact(validated), null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      await withinDeadline(writeOperation, options.deadlineAtMs, "review state write");
      await withinDeadline(
        this.fileSystem.rename(temporary, path),
        options.deadlineAtMs,
        "review state rename"
      );
    } finally {
      if (writeOperation !== undefined) {
        void writeOperation
          .finally(() => this.fileSystem.rm(temporary, { force: true }))
          .catch(() => undefined);
      }
      await settleCleanup(this.fileSystem.rm(temporary, { force: true }));
    }
  }

  private path(changeId: string): string {
    const name = `${createHash("sha256").update(changeId, "utf8").digest("hex")}.json`;
    const path = join(this.root, name);
    if (relative(this.root, path).startsWith(".."))
      throw new Error("review state path escaped its root");
    return path;
  }
}

export function parsePersistedReviewState(
  value: unknown,
  expectedChangeId?: string
): PersistedReviewState {
  const record = requireRecord(value, "review state");
  requireOnlyKeys(
    record,
    ["version", "changeId", "baseSha", "headSha", "updatedAt", "degraded", "findings"],
    "review state"
  );
  if (record.version !== 1) throw new TypeError("review state.version must be 1");
  const changeId = requireString(record.changeId, "review state.changeId");
  if (expectedChangeId !== undefined && changeId !== expectedChangeId) {
    throw new TypeError("review state.changeId does not match the requested change");
  }
  if (!Array.isArray(record.findings))
    throw new TypeError("review state.findings must be an array");
  return {
    version: 1,
    changeId,
    baseSha: requireString(record.baseSha, "review state.baseSha"),
    headSha: requireString(record.headSha, "review state.headSha"),
    updatedAt: requireString(record.updatedAt, "review state.updatedAt"),
    degraded: requireBoolean(record.degraded, "review state.degraded"),
    findings: record.findings.map((finding, index) => parseFinding(finding, index))
  };
}

function parseFinding(value: unknown, index: number): PersistedFindingState {
  const field = `review state.findings[${index}]`;
  const record = requireRecord(value, field);
  requireOnlyKeys(
    record,
    [
      "fingerprint",
      "reviewer",
      "title",
      "path",
      "line",
      "severity",
      "evidence",
      "status",
      "priorCommentId",
      "userReplies"
    ],
    field
  );
  const reviewer = requireString(record.reviewer, `${field}.reviewer`);
  if (!isReviewerId(reviewer)) throw new TypeError(`${field}.reviewer is invalid`);
  const severity = requireString(record.severity, `${field}.severity`);
  if (!isSeverity(severity)) throw new TypeError(`${field}.severity is invalid`);
  const status = requireString(record.status, `${field}.status`);
  if (!isLifecycleStatus(status)) throw new TypeError(`${field}.status is invalid`);
  if (
    !Array.isArray(record.userReplies) ||
    record.userReplies.some((reply) => typeof reply !== "string")
  ) {
    throw new TypeError(`${field}.userReplies must be an array of strings`);
  }
  const finding: PersistedFindingState = {
    fingerprint: requireString(record.fingerprint, `${field}.fingerprint`),
    reviewer,
    title: requireString(record.title, `${field}.title`),
    path: requireString(record.path, `${field}.path`),
    severity,
    evidence: requireString(record.evidence, `${field}.evidence`),
    status,
    userReplies: [...record.userReplies]
  };
  if (record.line !== undefined) {
    if (!Number.isInteger(record.line) || (record.line as number) < 1)
      throw new TypeError(`${field}.line is invalid`);
    finding.line = record.line as number;
  }
  if (record.priorCommentId !== undefined) {
    finding.priorCommentId = requireString(record.priorCommentId, `${field}.priorCommentId`);
  }
  return finding;
}

function validateChangeId(changeId: string): void {
  if (changeId.trim().length === 0 || changeId.length > 1024 || changeId.includes("\0")) {
    throw new TypeError("changeId must be a non-empty bounded string");
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new TypeError(`${field}.${unknown} is not allowed`);
}

function isReviewerId(value: string): value is ReviewerId {
  return ["code-quality", "security", "performance", "tests", "documentation", "release"].includes(
    value
  );
}

function isSeverity(value: string): value is PersistedFindingState["severity"] {
  return ["critical", "high", "medium", "low", "info"].includes(value);
}

function isLifecycleStatus(value: string): value is FindingLifecycleStatus {
  return ["new", "unresolved", "fixed", "user_resolved", "dismissed"].includes(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadlineAtMs: number | undefined,
  stage: string
): Promise<T> {
  if (deadlineAtMs === undefined) return operation;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new Error(`${stage} exceeded the overall deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${stage} exceeded the overall deadline`)),
          remaining
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleCleanup(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
