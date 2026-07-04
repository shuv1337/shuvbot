# Troubleshooting

Run diagnostics:

```bash
reviewbot doctor
```

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
