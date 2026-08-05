# HANDOFF

## Objective

Land the multi-agent coordinator review engine (`PLAN-multi-agent-review.md`)
and make it usable from GitHub, without changing shuvbot's trust rules.

## Current status

M1-M6 and M8-M9 are implemented. The coordinator is the default for local
`shuvbot review` and is available in the GitHub Action behind an explicit
`engine: coordinator` input. M7 (the recorded dogfood matrix) is still open.

- **Local review** runs the coordinator against the pinned `shuvcode@2.0.0-alpha-9`
  runtime, using the operator's own shuvcode profile. Jujutsu-aware, so it
  reviews the working copy rather than only committed work.
- **GitHub review** is manual and owner-only by design: `.github/workflows/shuvbot.yml`
  has no `pull_request` trigger and runs only when `shuv1337` mentions
  `@shuvbot` in a pull request comment. It subscribes to both comment events
  (`issue_comment` and `pull_request_review_comment`).
- **CI** (`.github/workflows/ci.yml`) runs typecheck, lint, tests, evals, build,
  and a `git diff --exit-code dist/` staleness check on every pull request.
- `implement` and `fix-ci` remain honest no-ops, unchanged.

## What is NOT done

1. **M8's exit criterion is unmet.** No opt-in coordinator workflow has run end
   to end against a real pull request. Everything is covered by integration
   tests against a scripted engine and a stand-in GitHub API, which cannot
   surface the class of fault that only appears against the real runtime - the
   four prompt-path bugs in `AGENTS.md` are all of that class.
2. **M7's dogfood matrix has not been recorded**, so latency, degradation, and
   review-quality claims are unmeasured.
3. **The Action default has deliberately not been flipped** to the coordinator.
4. **Two specialists fail their own validation.** In the full-tier run, the
   `security` and `performance` reviewers completed their model calls but their
   results were rejected as `REVIEW_SCHEMA_INVALID`. The engine now retains
   redacted samples of refused results, so one real full-tier run should be
   enough to diagnose it. This is the highest-value open item: two of six
   reviewers are silently degraded, and one of them is security.

## Known issues

- **Reviewers read the base revision, not the pull request.** The review
  workflow correctly checks out the trusted default branch (a same-repo pull
  request must never execute code holding `CLAUDE_CODE_OAUTH_TOKEN`), but the
  reviewers' filesystem tools are scoped to that checkout while their prompt
  tells them to inspect repository files. Patches are API-sourced and correct;
  cross-file reasoning is not. Likely fix: materialise the changed files'
  post-change content into the read-only workspace as data, which leaves the
  security posture untouched.
- **Issue #20**: intermittent `GitHub request failed (406)` about a second into
  a review, same pull request and secrets. Needs the failing endpoint named and
  one retry before an advisory check fails.
- **`legacy` is overloaded.** `review.engine = "legacy"` is dead code that only
  throws, while the Action's _working_ single-agent Claude default is not called
  legacy anywhere. M9 schedules removal after a deprecation window.
- **`docs/fork-review-design.md`** proposes splitting `canReview` into
  "may execute in a fork context" and "may publish on a fork pull request".
  Unimplemented and awaiting a decision; it would also stop fork pull requests
  spending a full coordinator run on a review that cannot be posted.

## Key context

- Runtime policy is the only permission authority. Fork pull requests get no
  shell, push, or secrets, are reviewed but never posted to, and receive no
  lifecycle state. `canApprove` stays disabled.
- Writing finding-lifecycle state is a **write to the pull request** and is
  gated on `policy.canReview` exactly like posting.
- `runCoordinatorReview` (`packages/review/src/run.ts`) backs both the CLI and
  the Action, so review judgement cannot drift between them.
- `AGENTS.md` holds the operational gotchas that cost real debugging time -
  read it before touching the session, prompt, runtime, or workflow paths.

## Validation

`bun install && bun run typecheck && bun run lint && bun test && bun run build && bun run evals`,
all green, and now enforced by CI rather than convention.

## Resume prompt

Read `AGENTS.md` and the "What is NOT done" list above. The next step is a real
coordinator review on a live pull request: comment `@shuvbot review` on an open
pull request, then read `$RUNNER_TEMP/shuvbot` artifacts from the run. That
single act closes M8's exit criterion and starts M7's matrix, and the retained
rejected-result samples should explain the two failing specialists.
