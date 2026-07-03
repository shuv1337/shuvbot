# Workflows

**Only `review` mode calls a real agent in this version.** `implement` and
`fix-ci` run their full policy/branch/tooling path but end in a no-op agent
step that says so in the run summary - see the notes on each workflow below.

## Automatic PR Review

Review mode needs Claude credentials in addition to the GitHub token: expose
`CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to the step via `env:`, or
the run will fail with a Claude auth error. When the real agent fails before
normal review artifacts are written, reviewbot logs a redacted diagnostic tail
and persists it as `$RUNNER_TEMP/reviewbot/reviewbot-agent-error.txt`.

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  - uses: shuv1337/shuvbot@v0
    with:
      token: ${{ secrets.GITHUB_TOKEN }}
    env:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Obtain `CLAUDE_CODE_OAUTH_TOKEN` locally with `reviewbot auth claude setup-token --repo <owner>/<repo>` (see `docs/claude-token.md`), or use `ANTHROPIC_API_KEY` instead.

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

Replace `shuv1337/shuvbot@v0` with the release commit SHA for immutable production workflows:

```yaml
- uses: shuv1337/shuvbot@<release-commit-sha>
```

Third-party actions in examples are SHA-pinned. Keep job permissions explicit and minimal.
