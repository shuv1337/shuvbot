# HANDOFF

## Objective

Work through the P0-P3 punch list from a prior full-repo review
(`/home/shuv/repos/shuvmate/data/shuvbot-review-p2/report.md`): wire the real
Claude Code agent into the shipped action (it was previously a fake/stub
agent in every mode), then fix the security/spec/test gaps the same review
found.

## Current status

All P0-P3 punch-list items (1-14) are implemented and committed on
`fm/shuvbot-wire-agent-r8`, one commit per logical slice. P4 (item 15, the
release cut/tag) is deliberately **not** done - it needs a scratch repo and
a live Claude secret, out of scope for this pass.

- **P0 (critical)**: `packages/action/src/main.ts` review mode now spawns the
  real `claude-code` driver through a new adapter
  (`packages/agents/src/review-agent.ts`) and starts the MCP tool server
  (policy-gated tools, audit log, redaction) per run, replacing
  `createFakeReviewAgent`. `implement`/`fix-ci` modes are explicitly
  **not** wired to a real agent - this was a deliberate scope call (see
  below), documented in `README.md`/`docs/workflows.md`/`docs/commands.md`.
  `docs/workflows.md` now shows the `CLAUDE_CODE_OAUTH_TOKEN` `env:` block.
- **P1**: shell sandbox now validates the full command string (chained/
  injected commands used to bypass the allow/deny check via the first
  token only); `create_pull_request` resolves the repo's real default
  branch instead of hardcoding `"main"`; workflow summaries are redacted
  and `RunRecord.errors` is now actually populated on failure paths;
  `prSummary`/`learnings` context blocks are labeled untrusted.
- **P2**: `SPEC.md` §7.2's config example now matches the real flat parser
  (verified by round-tripping it through `loadConfigFile`); `action.yml`
  declares its `outputs:` block; the never-implemented `output_schema`
  input and `[telemetry]` config block were removed until an actual
  implementation exists (SPEC is annotated "Not implemented" at each
  affected section rather than silently changed); `set_output`'s SPEC
  section is reconciled to the tool's real `{name, value}` shape; docs
  gained a standalone-output note and an "action output failures"
  troubleshooting section.
- **P3**: added `packages/action/test/main.integration.test.ts`, the first
  test that exercises `main()`/`entry.ts` at all - runs a real
  `fixtures/events/*.json` fixture end to end against a scripted driver and
  a hand-rolled `fetchImpl` GitHub API stand-in, asserting a review comment
  posts with the agent's finding at the right diff position. Also fixed
  the eval harness's vacuous hardening-case assertions - each of the 10
  cases now carries a real diff and is checked against the actual review
  pipeline instead of `expected.length > 0`.

## Key context

- Follow `SPEC.md`, `AGENTS.md`; `SPEC.md` is source of truth for
  product/security behavior *where it's not marked "Not implemented"* -
  several sections (§4.2 `output_schema`, §23, §24.4 `[telemetry]`) now say
  explicitly what isn't built yet.
- Runtime policy remains the only permission authority. Fork PRs must not
  get shell, push, or secrets. `canApprove` stays disabled for v1.
- Repo learnings stay disabled by default unless `[memory].learnings = true`.
- `dist/index.js` is regenerated via a dedicated build commit, not on every
  source change - see `AGENTS.md`.

## Deliberate scope decisions made this pass (flag if you disagree)

1. **implement/fix-ci left as honest no-ops, not wired to a real agent.**
   Wiring them for real means spawning the agent with real repo-editing/git
   authority (commits, pushes, PR creation) and turning its free-text output
   into the structured `{workDone, filesChanged, commandsRun, checks,
   commits}` / `{commandsRun, checks, commits}` shapes those runners expect -
   materially riskier and larger than review-mode wiring (which only needs
   to parse JSON findings out of text). The original task explicitly allowed
   descoping this to review-only if it looked riskier, provided docs say so
   plainly - done in `README.md`/`docs/workflows.md`/`docs/commands.md`.
2. **`output_schema` and `[telemetry]` removed rather than implemented.**
   Neither appears in `SPEC.md` §29's own v0.1-v0.4 milestone list, so
   removing them until built is consistent with the spec's own sequencing,
   not just a risk-driven cut.
3. **`set_output` SPEC section updated to match code, not the other way
   around.** The tool's `{name, value}` contract is real and tested; SPEC's
   `{result, summary?}` shape depends on the not-yet-built `output_schema`
   validation loop.

None of these were flagged `needs-decision` - they're P2/P3-tier per the
task's own escalation rule (only P0 item 1/3 or any P1 item required
`needs-decision` if skipped, and none were skipped).

## Validation

- `bun install && bun run typecheck && bun run lint && bun test && bun run build && bun run evals` all pass as of the last commit on this branch.
- `bun test` run 3x in a row with no flakiness (142 tests).
- Manually verified the shell-sandbox fix and the eval-harness fix actually
  catch regressions by deliberately breaking the underlying code, re-running,
  confirming failure, then reverting (see the corresponding commit messages
  for exact repro steps).

## Next steps

1. **P4 smoke test** (out of scope for this pass, needs a human): cut a
   scratch repo, reference this branch's commit SHA in a workflow, seed a
   real `CLAUDE_CODE_OAUTH_TOKEN` secret, open a PR with a deliberately
   obvious bug, and confirm a real review comment referencing it gets
   posted. Only after that passes should `v0`/`v0.1.0` get tagged - see
   `SPEC.md`'s release section and the original review report §5/§7.
2. If/when `implement`/`fix-ci` get wired for real, the MCP audit log
   (`packages/mcp/src/audit.ts`) is the right source of truth for
   `commandsRun`/`commits`/`checks` - it already records every real
   `git_commit`/`push_branch`/`run_shell` tool call the agent makes, so
   those runner result shapes can be derived from the audit snapshot rather
   than trusting the agent's free-text self-report.
3. `packages/cli/src/local-review.ts` still uses `createFakeReviewAgent`
   directly (intentionally, via its `agentFindings` param) - that's fine,
   it's a CLI testing/replay path, not the shipped action's runtime path,
   and wasn't in scope for this pass.

## Resume prompt

Pick up on `fm/shuvbot-wire-agent-r8` (or wherever it lands after review).
Run the validation commands above first to confirm nothing drifted, then
either proceed to the P4 smoke test (needs a scratch repo + a real secret,
so likely needs a human) or pick up one of the "Next steps" above.
