import * as core from "@actions/core";
import type { RunRecord } from "../../core/src/run-record.ts";

export async function writeWorkflowSummary(record: RunRecord): Promise<void> {
  await core.summary
    .addHeading("reviewbot")
    .addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true }
      ],
      ["Run ID", record.runId],
      ["Status", record.status],
      ["Mode", record.mode],
      ["Agent", record.agent],
      ["Model", record.model]
    ])
    .write();
}
