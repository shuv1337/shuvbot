import type { DashboardArtifact } from "./artifact-schema.ts";

export async function ingestDashboardArtifact(
  db: D1Database,
  artifact: DashboardArtifact
): Promise<void> {
  const { workflow, run } = artifact;
  const subject = run.subject;
  const durationMs =
    run.completedAt === undefined
      ? null
      : Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt));
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO repositories (id, full_name, html_url, private, last_synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           full_name = excluded.full_name,
           html_url = excluded.html_url,
           private = excluded.private,
           last_synced_at = excluded.last_synced_at`
      )
      .bind(
        workflow.repository.id,
        workflow.repository.fullName,
        workflow.repository.htmlUrl,
        workflow.repository.private ? 1 : 0,
        new Date().toISOString()
      )
  ];

  if (subject !== undefined) {
    statements.push(
      db
        .prepare(
          `INSERT INTO subjects (repository_id, kind, number)
           VALUES (?, ?, ?)
           ON CONFLICT(repository_id, kind, number) DO NOTHING`
        )
        .bind(workflow.repository.id, subject.kind, subject.number)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO workflow_runs (
           id, shuvbot_run_id, repository_id, subject_kind, subject_number,
           triggering_comment_id, actor, command_name, command_args, mode, event,
           status, review_decision, quorum_met, finding_count, started_at,
           completed_at, duration_ms, html_url, artifact_schema_version,
           artifact_available, failure_class, failure_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           shuvbot_run_id = excluded.shuvbot_run_id,
           repository_id = excluded.repository_id,
           subject_kind = excluded.subject_kind,
           subject_number = excluded.subject_number,
           triggering_comment_id = excluded.triggering_comment_id,
           actor = excluded.actor,
           command_name = excluded.command_name,
           command_args = excluded.command_args,
           mode = excluded.mode,
           event = excluded.event,
           status = excluded.status,
           review_decision = excluded.review_decision,
           quorum_met = excluded.quorum_met,
           finding_count = excluded.finding_count,
           completed_at = excluded.completed_at,
           duration_ms = excluded.duration_ms,
           html_url = excluded.html_url,
           artifact_schema_version = excluded.artifact_schema_version,
           artifact_available = 1,
           failure_class = excluded.failure_class,
           failure_message = excluded.failure_message`
      )
      .bind(
        workflow.id,
        run.runId,
        workflow.repository.id,
        subject?.kind ?? null,
        subject?.number ?? null,
        subject?.commentId ?? null,
        run.actor,
        run.command?.name ?? null,
        run.command?.args ?? null,
        run.mode,
        run.event,
        run.status,
        run.review?.decision ?? null,
        run.review === undefined ? null : run.review.quorumMet ? 1 : 0,
        artifact.findings.length,
        run.startedAt,
        run.completedAt ?? null,
        durationMs,
        workflow.htmlUrl,
        artifact.version,
        run.failure?.class ?? null,
        run.failure?.message ?? null
      ),
    db.prepare("DELETE FROM findings WHERE workflow_run_id = ?").bind(workflow.id),
    db.prepare("DELETE FROM session_summaries WHERE workflow_run_id = ?").bind(workflow.id),
    db.prepare("DELETE FROM artifact_references WHERE workflow_run_id = ?").bind(workflow.id)
  );

  for (const findings of chunks(artifact.findings, 9)) {
    const placeholders = findings.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO findings (
             workflow_run_id, finding_id, severity, confidence, title, body,
             path, line, reviewer, disposition, fingerprint
           ) VALUES ${placeholders}`
        )
        .bind(
          ...findings.flatMap((finding) => [
            workflow.id,
            finding.id,
            finding.severity,
            finding.confidence,
            finding.title,
            finding.body ?? "",
            finding.path,
            finding.line ?? null,
            finding.reviewer ?? null,
            finding.disposition ?? null,
            finding.fingerprint ?? null
          ])
        )
    );
  }

  for (const sessions of chunks(artifact.sessions, 7)) {
    const placeholders = sessions.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO session_summaries (
             workflow_run_id, session_id, role, reviewer, model, status,
             retry_count, input_tokens, output_tokens, cost, duration_ms,
             error_code, error_message
           ) VALUES ${placeholders}`
        )
        .bind(
          ...sessions.flatMap((session) => [
            workflow.id,
            session.sessionId,
            session.role,
            session.reviewer ?? null,
            session.model,
            session.status,
            session.retryCount,
            session.usage?.inputTokens ?? null,
            session.usage?.outputTokens ?? null,
            session.usage?.cost ?? null,
            session.durationMs ?? null,
            session.error?.code ?? null,
            session.error?.message ?? null
          ])
        )
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO artifact_references (
           workflow_run_id, artifact_id, name, size_bytes, expires_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        workflow.id,
        workflow.artifact.id,
        workflow.artifact.name,
        workflow.artifact.sizeBytes,
        workflow.artifact.expiresAt
      )
  );

  await db.batch(statements);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}
