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

**A real coordinator review has now produced real findings in GitHub Actions.**
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

1. **M8's exit criterion is met at the `trivial` tier only.** Dogfood #2
   produced real findings, but on a two-line diff that scheduled one reviewer.
   A substantial pull request that reaches the full tier is the next run that
   can say anything about multi-specialist behaviour.
2. **M7's dogfood matrix is unrecorded.** Two runs exist (#1 fully degraded, #2
   trivial-tier clean), so latency and quality are sampled, not measured.
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

## Recently fixed

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

Dogfood #2 passed at the `trivial` tier, so the next step is a **full-tier**
dogfood: open a pull request whose diff is large enough to schedule all six
specialists, comment `@shuvbot review` on it, and read `$RUNNER_TEMP/shuvbot`
from the run - `shuvbot-run.json` for coverage and per-session errors,
`shuvbot-findings.json` for the canonical findings artifact, and
`shuvbot-events.jsonl` for the session timeline. That is the run that should
surface whatever is behind the two `REVIEW_SCHEMA_INVALID` reviewers (`security`
and `performance`), exercise scheduling and quorum arithmetic under load, and
give M7's matrix a latency and cost figure that is not a two-line diff.

Note that finding bodies are **not** in the artifacts; the evidence strings live
in the posted review comments
(`gh api repos/<owner>/<repo>/pulls/<n>/comments`). Reading only the artifacts
will tell you a finding exists but nothing about its quality.
