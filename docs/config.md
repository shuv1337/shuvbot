# Configuration

Config is TOML. The local `review` command automatically loads `reviewbot.toml` from the current
working directory when it exists. Use `--config <path>` to select another file explicitly; a missing
explicit file is an error, while a missing default file falls back to built-in defaults.

## Coordinator status

`review.engine = "legacy"` remains the migration default, and production local legacy review fails
closed before Git because no safe driver exists; only tests inject fake agents.

Local coordinator review runs. `shuvcode@2.0.0-alpha-9` is published, the code-approved pin points at
it, its packed CLI and `shuvcode/client` contracts pass `bun run smoke:runtime`, and a real local
subscription review has returned a validated coordinator result. It requires
`review.shuvcode.use_user_auth = true`, a working local shuvcode profile, and the pinned package
installed in the repository being reviewed.

The coordinator is still not supported by the GitHub Action, the documented dogfood matrix and manual
acceptance criteria have not been recorded, and the default engine switch has not been approved, so
the coordinator is not yet a production replacement for the Action's review path.

For a local review, resolution order is:

1. Built-in defaults in `packages/core/src/config.ts`.
2. The complete normalized `reviewbot.toml` from the current working directory, when present.
3. The complete normalized TOML selected by `--config <path>`, which replaces the default file.
4. The `--engine legacy|coordinator` CLI override, if supplied.

`--engine` overrides only `review.engine`; every other setting still comes from the selected config
or its built-in default.

## Local review CLI

From this repository, run the coordinator preview against a three-dot Git range with:

```bash
bun run dogfood:review -- --base main --head HEAD
```

The script already supplies `review --engine coordinator`. The local command supports exactly these
review options:

| Option                         | Behavior                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `--engine legacy\|coordinator` | Overrides the engine selected by config.                                                      |
| `--config <path>`              | Loads that TOML instead of the auto-discovered `reviewbot.toml`.                              |
| `--json`                       | Emits the stable coordinator JSON envelope instead of human coordinator progress and summary. |
| `--base <ref>`                 | Selects the base ref; defaults to `main`.                                                     |
| `--head <ref>`                 | Selects the head ref; defaults to `HEAD`.                                                     |

For example, a config-selected coordinator run can omit the engine override:

```bash
bun packages/cli/src/index.ts review --config reviewbot.toml --base main --head HEAD
```

Unknown, positional, missing-value, invalid-value, and duplicate flags are rejected rather than
ignored or resolved by argument order.

Without `--json`, coordinator mode streams sanitized engine events as sessions are queued, start,
retry, complete, fail, time out, or are cancelled. A heartbeat appears only after a running session
has been quiet for 30 seconds. Every event includes elapsed time and current coverage, followed by a
human report containing the decision, coverage, lifecycle counts, concise finding locations, and
failed or timed-out reviewer names. With `--json`, progress is disabled and stdout is one versioned
object containing
`version`, `engine`, `status`, `tier`, `baseSha`, `headSha`, and `report`. The report is stable and
sanitized for common secret forms; it deliberately omits raw prompts, finding bodies, and evidence.
If a test or embedding injects a legacy driver, legacy mode prints its findings array as JSON and
`--json` does not change that output. The production CLI does not provide such a driver and therefore
fails before Git instead of returning an empty fake review.

Coordinator status `degraded` is reported when the decision is degraded or quorum is not met, but it
does not produce a nonzero process exit by itself. Coordinator statuses `failed`, `timed_out`, and
`cancelled` exit nonzero. Invalid options, config, refs, durations, and other thrown command failures
also exit nonzero. Finding severity or a non-clean completed decision does not currently determine
the local command's exit status. `no_changes` and `no_reviewable_changes` are successful, explicit
not-run results and exit zero.

Progress-output failures are isolated from execution. The final human or JSON write is authoritative:
if it throws, the command fails even if review execution and artifact persistence completed. Failure
to write either the engine artifacts or final run/findings artifacts changes the returned coordinator
status to `failed`, appears in final output when that output can be written, and produces a nonzero CLI
exit.

Common keys:

```toml
agent = "claude-code"
model = "claude/sonnet"
mode = "review"
timeout = "1h"
activity_timeout = "5m"
fail_on = "high"
fail_check = false
request_changes = false
report_on = "medium"
min_confidence = "medium"
shell = "restricted"
push = "restricted"

[review]
# Migration default; production local legacy review currently fails closed without a safe driver.
engine = "legacy" # legacy | coordinator
max_concurrency = 3 # 1-6
overall_timeout = "15m"
incremental = true
# Extends the built-in sensitive-path list; repository config cannot remove defaults.
sensitive_paths = []

[review.shuvcode]
package = "shuvcode"
# Must equal the code-approved executable pin.
version = "2.0.0-alpha-9"
use_user_auth = true

[review.models]
coordinator = "subscription/default-reasoning"
standard = "subscription/default-coding"
light = "subscription/default-fast"

[review.tiers.trivial]
max_lines = 10
max_files = 20
reviewers = ["code-quality"]

[review.tiers.lite]
max_lines = 100
max_files = 20
reviewers = ["code-quality", "tests", "performance", "documentation", "release"]

[review.tiers.full]
reviewers = ["code-quality", "security", "performance", "tests", "documentation", "release"]

[[review.reviewers]]
id = "security"
paths = ["**/*"]
ignore_paths = ["**/*.snap"]
prompt_append = "Apply the repository's documented trust-boundary conventions."
# model = "subscription/default-coding"

[paths]
include = ["**/*"]
ignore = ["dist/**"]

[shell_sandbox]
allow_commands = ["bun", "git"]
deny_commands = ["sudo", "su", "docker", "podman"]

[fix_ci]
max_attempts = 3
max_runtime = "90m"
rerun_checks = true

[memory]
enabled = false
backend = "github"
learnings = false
pr_summaries = true
```

Unknown top-level keys are rejected unless they start with `x-`.

`model` accepts reviewbot aliases such as `claude/sonnet` and `claude/opus`, or a direct provider model ID. The Claude Code driver resolves reviewbot aliases to Claude CLI-compatible model IDs before invoking `claude --print`.

Reviewer overrides are limited to the six built-ins. They may narrow paths, append bounded repository instructions, and select a known model reference. They cannot define tools, providers, credentials, or permission changes. The runtime package and source baseline are schema-controlled, but executable approval is a separate code-owned nullable pin; a parseable version is not permission to launch it.
Coordinator model references must use the `subscription` provider and resolve against the code-owned or runtime-discovered model catalog; configuration cannot register a model by naming it.

## Tier assignment and rosters

Risk assignment happens after deterministic diff-noise filtering:

| Tier      | Assignment                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `trivial` | At most 10 included changed lines, at most 20 files, and no sensitive path. Runs `code-quality`.                                      |
| `lite`    | At most 100 included changed lines, at most 20 files, and no sensitive path. Runs `code-quality`, `tests`, and one relevant reviewer. |
| `full`    | Larger or ambiguous generated changes, or any sensitive path. Runs all six specialists.                                               |

The lite roster is an eligibility list, not five sessions on every lite change. It must include `code-quality`, `tests`, and all content-aware eligible specialists: `performance`, `documentation`, and `release`. The planner selects documentation for documentation-only changes, release for release-note/changeset content, and performance otherwise. Security-sensitive changes are always promoted to full, where `security` is mandatory.

The full roster is `code-quality`, `security`, `performance`, `tests`, `documentation`, and `release`. Repository `sensitive_paths` extend the code-owned defaults for authentication, authorization, cryptography, secrets, permissions, workflows, dependency manifests, migrations, deployment, and release configuration; they cannot remove those defaults.

`max_concurrency` bounds concurrently running specialists, not the roster size. Its default is `3` and its accepted range is 1 through 6. `overall_timeout = "15m"` is the hard deadline supplied to coordinator execution. The local CLI streams the engine's sanitized lifecycle and quiet-heartbeat events; terminal rendering failures do not change review execution.

The overall deadline starts before base/head resolution. Git preprocessing, plugin and state
preparation, and workspace creation consume that budget; only the remaining time is passed to runtime
execution. It is not only a model timeout. Reconciliation, final artifact writes, and bounded cleanup
occur after engine execution and have their own failure handling. Durations must be positive and no
greater than `2147483647ms`.
Preprocessing additionally rejects more than 1,000 changed files, more than 1,501 planned Git
processes, or more than 64 MiB of collected Git diff/name/numstat output. Narrow the three-dot range or
use global path filters when those bounds are exceeded.

`[paths].include` and `[paths].ignore` are global review filters. They are applied before per-file Git
patch collection and before deterministic lockfile/generated-noise filtering; ignored files remain in
the plan as excluded metadata but are not sent to reviewers. Reviewer-specific `paths` and
`ignore_paths` narrow the already-global reviewable set and cannot restore a globally excluded file.

## Runtime, auth, and models

Coordinator mode requires the exact `shuvcode` package and version approved by shuvbot. The approved
pin is `shuvcode@2.0.0-alpha-9` (`APPROVED_SHUVCODE_RUNTIME_VERSION`), and `review.shuvcode.version`
must match it. Local coordinator execution rejects before Git when the configured version differs or
no pin is approved. The package must be installed in the repository being reviewed, because the
runtime is resolved from that directory. The code-owned pin and this documented value move together;
verify a new pin with `bun run smoke:runtime` first. Do not substitute a range, local workspace
build, private package export, or guessed future version.

With `use_user_auth = true`, the isolated shuvcode process reuses the provider authentication already available through the user's shuvcode profile and XDG profile paths. Shuvbot passes profile locations needed by the child process but does not read, copy, log, inject, or expose subscription credential values to review sessions. This local subscription path is distinct from future non-interactive GitHub Actions authentication.

`reviewbot doctor` inspects this auth through the packed public `auth.status()` API. The response is
secret-safe and local-only: it reports configured source/type, structural usability, detectable OAuth
expiry, and storage availability with `verification: not_performed`. A passing check means usable
local auth is configured, not that a provider remotely accepted it. The check performs no refresh,
provider request, or model generation and never reports profile identifiers, auth paths, credential
values, or raw storage errors. Provider and model catalog checks are also non-generating and continue
when auth is absent so doctor can report all independent configuration problems.

With `use_user_auth = false`, local coordinator review fails before git inspection, workspace
creation, state access, or runtime startup. Non-interactive coordinator authentication is not yet
implemented.

Model values use reviewbot's own `subscription/<name>` namespace so repository config never names
provider credentials. `coordinator` selects the judge model; `standard` is the normal specialist
tier; `light` is the fast specialist tier. A reviewer override may only reuse a model the
configuration already selects for one of those roles, so repository config cannot register providers
or credentials.

Each name is resolved against the runtime's own model catalog before any session selects a model, and
an unresolvable name fails the review once with a `REVIEW_CONFIG_INVALID` error naming the model:

- `subscription/default-reasoning`, `subscription/default-coding`, and `subscription/default-fast`
  resolve to whatever model the runtime reports as its default.
- `subscription/<model>` resolves to a catalog model with that id, choosing deterministically when
  several providers offer it.
- `subscription/<provider>:<model>` names the provider explicitly, for example
  `subscription/anthropic:claude-sonnet-4-5`. Some runtimes route models without publishing a model
  list; this is the only form that resolves in that case.

## Coverage, state, and output

Quorum requires:

| Tier      | Successful sessions                                                                   |
| --------- | ------------------------------------------------------------------------------------- |
| `trivial` | Coordinator and code quality                                                          |
| `lite`    | Coordinator, code quality, and both other scheduled specialists                       |
| `full`    | Coordinator, code quality, security, and at least three of the other four specialists |

Below-quorum local results are `degraded`, cannot claim a clean review, and may still include verified findings from successful sessions. Failed and timed-out reviewers are named in the local report. The local CLI does not post reviews or evaluate a GitHub check result.

`incremental = true` enables local finding reconciliation. The local change identity hashes a
canonical repository identity and resolved base commit. Repository identity prefers a normalized
`origin` with URL credentials, query, and fragment removed; repositories without an origin use an
owner-only ID in the shared Git common directory. Neither the remote URL nor credentials are
persisted or reported. Base aliases that resolve to the same commit share a lineage, as do linked Git worktrees; unrelated
repositories and different base commits do not. State is stored atomically in
`.reviewbot/state/reviews/<sha256(change identity)>.json` in the primary checkout shared by linked
worktrees. The directory and file are created with owner-only permissions, and persisted values pass
through the redactor. The state records the base and head SHAs, degraded flag, update time, and
fingerprinted findings. Reports list lifecycle counts for fixed and user-resolved findings separately,
while only active `new` and `unresolved` findings are actionable. Absent active findings become
`fixed` only after complete coverage; a degraded run preserves them. Setting `incremental = false`
skips state reads, reconciliation, and writes.

Each coordinator invocation also writes redacted event JSONL, session summary, and result artifacts
under `.reviewbot/runs/<run-id>/`. The collision-safe run ID is unique per invocation, so sequential
runs do not overwrite each other. These durable artifacts are outside the temporary review workspace
and survive its cleanup; incremental state remains separately under `.reviewbot/state/reviews/`.
Successful persistence produces `reviewbot-events.jsonl`, `reviewbot-review-sessions.json`,
`reviewbot-review-result.json`, `reviewbot-run.json`, and `reviewbot-findings.json`. JSON mode also
returns the absolute artifact directory and persistence status.

The local coordinator path produces reports only. GitHub posting and Action support remain future
integration work; this preview does not establish runtime permission enforcement or acceptance.
