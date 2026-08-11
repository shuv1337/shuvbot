# HANDOFF

## Objective

Land the multi-agent coordinator review engine (`PLAN-multi-agent-review.md`)
and make it usable from GitHub, without changing shuvbot's trust rules.

## Current status

M1-M6 and M8-M9 are implemented and merged (PRs #23, #24). The coordinator is
the default for local `shuvbot review` and available in the GitHub Action behind
an explicit `engine: coordinator` input. M7 (the recorded dogfood matrix) is
still open.

- **Local review** runs the coordinator against the pinned `shuvcode@2.0.0-alpha-9`
  runtime using the operator's own shuvcode profile. Jujutsu-aware, so it
  reviews the working copy rather than only committed work.
- **GitHub review** is manual and owner-only by design: `.github/workflows/shuvbot.yml`
  has no `pull_request` trigger and runs only when `shuv1337` mentions
  `@shuvbot` in a pull request comment. It subscribes to both comment events
  (`issue_comment` and `pull_request_review_comment`), because those are two
  distinct GitHub events that look like one act in the UI.
- **CI** (`.github/workflows/ci.yml`) runs typecheck, lint, format, tests,
  evals, build, and a `git diff --exit-code dist/` staleness check on every pull
  request and on master.
- `implement` and `fix-ci` remain honest no-ops, unchanged.

## The one thing to know before continuing

**A deterministic 40-read specialist budget is the first convergence change to
reach full-tier quorum repeatedly.** On the same historical range and models,
six budget-enabled local runs completed all 36/36 specialists, met quorum 6/6
times, and kept both required reviewers every time. Each reviewer is steered to
return only established findings at its 40th filesystem read; valid structured
results count as completed and session artifacts expose
`readBudgetExhausted: true`. A hard timeout remains `timed_out`, retains any
partial findings, and still does not count toward quorum.

This is not yet Action-proven. The last Action full-tier dogfood before the read
budget, run
[31462297649](https://github.com/shuv1337/shuvbot/actions/runs/31462297649),
completed 4/6 specialists in 9m54s and degraded because `security` and `release`
timed out. It spent 41,648 output tokens and $27.33. Timeout finalization worked
at the transport boundary, but neither timed-out specialist had an established
structured result to retain.

Getting there took three failed full-tier dogfoods and one local reproduction.

- **#3** (`@high`, 5m cap, concurrency 3): 4/6 cut off at exactly 300s.
- **#4** (10m cap, concurrency 6): _nobody_ finished, the run died on the 15m
  overall timeout and wrote **no artifacts at all**. Raising the clock and the
  concurrency made it strictly worse and destroyed the evidence.
- **#5** (`@medium`, back to 5m/3): 5/6 cut off.

Two root causes, neither of which is a timeout:

1. **`dist/index.js` was reviewed as source.** 2.6MB and 69k lines, it passed
   every filter, and 128KB of it was materialised into every reviewer's
   workspace. Reviewers ran away to 12-14k output tokens reading a derived
   file. Now filtered, along with `.next/`, `.nuxt/`, `.output/` and
   `.svelte-kit/`; `build/` and `out/` are deliberately **not** filtered.
2. **Timed-out sessions reported no usage**, because the scheduler races a task
   against its deadline and discards the losing side - and those are the
   expensive sessions. Totalled from the event log, #3 really cost **$48.02**
   against $3.23 reported, and #5 **$52.29** against $0.36. Roughly 15x.

**shuvbot reviewing shuvbot found five real defects in these very changes**,
including a security one: failure detail was truncated _before_ being scrubbed,
so a credential straddling the boundary was cut in half and no longer matched
the exact-value scrub, leaving a fragment of a real secret in retained text. It
also twice caught tests that passed for the wrong reason. All are fixed.

**The runaway is diagnosed, and all context-shaping fixes tested so far made
reviewers hunt more.**
`SHUVBOT_TRACE=1` on a local review records every raw runtime event. It shows
immediately what lifecycle events never could: reviewers **page through the
materialised content**, roughly 110-140 lines per `read` call, with `offset`
and `limit`. One scope held ~6,500 lines across 8 files - about 50 tool calls
to see it once - and the largest file (1,788 lines) was read ten times.
Tool-call volume tracks timeouts closely.

Measured on the same historical range (`d89f4c4..2aca00a`), same models:

| variant                                        | calls | timed out |
| ---------------------------------------------- | ----- | --------- |
| whole-file baseline                            | 160   | 3 of 6    |
| changed-hunk elision plus prompt               | 284   | 5 of 6    |
| prompt-only: forbid paging                     | 186   | 1 of 6    |
| reviewer-specific path scopes                  | 286   | 3 of 6    |
| 128 KB whole-content budget per reviewer scope | 281   | 3 of 6    |

The prompt-only run happened to reach quorum, but 90 of 96 content reads still
used offsets and the runaway made 76 calls, so the mechanism was ignored. The
read-budget variant then reached 6/6 in five consecutive runs. A subsequent
path-filtered counter initially failed because sanitized runtime events omitted
tool input; its 257-call negative control left every budget marker false and
timed out `release`. The adapter now exposes only a non-sensitive `toolKind`
classification, and a load-bearing runtime test pins that contract. The
corrected repetition again completed 6/6 in 7m16s: three reviewers stopped at
exactly 40 reads, all three returned valid results, total specialist output was
27,887 tokens, and no reviewer timed out. Across budget-enabled runs,
end-to-end time ranged from 4m58s to 7m20s and specialist output from 21,819 to
30,786 tokens. This proves local reliability, not recall or Action behavior; an
Action dogfood remains before calling the fix shipped.

**A real coordinator review has produced real findings in GitHub Actions.**
Dogfood #2, run
[31045879626](https://github.com/shuv1337/shuvbot/actions/runs/31045879626) on
PR #25 (a throwaway pull request, closed unmerged): `status: success`,
`decision: minor_issues`, quorum met, two findings posted as inline review
comments, both correct. ~49s engine time, $0.18.

The pull request planted two one-line flaws in `packages/review/src/workspace.ts`
whose severity is only judgeable from **unchanged regions of the same file**
(`limit <= 0` weakened to `limit < 0`; a content write moved from
`flag: "wx", mode: 0o600` to `flag: "w", mode: 0o644`). The diff was two
±3-line hunks, yet the reviewer's evidence cited lines 91, 125, 233 and 235 and
the naming semantics of `encodeContentPath` - none of which appear in the patch.
A specialist's filesystem root is the temporary workspace, not the checkout, so
that context could only have come from the materialised post-change content.
Both the content-materialisation fix and the single-provider environment-auth
fix are therefore exercised by a real run.

Dogfood #1 remains the reference for the degradation path. Run
[31003444378](https://github.com/shuv1337/shuvbot/actions/runs/31003444378) on
PR #24 had all six specialists fail about 700ms in, twice each, because
environment auth forwards exactly **one** credential while the default roster
spanned **three providers**. The posted review said `DEGRADED - REVIEW
INCOMPLETE`, reported 0/6 coverage, named every failed reviewer, and refused to
claim clean - a totally broken review did not masquerade as a clean one.

Across later dogfoods, the Action has proved accurate content-backed findings,
lite-tier quorum, full-tier scheduling, honest degradation, usage accounting,
and timeout finalization. Full-tier quorum with the read budget is the remaining
production proof.

## What is NOT done

1. **The read budget is not yet Action-proven.** Full tier reached quorum in
   six budget-enabled local runs, but the source and bundle must land before the
   trusted-default-branch workflow can exercise it.
2. **M7's dogfood matrix is unrecorded.** Several targeted runs exist, but
   latency, cost, recall, and precision are sampled rather than measured against
   a fixed corpus.
3. **The Action default has deliberately not been flipped** to the coordinator.
4. **Finding recall under the 40-read budget is unmeasured.** Repeated runs
   produced plausible findings, but no planted-defect precision/recall corpus
   exists yet.

## Known issues

- **Issue #20**: intermittent `GitHub request failed (406)` about a second into
  a review, same pull request and secrets. Needs the failing endpoint named and
  one retry before an advisory check fails.
- **`legacy` is overloaded.** `review.engine = "legacy"` is dead code that only
  throws, while the Action's _working_ single-agent Claude default is not called
  legacy anywhere. M9 schedules removal after a deprecation window.
- **`docs/fork-review-design.md`** proposes splitting `canReview` into "may
  execute in a fork context" and "may publish on a fork pull request".
  Unimplemented, awaiting a decision; it would also stop fork pull requests
  spending a full coordinator run on a review that cannot be posted.

## Recently fixed

- **Provider failures are diagnosable.** A failure used to reach the operator as
  a sanitised category and nothing else, so dogfood #1's cause had to be
  inferred from the model roster. The runtime now retains a bounded one-line
  summary of the source event's own error fields, and a failed session is
  recorded in `shuvbot-rejected-results.json` alongside refused results, tagged
  `kind: "failure"`. Retention is fail-closed - detail exists only when the
  caller supplies a redactor - and the runtime additionally scrubs any
  credential it injected by exact value, because the pattern redactor cannot
  recognise a token shape it does not know.
- **Reviewers no longer read the base revision.** Specialists are scoped to the
  temporary review workspace, which held only patches, so any cross-file
  question was answered from a checkout that is the trusted default branch, not
  the pull request. The workspace now materialises each reviewed file's
  post-change content as inert data (`contents/<sha256>.txt`, mode 0600, in the
  temp workspace only), the Action sources it from the contents API at the head
  commit, and the local CLI sources it from `git show <rev>:<path>`. The
  security posture is unchanged: nothing is written into the checkout and
  nothing is executed. Sourcing is best-effort and bounded (100 files, 1 MB per
  file from the API, 128 KB per file and 8 MB per workspace materialised), and
  a file whose content cannot be sourced is reviewed from its patch alone.
  Reviewer prompts now name the content files and forbid confirming a symbol
  from anything outside the workspace. **Exercised by dogfood #2**, whose
  findings cited same-file lines that never appear in the diff.

## Key context

- Runtime policy is the only permission authority. Fork pull requests get no
  shell, push, or secrets, are reviewed but never posted to, and receive no
  lifecycle state. `canApprove` stays disabled.
- Writing finding-lifecycle state is a **write to the pull request** and is
  gated on `policy.canReview` exactly like posting.
- `runCoordinatorReview` (`packages/review/src/run.ts`) backs both the CLI and
  the Action, so review judgement cannot drift between them.
- Environment auth reaches exactly one provider. Any change to
  `REVIEW_MODEL_ALIASES` or to a repository's `[review.models]` must keep the
  roster on that provider, or every specialist fails.
- The Action discovers `shuvbot.toml` like the CLI does; an explicit `config:`
  input still wins, which is how `.github/shuvbot.ci.toml` keeps CI-only
  settings (`auth = "environment"`, Anthropic-only models) out of local runs.
- `AGENTS.md` holds the operational gotchas that cost real debugging time - read
  it before touching the session, prompt, runtime, or workflow paths.

## Validation

`bun install && bun run typecheck && bun run lint && bun run format:check && bun test && bun run build && bun run evals`,
all green and enforced by CI rather than convention.

## Resume prompt

Read `AGENTS.md`, then the "one thing to know" section above.

Land the source change and regenerated Action bundle, then run one full-tier
`@shuvbot review` against the trusted default branch. Success means quorum,
both `code-quality` and `security` completed, no hard timeout, and session
artifacts truthfully identifying every reviewer that exhausted its read budget.
Do not retune timeouts, concurrency, model, or scope in the same run.

Read `$RUNNER_TEMP/shuvbot` from the run - `shuvbot-run.json` for coverage and
per-session errors, `shuvbot-findings.json` for the canonical findings
artifact, `shuvbot-events.jsonl` for the session timeline (this is where the
exact 300s wall was visible), and `shuvbot-rejected-results.json` for anything
the review refused.

Note that finding bodies are **not** in the artifacts; the evidence strings live
in the posted review comments
(`gh api repos/<owner>/<repo>/pulls/<n>/comments`). Reading only the artifacts
will tell you a finding exists but nothing about its quality.
