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

**Multi-specialist review now reaches quorum in the Action, and the run record
finally reports what it spent.** Dogfood #6, run
[31068925734](https://github.com/shuv1337/shuvbot/actions/runs/31068925734) on
PR #27: `tier: lite`, **quorum met**, `minor_issues`, no reviewer missing,
3m32s, and a reported cost of **$8.13** that is now the real number rather than
a fraction of it.

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

**What is still not right:** at the `full` tier a local run reached only 4/6,
with `performance` and `release` running away to ~11.6k output tokens and
timing out. The runaway is not tied to a particular reviewer - it moves between
runs - and quorum at the full tier needs 5. Full tier has therefore still never
reached quorum, in the Action or locally.

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

What dogfood #2 proved, and what it did not:

- **Proved:** specialists produce accurate, well-evidenced findings through the
  Action, and they reason from the pull request's content rather than the
  checked-out default branch.
- **Not proved:** anything above the `trivial` tier. A two-line diff scheduled
  exactly one reviewer (`code-quality`), so the six-specialist full tier, its
  scheduling, and its quorum arithmetic are still unexercised in the Action.

## What is NOT done

1. **The full tier has still never reached quorum.** After the build-output
   fix a local full-tier run reached 4/6, needing 5; `performance` and
   `release` ran away to ~11.6k output tokens and were cut off. The `lite`
   tier now works end to end in the Action, so the coordinator is proven up to
   `lite` and no further.
2. **M7's dogfood matrix is unrecorded.** Six runs exist (#1 degraded on auth,
   #2 trivial clean, #3/#4/#5 full-tier degraded, #6 lite-tier clean), so
   latency, cost and quality are sampled rather than measured.
3. **The Action default has deliberately not been flipped** to the coordinator.
4. **Two specialists fail their own validation.** In an earlier _local_
   full-tier run, `security` and `performance` completed their model calls but
   their results were rejected as `REVIEW_SCHEMA_INVALID`. The engine retains
   redacted samples of refused results, so one real full-tier run should explain
   it. Unrelated to the CI provider failure above, and still the highest-value
   correctness item: one of the two is security.

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

The full-tier dogfood has run and it degraded on timeouts, so the next step is
to retune and repeat it. Pick one of `activity_timeout`, `max_concurrency`, or
the specialist effort in `.github/shuvbot.ci.toml`, change only that, and
re-run `@shuvbot review` on a full-tier pull request so the variable is
identifiable. Each attempt costs roughly $3 and ten minutes. Success means
`code-quality` and `security` both completing, because they are the full tier's
required reviewers and nothing reaches quorum without them.

Read `$RUNNER_TEMP/shuvbot` from the run - `shuvbot-run.json` for coverage and
per-session errors, `shuvbot-findings.json` for the canonical findings
artifact, `shuvbot-events.jsonl` for the session timeline (this is where the
exact 300s wall was visible), and `shuvbot-rejected-results.json` for anything
the review refused.

Note that finding bodies are **not** in the artifacts; the evidence strings live
in the posted review comments
(`gh api repos/<owner>/<repo>/pulls/<n>/comments`). Reading only the artifacts
will tell you a finding exists but nothing about its quality.
