# Commands

Mention commands use the `@reviewbot` prefix:

- `@reviewbot review` maps to review mode.
- `@reviewbot implement <task>` maps to trusted implementation mode.
- `@reviewbot improve <task>` maps to implementation mode.
- `@reviewbot fix-ci` maps to CI repair mode.
- `@reviewbot ask`, `explain`, and `summarize` map to triage mode.
- `@reviewbot describe`, `changelog` map to release-notes mode.
- `@reviewbot test-plan` maps to review mode.

CLI commands:

- `reviewbot review --base main --head HEAD`
- `reviewbot replay --fixture fixtures/events/pull_request.opened.json --dry-run`
- `reviewbot doctor`
- `reviewbot auth claude setup-token`
- `reviewbot auth claude import`
- `reviewbot config validate [path]`
