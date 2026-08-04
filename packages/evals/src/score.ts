export interface EvalScore {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
}

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  notes: string[];
}

export function scoreResults(results: readonly EvalCaseResult[]): EvalScore {
  const passed = results.filter((result) => result.passed).length;
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
    passRate: results.length === 0 ? 1 : passed / results.length
  };
}

export function formatScoreTable(results: readonly EvalCaseResult[]): string {
  const score = scoreResults(results);
  const rows = [
    "| Case | Result | Notes |",
    "| --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.passed ? "pass" : "fail"} | ${result.notes.join("; ")} |`
    ),
    `| total | ${score.passed}/${score.total} | passRate=${score.passRate.toFixed(2)} |`
  ];
  return rows.join("\n");
}
