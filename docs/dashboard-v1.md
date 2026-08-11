# Dashboard v1

## Goal

Provide a centralized, read-only view of every manual shuvbot invocation across
the configured repositories. A run should be discoverable by repository, pull
request or issue, triggering comment, status, mode, duration, findings, and
runtime usage.

## Trigger contract

The action accepts work only when both conditions hold:

- The GitHub event is an `issue_comment` on a pull request or issue, or a
  `pull_request_review_comment`.
- The comment contains a recognized `@shuvbot <command>` mention.

PR bodies, issue bodies, workflow dispatch, schedules, workflow runs, and direct
pull-request events are observationally skipped. The repository workflow also
filters these events before the job starts, but the action enforces the same
rule for callers that invoke it through another workflow.

## Recommended architecture

Use a small server-side dashboard backed by a GitHub App with read-only
permissions. Do not give the browser a GitHub token or the Action's
write-capable `GITHUB_TOKEN`.

The dashboard server should:

1. Enumerate installations and repositories permitted by the App.
2. Find the `shuvbot` workflow runs for each repository.
3. Read run metadata and download the uploaded `shuvbot` artifact.
4. Join the artifact run record with pull-request reviews, review comments,
   issue comments, and thread resolution state.
5. Expose only GET endpoints to the browser and render untrusted GitHub text as
   escaped text or sanitized Markdown.

This avoids a new write endpoint in v1. The source of truth remains GitHub
Actions plus GitHub's review/comment APIs. The dashboard can cache responses on
the server for a short period without becoming an authoritative store.

## Read model

The dashboard should project one record per Action run:

- `runId`, workflow run ID, repository, PR or issue number, triggering comment
  ID, actor, command, mode, event, status, timestamps, and links.
- Review decision, degraded/quorum state, finding counts, finding lifecycle
  counts, and review/comment URLs.
- Per-session status, model, attempts, token usage, cost, and classified error.
- Redacted failure information and artifact availability.

The artifact must be treated as untrusted input even though it came from the
trusted workflow. Validate schema versions, bound field sizes, and never expose
raw session traces or rejected model payloads by default.

## Known v1 limits

- GitHub artifact retention bounds history unless repositories retain artifacts
  indefinitely or a later v2 adds an append-only archive.
- A dashboard refresh may need several GitHub API calls because run records and
  review comments are separate resources.
- The current run record does not persist the final review URL directly; the
  dashboard can join that URL from the workflow run and GitHub review data.
- Local CLI runs are not visible unless a later exporter is added. v1 should
  explicitly label them as outside the dashboard's source boundary.

## Follow-up before implementation

Choose the dashboard hosting target and GitHub App ownership model. The minimum
required App permissions are read-only Actions, pull requests, issues, and
metadata access. Once selected, implement the server-side GitHub client,
artifact parser, bounded read model, and a read-only UI as a separate package so
dashboard credentials and UI code never enter the Action bundle.
