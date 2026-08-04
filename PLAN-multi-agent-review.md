# PLAN: Multi-Agent Review Coordinator

## Purpose

Evolve shuvbot's `review` mode into a Cloudflare-style coordinator system without narrowing the broader product. Mention-driven implementation, CI repair, and generic action modes remain part of shuvbot. The new review engine is introduced beside the current path, dogfooded locally, and promoted only after it is useful in practice.

This plan supersedes the single-agent assumptions for review orchestration in `SPEC.md`. It does not invalidate the completed implementation history in `PLAN-reviewbot-implementation.md` or `PLAN-reviewbot-remaining.md`.

Primary external reference:

- Cloudflare, "Orchestrating AI Code Review at scale": https://blog.cloudflare.com/ai-code-review/

## Agreed Decisions

1. Multi-agent review is a subsystem of the broader shuvbot agent bridge.
2. Review orchestration uses OpenCode through the shuvcode fork, not a new shuvbot-owned agent scheduler.
3. The runtime is an isolated process pinned to a tested shuvcode release. `1.18.4` remains the historical source baseline in `~/repos/shuvcode`; the approved executable pin is `2.0.0-alpha-9`, the first corrected release whose packed artifacts pass the M3 smoke test.
4. Missing generic runtime capabilities belong in upstreamable shuvcode APIs. Review policy and reviewer behavior remain in shuvbot.
5. Local CLI is the first delivery target. GitHub Actions follows after local dogfooding.
6. Local provider authentication is delegated to the user's shuvcode profile. Shuvbot does not read or inject local subscription credentials.
7. The plugin core is implemented now, but the first platform implementation remains GitHub-only.
8. Full review uses six specialists: code quality, security, performance, tests, documentation, and release/compatibility. A coordinator judges and consolidates their results.
9. Deterministic `trivial`, `lite`, and `full` risk tiers select reviewers and model tiers. Security-sensitive paths always select `full`.
10. Local specialist concurrency defaults to three.
11. Review findings use a typed JSON contract at every agent boundary.
12. All review agents are read-only. Deterministic shuvbot code applies runtime policy and posts the final review.
13. The bot may comment and request changes for critical findings when configured. It does not submit GitHub `APPROVE`.
14. Tier-aware quorum permits degraded reviews but never reports a clean result without the required reviewers.
15. Incremental re-review behavior is required in the first usable coordinator release.
16. Target latency is under two minutes for trivial, under five minutes for lite, and under ten minutes for full reviews, with a 15-minute hard cap.
17. Remote model configuration and external telemetry are deferred. Plugin seams must permit both later.
18. Built-in reviewers allow bounded repo prompt additions, path rules, thresholds, and model overrides. Repositories cannot replace system rules or grant tools.
19. The coordinator engine launches beside the legacy engine behind `review.engine` and becomes the default only after manual dogfooding.

## Implementation Status

Updated 2026-08-03:

- [x] M1 contracts and deterministic preprocessing: coordinator config, diff filtering, shared workspace, risk tiers, content-relevant lite assignment, deterministic fingerprints, canonical finding metadata, and deeply immutable execution plans are implemented with tests.
- [x] M2 plugin core: lifecycle ordering, failure semantics, immutable assembly, six built-ins, bounded repo overrides, code-owned provider/model catalogs, and narrowing-only read tools are implemented with tests. Runtime-discovered catalog values will be supplied by M4 execution.
- [x] M3 shuvcode runtime prerequisites: `shuvcode@2.0.0-alpha-9` is published to npm across all 19 fork packages with matching dist-tags and a GitHub release on tag `v2.0.0-alpha-9`. The code-approved executable pin is `2.0.0-alpha-9`, and `bun run smoke:runtime` passes 9/9 against the published artifacts: the pinned isolated process starts, the coordinator session and narrowed specialist sessions are created and server-enforced, widening is rejected, an active session is interrupted, and shutdown leaks no process. Two defects found by that smoke are fixed: the adapter resolved the packed client with CJS `require.resolve`, which can never match the release's `import`-only export map, and specialists forked an unprompted coordinator session, which the runtime rejects with `empty_session`.
- [ ] M4 coordinator execution: all six specialist prompts, shared mandatory rules, strict typed reviewer/coordinator results, bounded scheduling, specialist/coordinator/overall hard deadlines, cancellation, one bounded structured-output repair, provenance validation, deterministic finalization, server-enforced read-only session policy integration, and the isolated runtime adapter are implemented with fake-runtime end-to-end coverage. Session creation, policy enforcement, and shutdown are proven against the published runtime by the M3 smoke. A real `reviewbot review --engine coordinator` run against the published runtime now reaches the runtime and drives real sessions, but every session fails: the exit criterion is blocked on the model catalog described below.
- [x] M5 quorum, resilience, and observability: tier-aware quorum and degradation, stable error classification, bounded retries/interruption, safe runtime event and usage translation, complete repair/session accounting, run-record coverage, and durable redacted run/session/result artifacts are integrated and tested. This completes the local M5 exit criterion; GitHub artifact upload remains M8 work.
- [x] M6 incremental lifecycle: validated atomic file state, deterministic reconciliation for unresolved, fixed, degraded, user-resolved, and materially worsened findings, paginated bot-thread/reply ingestion, and a tested two-run local lifecycle complete the M6 exit criterion. GitHub-native state writes remain gated on M8 rather than being treated as local M6 completion work.
- [ ] M7 local dogfood UX: local engine selection, strict flags, live progress, stable JSON, no-change results, incremental state, durable artifacts, and coordinator-aware doctor diagnostics are implemented. The dogfood matrix and manual acceptance criteria have not run, so M7 remains incomplete.
- [ ] M8-M9 remain pending: the Action does not route to the coordinator, GitHub-native coordinator writes are not integrated, and no default switch is approved.

## Current Repository Assessment

### Reusable foundations

- Deterministic event normalization and runtime policy are implemented.
- The MCP server binds to loopback, validates tool schemas, enforces policy, redacts records, and audits calls.
- GitHub diff parsing, line mapping, review posting, hidden-marker dedupe, and request-changes gates exist.
- Five skill prompts and path/trigger filters exist.
- Review findings are parsed, calibrated, filtered, deduplicated, budgeted, and mapped to inline positions.
- File, GitHub, and in-memory state stores exist.
- Local review, action review, artifacts, run records, and eval fixtures exist.
- Restricted write paths for non-review modes remain isolated behind runtime policy.

### Remaining release and integration gates

- Local `legacy` remains the config default but fails closed before Git because no safe production legacy driver exists. Tests can inject a fake `ReviewAgent`; production does not silently return fake findings.
- Local coordinator routing and execution are implemented and the approved shuvcode runtime pin is `2.0.0-alpha-9`, so coordinator mode no longer fails closed on the pin. It still requires `review.shuvcode.use_user_auth = true` and a working local shuvcode subscription profile; an unapproved or mismatched pin continues to fail before any Git work.
- A first real local coordinator dogfood ran on 2026-08-04 against `shuvcode@2.0.0-alpha-9` (`--engine coordinator --base HEAD~1 --head HEAD`, lite tier, three reviewers). Preprocessing, planning, runtime startup, session creation, policy enforcement, prompting, progress streaming, quorum, and artifact persistence all worked, and the run correctly reported `DEGRADED - REVIEW INCOMPLETE` with `0/3` coverage instead of claiming clean. Every session nonetheless failed, for two reasons that are now the M4 blockers:
  - **The model catalog is unresolvable placeholders.** `createReviewerConfigPlugin` is called with its default code-owned catalog (`subscription/default-reasoning`, `subscription/default-coding`, `subscription/default-fast`) and no provider serves those refs. The runtime accepts `session.switchModel` for any ref without validation, so the failure only appears at prompt time as `session.execution.failed` with `{"type":"provider.no-route","message":"Model unavailable: subscription/default-coding"}`. Configuring real refs such as `anthropic/claude-sonnet-4-5` is currently rejected as `Unknown review model`, because the catalog validates against the same placeholder list. Runtime-discovered catalog values are required, and `packages/cli/src/local-review.ts` configures plugins before it starts the runtime, so closing this needs the runtime to start (or a model catalog to be fetched) before plugin configuration.
  - **Provider failures are reported as schema failures.** The run recorded every session as `REVIEW_SCHEMA_INVALID` / "Structured response was invalid", which sends an operator after the reviewer JSON schema rather than the missing model. Failure classification must distinguish an unroutable or unavailable model from an invalid structured response.
- Real subscription dogfood therefore remains incomplete. M7 stays unchecked until the documented repository/change matrix and manual quality, latency, degradation, and incremental acceptance criteria are recorded against a run whose sessions actually succeed.
- `packages/action/src/main.ts` still uses the legacy fake-agent pipeline and does not select the coordinator. GitHub-native coordinator posting, state writes, artifact upload, non-interactive auth, and cancellation remain M8 work.
- The default must remain `legacy` until M3, M4, M7, and M8 evidence is reviewed and the M9 switch is explicitly approved; this default is a migration setting, not a claim that production local legacy review works.

## Target Architecture

```text
reviewbot review / GitHub pull_request
  -> deterministic event, policy, config resolution
  -> review plugin bootstrap (concurrent, non-fatal)
  -> review plugin configure (sequential, fatal)
  -> review plugin postConfigure (async enrichment)
  -> diff filtering and deterministic risk assessment
  -> shared review workspace
       manifest.json
       shared-review-context.txt
       patches/<encoded-path>.patch
       previous-findings.json
  -> isolated pinned shuvcode process
  -> coordinator session
       -> spawn up to three specialist sessions concurrently
       -> collect typed ReviewerResult values
       -> enforce tier-aware quorum
       -> verify, dedupe, calibrate, and disposition findings
       -> return typed CoordinatorResult
  -> deterministic shuvbot validation and line mapping
  -> deterministic runtime policy decision
  -> local report or GitHub review posting
  -> redacted artifacts and finding lifecycle state
```

### Trust boundary

- Plugins contribute through a controlled `ReviewConfigureContext`; they do not mutate final configuration directly.
- Coordinator and specialists receive read-only filesystem/repository tools only.
- No review session receives GitHub write, shell, git-write, output, memory-write, or secret-bearing tools.
- PR text, comments, branch names, commit messages, patches, source files, and prior replies remain labeled untrusted.
- Shuvbot validates every agent result independently before it can affect review state or GitHub output.
- Runtime policy remains the sole authority for `COMMENT`, `REQUEST_CHANGES`, check failure, and all other mutations.

## Contracts

### Plugin lifecycle

Create `packages/review/src/plugins/types.ts`:

```ts
export interface ReviewPlugin {
  id: string;
  bootstrap?(ctx: ReviewBootstrapContext): Promise<void>;
  configure?(ctx: ReviewConfigureContext): Promise<void>;
  postConfigure?(ctx: ReviewPostConfigureContext): Promise<void>;
}

export interface ReviewConfigureContext {
  registerReviewer(reviewer: ReviewerDefinition): void;
  registerProvider(provider: ReviewProviderDefinition): void;
  addPromptSection(section: PromptSection): void;
  setReviewerModel(reviewer: ReviewerId, model: ModelRef): void;
  restrictReviewerTools(reviewer: ReviewerId, tools: readonly string[]): void;
}
```

Lifecycle semantics:

- `bootstrap`: concurrent and non-fatal; failures are recorded.
- `configure`: sequential and fatal; configuration ordering is explicit.
- `postConfigure`: runs after immutable configuration assembly; failures follow each plugin's declared criticality.
- Core validates duplicate IDs, unknown reviewers/models, and attempted permission widening.

Initial plugins:

- `github`: PR metadata and previous review state.
- `local`: git diff and file-backed finding state.
- `shuvcode`: process, client, session, and event-stream setup.
- `reviewer-config`: built-in roster plus bounded repository overrides.
- `artifacts`: redacted local artifacts.
- `telemetry`: local run records only; remote export remains disabled.

### Risk tiers

Create `packages/review/src/risk.ts` with a pure, tested classifier.

Initial defaults:

| Tier      | Deterministic trigger                                                              | Sessions                                                             |
| --------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `trivial` | At most 10 changed lines, at most 20 files, and no sensitive path                  | coordinator + code quality                                           |
| `lite`    | At most 100 changed lines, at most 20 files, and no sensitive path                 | coordinator + code quality + tests + one content-relevant specialist |
| `full`    | Larger change, more than 20 files, generated-risk ambiguity, or any sensitive path | coordinator + all six specialists                                    |

Sensitive path matching must be configurable and initially include authentication, authorization, crypto, secrets, permissions, workflows, dependency manifests, migrations, and deployment/release configuration.

Risk classification is deterministic. The coordinator may request an optional specialist only within the tier's configured maximum; it cannot downgrade the tier.

### Diff filtering and shared context

Create `packages/review/src/diff-filter.ts` and `packages/review/src/workspace.ts`.

Filter before model execution:

- lockfiles
- vendored dependencies
- minified or bundled assets
- source maps
- generated files with reliable markers

Do not filter database migrations, generated API/schema changes with behavioral impact, dependency manifests, or workflow/release configuration.

Write one patch file per changed file and one shared context file. Prompts receive paths and manifests rather than embedding the complete diff repeatedly. Workspace paths must remain inside a run-scoped temporary directory.

### Reviewer definitions

Create prompt modules under `packages/review/src/reviewers/`:

- `code-quality.ts`: correctness, data flow, concurrency, error handling, maintainability with concrete impact.
- `security.ts`: exploitable or concretely dangerous trust-boundary failures only.
- `performance.ts`: measurable regressions, algorithmic blowups, resource leaks, and hot-path issues only.
- `tests.ts`: incorrect tests and specific missing regression coverage for changed behavior.
- `documentation.ts`: public contract drift, stale examples, and required migration/operator documentation.
- `release.ts`: compatibility, migrations, deployment ordering, versioning, and rollback risk.

Every prompt must contain explicit "flag" and "do not flag" sections. Shared mandatory rules are appended after repository-provided additions so repository text cannot remove them.

### Typed findings

Extend the canonical finding contract rather than introducing XML:

```ts
export interface ReviewFinding {
  id: string;
  fingerprint: string;
  reviewer: ReviewerId;
  skill: string;
  title: string;
  body: string;
  evidence: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: "high" | "medium" | "low";
  path: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  side?: "RIGHT" | "LEFT";
  suggestedFix?: string;
  tags?: string[];
  disposition?: "new" | "unresolved" | "fixed" | "user_resolved" | "dismissed";
  priorFindingId?: string;
}
```

`fingerprint` is deterministic from root cause plus stable code location, not generated by the model. Agent-provided IDs are treated as run-local only.

Specialist output:

```ts
export interface ReviewerResult {
  reviewer: ReviewerId;
  status: "completed" | "failed" | "timed_out";
  summary: string;
  findings: ReviewFindingCandidate[];
  usage?: Usage;
  error?: ClassifiedReviewError;
}
```

Coordinator output:

```ts
export interface CoordinatorResult {
  decision: "clean" | "comments" | "minor_issues" | "significant_concerns" | "degraded";
  findings: CoordinatedFinding[];
  dropped: DroppedFinding[];
  coverage: ReviewCoverage;
  summary: string;
}
```

Both outputs are schema-validated. Invalid output receives one bounded repair attempt; repeated failure is classified and fed into quorum handling.

### Tier-aware quorum

Initial required coverage:

| Tier      | Required successful sessions                                                              |
| --------- | ----------------------------------------------------------------------------------------- |
| `trivial` | coordinator and code quality                                                              |
| `lite`    | coordinator, code quality, and two scheduled specialists                                  |
| `full`    | coordinator, code quality, security, and at least three of the remaining four specialists |

Rules:

- A result below quorum is `degraded` and cannot say the change is clean.
- Successful findings may still be displayed, but no blocking decision is made from incomplete coordinator output.
- A failed optional reviewer is named in local output and artifacts.
- Security-sensitive full reviews require the security reviewer; no fallback reviewer may silently satisfy that role.

### Incremental re-review state

Add finding state methods rather than overloading PR summary text:

```ts
export interface ReviewStateStore {
  readReviewState(changeId: string): Promise<PersistedReviewState | null>;
  writeReviewState(changeId: string, state: PersistedReviewState): Promise<void>;
}
```

Persist:

- head/base SHAs
- finding fingerprints and prior comment/thread IDs
- prior severity and evidence
- resolved status
- relevant user replies
- coordinator disposition

Re-review behavior:

- Omit fixed findings and mark their state fixed.
- Re-emit unresolved findings with the same fingerprint.
- Respect user-resolved or acknowledged findings unless materially worsened.
- Give disagreement text to the coordinator as untrusted context for explicit reconsideration.
- Never infer resolution solely because a finding is absent from one failed or degraded run.

### Process and session lifecycle

Add a coordinator-specific runtime adapter under `packages/review/src/runtime/shuvcode.ts`; do not overload the existing coding-agent `AgentDriver` contract.

Requirements:

- Resolve and verify the pinned `shuvcode` package version.
- Launch an isolated loopback/stdio process with an ephemeral password and run-scoped config/state paths where supported.
- Reuse the user's shuvcode provider authentication without reading credential values in shuvbot.
- Start the coordinator session and child specialist sessions through typed client APIs.
- Stream structured session events into redacted JSONL run logs.
- Emit a heartbeat after 30 seconds without visible output.
- Cap specialist concurrency at three by default.
- Enforce per-session, coordinator, and overall deadlines.
- Interrupt all remaining sessions and terminate the process on completion, cancellation, or timeout.
- Never pass large prompts as command-line arguments.

Expected shuvcode API audit:

- The original `1.18.4` source baseline was not an executable integration pin and its declared `./server-process` export was not present in packed artifacts.
- The corrected release packaging bundles a version-matched Promise client at `shuvcode/client` and deliberately uses CLI stdio spawning instead of the source-only server-process module.
- All 19 fork package names exist publicly and the live ownership preflight passes.
- The v2 embedded `@opencode-ai/sdk-next` package is private and must not be imported from shuvbot until it is published as a supported API.
- General-purpose v2 JSON-schema output is implemented across schema, protocol, execution, projection, events, and generated clients; it must be included in the corrected published release.
- If reliable isolated startup, event subscription, parent/child session creation, async prompting, structured output, or interruption is missing from released APIs, add the smallest general capability in `~/repos/shuvcode`, test it there, publish a release, then update the exact shuvbot pin.

### Timeouts and resilience

Initial budgets:

- Reviewer inactivity: 60 seconds before classification as startup/inactivity failure.
- Reviewer deadline: 4 minutes; code quality may use 6 minutes.
- Coordinator judge deadline after reviewer completion: 3 minutes.
- Overall review hard cap: 15 minutes.
- Retry only when at least 90 seconds remain.
- One retry per failed session in the first release.

Classify errors into retryable provider/rate-limit/service failures and non-retryable auth, context overflow, schema, policy, cancellation, and local configuration failures.

Do not build a distributed circuit breaker in the local-first milestone. Record enough model/provider failure data to add per-tier circuit state when GitHub Actions and remote routing are introduced.

### Deterministic decision mapping

The coordinator recommends one of the typed decisions. Shuvbot maps it to behavior:

| Coordinator result     | Local result | GitHub behavior                                                                                          |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `clean`                | clean        | `COMMENT` summary; never `APPROVE`                                                                       |
| `comments`             | findings     | `COMMENT`                                                                                                |
| `minor_issues`         | findings     | `COMMENT`, optional failing check by configured threshold                                                |
| `significant_concerns` | blocked      | `REQUEST_CHANGES` only when policy/config permit; otherwise `COMMENT` plus failing check when configured |
| `degraded`             | incomplete   | `COMMENT`/check warning; never claim clean and never block solely because coverage failed                |

## Configuration Shape

Extend TOML while preserving legacy defaults during migration:

```toml
[review]
engine = "legacy" # legacy | coordinator
max_concurrency = 3
overall_timeout = "15m"
incremental = true

[review.shuvcode]
package = "shuvcode"
version = "1.18.4" # source baseline only; APPROVED_SHUVCODE_RUNTIME_VERSION is currently null
use_user_auth = true

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

[review.models]
coordinator = "subscription/default-reasoning"
standard = "subscription/default-coding"
light = "subscription/default-fast"

[[review.reviewers]]
id = "security"
paths = ["**/*"]
ignore_paths = ["**/*.snap"]
prompt_append = "Apply this repository's documented trust-boundary conventions."
```

Model references are shuvcode provider/model references or stable shuvbot aliases resolved through the shuvcode catalog. Repository config may select known models but may not add credentials or providers.

## Implementation Milestones

### M1: Contracts and deterministic preprocessing

Goal: land the new domain model without invoking shuvcode.

Files:

- Add `packages/review/src/types.ts`.
- Add `packages/review/src/risk.ts`.
- Add `packages/review/src/diff-filter.ts`.
- Add `packages/review/src/workspace.ts`.
- Extend `packages/core/src/review-schema.ts` with evidence, reviewer, fingerprint, and disposition fields.
- Extend `packages/core/src/config.ts` with `review.engine`, tiers, concurrency, timeout, reviewer overrides, and pinned runtime config.

Tests:

- Boundary tests for all three risk tiers.
- Security-sensitive paths force full review.
- Noise filtering preserves migrations and behavioral generated files.
- Workspace path traversal is impossible.
- Fingerprints are stable across run-local IDs and line shifts within the configured location bucket.
- Legacy config remains valid and defaults to `legacy` during migration.

Exit criteria:

- Pure preprocessing produces a complete immutable `ReviewExecutionPlan` from local git inputs.

### M2: Plugin core

Goal: assemble review configuration through isolated plugin contributions.

Files:

- Add `packages/review/src/plugins/types.ts`.
- Add `packages/review/src/plugins/runner.ts`.
- Add `packages/review/src/plugins/local.ts`.
- Add `packages/review/src/plugins/reviewer-config.ts`.
- Add `packages/review/src/plugins/artifacts.ts`.

Tests:

- Bootstrap hooks run concurrently and failures are non-fatal.
- Configure hooks preserve order and fail fast.
- Plugins cannot mutate finalized configuration.
- Tool restrictions can only narrow permissions.
- Duplicate reviewer/provider IDs fail clearly.

Exit criteria:

- A fake runtime receives an immutable plan containing six built-in reviewers and tier-specific assignments.

### M3: Shuvcode runtime prerequisites

Goal: prove the released fork can host coordinator and child sessions without private workspace imports.

Work in `~/repos/shuvcode` only if required:

- Correct release packaging so the CLI and a version-matched supported Promise client can be installed from packed artifacts.
- Add a pack/install smoke test in an empty project.
- Add or stabilize released APIs for isolated server startup and shutdown.
- Ensure typed event subscription exposes session activity, idle, completion, usage, and errors.
- Ensure parent/child sessions, agent/model selection, async prompt submission, structured output, and interruption are supported.
- Add integration tests using fake providers or simulation mode.
- Publish a tested shuvcode release.

Work in shuvbot:

- Replace the `1.18.4` source baseline with the exact corrected shuvcode release.
- Add a compatibility smoke test and actionable version mismatch diagnostic.

Exit criteria:

- A shuvbot test starts the pinned isolated process, creates parent and child sessions, receives events, interrupts a session, and shuts down without leaked processes.

Status: met by `bun run smoke:runtime` against `shuvcode@2.0.0-alpha-9` (9/9). Two
constraints were discovered and are now encoded in the adapter and its tests:

- The release exports `shuvcode/client` under the `import` condition only, so the
  packed package must be resolved from its manifest rather than by CJS
  `require.resolve`.
- `Session.fork` resolves its boundary from the parent's persisted messages, so an
  unprompted session cannot be forked. Specialists are therefore independent
  sessions created with an explicitly narrowed, server-enforced policy rather than
  forks of the coordinator.

### M4: Coordinator and specialist execution

Goal: complete one local typed multi-agent review.

Files:

- Add `packages/review/src/runtime/shuvcode.ts`.
- Add `packages/review/src/scheduler.ts`.
- Add `packages/review/src/coordinator.ts`.
- Add `packages/review/src/reviewers/*.ts` for all six specialists.
- Add `packages/review/src/prompts/REVIEWER_SHARED.ts`.
- Add JSON schemas for `ReviewerResult` and `CoordinatorResult`.

Tests:

- Maximum three specialists run concurrently.
- Session prompts reference shared files rather than duplicating full context.
- Invalid structured output receives one repair attempt.
- Read-only tool sets are enforced for every review session.
- Heartbeats do not reset hard deadlines.
- Cancellation terminates child sessions and the isolated process.

Exit criteria:

- `reviewbot review --engine coordinator` returns a validated coordinator result from a real local shuvcode subscription session.

### M5: Quorum, resilience, and observability

Goal: make partial failure honest and diagnosable.

Files:

- Add `packages/review/src/quorum.ts`.
- Add `packages/review/src/errors.ts`.
- Extend `packages/core/src/run-record.ts` for tier, sessions, coverage, usage, retries, and coordinator decisions.
- Emit buffered redacted JSONL logs and a session summary artifact.

Tests:

- Every tier's quorum matrix.
- Full security review cannot pass without security.
- Retryable and non-retryable error classification.
- Timeout budget and retry-budget enforcement.
- Below-quorum output cannot claim clean or trigger blocking solely from failed coverage.
- Secret fixtures do not appear in session logs or artifacts.

Exit criteria:

- Failures identify the reviewer, model reference, classification, retry, and resulting coverage without exposing credentials or raw private prompts.

### M6: Incremental review lifecycle

Goal: make synchronize/re-review runs update prior findings instead of starting over.

Files:

- Extend `packages/core/src/state.ts` or add `packages/review/src/state.ts` with `ReviewStateStore`.
- Add `packages/review/src/reconcile.ts`.
- Extend GitHub comment/review readers to capture bot thread IDs, resolution state where available, and replies.
- Add file-backed local review state keyed by repository plus base branch/change identifier.

Tests:

- Fixed findings disappear and become fixed.
- Unresolved findings retain fingerprints.
- User acknowledgment/resolution is respected.
- Disagreement is reconsidered as untrusted context.
- Degraded runs do not resolve absent findings.
- Head SHA changes are recorded atomically.

Exit criteria:

- Two sequential local reviews demonstrate new, unresolved, fixed, and user-resolved lifecycle transitions.

### M7: Local dogfood UX

Goal: make the coordinator engine practical for daily local use.

Files:

- Update `packages/cli/src/local-review.ts` to select legacy or coordinator engines.
- Add progress output for tier, scheduled reviewers, queue/running/completed state, heartbeats, and coverage.
- Add human-readable summary plus optional JSON output.
- Update `reviewbot doctor` with shuvcode pin, auth availability, process launch, and model resolution checks.
- Update docs and sample config.

Dogfood targets:

- shuvbot itself.
- shuvcode changes that do not expose unrelated private content.
- At least two repositories with different languages or build systems.
- Small, medium, security-sensitive, documentation-only, migration, generated-code, and large changes.

Manual acceptance criteria:

- Reviewers consistently prefer silence over speculative findings.
- Duplicate findings are consolidated.
- Evidence points to changed code and survives manual inspection.
- Full reviews normally complete under ten minutes.
- Degraded coverage is obvious.
- Incremental runs do not repost fixed findings.
- The local workflow is useful enough to choose over the legacy path.

Exit criteria:

- Record dogfood outcomes and approve making the coordinator engine eligible for GitHub integration. Fixture scores remain regression signals, not the sole launch gate.

### M8: GitHub integration and migration

Goal: reuse the proven local engine in GitHub Actions without changing trust rules.

Files:

- Add the GitHub review plugin.
- Route `packages/action/src/main.ts` through the engine selector.
- Persist finding lifecycle state with GitHub-native storage.
- Map coordinator decisions through deterministic posting policy.
- Add action inputs/outputs and workflow summary fields for engine, tier, coverage, and degraded status.
- Define non-interactive shuvcode authentication separately from local subscription auth.

Tests:

- Fork PRs remain read-only and secret-free.
- Review agents never receive write-capable MCP tools.
- `APPROVE` remains impossible.
- Critical findings request changes only when policy and config allow it.
- Re-review updates prior threads/comments without duplicates.
- Action cancellation terminates shuvcode and child sessions.

Exit criteria:

- Opt-in GitHub workflow runs the coordinator engine end to end with redacted artifacts and correct review state.

### M9: Default switch and cleanup

Goal: make the coordinator engine the default only after explicit approval.

Tasks:

- Review dogfood and GitHub opt-in evidence.
- Set `review.engine = "coordinator"` as the default in a versioned config migration.
- Keep explicit `legacy` fallback for one deprecation window.
- Remove `createFakeReviewAgent` from production action and CLI paths immediately; retain it only in tests.
- Remove the legacy engine after the deprecation window and migrate relevant tests.
- Update `SPEC.md`, README, config docs, troubleshooting, release notes, and `dist/index.js`.

Exit criteria:

- No production path silently returns an empty fake review.
- Coordinator mode is the documented default and legacy removal has a dated release target.

## Validation

Run for every shuvbot milestone:

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run evals
```

Run targeted real-runtime tests separately so normal unit tests do not consume subscription quota:

```bash
bun run test:integration:shuvcode
bun run dogfood:review -- --base main --head HEAD
```

The exact script names are introduced with their owning milestone.

## Deferred Work

- Remote reviewer/model override service.
- External telemetry collector and Prometheus export.
- Cross-run distributed circuit breakers.
- GitLab or other VCS plugins.
- Arbitrary repository-defined agents or tool sets.
- AI-generated GitHub approvals.
- Organization-wide policy UI.
- Hosted multi-tenant storage.
- AGENTS.md freshness specialist; reconsider after the six-reviewer roster is calibrated.

## Primary Risks

- Publishing the corrected shuvcode contracts depends on a reviewed commit, trusted publisher/manual release dispatch, and registry verification. Do not bypass that gate with private imports or an unreviewed package.
- Subscription provider limits may make three-way concurrency unstable. Measure queueing, rate limits, and fallback behavior during dogfood.
- Six specialists can multiply low-value findings. Tight negative prompting, typed evidence, coordinator verification, and posting budgets are launch requirements.
- Incremental GitHub thread resolution differs from local state and may require platform-specific reconciliation.
- The existing action targets Node 24 while shuvcode is Bun-oriented. Keep the runtime out-of-process and test packaged Linux execution before GitHub integration.
- Plugin extensibility can become a permission bypass. Contribution APIs must be capability-narrowing and final assembly must be immutable.
