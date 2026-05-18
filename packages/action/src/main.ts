import * as core from "@actions/core";
import { readActionInputs } from "./inputs.ts";
import { loadConfigFile, normalizeConfig } from "../../core/src/config.ts";
import { RunLogger } from "../../core/src/observability.ts";
import { createRunRecord, completeRunRecord } from "../../core/src/run-record.ts";
import { writeWorkflowSummary } from "./workflow-summary.ts";

export async function main(): Promise<void> {
  const logger = new RunLogger();
  const inputs = readActionInputs();
  const fileConfig = inputs.config ? await loadConfigFile(inputs.config) : normalizeConfig({});
  const config = {
    ...fileConfig,
    agent: inputs.agent ?? fileConfig.agent,
    model: inputs.model ?? fileConfig.model,
    mode: inputs.mode ?? fileConfig.mode,
    timeout: inputs.timeout ?? fileConfig.timeout,
    activityTimeout: inputs.activityTimeout ?? fileConfig.activityTimeout,
    shell: inputs.shell ?? fileConfig.shell,
    push: inputs.push ?? fileConfig.push
  };

  const record = createRunRecord({
    event: process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch",
    actor: process.env.GITHUB_ACTOR ?? "unknown",
    mode: config.mode,
    agent: config.agent,
    model: config.model
  });

  logger.log("info", "run.initialized", {
    runId: record.runId,
    mode: config.mode,
    agent: config.agent,
    model: config.model
  });

  core.setOutput("result", JSON.stringify({ runId: record.runId, status: "initialized" }));
  await writeWorkflowSummary(completeRunRecord(record, "success"));
}
