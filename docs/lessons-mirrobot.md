# Lessons from Mirrobot-agent

Comparison of [Mirrowel/Mirrobot-agent](https://github.com/Mirrowel/Mirrobot-agent)
against shuvbot, taken while shuvbot's coordinator review already works and the
gap is features and observability rather than core review quality.

Mirrobot is a GitHub Actions platform: eight workflows, composed prompt parts,
and an OpenCode session that does the work. Shuvbot is a TypeScript runtime
with deterministic policy, a multi-agent coordinator, and GitHub-native
posting. Copying workflows or prompt text wholesale would fight that shape.
The useful takeaways are product behavior, not implementation.

## What Mirrobot is strong at

| Surface                         | What they do                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mention UX                      | Eyes on the triggering comment within seconds, rocket on success, confused on failure. The Actions run is not the only "bot heard you" signal.                                 |
| Author-facing review            | Plain-language verdict, severity icons on every finding, previous-feedback status on follow-up, SHA footer so the next run knows what it already reviewed.                     |
| Thread context                  | Three-block discussion: this agent's latest reviews (unfiltered), older own reviews (filtered), everyone else (noise-filtered). Other AI reviewers are leads, never authority. |
| Routing audit                   | One comment-triggered workflow parses once and dispatches one target. The router run's step summary is the record of why the agent did or did not respond.                     |
| Merge audit                     | `/mirrobot-check` is a separate compliance pass that posts a real status check. Review and merge-readiness are not the same job.                                               |
| Modes that shuvbot still no-ops | Issue analysis on open, mention Q&A, "fix this" → branch/PR. Those are SPEC modes (`triage`, `implement`) that shuvbot has not wired to a real agent.                          |
| Prompt discipline               | 33 parts assembled by 13 manifests, with 325 wording pins in CI. Drift in load-bearing instructions fails the build.                                                           |

## What shuvbot already does better

Do not take these from Mirrobot. We would be going backwards.

- **Permissions are code, not prompt.** Mirrobot's deny-by-default bash profile lives in an OpenCode config secret. Shuvbot's `RuntimePolicy` cannot be widened by model output or event payload.
- **PR content is never checked out into a privileged job.** Mirrobot fetches the PR head, then scrubs auto-load files. Shuvbot coordinator review keeps the trusted default branch and treats PR text as bounded workspace data.
- **Finding lifecycle is structured.** Fingerprints, hidden state, user-resolved threads, and degraded-run protection already cover follow-up better than re-reading the last review body.
- **Quorum and specialists.** Six reviewers plus a coordinator, with coverage that cannot claim clean when a required reviewer is missing.
- **Cost is captured.** Session usage is accumulated even on timeout. Mirrobot's `--share` session is operator-visible in a different way; we already have the numbers, we were just not showing them.

`APPROVE` stays rejected. Mirrobot's approval ladder is thoughtful and we should not adopt the event.

## Taken in this change

1. **Mention reactions.** Eyes / rocket / confused on the triggering comment only. Cosmetic: a GitHub failure posting them does not fail the run. Ambient `pull_request` events have nothing to react on.
2. **Author-facing review body.** Verdict line, severity-grouped finding list, previous-feedback counts, unmappable findings kept in the body. Coverage stays in a `<details>` block. The CLI report is unchanged.
3. **Workflow summary spend.** Input/output tokens, cost, and per-session rows. A timed-out specialist can no longer look like a cheap clean run in the Actions UI.

## Worth taking later (not in this change)

Ordered by how well they fit the current architecture.

1. **Thread-context assembly for the coordinator.** Feed previous own reviews and a noise-filtered thread into the shared workspace, labeled untrusted. Finding state already knows _what_ was open; the model still cannot see _why_ the author replied.
2. **Issue analysis / mention Q&A.** SPEC `triage` mode. Mirrobot's investigator/conversationalist split is a prompt strategy; shuvbot should keep mode selection deterministic (`@shuvbot ask`) and only then run an agent.
3. **Compliance / merge-readiness as a distinct mode.** Do not overload review. A `/shuvbot check` (or `fix-ci`'s cousin) that posts a status is the right shape if we want a merge gate.
4. **Prompt-part pins.** Shuvbot prompts are TypeScript strings. Pinning load-bearing sentences in tests is the analogue of Mirrobot's 325 rules, without a bash assembler.
5. **Shareable session traces.** If the pinned shuvcode runtime grows a safe share URL, link it from the workflow summary. Do not paste transcripts into the PR.

## Do not take

- Checking out PR heads into a job that holds provider credentials.
- `pull_request_target` stubs, even zero-secret ones, unless the security model is re-derived from scratch.
- OpenCode config (including API keys) stuffed into a single GitHub secret.
- Agent-owned `gh` posting. Posting stays in shuvbot code behind `policy.canReview`.
- Workspace scrub of `AGENTS.md` / `.cursor/` as a substitute for not executing PR code.
- Automatic review on every `opened` / `synchronize`. This repository's own workflow is mention-only on purpose.

## Mapping cheat sheet

| Mirrobot                               | Shuvbot today                               | Move                                                          |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Agent router + step-summary audit      | Single workflow, `explainUnhandledRun`      | Keep one workflow; richer summary is the audit trail          |
| Fast eyes / rocket / confused          | Nothing on the mention                      | Taken                                                         |
| FIRST vs FOLLOW-UP prompt + SHA footer | Finding fingerprints + hidden state         | Keep ours; add previous-feedback to the posted body (taken)   |
| Severity 🔴🟠🟡🔵                      | `critical`/`high`/`medium`/`low`/`info`     | Icons on posted comments (taken)                              |
| Justified verdict, including APPROVE   | Decision + posting policy, never APPROVE    | Human verdict, still no APPROVE (taken)                       |
| Three-block discussion                 | Patch + post-change contents + hidden state | Later, as labeled untrusted context                           |
| Issue analysis                         | Unwired `triage`                            | Later                                                         |
| Bot reply strategies                   | Unwired `implement` / `ask`                 | Later                                                         |
| Compliance check                       | Unwired, plus optional `fail_check`         | Later, as its own mode                                        |
| Prompt parts + CI pins                 | TypeScript prompts + evals                  | Later, as string pins                                         |
| Workspace scrub                        | No PR checkout                              | Do not take                                                   |
| `opencode run --share`                 | JSONL + artifacts                           | Summary spend (taken); share URL later if the runtime has one |
