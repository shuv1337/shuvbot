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

- `reviewbot review --base main --head HEAD`
- `reviewbot replay --fixture fixtures/events/pull_request.opened.json --dry-run`
- `reviewbot doctor`
- `reviewbot auth claude setup-token`
- `reviewbot auth claude import`
- `reviewbot config validate [path]`
