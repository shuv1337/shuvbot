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

- **Reviewers read the base revision, not the pull request.** The workflow
  correctly checks out the trusted default branch - a same-repo pull request
  must never execute code holding `CLAUDE_CODE_OAUTH_TOKEN`, and
  `packages/action/test/workflow-security.test.ts` pins that. But the
  reviewers' filesystem tools are scoped to that checkout, while their prompt
  tells them to inspect repository files. Patches are API-sourced and correct;
  **cross-file reasoning is not**. A reviewer opening `helpers.ts` to confirm a
  function the pull request adds there reads the pre-change file and can report
  a false "undefined function". Fix without touching the security posture:
  materialise the changed files' post-change content into the read-only
  workspace as data, never as executable code. This becomes live the moment
  specialists actually run, so it is effectively a prerequisite for trusting the
  next dogfood's findings.
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

The next step is the second dogfood, and it is worth doing the base-revision
file-read fix first so its findings can be trusted. Then open a pull request,
comment `@shuvbot review` on it, and read `$RUNNER_TEMP/shuvbot` from the run:
`shuvbot-run.json` for coverage and per-session errors, `shuvbot-findings.json`
for the canonical findings artifact, and `shuvbot-events.jsonl` for the session
timeline. Success this time means specialists completing and producing findings;
that closes M8's exit criterion, starts M7's matrix, and should surface whatever
is behind the two `REVIEW_SCHEMA_INVALID` reviewers.
