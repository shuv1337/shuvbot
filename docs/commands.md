# Commands

Mention commands use the `@reviewbot` prefix:

- `@reviewbot review` maps to review mode. Runs a real agent.
- `@reviewbot implement <task>` maps to trusted implementation mode. Not yet wired to a real agent - see `docs/workflows.md`.
- `@reviewbot improve <task>` maps to implementation mode. Not yet wired to a real agent - see `docs/workflows.md`.
- `@reviewbot fix-ci` maps to CI repair mode. Not yet wired to a real agent - see `docs/workflows.md`.
- `@reviewbot ask`, `explain`, and `summarize` map to triage mode. Not yet wired to a real agent.
- `@reviewbot describe`, `changelog` map to release-notes mode. Not yet wired to a real agent.
- `@reviewbot test-plan` maps to review mode.

CLI commands:

- `reviewbot review --base main --head HEAD [--config <path>] [--engine legacy|coordinator] [--json]`
- `reviewbot replay --fixture fixtures/events/pull_request.opened.json --dry-run`
- `reviewbot doctor`
- `reviewbot auth claude setup-token`
- `reviewbot auth claude import`
- `reviewbot config validate [path]`

`review` uses a three-dot Git range and defaults to `main...HEAD`. A local `reviewbot.toml` is loaded
when present; an explicit missing `--config` is an error. Flags are strict: unknown, positional,
missing-value, invalid, and duplicate options fail rather than being ignored.

`coordinator` is the config default and runs real multi-agent reviews against the approved
`shuvcode` runtime pin, with live progress, stable JSON, explicit `no_changes` and
`no_reviewable_changes` results, incremental state, and durable artifacts. `legacy` stays selectable
but has no safe production driver and fails closed before Git. The GitHub Action does not route to
the coordinator; it runs a single Claude Code agent.

`doctor` is a strict prerequisite command: any check with status `fail` makes it exit nonzero,
including general GitHub CLI, Claude, Claude-auth, Git, Bun, Node, MCP, or redaction failures. Warnings
and skipped coordinator checks do not affect its exit status. With coordinator config it additionally
checks the configured packed package/client capabilities, local auth structure, isolated launch, and
non-generating model catalog resolution; a passing diagnostic verifies prerequisites rather than
replacing a real review.
