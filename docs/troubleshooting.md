# Troubleshooting

Run diagnostics:

```bash
reviewbot doctor
```

From this repository without an installed `reviewbot` binary, use:

```bash
bun packages/cli/src/index.ts doctor
```

Doctor looks for `reviewbot.toml` in the current working directory; the CLI does not expose a doctor
config-path option. It checks config loading, GitHub CLI and Claude availability, Claude auth presence,
git, Bun, Node, MCP startup/shutdown, and redaction. Its exit is strict: any failed check makes the
command exit nonzero, even when that check is unrelated to the selected review engine; warnings and
skipped checks do not change the exit status. When that config sets
`review.engine = "coordinator"`, doctor also checks the exact shuvcode package and public
`shuvcode/client` export, local auth readiness through a public `auth.status()` operation,
isolated runtime launch and health-version agreement, and non-generating resolution of the
coordinator, standard, and light models through public provider and model catalogs. Doctor never
reads credential values. Auth readiness is local and structural only: doctor displays
`verification: not_performed` and does not claim that a provider has accepted the credential. If an
older packed client has no auth-status capability, doctor fails with an exact-release diagnostic and
does not launch it.
With the legacy engine selected, coordinator checks are skipped warnings. A passing probe verifies
prerequisites; it does not replace a real review.

`review.engine` defaults to `"coordinator"` and local coordinator review runs against the approved
`shuvcode@2.0.0-alpha-9` pin. It needs a local shuvcode profile with an authenticated provider; the
runtime resolves from the reviewed repository first and from reviewbot's own install second. A
configured version that differs from the code-approved pin still fails before Git, and so does the
`legacy` engine, which has no safe production driver. Do not work around a pin mismatch with a
version range, workspace-private import, or guessed version.

If a specialist or coordinator result is refused as `REVIEW_SCHEMA_INVALID`, the refused value is
kept, redacted and truncated, in `.reviewbot/runs/<id>/reviewbot-rejected-results.json` together with
the validation reason.

To run a local review:

```bash
bun run dogfood:review -- --base main --head HEAD
```

Add `--json` for the stable sanitized JSON report, or `--config <path>` to load a particular TOML
file instead of the auto-loaded `reviewbot.toml` in the current working directory. The script already
supplies `--engine coordinator`; duplicate flags are rejected, so do not append another `--engine`.

Common failures:

- Config rejected: run `reviewbot config validate reviewbot.toml`.
- Claude CLI missing (`claude: not found`): install Claude Code before the shuvbot action step and add `$HOME/.local/bin` to `GITHUB_PATH` as shown in `docs/workflows.md`.
- No Claude auth: set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Review-mode agent failures include a redacted stdout/stderr tail in the step log and in `$RUNNER_TEMP/reviewbot/reviewbot-agent-error.txt` when the pipeline fails before normal review artifacts are written.
- No comments posted: check job `permissions`, runtime policy reasons, and fork status.
- Shell denied: shell is disabled for forks and untrusted actors; Docker is required for restricted shell.
- Push denied: implementation and fix-ci only push to `reviewbot/*` branches.
- Inline comment missing: the finding line must map to a diff position; otherwise it falls back to the summary.
- Evals failing: run `bun run evals` and inspect the markdown summary table.
- Action startup fails with `ERR_MODULE_NOT_FOUND` for `@actions/core` or another package: the committed `dist/index.js` is not self-contained. Run `bun run build`, commit the regenerated bundle, and verify with `bun test packages/action/test/dist-bundle.test.ts`.

## Action output failures

- `result` is empty or just `{"status":"initialized",...}`: the run didn't match a mode that calls a real agent. Only `review` mode does today - see `docs/workflows.md`.
- `review_findings` is `[]` on a PR you expect findings on: check the workflow summary's "Errors" table first (redacted). Also check `reportOn`/`minConfidence`/`failOn` in your config; findings below threshold are dropped, not silently kept. If every review skill failed before findings were produced, the action fails and writes redacted agent diagnostics to the step log and `$RUNNER_TEMP/reviewbot/reviewbot-agent-error.txt`.
- Setting `output_schema` in `with:` does nothing: this input was removed from `action.yml` - it isn't implemented yet (see `docs/workflows.md`).
- A downstream step can't read `steps.<id>.outputs.result`: confirm the step has an `id:` and that `action.yml`'s `outputs:` block still lists `result`/`review_findings`/`summary` (it should - if a fork/local build stripped it, GitHub Actions won't expose the output even though `core.setOutput` still writes it to `$GITHUB_OUTPUT`).
- Coordinator config rejected: the schema requires package name `shuvcode` and an exact semver rather than a range. Executable approval is enforced separately by the nullable code-owned runtime pin.
- Legacy review unavailable: this is expected in production local use. The default is retained for migration compatibility, but only tests/embeddings inject a legacy driver.
- Coordinator runtime not approved: wait for the corrected release to be published and packed-smoked and for `APPROVED_SHUVCODE_RUNTIME_VERSION` to be updated. Installing the `1.18.4` source baseline does not bypass the pre-Git rejection.
- Coordinator package missing: install the eventual exact published pin in the project; shuvbot must resolve both its CLI and public `shuvcode/client` export from that package.
- Coordinator startup or health mismatch: confirm the installed package version equals the configured pin. Startup is isolated on loopback/stdio and health must report the same version.
- Coordinator auth capability unsupported: install the exact corrected release once published. The completed public `auth.status()` contract is required; doctor will not parse auth storage or launch an older client when it is absent.
- Coordinator auth unavailable: authenticate through the user's normal shuvcode profile. Doctor checks only configured source/type, structural usability, detectable OAuth expiry, and storage availability. `verification: not_performed` means no provider request, refresh, model generation, or remote validity check occurred. Shuvbot does not read or print credential values, profile identifiers, auth paths, or raw storage errors.
- Coordinator user auth disabled: local coordinator mode requires `review.shuvcode.use_user_auth = true` and fails before git, state, workspace, or runtime work when it is false. Non-interactive auth is not implemented.
- Coordinator model catalog unsupported: the packed client must expose public `provider.list()` and `model.list()` operations. Doctor does not create or interrupt a session as a model probe and consumes no model quota.
- Coordinator model unresolved: use a model present in the public provider/model catalogs. Repository config cannot add a provider or credentials.
- Coordinator appears idle: human mode prints a heartbeat after 30 seconds without session activity, with elapsed time and coverage. `--json` intentionally prints no progress so stdout remains one valid JSON document.
- Coordinator artifacts missing: inspect `.reviewbot/runs/<run-id>/` for `reviewbot-events.jsonl`, `reviewbot-review-sessions.json`, `reviewbot-review-result.json`, `reviewbot-run.json`, and `reviewbot-findings.json`. Every invocation uses a new run ID; these files survive temporary workspace cleanup and do not replace incremental state under `.reviewbot/state/reviews/`.
- Coordinator report is degraded: inspect failed and timed-out reviewer names and coverage. Below quorum cannot claim clean or request changes because coverage failed, although independently verified findings may still be shown.
- Coordinator command exits zero after a degraded report: this is current behavior. Only `failed`, `timed_out`, `cancelled`, or a thrown command error sets a nonzero exit for local coordinator review.
- Coordinator reports `no_changes` or `no_reviewable_changes`: these are successful not-run results and exit zero. The first means the range has no changed files; the second means global paths or deterministic filters excluded every changed file.
- Coordinator final output fails: progress writes are best-effort, but the final human/JSON write is authoritative and a write error fails the command. Artifact persistence failure likewise changes coordinator status to `failed` and exits nonzero.
- Coordinator preprocessing exceeds limits: `review.overall_timeout` starts before ref resolution, preprocessing consumes the runtime budget, and only the remaining time reaches coordinator execution. Durations are capped at `2147483647ms`; local collection is capped at 1,000 changed files, 1,501 planned Git processes, and 64 MiB of Git output. Narrow `base...head` or use `[paths]` global include/ignore filters.
- Prior finding unexpectedly remains after a degraded run: this is intentional. Incremental reconciliation does not infer that a finding was fixed from incomplete coverage.
- Incremental runs do not share history: confirm both runs resolve the same `origin` repository and base commit. Base aliases and linked Git worktrees share state, but a different resolved base commit or unrelated repository intentionally starts another lineage. Repositories without `origin` use an owner-only identity in their shared Git common directory.
- Expected GitHub review output is absent: the coordinator preview is wired only to the local CLI; GitHub Action integration and posting are not implemented.
