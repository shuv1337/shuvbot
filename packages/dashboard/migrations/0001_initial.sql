PRAGMA foreign_keys = ON;

CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  html_url TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  last_synced_at TEXT NOT NULL
);

CREATE TABLE subjects (
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
  number INTEGER NOT NULL CHECK (number > 0),
  title TEXT,
  html_url TEXT,
  state TEXT,
  PRIMARY KEY (repository_id, kind, number)
);

CREATE TABLE workflow_runs (
  id INTEGER PRIMARY KEY,
  shuvbot_run_id TEXT NOT NULL UNIQUE,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  subject_kind TEXT,
  subject_number INTEGER,
  triggering_comment_id INTEGER,
  actor TEXT NOT NULL,
  command_name TEXT,
  command_args TEXT,
  mode TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure')),
  review_decision TEXT,
  quorum_met INTEGER CHECK (quorum_met IN (0, 1)),
  finding_count INTEGER NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  html_url TEXT NOT NULL,
  artifact_schema_version INTEGER NOT NULL,
  artifact_available INTEGER NOT NULL CHECK (artifact_available IN (0, 1)),
  failure_class TEXT,
  failure_message TEXT,
  FOREIGN KEY (repository_id, subject_kind, subject_number)
    REFERENCES subjects(repository_id, kind, number)
);

CREATE TABLE findings (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  reviewer TEXT,
  disposition TEXT,
  fingerprint TEXT,
  PRIMARY KEY (workflow_run_id, finding_id)
);

CREATE TABLE session_summaries (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coordinator', 'specialist')),
  reviewer TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (workflow_run_id, session_id)
);

CREATE TABLE artifact_references (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  expires_at TEXT,
  PRIMARY KEY (workflow_run_id, artifact_id)
);

CREATE INDEX workflow_runs_repository_started
  ON workflow_runs(repository_id, started_at DESC, id DESC);
CREATE INDEX workflow_runs_subject
  ON workflow_runs(repository_id, subject_kind, subject_number, started_at DESC);
CREATE INDEX workflow_runs_status_started
  ON workflow_runs(status, started_at DESC);
CREATE INDEX findings_severity_run ON findings(severity, workflow_run_id);
CREATE INDEX session_summaries_run ON session_summaries(workflow_run_id);
