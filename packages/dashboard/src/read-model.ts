const STATUSES = new Set(["running", "success", "failure"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const SUBJECT_KINDS = new Set(["issue", "pull_request"]);
const MAX_LIMIT = 100;

export interface RunFilters {
  repository?: string;
  subjectKind?: string;
  subjectNumber?: number;
  status?: string;
  command?: string;
  severity?: string;
  from?: string;
  to?: string;
  before?: string;
  limit: number;
}

interface RunListRow {
  id: number;
  shuvbot_run_id: string;
  repository: string;
  subject_kind: string | null;
  subject_number: number | null;
  actor: string;
  command_name: string | null;
  mode: string;
  event: string;
  status: string;
  review_decision: string | null;
  quorum_met: number | null;
  finding_count: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  html_url: string;
  artifact_available: number;
}

interface RunDetailRow extends RunListRow {
  repository_id: number;
  repository_url: string;
  triggering_comment_id: number | null;
  command_args: string | null;
  artifact_schema_version: number;
  failure_class: string | null;
  failure_message: string | null;
}

interface FindingRow {
  workflow_run_id: number;
  finding_id: string;
  severity: string;
  confidence: string;
  title: string;
  body: string;
  path: string;
  line: number | null;
  reviewer: string | null;
  disposition: string | null;
  fingerprint: string | null;
}

interface SessionRow {
  workflow_run_id: number;
  session_id: string;
  role: string;
  reviewer: string | null;
  model: string;
  status: string;
  retry_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
}

interface ArtifactRow {
  workflow_run_id: number;
  artifact_id: number;
  name: string;
  size_bytes: number;
  expires_at: string | null;
}

export interface RunDetail extends RunDetailRow {
  findings: FindingRow[];
  sessions: SessionRow[];
  artifacts: ArtifactRow[];
}

interface RepositoryRow {
  id: number;
  full_name: string;
  html_url: string;
  private: number;
  last_synced_at: string;
  run_count: number;
  latest_run_at: string | null;
}

type D1Value = string | number | null;

export function parseRunFilters(url: URL): RunFilters {
  const subjectKind = optionalEnum(
    url.searchParams.get("subject_kind"),
    SUBJECT_KINDS,
    "subject_kind"
  );
  const status = optionalEnum(url.searchParams.get("status"), STATUSES, "status");
  const severity = optionalEnum(url.searchParams.get("severity"), SEVERITIES, "severity");
  const subjectNumber = optionalPositiveInteger(
    url.searchParams.get("subject_number"),
    "subject_number"
  );
  const limitValue = optionalPositiveInteger(url.searchParams.get("limit"), "limit") ?? 50;
  if (limitValue > MAX_LIMIT) throw new RangeError(`limit must be at most ${MAX_LIMIT}`);
  const from = optionalDate(url.searchParams.get("from"), "from");
  const to = optionalDate(url.searchParams.get("to"), "to");
  const before = optionalDate(url.searchParams.get("before"), "before");
  const filters: RunFilters = { limit: limitValue };
  const repository = optionalString(url.searchParams.get("repository"), "repository");
  const command = optionalString(url.searchParams.get("command"), "command");
  if (repository !== undefined) filters.repository = repository;
  if (command !== undefined) filters.command = command;
  if (subjectKind !== undefined) filters.subjectKind = subjectKind;
  if (subjectNumber !== undefined) filters.subjectNumber = subjectNumber;
  if (status !== undefined) filters.status = status;
  if (severity !== undefined) filters.severity = severity;
  if (from !== undefined) filters.from = from;
  if (to !== undefined) filters.to = to;
  if (before !== undefined) filters.before = before;
  return filters;
}

export async function listRuns(db: D1Database, filters: RunFilters): Promise<RunListRow[]> {
  const clauses: string[] = [];
  const bindings: D1Value[] = [];
  if (filters.repository !== undefined)
    addClause(clauses, bindings, "r.full_name = ?", filters.repository);
  if (filters.subjectKind !== undefined)
    addClause(clauses, bindings, "w.subject_kind = ?", filters.subjectKind);
  if (filters.subjectNumber !== undefined)
    addClause(clauses, bindings, "w.subject_number = ?", filters.subjectNumber);
  if (filters.status !== undefined) addClause(clauses, bindings, "w.status = ?", filters.status);
  if (filters.command !== undefined)
    addClause(clauses, bindings, "w.command_name = ?", filters.command);
  if (filters.from !== undefined) addClause(clauses, bindings, "w.started_at >= ?", filters.from);
  if (filters.to !== undefined) addClause(clauses, bindings, "w.started_at <= ?", filters.to);
  if (filters.before !== undefined)
    addClause(clauses, bindings, "w.started_at < ?", filters.before);
  if (filters.severity !== undefined) {
    addClause(
      clauses,
      bindings,
      "EXISTS (SELECT 1 FROM findings f WHERE f.workflow_run_id = w.id AND f.severity = ?)",
      filters.severity
    );
  }
  bindings.push(filters.limit);
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const result = await db
    .prepare(
      `SELECT w.id, w.shuvbot_run_id, r.full_name AS repository,
              w.subject_kind, w.subject_number, w.actor, w.command_name,
              w.mode, w.event, w.status, w.review_decision, w.quorum_met,
              w.finding_count, w.started_at, w.completed_at, w.duration_ms,
              w.html_url, w.artifact_available
       FROM workflow_runs w
       JOIN repositories r ON r.id = w.repository_id
       ${where}
       ORDER BY w.started_at DESC, w.id DESC
       LIMIT ?`
    )
    .bind(...bindings)
    .all<RunListRow>();
  return result.results;
}

export async function getRun(db: D1Database, id: number): Promise<RunDetail | null> {
  const run = await db
    .prepare(
      `SELECT w.id, w.shuvbot_run_id, w.repository_id, w.subject_kind,
              w.subject_number, w.triggering_comment_id, w.actor, w.command_name,
              w.command_args, w.mode, w.event, w.status, w.review_decision,
              w.quorum_met, w.finding_count, w.started_at, w.completed_at,
              w.duration_ms, w.html_url, w.artifact_schema_version,
              w.artifact_available, w.failure_class, w.failure_message,
              r.full_name AS repository, r.html_url AS repository_url
       FROM workflow_runs w
       JOIN repositories r ON r.id = w.repository_id
       WHERE w.id = ?`
    )
    .bind(id)
    .first<RunDetailRow>();
  if (run === null) return null;
  const [findings, sessions, artifacts] = await Promise.all([
    db
      .prepare("SELECT * FROM findings WHERE workflow_run_id = ? ORDER BY finding_id")
      .bind(id)
      .all<FindingRow>(),
    db
      .prepare("SELECT * FROM session_summaries WHERE workflow_run_id = ? ORDER BY session_id")
      .bind(id)
      .all<SessionRow>(),
    db
      .prepare("SELECT * FROM artifact_references WHERE workflow_run_id = ? ORDER BY artifact_id")
      .bind(id)
      .all<ArtifactRow>()
  ]);
  return {
    ...run,
    findings: findings?.results ?? [],
    sessions: sessions?.results ?? [],
    artifacts: artifacts?.results ?? []
  };
}

export async function listRepositories(db: D1Database): Promise<RepositoryRow[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.full_name, r.html_url, r.private, r.last_synced_at,
              COUNT(w.id) AS run_count, MAX(w.started_at) AS latest_run_at
       FROM repositories r
       LEFT JOIN workflow_runs w ON w.repository_id = r.id
       GROUP BY r.id
       ORDER BY r.full_name`
    )
    .all<RepositoryRow>();
  return result.results;
}

function addClause(clauses: string[], bindings: D1Value[], clause: string, value: D1Value): void {
  clauses.push(clause);
  bindings.push(value);
}

function optionalString(value: string | null, key: "repository" | "command"): string | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > 512) throw new RangeError(`${key} is too long`);
  return value;
}

function optionalEnum(
  value: string | null,
  allowed: ReadonlySet<string>,
  key: string
): string | undefined {
  if (value === null || value === "") return undefined;
  if (!allowed.has(value)) throw new TypeError(`${key} is invalid`);
  return value;
}

function optionalPositiveInteger(value: string | null, key: string): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new TypeError(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`${key} must be a positive integer`);
  return parsed;
}

function optionalDate(value: string | null, key: string): string | undefined {
  if (value === null || value === "") return undefined;
  const inclusiveValue =
    key === "to" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const parsed = new Date(inclusiveValue);
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${key} must be an ISO date`);
  return parsed.toISOString();
}
