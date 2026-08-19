import * as core from "@actions/core";
import { DefaultRedactor, type Redactor } from "../../core/src/redaction.ts";
import type { ReviewRunSummary, RunRecord } from "../../core/src/run-record.ts";

export async function writeWorkflowSummary(
  rawRecord: RunRecord,
  redactor: Redactor = new DefaultRedactor()
): Promise<void> {
  const record = redactor.redact(rawRecord);
  const summary = core.summary.addHeading("shuvbot").addTable([
    [
      { data: "Field", header: true },
      { data: "Value", header: true }
    ],
    ["Run ID", record.runId],
    ["Status", record.status],
    ["Trigger", record.trigger],
    ["Event", `${record.event}${record.eventAction ? `:${record.eventAction}` : ""}`],
    ["Actor", record.actor],
    ["Mode", record.mode],
    ["Agent", record.agent],
    ["Model", record.model]
  ]);

  const elapsed = formatElapsed(record);
  if (elapsed !== undefined) {
    summary.addRaw(`\nElapsed: ${elapsed}\n`);
  }

  if (record.policy) {
    const p = record.policy;
    summary.addHeading("Runtime policy", 2).addTable([
      [
        { data: "Permission", header: true },
        { data: "Value", header: true }
      ],
      ["shell", p.shell],
      ["push", p.push],
      ["actorPermission", p.actorPermission],
      ["isFork", String(p.isFork)],
      ["isPrivateRepo", String(p.isPrivateRepo)],
      ["canComment", String(p.canComment)],
      ["canReview", String(p.canReview)],
      ["canApprove", String(p.canApprove)],
      ["canRequestChanges", String(p.canRequestChanges)],
      ["canCreatePr", String(p.canCreatePr)],
      ["canReadSecrets", String(p.canReadSecrets)],
      ["canAddLabels", String(p.canAddLabels)],
      ["canUpdateIssue", String(p.canUpdateIssue)],
      ["canUpdatePullRequest", String(p.canUpdatePullRequest)]
    ]);
    if (p.reasons.length > 0) {
      summary.addHeading("Policy reasons", 3).addList(p.reasons);
    }
  }

  if (record.filesConsidered.length > 0) {
    summary.addHeading("Files considered", 2).addList(record.filesConsidered);
  }
  if (record.filesIgnored.length > 0) {
    summary.addHeading("Files ignored", 2).addList(record.filesIgnored);
  }
  if (record.toolCalls.length > 0) {
    summary.addHeading("Tools called", 2).addTable([
      [
        { data: "Tool", header: true },
        { data: "Duration (ms)", header: true },
        { data: "Status", header: true }
      ],
      ...record.toolCalls.map(
        (call) => [call.name, String(call.durationMs), call.status] as string[]
      )
    ]);
  }
  if (record.review) {
    const review = record.review;
    // Coverage is the point of this table: a degraded review looks exactly like
    // a clean one unless the missing reviewers are stated outright.
    summary.addHeading("Review", 2).addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true }
      ],
      ["Engine", review.engine],
      ["Risk tier", review.tier],
      ["Decision", review.decision],
      ["Quorum met", String(review.quorumMet)],
      ["Reviewers completed", review.successfulReviewers.join(", ") || "none"],
      ["Reviewers missing", review.missingReviewers.join(", ") || "none"],
      ["Retries", String(review.retries)],
      ...usageRows(review.usage)
    ]);
    if (review.sessions.length > 0) {
      summary.addHeading("Sessions", 3).addTable([
        [
          { data: "Role", header: true },
          { data: "Reviewer", header: true },
          { data: "Status", header: true },
          { data: "Model", header: true },
          { data: "Tokens in/out", header: true },
          { data: "Cost", header: true }
        ],
        ...review.sessions.map((session) => [
          session.role,
          session.reviewer ?? "—",
          session.status,
          session.model,
          session.usage ? `${session.usage.inputTokens} / ${session.usage.outputTokens}` : "—",
          formatCost(session.usage?.cost)
        ])
      ]);
    }
    if (review.findingAccounting) {
      const counts = review.findingAccounting;
      summary.addHeading("Findings", 3).addTable([
        [
          { data: "Active", header: true },
          { data: "New", header: true },
          { data: "Unresolved", header: true },
          { data: "Fixed", header: true },
          { data: "User-resolved", header: true },
          { data: "Dismissed", header: true }
        ],
        [
          String(counts.active),
          String(counts.new),
          String(counts.unresolved),
          String(counts.fixed),
          String(counts.userResolved),
          String(counts.dismissed)
        ]
      ]);
    }
  }
  if (record.implementation) {
    summary.addHeading("Implementation", 2).addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true }
      ],
      ["Requested task", record.implementation.requestedTask],
      ["Branch", record.implementation.branch]
    ]);
    if (record.implementation.commandsRun.length > 0) {
      summary.addHeading("Commands run", 3).addList(record.implementation.commandsRun);
    }
    if (record.implementation.checks.length > 0) {
      summary.addHeading("Checks", 3).addList(record.implementation.checks);
    }
    if (record.implementation.commits.length > 0) {
      summary.addHeading("Commits", 3).addList(record.implementation.commits);
    }
  }
  if (record.errors.length > 0) {
    summary.addHeading("Errors", 2).addTable([
      [
        { data: "Class", header: true },
        { data: "Message", header: true }
      ],
      ...record.errors.map((err) => [err.class, err.message] as string[])
    ]);
  }

  await summary.write();
}

function usageRows(usage: ReviewRunSummary["usage"]): string[][] {
  if (usage === undefined) return [];
  const rows = [
    ["Input tokens", String(usage.inputTokens)],
    ["Output tokens", String(usage.outputTokens)]
  ];
  if (usage.cost !== undefined) rows.push(["Cost", formatCost(usage.cost)]);
  return rows;
}

function formatCost(cost: number | undefined): string {
  return cost === undefined ? "—" : `$${cost.toFixed(2)}`;
}

function formatElapsed(record: RunRecord): string | undefined {
  if (record.completedAt === undefined) return undefined;
  const started = Date.parse(record.startedAt);
  const completed = Date.parse(record.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return undefined;
  }
  const seconds = Math.floor((completed - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}
