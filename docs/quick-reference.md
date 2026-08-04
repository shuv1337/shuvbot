# Quick reference

Day-to-day usage. `docs/config.md` has the full settings reference, `docs/commands.md` the full
command list, and `docs/troubleshooting.md` the diagnostics.

The two paths are different engines, on purpose:

|         | Local CLI                                       | GitHub Action                            |
| ------- | ----------------------------------------------- | ---------------------------------------- |
| Engine  | Coordinator: six specialists plus a coordinator | Single Claude Code agent                 |
| Models  | Curated catalog, per role                       | One model for the run                    |
| Runs on | Your machine, your shuvcode subscription        | GitHub runner, `CLAUDE_CODE_OAUTH_TOKEN` |
| Output  | Terminal, JSON, run artifacts                   | PR review comments, check, step summary  |

Changing local models does not change what the Action does.

## Local reviews

```bash
bun packages/cli/src/index.ts review --base main --head HEAD
```

From another repository, point at this checkout:

```bash
cd ~/repos/some-project
bun ~/repos/shuvbot/packages/cli/src/index.ts review --base main --head HEAD
```

The runtime is found in the reviewed repository first, then in reviewbot's own install, so the
reviewed project does not need to depend on `shuvcode`.

| Flag                           | Meaning                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `--base <ref>`                 | Range start. Defaults to `main`.                                              |
| `--head <ref>`                 | Range end. Defaults to `HEAD`.                                                |
| `--config <path>`              | Load a specific TOML instead of `./reviewbot.toml`. Missing file is an error. |
| `--engine coordinator\|legacy` | Override the configured engine. `legacy` fails closed.                        |
| `--json`                       | Stable machine-readable report instead of progress output.                    |

The range is three-dot, so `--base main --head HEAD` reviews what your branch adds relative to
`main`. Flags are strict: unknown, duplicate, or valueless options fail rather than being ignored.

Reviews read **committed** history. Uncommitted work is invisible, so commit before reviewing or the
feedback describes the previous state.

Common ranges:

```bash
--base HEAD~1 --head HEAD   # last commit
--base main   --head HEAD   # whole branch
--base origin/master --head HEAD
```

### Reading the result

Size picks the tier, which picks the roster: `trivial` runs one reviewer, `lite` five, `full` all
six. Quorum decides whether the run is trustworthy, so a review can be honest about being
incomplete rather than reporting a clean result it did not earn.

```
[completed] release | elapsed 1m 16s | coverage 6/6 | required 2/2
Decision: MINOR ISSUES
Coverage: 6/6 reviewers | quorum met
- [medium/new] Duplicate-draft check compares a literal string (PLAN.md:53, documentation)
```

- `CLEAN`, `MINOR ISSUES`, `SIGNIFICANT CONCERNS` - the coordinator's verdict.
- `DEGRADED - REVIEW INCOMPLETE` - too many specialists failed to trust the result.
- `coverage a/b` - specialists that returned a valid result; `required` counts the ones this tier
  needs.

Findings are `[severity/state] summary (file:line, reviewer)`.

### Configuration

A `reviewbot.toml` in the repository being reviewed. Everything is optional.

```toml
[review]
engine = "coordinator"   # default
max_concurrency = 3      # specialists in flight
overall_timeout = "15m"
incremental = true       # remember findings between runs

[review.models]
coordinator = "subscription/claude-opus-5@medium"
standard    = "subscription/grok-4.5@high"
light       = "subscription/gpt-5.6-luna@max"

[review.tiers.full]
reviewers = ["code-quality", "security", "performance", "tests", "documentation", "release"]

[[review.reviewers]]
id = "security"
paths = ["src/api/**"]
prompt_append = "Treat every request body as untrusted."

[paths]
ignore = ["dist/**", "**/*.snap"]
```

Model names are `subscription/<model>` or `subscription/<model>@<effort>`, resolved through the
curated catalog in `packages/review/src/runtime/model-catalog.ts`. That file is where you add a
model, change a role default, or record which efforts a model accepts. A per-reviewer `model` must
be one the configuration already selects for a role.

### Artifacts

Each run writes `.reviewbot/runs/<id>/`:

| File                              | Contents                                            |
| --------------------------------- | --------------------------------------------------- |
| `reviewbot-run.json`              | Run record: timings, engine, config summary         |
| `reviewbot-review-result.json`    | Decision, coverage, quorum, retries                 |
| `reviewbot-review-sessions.json`  | Per-session model, status, usage, errors            |
| `reviewbot-events.jsonl`          | Redacted session timeline                           |
| `reviewbot-findings.json`         | Findings as structured data                         |
| `reviewbot-rejected-results.json` | Only when a result was refused: the offending value |

`.reviewbot/` is gitignored here; add it to `.gitignore` in other repositories.

### When something breaks

```bash
bun packages/cli/src/index.ts doctor    # prerequisites, auth, runtime, model catalog
bun run smoke:runtime                    # drive the pinned runtime end to end
```

| Symptom                                         | Cause                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `REVIEW_CONFIG_INVALID` naming a model          | Model or effort is not curated. The message lists the accepted ones.           |
| `REVIEW_SCHEMA_INVALID`                         | A result failed validation. The value is in `reviewbot-rejected-results.json`. |
| `Cannot resolve the installed shuvcode package` | Run `bun install` in this checkout.                                            |
| Runtime pin mismatch                            | `review.shuvcode.version` must equal the code-approved pin.                    |
| `no_changes` / `no_reviewable_changes`          | The range is empty or entirely ignored by `[paths]`.                           |
| Review describes code you already fixed         | Uncommitted work. Commit and rerun.                                            |

## GitHub reviews

`.github/workflows/reviewbot.yml` runs the published action on pull requests targeting `master`. It
is **advisory**: it comments but never blocks a merge.

```yaml
- uses: shuv1337/shuvbot@v0
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Requires the `CLAUDE_CODE_OAUTH_TOKEN` secret (`docs/claude-token.md` to mint one). Fork pull
requests are skipped, because secrets are not available to them, and drafts wait for
`ready_for_review`.

Useful inputs: `mode`, `model`, `config`, `timeout`, `activity_timeout`, `push`, `shell`, `prompt`.
Outputs: `result`, `review_findings`, `summary`. Failure diagnostics upload as the `reviewbot`
artifact.

To make it blocking, set these in `reviewbot.toml` - both default to `false`, so decide deliberately:

```toml
fail_check = true       # fail the check run
request_changes = true  # request changes on the PR
fail_on = "high"        # severity that counts
```

Only **review** mode runs a real agent. `implement`, `improve`, `fix-ci`, `ask`, and `describe` run
their policy and tooling path and stop at a documented no-op. See `docs/workflows.md`.

Mention commands like `@reviewbot review` are handled by the action, but this workflow only listens
to `pull_request`. Add an `issue_comment` trigger to use them.

## Choosing a path

- Working locally, want depth and control over models: local CLI.
- Want a second opinion on someone's PR, in the PR: GitHub Action.
- The Action does not run the coordinator, and local reviews do not post to GitHub. Routing the
  Action through the coordinator is unfinished work.
