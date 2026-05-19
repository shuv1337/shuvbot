import * as core from "@actions/core";
import type { RunRecord } from "../../core/src/run-record.ts";

export async function writeWorkflowSummary(record: RunRecord): Promise<void> {
  const summary = core.summary
    .addHeading("reviewbot")
    .addTable([
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

  if (record.policy) {
    const p = record.policy;
    summary
      .addHeading("Runtime policy", 2)
      .addTable([
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
    summary
      .addHeading("Tools called", 2)
      .addTable([
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
  if (record.implementation) {
    summary
      .addHeading("Implementation", 2)
      .addTable([
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
    summary
      .addHeading("Errors", 2)
      .addTable([
        [
          { data: "Class", header: true },
          { data: "Message", header: true }
        ],
        ...record.errors.map((err) => [err.class, err.message] as string[])
      ]);
  }

  await summary.write();
}
