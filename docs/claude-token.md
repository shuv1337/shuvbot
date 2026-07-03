# Claude Token

Claude Code is the first-class initial agent driver for reviewbot.

## Auth priority

Reviewbot resolves Claude credentials in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN`
2. `ANTHROPIC_API_KEY`

If both are present, `CLAUDE_CODE_OAUTH_TOKEN` wins. Blank values are ignored.

## Setup-token flow

Use the local Claude CLI to create a long-lived token:

```bash
reviewbot auth claude setup-token
```

To store it directly as a GitHub secret:

```bash
reviewbot auth claude setup-token --repo owner/repo
```

The default secret name is `CLAUDE_CODE_OAUTH_TOKEN`. Override it with:

```bash
reviewbot auth claude setup-token --repo owner/repo --secret CLAUDE_CODE_OAUTH_TOKEN
```

You can also pipe an existing token:

```bash
claude setup-token | reviewbot auth claude import --repo owner/repo
```

## Runtime handling

- Token values are masked with the GitHub Actions secret masker when available.
- Token values are passed only to the selected Claude Code driver process.
- Token values are not included in prompts, MCP tool inputs, logs, workflow summaries, or shell subprocesses.
- Claude Code receives the reviewbot MCP server through the local Claude CLI `--mcp-config` flag with `--strict-mcp-config`.
- Reviewbot model aliases such as `claude/sonnet` are resolved to Claude CLI-compatible model IDs before being passed to `--model`.
- On non-zero Claude exits, reviewbot reports a bounded, redacted tail of stdout and stderr so CLI errors that appear on stdout remain diagnosable.

## Doctor checks

Run:

```bash
reviewbot doctor
```

The doctor checks config validity, `gh` auth, Claude CLI availability, Claude auth source, git state, Bun/Node versions, MCP server startup, and redaction behavior.
