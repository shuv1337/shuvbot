# Troubleshooting

Run diagnostics:

```bash
reviewbot doctor
```

Common failures:

- Config rejected: run `reviewbot config validate reviewbot.toml`.
- No Claude auth: set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- No comments posted: check job `permissions`, runtime policy reasons, and fork status.
- Shell denied: shell is disabled for forks and untrusted actors; Docker is required for restricted shell.
- Push denied: implementation and fix-ci only push to `reviewbot/*` branches.
- Inline comment missing: the finding line must map to a diff position; otherwise it falls back to the summary.
- Evals failing: run `bun run evals` and inspect the markdown summary table.
