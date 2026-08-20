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
4. Project workflow metadata and the validated artifact into the D1 read model.
5. Expose only GET endpoints to the browser and render untrusted GitHub text as
   escaped text or sanitized Markdown.

This avoids a new write endpoint in v1. The source of truth remains GitHub
Actions plus GitHub's review/comment APIs. The dashboard can cache responses on
the server for a short period without becoming an authoritative store.

## Read model

The dashboard should project one record per Action run:

- `runId`, workflow run ID, repository, PR or issue number, triggering comment
  ID, actor, command, mode, event, status, timestamps, and links.
- Review decision, quorum state, finding count, and workflow URL.
- Per-session status, model, attempts, token usage, cost, and classified error.
- Redacted failure information and artifact availability.

The artifact must be treated as untrusted input even though it came from the
trusted workflow. Validate schema versions, bound field sizes, and never expose
raw session traces or rejected model payloads by default.

## Known v1 limits

- GitHub artifact retention bounds history unless repositories retain artifacts
  indefinitely or a later v2 adds an append-only archive.
- v1 does not join pull-request review comments, issue comments, thread
  resolution state, subject titles, or final review URLs. Those require a later
  read-model and GitHub API expansion.
- Local CLI runs are not visible unless a later exporter is added. v1 should
  explicitly label them as outside the dashboard's source boundary.

## Implementation status

The hosting target is Cloudflare Workers with D1. The first implementation slice
lives in `packages/dashboard` and includes the D1 schema, bounded artifact
projection, GET-only API, and read-only run list UI. It deliberately stores no
raw event stream, rejected model payload, or unvalidated artifact JSON.

The current ingestion boundary treats the downloaded artifact set as version 1.
Coordinator `shuvbot-findings.json` files must carry their existing `version: 1`;
the legacy findings array and the currently unversioned `shuvbot-run.json` are
validated by the dashboard's own bounded schemas before projection.

GitHub App polling is implemented as a server-side scheduled handler. It requires
a server-side App identity with read-only Actions and metadata access. Browser routes
must remain GET/HEAD-only when scheduled polling is added; credentials and D1
writes stay behind the Worker boundary.

The scheduled poller runs every 15 minutes and reads bounded recent workflow
runs from each GitHub App installation. Configure `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` with `wrangler secret put`; neither belongs in
`wrangler.jsonc` or browser code. ZIP ingestion accepts only the expected
top-level files, rejects traversal/duplicates/unknown versions, caps each
extracted file at 8 MiB, and caps aggregate extracted content at 16 MiB before
JSON parsing. Artifact redirects are followed manually only to allowlisted
GitHub Actions or Azure Blob hosts, without forwarding the installation token.

One scheduled invocation examines at most 10 installations, 20 repositories,
and 10 recent completed runs per repository, and ingests at most five new runs.
Each run validates the complete producer collections, then stores at most the
first 100 findings and 20 session summaries. Bulk inserts stay under D1's
100-bound-parameter query limit. These bounds assume a Workers Paid
deployment's 1,000-query/subrequest allowance rather than the Free plan's 50.

`workers_dev` is disabled deliberately. The `shuvbot.shuv.dev` custom domain is
protected by a Cloudflare Access application before the route is deployed;
otherwise a read-only dashboard can still leak private repository history. The
Worker itself exposes no browser write route, but Cloudflare Access remains the
viewer-authentication boundary.
