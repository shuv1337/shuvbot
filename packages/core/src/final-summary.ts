export interface FinalSummaryInput {
  requestedTask: string;
  workDone: string[];
  filesChanged: string[];
  commandsRun: string[];
  checks: string[];
  commits: string[];
  followUps: string[];
}

export function formatFinalSummary(input: FinalSummaryInput): string {
  return [
    "## shuvbot summary",
    "",
    `Requested task: ${input.requestedTask}`,
    "",
    section("Work done", input.workDone),
    section("Files changed", input.filesChanged),
    section("Commands run", input.commandsRun),
    section("Checks", input.checks),
    section("Commits", input.commits),
    section("Follow-ups", input.followUps)
  ].join("\n");
}

function section(title: string, values: readonly string[]): string {
  const body = values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None";
  return `### ${title}\n${body}\n`;
}
