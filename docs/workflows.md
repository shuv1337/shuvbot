# Workflows

**Only `review` mode calls a real agent in this version.** `implement` and
`fix-ci` run their full policy/branch/tooling path but end in a no-op agent
step that says so in the run summary - see the notes on each workflow below.

## Automatic PR Review

Review mode needs the Claude Code CLI on `PATH` and Claude credentials in
addition to the GitHub token: install Claude Code before the shuvbot step, then
expose `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to the step via
`env:`, or the run will fail with a Claude auth error. When the real agent
fails before normal review artifacts are written, reviewbot logs a redacted
diagnostic tail and persists it as `$RUNNER_TEMP/reviewbot/reviewbot-agent-error.txt`.

```yaml
name: reviewbot
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: {}

jobs:
  review:
    # Public repos can add this guard to skip fork PRs without secrets:
    # if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      checks: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Claude Code
        run: |
          curl -fsSL https://claude.ai/install.sh | bash
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - name: Verify Claude Code
        run: claude --version
      - uses: shuv1337/shuvbot@v0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - name: Upload reviewbot artifacts
        if: always()
        uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
        with:
          name: reviewbot
          path: ${{ runner.temp }}/reviewbot
          if-no-files-found: warn
```

Obtain `CLAUDE_CODE_OAUTH_TOKEN` locally with `reviewbot auth claude setup-token --repo <owner>/<repo>` (see `docs/claude-token.md`), or use `ANTHROPIC_API_KEY` instead. Public repositories should keep `pull_request` (not `pull_request_target`) and add `if: github.event.pull_request.head.repo.full_name == github.repository` on the job when credentials are unavailable to fork PRs; those fork PRs will be skipped instead of failing the Claude auth check.

## Mention-Driven Implement

Not yet wired to a real agent in this version. Trusted collaborators can comment:

```text
@reviewbot implement fix the failing parser test
```

The bot creates/fast-forwards a `reviewbot/*` branch and validates implement-mode
policy, but the agent step itself is a no-op: it writes no patch, runs no
commands, and opens no PR. Fork and untrusted contexts keep shell/push
disabled regardless.

## CI Repair

Not yet wired to a real agent in this version. The bot reads failed check logs
and validates fix-ci policy, but the agent step is a no-op: it attempts no
fix and pushes no commit. The workflow below still runs end-to-end and posts
a summary explaining that no fix was attempted.

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: read
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  - name: Install Claude Code
    run: |
      curl -fsSL https://claude.ai/install.sh | bash
      echo "$HOME/.local/bin" >> "$GITHUB_PATH"
  - name: Verify Claude Code
    run: claude --version
  - uses: shuv1337/shuvbot@v0
    with:
      mode: fix-ci
      token: ${{ secrets.GITHUB_TOKEN }}
```

## Standalone Step / Structured Output

Not yet wired to a real agent in this version. `output_schema` was removed
from `action.yml` - it was read into memory but nothing ever validated
output against it (SPEC §23.1's parse/validate/retry loop was never built).
A step with no matching event/mode still runs successfully and sets
`result` to a small status object (`runId`, `status: "initialized"`,
`mode`, `trigger`), but no agent is invoked and no schema-validated output
is produced. Only `review` mode currently produces real `result`,
`review_findings`, and `summary` outputs.

## Hardened SHA-Pinned Variant

Replace `shuv1337/shuvbot@v0` with an immutable point release or exact commit SHA for reproducible production workflows:

```yaml
- uses: shuv1337/shuvbot@v0.1.0
# or
- uses: shuv1337/shuvbot@<release-commit-sha>
```

Third-party actions in examples are SHA-pinned. Keep job permissions explicit and minimal.
