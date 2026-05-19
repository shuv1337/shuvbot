import type { ParsedCommand } from "./commands.ts";
import { formatFinalSummary } from "./final-summary.ts";
import type { RuntimePolicy } from "./policy.ts";
import { deriveReviewbotBranch } from "../../github/src/branches.ts";

export interface ImplementAgent {
  run(input: { task: string; branch: string }): Promise<{
    workDone?: string[];
    filesChanged?: string[];
    commandsRun?: string[];
    checks?: string[];
    commits?: string[];
    followUps?: string[];
  }>;
}

export interface RunImplementInput {
  cwd: string;
  runId: string;
  command: ParsedCommand;
  policy: RuntimePolicy;
  startPoint: string;
  agent: ImplementAgent;
  prepareBranch: (input: { cwd: string; branch: string; startPoint: string }) => Promise<unknown>;
}

export interface RunImplementResult {
  branch: string;
  summary: string;
  requestedTask: string;
  commandsRun: string[];
  checks: string[];
  commits: string[];
}

export async function runImplement(input: RunImplementInput): Promise<RunImplementResult> {
  if (input.policy.push === "disabled" || input.policy.shell === "disabled" || !input.policy.canCreatePr) {
    throw new Error("implement mode requires trusted push, shell, and create-pr policy");
  }
  const branch = deriveReviewbotBranch({
    mode: "implement",
    runId: input.runId,
    requestedBy: input.command.actor,
    task: input.command.args || input.command.command
  });
  await input.prepareBranch({ cwd: input.cwd, branch, startPoint: input.startPoint });
  const result = await input.agent.run({ task: input.command.args, branch });
  const commandsRun = result.commandsRun ?? [];
  const checks = result.checks ?? [];
  const commits = result.commits ?? [];
  return {
    branch,
    requestedTask: input.command.args,
    commandsRun,
    checks,
    commits,
    summary: formatFinalSummary({
      requestedTask: input.command.args,
      workDone: result.workDone ?? [],
      filesChanged: result.filesChanged ?? [],
      commandsRun,
      checks,
      commits,
      followUps: result.followUps ?? []
    })
  };
}
