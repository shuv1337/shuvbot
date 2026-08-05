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

**A real coordinator review has run in GitHub Actions once, and produced zero
findings.** Run
[31003444378](https://github.com/shuv1337/shuvbot/actions/runs/31003444378) on
PR #24: the whole pipeline worked - auth, runtime startup, session creation,
scheduling, quorum, posting, artifacts - but all six specialists failed about
700ms in, twice each, and only the coordinator completed.

Cause: environment auth forwards exactly **one** credential, while the default
model roster spans **three providers** (`default-reasoning` is Anthropic,
`default-coding` is xAI, `default-fast` is OpenAI). Invisible locally, because a
developer's shuvcode profile has all three authenticated.

Fixed in #24: environment auth now resolves every configured model and refuses
up front when its provider is not the one the credential authenticates, and this
repository's CI roster is pinned to Anthropic models with a test asserting the
committed CI config stays reachable. **That fix has not yet been exercised by a
real run.**

What this proved, and what it did not:

- **Proved:** the mechanism works end to end, and the degradation path is
  trustworthy. The posted review said `DEGRADED - REVIEW INCOMPLETE`, reported
  0/6 coverage, named every failed reviewer, and refused to claim clean or
  request changes. A totally broken review did not masquerade as a clean one.
- **Not proved:** anything about review quality. No specialist has ever produced
  a finding through the Action.

## What is NOT done

1. **M8's exit criterion is partially met.** The pipeline ran end to end, but no
   specialist produced a finding, so the thing under test was not tested.
   Re-running the dogfood on the next pull request is the first run that can say
   anything about quality.
2. **M7's dogfood matrix is unrecorded**, so latency, degradation, and quality
   claims remain unmeasured.
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
- **Provider failures are undiagnosable.** The CI failure surfaced only as a
  sanitised `Provider request failed`; the cause had to be inferred from the
  model alias table. The retained-sample treatment that exists for schema
  failures should extend to provider failures.
- **`legacy` is overloaded.** `review.engine = "legacy"` is dead code that only
  throws, while the Action's _working_ single-agent Claude default is not called
  legacy anywhere. M9 schedules removal after a deprecation window.
- **`docs/fork-review-design.md`** proposes splitting `canReview` into "may
  execute in a fork context" and "may publish on a fork pull request".
  Unimplemented, awaiting a decision; it would also stop fork pull requests
  spending a full coordinator run on a review that cannot be posted.

## Recently fixed, unexercised by a real run

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
  from anything outside the workspace. **No real run has exercised this** - it
  becomes visible the first time specialists actually produce findings.

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

The base-revision file-read fix has landed, so the next step is the second
dogfood: open a pull request, comment `@shuvbot review` on it, and read
`$RUNNER_TEMP/shuvbot` from the run:
`shuvbot-run.json` for coverage and per-session errors, `shuvbot-findings.json`
for the canonical findings artifact, and `shuvbot-events.jsonl` for the session
timeline. Success this time means specialists completing and producing findings;
that closes M8's exit criterion, starts M7's matrix, and should surface whatever
is behind the two `REVIEW_SCHEMA_INVALID` reviewers. It is also the first run
that can show whether reviewers actually use the materialised file content -
the findings artifact's evidence strings are where that shows up.
