import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeConfig } from "../../core/src/config.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { runReview, type ReviewAgent } from "../../core/src/review-runner.ts";
import type { PullRequestEvent } from "../../core/src/events.ts";
import { formatScoreTable, type EvalCaseResult } from "./score.ts";
import { replayGithubEventFixture } from "./replay-github-event.ts";

export interface RunEvalHarnessInput {
  root?: string;
}

interface HardeningCase {
  id: string;
  description: string;
  expected: string[];
  files: Array<{ filename: string }>;
  diff: string;
}

// One actionable-finding tag per built-in skill so a seeded finding survives
// review-pipeline noise/actionability filtering regardless of which skill
// reported it - see runReviewPipeline's isActionable/isNoise checks.
const ACTIONABLE_TAG_BY_SKILL: Record<string, string> = {
  "code-review": "correctness",
  "security-review": "security",
  "workflow-security": "ci",
  "test-review": "test",
  "docs-review": "docs"
};

export async function runEvalHarness(
  input: RunEvalHarnessInput = {}
): Promise<{ results: EvalCaseResult[]; table: string }> {
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
    const parsed = JSON.parse(raw) as HardeningCase;
    results.push(await runHardeningCase(root, parsed, name));
  }

  return { results, table: formatScoreTable(results) };
}

/**
 * Runs a hardening case's diff through the real review pipeline (skill
 * routing, context assembly, pipeline filtering). The scripted agent below
 * only returns a finding when it's invoked for one of the case's expected
 * skill ids - it does not respond to every triggered skill the way a
 * constant-seeded fake agent would - so a case only passes if
 * runnableReviewSkills() actually routed the file to that skill. This
 * proves skill-path/trigger routing works for the case's file; it does not
 * test whether a live agent would detect the vulnerability, which needs a
 * real/scripted driver call and network access (see the smoke test in the
 * punch-list report).
 */
async function runHardeningCase(
  root: string,
  testCase: HardeningCase,
  dirName: string
): Promise<EvalCaseResult> {
  const id = testCase.id ?? dirName;
  if (!testCase.diff || !Array.isArray(testCase.files) || testCase.files.length === 0) {
    return { id: `case:${id}`, passed: false, notes: ["case.json is missing diff/files"] };
  }

  const expectedSkills = new Set(testCase.expected);
  const path = testCase.files[0]!.filename;
  const agent: ReviewAgent = {
    async run({ skillId }) {
      if (!expectedSkills.has(skillId)) return [];
      return [
        {
          id: `${id}-${skillId}`,
          skill: skillId,
          title: testCase.description,
          body: testCase.description,
          severity: "high",
          confidence: "high",
          path,
          line: 1,
          tags: [ACTIONABLE_TAG_BY_SKILL[skillId] ?? "correctness"]
        }
      ];
    }
  };

  const result = await runReview({
    cwd: root,
    repo: "shuvbot/evals",
    event: fakePullRequestEvent(testCase.files),
    diff: testCase.diff,
    files: testCase.files,
    config: normalizeConfig({}),
    policy: defaultRuntimePolicy({
      actor: "evals",
      actorPermission: "write",
      event: "pull_request",
      isFork: false,
      isPrivateRepo: false
    }),
    agent
  });

  const foundSkills = new Set(result.findings.map((finding) => finding.skill));
  const missing = testCase.expected.filter((skillId) => !foundSkills.has(skillId));

  return {
    id: `case:${id}`,
    passed: missing.length === 0,
    notes: [
      `expected=${testCase.expected.join(",")}`,
      `found=${[...foundSkills].join(",") || "none"}`,
      ...(missing.length > 0 ? [`missing=${missing.join(",")}`] : [])
    ]
  };
}

function fakePullRequestEvent(files: Array<{ filename: string }>): PullRequestEvent {
  return {
    kind: "pull_request",
    name: "pull_request",
    action: "opened",
    repo: { owner: "shuvbot", name: "evals", fullName: "shuvbot/evals", isPrivate: false },
    sender: { login: "evals" },
    raw: { files },
    pullRequest: {
      number: 0,
      title: "Hardening eval case",
      body: "",
      state: "open",
      draft: false,
      user: { login: "evals" },
      baseRef: "main",
      baseSha: "base",
      headRef: "case",
      headSha: "head",
      headRepoFullName: "shuvbot/evals",
      isFork: false
    }
  };
}

if (import.meta.main) {
  const result = await runEvalHarness();
  console.log(result.table);
  if (result.results.some((entry) => !entry.passed)) process.exitCode = 1;
}
