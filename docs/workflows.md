# Workflows

## Automatic PR Review

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
```

## Mention-Driven Implement

Trusted collaborators can comment:

```text
@reviewbot implement fix the failing parser test
```

The bot creates a `reviewbot/*` branch, posts progress, and opens or updates a PR. Fork and untrusted contexts keep shell/push disabled.

## CI Repair

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

## Hardened SHA-Pinned Variant

Replace `shuv1337/shuvbot@v0` with the release commit SHA for immutable production workflows:

```yaml
- uses: shuv1337/shuvbot@<release-commit-sha>
```

Third-party actions in examples are SHA-pinned. Keep job permissions explicit and minimal.
