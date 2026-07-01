# reviewbot

`reviewbot` is a GitHub-native code review and coding-agent action. It reviews pull requests, responds to trusted `@reviewbot` mentions, can run a guarded CI repair loop, and keeps all runtime authority in deterministic policy code rather than prompts or GitHub payloads.

**Status: review mode is live in this version.** It runs the real Claude Code
driver against the MCP tool server and posts real findings. `implement` and
`fix-ci` modes exist end-to-end (policy, branch prep, commit/PR tooling) but
are not yet wired to a real agent - they currently no-op and say so in their
run summary. See `docs/workflows.md` for details.

## Secure Quickstart

```yaml
name: reviewbot
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: shuv1337/shuvbot@v0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config: reviewbot.toml
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Start with:

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun run evals
```

## Configuration

Create `reviewbot.toml` only when defaults need changing:

```toml
agent = "claude-code"
model = "claude/sonnet"
mode = "review"
report_on = "medium"
min_confidence = "medium"
shell = "restricted"
push = "restricted"

[memory]
enabled = false
learnings = false
```

See `docs/config.md`, `docs/security.md`, `docs/workflows.md`, and `docs/claude-token.md`.
