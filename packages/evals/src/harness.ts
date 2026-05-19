import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatScoreTable, type EvalCaseResult } from "./score.ts";
import { replayGithubEventFixture } from "./replay-github-event.ts";

export interface RunEvalHarnessInput {
  root?: string;
}

export async function runEvalHarness(input: RunEvalHarnessInput = {}): Promise<{ results: EvalCaseResult[]; table: string }> {
  const root = input.root ?? process.cwd();
  const eventDir = join(root, "fixtures", "events");
  const caseDir = join(root, "packages", "evals", "cases");
  const eventFiles = (await readdir(eventDir)).filter((name) => name.endsWith(".json"));
  const caseNames = await readdir(caseDir);
  const results: EvalCaseResult[] = [];

  for (const file of eventFiles) {
    const replay = await replayGithubEventFixture(join(eventDir, file));
    results.push({
      id: `fixture:${file}`,
      passed: !replay.redactedPayload.includes("ghp_") && !replay.canApprove,
      notes: [`mode=${replay.mode}`, `shell=${replay.shell}`, `push=${replay.push}`]
    });
  }

  for (const name of caseNames) {
    const raw = await readFile(join(caseDir, name, "case.json"), "utf8");
    const parsed = JSON.parse(raw) as { id?: string; expected?: unknown[] };
    results.push({
      id: `case:${parsed.id ?? name}`,
      passed: Array.isArray(parsed.expected) && parsed.expected.length > 0,
      notes: ["seeded"]
    });
  }

  return { results, table: formatScoreTable(results) };
}

if (import.meta.main) {
  const result = await runEvalHarness();
  console.log(result.table);
  if (result.results.some((entry) => !entry.passed)) process.exitCode = 1;
}
