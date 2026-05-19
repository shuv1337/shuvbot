# PLAN-reviewbot-remaining.md

## Purpose

Detailed implementation plan for everything still ahead of `reviewbot` after Milestones 0 and 1 (skeleton + GitHub event core + runtime policy). This document is the working reference for Milestones 2 through 9, the v0.x release slices, and the v0/v1 hardening checklists.

The original spec lives in `SPEC.md`. The historical task-by-task plan lives in `PLAN-reviewbot-implementation.md`. This file expands on the remaining milestones with concrete files, signatures, tests, and commit shapes so an autonomous agent (or human) can pick up any milestone and execute it without re-deriving structure.

## Starting State (refreshed 2026-05-18)

- Milestone 0: scaffold, config parser, redaction, policy skeleton, CLI stubs, docs stubs, `dist/index.js`. Done.
- Milestone 1: normalized `BotEvent` types, command parser, mode resolution, runtime policy builder with the SPEC §9.2 matrix, expanded workflow summary, envelope validator, minimal `GitHubClient`. Done.
- Milestone 2 is partially complete: `@modelcontextprotocol/sdk` is installed, `packages/mcp/src/tool-spec.ts` has schema validation, policy gating, redacted audit records, and tests; `packages/mcp/src/server.ts` starts a stateless Streamable HTTP MCP server on `127.0.0.1:0` and has client-driven lifecycle tests.
- Milestone 2 tool surfaces are implemented through conservative git/shell/memory stubs; concrete review pipeline integration remains ahead.
- Milestone 3 is partially scaffolded: agent driver interfaces, minimal Claude model aliases, CLI command routing stubs, and placeholder agent modules exist. Auth resolution, setup-token/import helpers, real Claude Code process execution, doctor checks, and secret-leak tests remain open.
- Repo layout under `packages/`: `action/`, `core/`, `github/`, `mcp/`, `agents/`, `cli/`, `evals/`. User-facing docs currently live at repo-level `docs/`.
- Latest validation during this refresh: `bun run typecheck`, focused review tests, `bun test`, `bun run lint`, and `bun run build` green; 101 tests passing.

## Cross-Cutting Invariants (do not regress)

These constraints apply across every remaining milestone. Audit before merging anything.

1. **Runtime policy is the only authority** for tool permissions. Never let payloads, comments, prompts, repo instructions, or skill configs change `RuntimePolicy` after `buildRuntimePolicy` returns.
2. **Envelope validator runs on every external entry point** that takes user-provided JSON. Forbidden fields stay forbidden.
3. **Fork PRs never get shell, push, or secrets.** Add a regression test whenever any new code path touches policy.
4. **Credentials never enter prompts.** Add a redaction regression test when any new logging/serialization path is added.
5. **MCP server binds to `127.0.0.1` on an ephemeral port.** No code path may bind it to `0.0.0.0` or a fixed port.
6. **Approval (`canApprove`) stays disabled in v1.** Do not add a config flag yet.
7. **All new errors extend `ReviewbotError`** with a stable `code`. Tool errors crossing the agent boundary must be sanitized.
8. **Bun + TypeScript + strict tsconfig.** Maintain `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` correctness.
9. **`dist/index.js` is committed** after each milestone that changes behavior visible to the GitHub Action runtime.
10. **Workflow summary is non-secret** and includes the runtime policy reasons for traceability.

## Repository Map (target end-state)

The slots already exist; this is the agreed final shape. Filenames marked `[stub]` exist as placeholders today and should be filled in by the milestone listed in parentheses.

```text
packages/
  action/src/
    entry.ts
    main.ts
    inputs.ts
    workflow-summary.ts
    artifacts.ts                 [Milestone 4]
  core/src/
    config.ts
    events.ts
    commands.ts
    modes.ts
    policy.ts
    review-schema.ts             [Milestone 4 — interface exists; pipeline still missing]
    state.ts                     [Milestone 8]
    time.ts
    redaction.ts
    errors.ts
    observability.ts
    run-record.ts
    context/                     [Milestone 4]
      assembler.ts
      manifest.ts
      labels.ts
  github/src/
    octokit.ts
    diff.ts                      [Milestone 4]
    comments.ts                  [Milestone 4]
    reviews.ts                   [Milestone 4]
    checks.ts                    [Milestone 7]
    permissions.ts
    artifacts.ts                 [Milestone 4/9]
  mcp/src/                       [Milestone 2 — foundation partial]
    server.ts                    [partial]
    tool-spec.ts                 [partial]
    audit.ts                     [done]
    tools/
      pr.ts                      [placeholder]
      issue.ts                   [placeholder]
      comment.ts                 [placeholder]
      review.ts                  [placeholder]
      checks.ts                  [placeholder]
      git.ts                     [placeholder]
      shell.ts                   [placeholder]
      output.ts                  [placeholder]
      labels.ts                  [placeholder]
      memory.ts                  [conservative stub]
      files.ts                   [placeholder]
  agents/src/                    [Milestone 3 onward — foundation partial]
    driver.ts                    [partial]
    auth.ts                      [placeholder]
    claude-code.ts               [placeholder]
    anthropic-sdk.ts
    openai.ts
    codex-cli.ts
    aider.ts
    model-registry.ts            [partial]
  cli/src/
    index.ts
    init.ts                      [Milestone 4 — placeholder]
    local-review.ts              [Milestone 4 — placeholder]
    replay.ts                    [Milestone 9 — placeholder]
    doctor.ts                    [Milestone 3 — placeholder]
    auth/claude-setup-token.ts   [Milestone 3 — missing]
    auth/claude-import.ts        [Milestone 3 — missing]
  evals/                         [Milestone 9]
    fixtures/
    cases/
    src/harness.ts
    src/replay-github-event.ts
    src/score.ts
fixtures/events/                 [Milestone 9]
docs/                            [all milestones]
```

---

## Milestone 2 — MCP Tool Server and Safe Tool Execution

### Current status

Partial. The execution substrate exists and is tested, but the tool catalog is still placeholder-only. The next Milestone 2 batch should focus on concrete tools and a standalone audit module, not on redoing server lifecycle or generic schema validation.

### Goal

Stand up a local MCP server bound to `127.0.0.1:<ephemeral>` that exposes policy-enforced read, write, git, shell, memory, and output tools. The server must be drivable by a fake agent end-to-end before any real agent is wired up.

### Dependencies

- [x] Add `@modelcontextprotocol/sdk` as a dependency.
- [ ] Add a JSON schema validator if the current hand-rolled `ToolSchema` validator becomes insufficient. Current implementation uses internal schema validation plus Zod conversion for MCP registration, not Ajv.
- Keep `bun-types` in dev deps; no Bun-only APIs in MCP server code (Node 24 must run it after bundling).

### Pre-flight

- Re-read SPEC §10 (Tool server) and §11 (Agents).
- Confirm `GitHubClient` interface in `packages/github/src/octokit.ts` is sufficient for every tool route below; widen if needed.
- Define the `Octokit-ish` request surface that handlers expect (e.g., paginated list helpers) before writing handlers.

### Tasks

#### Core scaffolding

- [x] `packages/mcp/src/tool-spec.ts`:
  - [x] `ToolPolicyRequirement` implemented as structured runtime-policy requirements (`shell`, `push`, `canComment`, `canReview`, etc.).
  - [x] `ToolContext` carries `runId`, actor/mode, `policy`, `redactor`, and `audit`.
  - [x] Extend `ToolContext` with `repo`, `client`, `cwd`, `logger`, and `state` before concrete tools land.
  - [x] `ToolSpec<Input, Output>` with input/output schemas and a `handler` returning `Output`.
  - [x] `executeTool` validates input, calls policy checks, runs handler, validates output, and records audit entries.
  - [x] Runtime-policy mapping denies by default for configured requirements.
  - [ ] Add dedicated `ToolValidationError` and `ToolOutputError` if `StructuredOutputError` is too broad for tool-boundary diagnostics.

- [x] `packages/mcp/src/audit.ts`:
  - [x] `AuditLog` API records tool status, duration, sanitized input/output digests, policy decision, sanitized errors, and stable error codes.
  - [x] Use `Redactor` from `packages/core/src/redaction.ts` for inputs and errors before recording.
  - [x] Append to a per-run in-memory buffer; provide `snapshot()` for run-record attachment.
  - [x] Migrate or wrap the current `ToolAuditSink`/`ToolAuditRecord` in `tool-spec.ts` so existing tests keep their behavior.

- [x] `packages/mcp/src/server.ts`:
  - [x] Build MCP server using the official TypeScript SDK and bind to `127.0.0.1:0` (let OS pick port).
  - [ ] Register every real tool from `tools/` automatically after handlers replace placeholders.
  - [ ] Keep or adapt the current `startReviewbotMcpServer(...).close()` API; add `connectionInfo()` only if callers need the exact `{ url, port }` shape.
  - [x] Hard-deny external network access by binding to `127.0.0.1` and ignoring `HOST`/`PORT` envs.

#### Read-context tools (`packages/mcp/src/tools/pr.ts`, `issue.ts`, `files.ts`, `checks.ts`)

- [x] Replace placeholder exports in read-context `packages/mcp/src/tools/*.ts` with real tool specs.
- [x] `get_pr` — returns SPEC `PullRequestSummary` plus `mergeable`, `mergeStateStatus`, `labels`.
- [x] `get_pr_diff` — fetches diff via `application/vnd.github.v3.diff`. Optional `maxBytes` truncates with a tail marker.
- [x] `get_pr_files` — paginates `/pulls/{n}/files`. Returns minimal file objects: `filename`, `status`, `additions`, `deletions`, `patch`.
- [x] `get_issue` — issue title/body/state/labels.
- [x] `get_issue_comments` — paginated comments.
- [x] `get_review_comments` — paginated review comments with `position` data.
- [x] `get_check_runs` — paginated check runs for a ref.
- [x] `get_check_logs` — downloads check-run logs (gated by `canReadChecks`).
- [x] `search_repo` — wraps GitHub `search/code`. Bounded result count.
- [x] `read_file` — checks out path inside `cwd`, returns up to N bytes. Refuses paths escaping `cwd`.

#### Write-GitHub tools (`packages/mcp/src/tools/comment.ts`, `review.ts`, `labels.ts`, `output.ts`)

- [x] `create_issue_comment` — requires `canComment`. Hidden marker `<!-- reviewbot:... -->` supports dedupe.
- [x] `edit_issue_comment` — requires `canComment`.
- [x] `reply_to_review_comment` — requires `canReview`.
- [x] `create_pull_request_review` — requires `canReview`. Supports `event`: `COMMENT`, `REQUEST_CHANGES`. `APPROVE` always rejected.
- [x] `update_pull_request_body` — requires `canUpdatePullRequest`.
- [x] `add_labels` — requires `canAddLabels`.
- [x] `set_output` — writes structured action output through the tool output sink when configured.

#### Git/shell/memory tools (`packages/mcp/src/tools/git.ts`, `shell.ts`, `memory.ts`)

- [x] `git_status`, `git_diff`, `git_fetch` — read-only, require `canReadChecks` or similar lightweight check.
- [x] `git_commit` — requires `push >= restricted` and `actorPermission >= write`. Enforces `reviewbot:` commit prefix template.
- [x] `push_branch`, `push_tags` — require `push >= restricted`. Branch name must match `reviewbot/*`; tag push fails closed in v0 conservative tooling.
- [x] `delete_branch` — requires `push >= restricted` and branch matches `reviewbot/*`.
- [x] `create_pull_request` — requires `canCreatePr`. Bot-branch only.
- [x] `run_shell` — requires `shell >= restricted`. Stub fails closed until full sandbox arrives in Milestone 6.
- [x] `kill_background_process` — pairs with `run_shell`.
- [x] Memory tools (`read_pr_summary`, `write_pr_summary`, `read_repo_learnings`, `write_repo_learnings`) — return `null`/no-op until Milestone 8 unless `memory.enabled` and a backend exists.

#### Hidden markers and dedupe

- [x] Helper in `packages/github/src/comments.ts`: `findExistingMarker(comments, key)`, `formatMarker(key, payload)`.
- [x] Wire dedupe into `create_issue_comment` and `create_pull_request_review`.

### Tests

- [x] Server lifecycle: starts, returns port, stops cleanly without leaking handles.
- [x] Tool input validation rejects malformed payloads.
- [x] Tool output validation catches schema violations.
- [x] Policy denial paths return sanitized `PolicyDeniedError` without leaking input details.
- [x] Fake-agent driver (defined inline in tests) can read PR data via `get_pr` and `get_pr_diff` using a mocked `GitHubClient`.
- [x] Write tools refuse under fork policy / `read` actor.
- [x] `create_pull_request_review` rejects `event: "APPROVE"` regardless of policy.
- [x] Audit log captures input/output digests and is redacted, including snapshot coverage.
- [x] Hidden-marker dedupe prevents duplicate comments across invocations.

### Validation commands

```bash
bun run typecheck
bun test -- packages/mcp
bun test
bun run build
```

### Completion criteria

- [ ] All defined tools registered, schema-validated, and policy-gated.
- [x] Server binds to `127.0.0.1:0`, never to a public interface.
- [ ] Fake agent can drive a read-only review workflow end-to-end using the MCP server.
- [x] Run record can attach an audit summary for tool calls.

### Suggested commit split

1. Done: `chore(deps): add @modelcontextprotocol/sdk`
2. Done/partial: `feat(mcp): tool spec, audit hook, policy gating`
3. Done: `feat(mcp): MCP server lifecycle on loopback`
4. Next: `feat(mcp): audit log snapshots and context expansion`
5. Next: `feat(mcp): read-context tools (pr, issue, files, checks)`
6. Next: `feat(mcp): write tools with dedupe markers`
7. Next: `feat(mcp): git/shell/memory tool stubs gated by policy`
8. Next: `test(mcp): concrete tools, policy denial, fake-agent`
9. Next: `docs: MCP tool catalog stub`
10. Final for milestone: `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Octokit vs. minimal client.** Decide whether to adopt `@octokit/request` plus paginator helpers, or build pagination on top of the existing `GitHubClient`. Recommendation: add `@octokit/request` only; keep our wrapper as the interface for handlers so tests can mock easily.
- **Bun runtime vs. tsup-bundled Node.** MCP SDK currently targets Node; verify it bundles cleanly via tsup.
- **Tool-spec input schemas** must be plain JSON Schema (Draft-07) for portability with the MCP SDK; do not lean on Zod-only constructs without conversion.

---

## Milestone 3 — Claude Code Driver and Setup-Token Auth

### Current status

Partial scaffold only. Do not redo the existing `AgentDriver` interface or model-alias baseline unless the SPEC contract requires a small widening; focus on auth resolution, real process execution, CLI auth helpers, doctor checks, and leak tests.

### Goal

Wire the primary `claude-code` agent driver with `CLAUDE_CODE_OAUTH_TOKEN` (preferred) and `ANTHROPIC_API_KEY` (fallback). Add the CLI helpers, doctor checks, and aggressive secret masking. No prompt content yet — only the substrate.

### Dependencies

- No new runtime deps strictly required; we shell out to the local `claude` CLI.
- Add `execa` (or use `node:child_process`) for process management; prefer `node:child_process` to avoid extra deps.

### Tasks

#### Agent driver substrate

- [x] `packages/agents/src/driver.ts` — initial SPEC §11.1-style interface plus `AgentRunInput`/`AgentRunResult`.
- [x] Add `packages/agents/src/index.ts` barrel export.
- [x] `packages/agents/src/auth.ts`:
  - [x] `resolveClaudeAuth(env)` matching SPEC §6.4 exactly.
  - [x] Generic `resolveAuthFor(driverId, env)` for future providers.
  - [x] `maskSecret(value, label)` that calls `core.setSecret` when running in GitHub Actions.
- [x] `packages/agents/src/model-registry.ts` — minimal Claude aliases exist; expand to expose `resolveModel(aliasOrId, supports?)` returning a `ResolvedModel` with provider + concrete model.
- [x] `packages/agents/src/claude-code.ts`:
  - [x] Detect `claude` CLI in PATH; surface clear `AuthError` if missing.
  - [x] Spawn with sanitized env: only auth env that the driver requires.
  - [x] Pass MCP server URL via Claude CLI `--mcp-config` and `--strict-mcp-config`.
  - [x] Stream stdout/stderr through the redactor.
  - [x] Track activity timestamps; abort on `activityTimeoutMs` of silence and on total `timeoutMs`.
  - [x] Strip `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` from shell-tool child processes by default.

#### CLI auth helpers

- [x] `packages/cli/src/auth/claude-setup-token.ts`:
  - [x] Detect `claude` CLI; run `claude setup-token`, capturing only the printed token.
  - [x] Validate token shape (length sanity, never log).
  - [x] Mask token output; optional `--repo` writes via `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo … --body …`.
- [x] `packages/cli/src/auth/claude-import.ts`:
  - [x] Read token from stdin (single line).
  - [x] Mask and optionally store via `gh secret set`.
- [x] Wire both into `packages/cli/src/index.ts`.

#### Doctor

- [x] `packages/cli/src/doctor.ts`:
  - [x] Config validity (reuse `loadConfigFile`).
  - [x] `gh` CLI availability and authenticated user.
  - [x] `claude` CLI availability and version.
  - [x] Presence of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (without printing values).
  - [x] Git cleanliness.
  - [x] Bun and Node versions.
  - [x] MCP server smoke test (start + stop).
  - [x] Redaction smoke test: verify a known fake secret is replaced before printing.

### Tests

- [x] `auth.test.ts`: OAuth wins over API key; missing both throws `AuthError`; whitespace-only values rejected.
- [x] `claude-code.driver.test.ts`: fake child process via stub; verifies timeout and activity-timeout fire correctly.
- [x] `secret-leak.test.ts`: fake token values are captured from driver/doctor/auth output and asserted absent.
- [x] `cli/auth/setup-token.test.ts`: stdin path masks token; `--repo` path calls a mocked `gh` shim.
- [x] `doctor.test.ts`: prints all checks; passes when env is healthy.

### Validation commands

```bash
bun run typecheck
bun test -- packages/agents
bun test -- packages/cli
bun test
bun run build
```

### Completion criteria

- [x] Driver can be invoked in a dry-run/fake-MCP integration test using a stub Claude CLI.
- [x] OAuth-token handling is isolated to `packages/agents/src/auth.ts`, `packages/agents/src/claude-code.ts`, and CLI auth utilities.
- [x] Known fake token never appears in tested driver, CLI auth, or doctor output.

### Suggested commit split

1. `feat(agents): driver interface and model registry resolver`
2. `feat(agents): Claude auth resolver with masking`
3. `feat(agents): claude-code driver with timeout/activity-timeout`
4. `feat(cli): claude setup-token and import commands`
5. `feat(cli): doctor command`
6. `test(agents,cli): auth, driver lifecycle, secret leak, doctor`
7. `docs: claude-token.md filled in`
8. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Where MCP attaches.** Confirm whether the Claude Code CLI accepts an MCP URL via CLI flag, env var, or a config file. Encode in `claude-code.ts` and document in `docs/claude-token.md`.
- **Streaming progress.** Decide format for workflow-summary progress (recommend a single rolling section, not appended log lines).

---

## Milestone 4 — Review MVP

### Goal

Implement `review` mode end-to-end with a single built-in `code-review` skill, structured findings, inline review comments (with summary fallback), severity thresholds, dedupe, and run artifacts. No verification pass yet — that arrives in Milestone 5.

### Tasks

#### Diff and context

- [x] `packages/github/src/diff.ts`:
  - [x] `fetchPullRequestDiff(client, pr)` — returns raw diff and parsed hunks via a simple unified-diff parser.
  - [x] `mapDiffPositions(hunks)` — produces a `Map<string, DiffPosition[]>` keyed by path.
  - [x] `isCommentableLine(positions, path, line)` — used by review tool.
- [x] `packages/core/src/context/assembler.ts`:
  - [x] `assembleReviewContext({ event, repo, diff, files, repoInstructions, prSummary?, learnings? })` returning labeled L0–L10 sections.
  - [x] `loadRepoInstructions(cwd)` scanning for `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/**`, `.cursorrules`, `.github/copilot-instructions.md`.
- [x] `packages/core/src/context/labels.ts`:
  - [x] Wrap untrusted blocks with explicit instruction headers (SPEC §15.3).
- [x] `packages/core/src/context/manifest.ts`:
  - [x] Emit `reviewbot-context-manifest.json` listing every section, byte size, and untrusted flag.

#### Review schema and pipeline

- [ ] `packages/core/src/review-schema.ts`:
  - [x] `ReviewFinding` type (SPEC §13.1) plus validation helper.
  - [x] `parseFindings(raw)` returning `{ findings: ReviewFinding[]; errors: string[] }`.
- [ ] `packages/core/src/review-pipeline.ts`:
  - [x] `runReviewPipeline({ candidates, policy, config, diffPositions })`:
    - parse + validate
    - apply `minConfidence`, `reportOn`, `maxFindings`, `maxInlineFindings`
    - dedupe by `(path, lineRange, skill, normalizedTitle)`
    - map to diff positions; flag fallback when inline mapping fails
    - assign hidden marker IDs
- [x] `packages/github/src/reviews.ts`:
  - [x] `postReview(client, pr, body, comments, event)` honoring policy and event selection.
  - [x] `fallbackToSummary(finding)` when inline mapping fails.
  - [x] `dedupePreviousFindings(existingComments, newFindings)` via hidden markers.

#### Skill registry (single skill for MVP)

- [x] `packages/core/src/skills/index.ts` — registry stub for v0.1.
- [x] `packages/core/src/skills/code-review.ts` — built-in skill prompt + path filters (default `**/*`).

#### Run record + artifacts

- [x] `packages/action/src/artifacts.ts`:
  - [x] Write `reviewbot-run.json`, `reviewbot-findings.json`, `reviewbot-context-manifest.json` to `${RUNNER_TEMP}/reviewbot/` and upload via `actions/upload-artifact` syntax in example workflow (not done in code — just files on disk).
- [x] Extend `RunRecord` with `findings`, `postedComments`, and `contextManifestPath` (already structurally allowed).

#### CLI

- [x] `packages/cli/src/local-review.ts`:
  - [x] Run `review` mode against a local repo using `--base`/`--head`.
  - [x] Print findings to stdout; optionally write findings JSON.

### Tests

- [x] Diff parser maps added/modified/deleted lines correctly across small and multi-hunk fixtures.
- [x] Diff position mapping rejects out-of-range line comments.
- [x] Pipeline drops findings below `minConfidence`/`reportOn` thresholds.
- [x] `maxInlineFindings` and `maxFindings` budgets enforced; overflow folded into summary.
- [x] Dedupe merges findings with same `(path, lineRange, skill, normalizedTitle)`.
- [x] High-severity finding without inline mapping falls back to summary, never dropped silently.
- [x] Review mode under fork policy never tries to push or comment beyond review.
- [x] Hidden markers prevent reposting identical findings on a synchronize event.
- [x] Context manifest lists every section with byte sizes and `untrusted` flags.

### Validation commands

```bash
bun run typecheck
bun test -- packages/github
bun test -- packages/core
bun test -- packages/action
bun run build
```

### Completion criteria

- [x] A PR fixture can be reviewed end-to-end with a fake agent.
- [x] Inline comments only attempted for valid diff positions.
- [x] All three run artifacts emitted on disk; paths recorded in `RunRecord`.
- [x] Action sets `review_findings` and `summary` outputs.

### Suggested commit split

1. `feat(github): diff fetch and position mapping`
2. `feat(core): review schema and pipeline`
3. `feat(core): context assembler with untrusted labeling`
4. `feat(core): code-review skill (built-in)`
5. `feat(github): post review with dedupe markers and fallback`
6. `feat(action): review-mode wiring, artifacts, outputs`
7. `feat(cli): local review command`
8. `test: diff, pipeline, fallback, dedupe, fork policy`
9. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Token budget for context.** Implement file-count cap (`maxContextFiles = 50`) and hunk char cap (`maxChunkChars = 8000`) from the start. Defer adaptive shrinking to Milestone 5.
- **Agent prompt format.** Lock down a JSON-only contract: the prompt instructs the agent to emit a single JSON array conforming to the findings schema, no prose. Keep prompt under version control in `packages/core/src/skills/code-review.ts`.

---

## Milestone 5 — Warden-Grade Review Quality

### Goal

Move review mode from MVP to low-noise, multi-skill, verified output with calibrated severity, dedupe across runs, suggested fixes, and optional `REQUEST_CHANGES` / failing-check behavior.

### Tasks

- [ ] Add built-in skills: `security-review`, `workflow-security`, `test-review`, `docs-review`. Each in its own file under `packages/core/src/skills/`.
- [ ] Extend skill interface to honor `paths`, `ignorePaths`, `triggers`, `failOn`, `reportOn`, `minConfidence`.
- [ ] Implement skill trigger matching: event + action + path-filter intersection.
- [ ] Implement six-stage pipeline in `packages/core/src/review-pipeline.ts`:
  1. candidate generation (per skill)
  2. verification pass (same model, read-only, takes the candidate plus relevant source)
  3. dedupe (cross-skill, by path/line/title/root-cause similarity)
  4. severity calibration (downgrade vague/speculative)
  5. actionability filter (must hit at least one allowed finding category)
  6. posting budget (`maxInlineFindings`, `maxFindings`)
- [ ] Suggested-fix validation: small range, indentation-correct, single-file inline, never spans multiple files.
- [ ] `REQUEST_CHANGES` policy: global default + per-skill override. Threshold-driven.
- [ ] Failing-check support gated by `failCheck` config.
- [ ] Noise filters from SPEC §14.2 implemented as a deterministic post-filter.
- [ ] Findings artifact upload (`reviewbot-findings.json`) consistent across all skills.

### Tests

- [ ] Skill path/ignore filters include/exclude expected files for each skill.
- [ ] Trigger matcher respects event + action whitelists.
- [ ] Verification pass removes findings unsupported by source.
- [ ] Severity calibration downgrades speculative findings.
- [ ] Noise filter removes style nags and acknowledged-in-body issues.
- [ ] Suggested fix rejected when indentation mismatched or range too large.
- [ ] `REQUEST_CHANGES` only emitted when enabled and threshold exceeded.
- [ ] Failing check only triggers when enabled and threshold exceeded.
- [ ] Multi-skill run produces deduped output with stable IDs.

### Validation commands

```bash
bun run typecheck
bun test
bun run build
```

### Completion criteria

- [ ] All five built-in skills runnable with path filters and triggers.
- [ ] Verification, dedupe, calibration, actionability, and budget are mandatory steps in the path.
- [ ] Output remains low-noise on the golden PR fixtures.

### Suggested commit split

1. `feat(skills): security-review, workflow-security, test-review, docs-review`
2. `feat(skills): path/trigger/threshold filtering`
3. `feat(review): verification pass`
4. `feat(review): dedupe + severity calibration + actionability + budget`
5. `feat(review): suggested-fix validation`
6. `feat(review): REQUEST_CHANGES and failing check gates`
7. `test: skill filters, pipeline stages, golden PR fixtures`
8. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Cost.** Verification doubles model calls. Allow `[review.verify].enabled = true` config with default `true` and document the cost. Per Locked Decision: same model for generation and verification in v0.x.
- **Similarity scoring** for dedupe should be deterministic. Recommend normalized title + path + line bucket; avoid embedding-based clustering in v0.x.

---

## Milestone 6 — Mention-Driven Implementation Mode

### Goal

Allow trusted maintainers/collaborators to invoke `implement` (and other write-capable modes) via `@reviewbot` mentions. Manage `reviewbot/*` bot branches, post progress, run restricted shell inside a sandbox, and open/update PRs with structured final summaries.

### Tasks

- [ ] Finalize command parser behavior in mention events; ensure command source is preserved through the pipeline.
- [ ] `packages/action/src/progress.ts` (new):
  - [ ] Create one progress comment for mention/manual runs.
  - [ ] Update at most every 10–15 s (debounced); replace on completion; keep on failure.
- [ ] `packages/github/src/branches.ts` (new):
  - [ ] Always derive `reviewbot/<slug>` from the run; reject any branch outside the `reviewbot/` prefix in git tools.
  - [ ] Create or fast-forward bot branch off the trigger commit.
- [ ] Restricted shell sandbox in `packages/mcp/src/tools/shell.ts`:
  - [ ] Docker by default when available; fail closed otherwise.
  - [ ] Allowlisted env vars only; secrets stripped unless explicitly permitted by policy.
  - [ ] Command allow/deny lists from config.
  - [ ] Tree-kill on timeout.
  - [ ] Background process tracking via `kill_background_process`.
- [ ] Complete git write tools: `git_commit`, `push_branch`, `create_pull_request` with commit-message template from SPEC §13.2.
- [ ] Final summary content: requested task, work done, files changed, commands run, checks passed/failed, commits pushed, follow-ups.
- [ ] Workflow summary updates for implement mode (include shell commands and commits).

### Tests

- [ ] Non-trusted actor cannot trigger write-capable mode.
- [ ] Fork PR mention is denied push/shell/secrets even when policy elsewhere allows it.
- [ ] Maintainer mention gets restricted shell/push as configured.
- [ ] Progress comment is debounced; updates capped at the configured rate.
- [ ] Bot branch naming collision avoidance.
- [ ] Sandbox: secrets stripped from child env unless explicitly allowed.
- [ ] Git writes denied when push policy is disabled.
- [ ] Commit message contains `reviewbot: …`, `Requested-by`, `Run-id`, `Mode`.

### Validation commands

```bash
bun run typecheck
bun test
bun run build
```

### Completion criteria

- [ ] `@reviewbot implement …` fixture flow runs end-to-end with a fake agent and produces a final summary.
- [ ] Implementation path cannot bypass `reviewbot/*` branch policy or shell sandbox.
- [ ] Final summaries are clear, non-chatty, and free of secrets.

### Suggested commit split

1. `feat(action): progress comment lifecycle`
2. `feat(github): bot branch helpers`
3. `feat(mcp): restricted shell sandbox (Docker default, fail-closed)`
4. `feat(mcp): git write tools with template enforcement`
5. `feat(action): implement-mode end-to-end wiring`
6. `test: branch enforcement, sandbox env, progress debounce`
7. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Docker availability** on GitHub-hosted runners is fine but may not be guaranteed elsewhere. Document fail-closed behavior in `docs/security.md`.
- **Progress comments vs. workflow summary.** Per SPEC §17, progress comments are for mention/manual runs only; automatic PR reviews should rely on the check summary.

---

## Milestone 7 — CI Repair Loop (`fix-ci`)

### Goal

Diagnose failed checks, patch, validate locally when allowed, push fixes to `reviewbot/*`. Hard attempt and runtime budgets.

### Tasks

- [ ] `packages/github/src/checks.ts`:
  - [ ] `findFailedCheckRuns(client, ref)`.
  - [ ] `fetchCheckLog(client, runId, maxBytes)` with compression/truncation.
- [ ] Treat all check log content as untrusted (label in context assembly).
- [ ] `packages/core/src/fix-ci.ts`:
  - [ ] `summarizeFailures(logs)` prompt template.
  - [ ] `runFixCiLoop({ policy, config, maxAttempts, maxRuntime })` orchestrating: diagnose → patch → tests (if allowed) → commit → push → re-check.
- [ ] Config block:
  ```toml
  [fixCi]
  maxAttempts = 3
  maxRuntime = "90m"
  rerunChecks = true
  ```
- [ ] Enforce attempt and runtime budgets; on exhaustion, post a structured summary of what was tried.
- [ ] Only commit/push to `reviewbot/*` branches.

### Tests

- [ ] Failed check logs fetched, truncated, and redacted.
- [ ] Log content cannot mutate runtime policy.
- [ ] Attempt budget enforced.
- [ ] Runtime budget enforced.
- [ ] Exhaustion summary includes attempted fixes and useful next steps.
- [ ] Push remains disabled for fork/untrusted contexts.

### Validation commands

```bash
bun run typecheck
bun test
bun run build
```

### Completion criteria

- [ ] `fix-ci` runs against a fixture set with a fake agent and emits a structured summary.
- [ ] Budgets covered by tests.

### Suggested commit split

1. `feat(github): failed-check discovery and log fetch with truncation`
2. `feat(core): fix-ci orchestration with budgets`
3. `feat(action): fix-ci mode wiring`
4. `test: budgets, untrusted logs, fork denial`
5. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Log size.** Compress aggressively before model context. Recommend tail-first truncation with a head sample.

---

## Milestone 8 — State and Memory

### Goal

Optional, GitHub-native state for PR summaries and (opt-in) repo learnings. No mandatory backend.

### Tasks

- [ ] `packages/core/src/state.ts`:
  - [ ] `StateStore` interface (SPEC §16.1).
  - [ ] `MemoryStateStore` for tests.
  - [ ] `GitHubStateStore` using hidden bot comments (`<!-- reviewbot:pr-summary:v1:… -->`) and workflow artifacts.
  - [ ] `FileStateStore` under `.reviewbot/state/` for local CLI use.
  - [ ] `ApiStateStore` interface stub for future hosted backend.
- [ ] Memory tools (`packages/mcp/src/tools/memory.ts`) read/write through the state store, respecting `memory.enabled` and `memory.learnings`.
- [ ] All persisted state passes through the redactor before write.
- [ ] Update `RunRecord.putRun` path to optionally persist via the configured backend.

### Tests

- [ ] PR summary hidden comment created/updated idempotently across runs.
- [ ] Repo learnings never read/written unless `memory.learnings = true`.
- [ ] File backend writes only under `.reviewbot/state/`.
- [ ] No secret value appears in any persisted record.

### Validation commands

```bash
bun run typecheck
bun test
bun run build
```

### Completion criteria

- [ ] Memory features are optional and off unless configured.
- [ ] Backend behavior covered by tests; state inspection straightforward.

### Suggested commit split

1. `feat(core): state store interface + memory backend`
2. `feat(core): github state backend with hidden markers`
3. `feat(core): file state backend`
4. `feat(mcp): memory tools wired through state store`
5. `test: state idempotency, learnings opt-in, redaction`
6. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Hidden state visibility.** Document marker schema and how maintainers can inspect/remove it. Avoid silent mutable state.

---

## Milestone 9 — Hardening, Evals, Docs, and Release

### Goal

Secure v0 release with prompt-injection tests, fork-PR fixtures, eval cases, complete docs, release build, and pinned example workflows.

### Tasks

#### Fixtures and evals

- [ ] `fixtures/events/`:
  - [ ] `pull_request.opened.json`
  - [ ] `pull_request.synchronize.json`
  - [ ] `issue_comment.mention.json`
  - [ ] `review_comment.mention.json`
  - [ ] `workflow_dispatch.json`
  - [ ] `check_suite.completed.failed.json`
  - [ ] `workflow_run.completed.failure.json`
- [ ] `packages/evals/src/harness.ts` + `replay-github-event.ts` + `score.ts`.
- [ ] `packages/evals/cases/`:
  - [ ] `security-sql-injection/`
  - [ ] `workflow-script-injection/`
  - [ ] `broken-test/`
  - [ ] `missing-await/`
  - [ ] `bad-react-hook/`
  - [ ] `unsafe-regex/`
  - [ ] `incorrect-permission-check/`
  - [ ] `path-traversal/`
  - [ ] `command-injection/`
  - [ ] `overbroad-github-token/`
- [ ] `EvalScore` (SPEC §26.5) implemented and reported in summary tables.
- [ ] `bun run evals` script wired in `package.json`.

#### Red-team tests

- [ ] PR/issue/comment bodies that attempt prompt injection (SPEC §26.6).
- [ ] Assertions:
  - [ ] No secrets surfaced in any output.
  - [ ] Policy unchanged.
  - [ ] No shell/push escalation.
  - [ ] No approval.

#### CLI

- [ ] `packages/cli/src/replay.ts` — replay any fixture against the local runtime in `--dry-run` mode.

#### Docs and examples

- [ ] Fully populate:
  - [ ] `README.md` with secure quickstart and badge-ready snippet.
  - [ ] `docs/config.md` — TOML reference and resolution order.
  - [ ] `docs/security.md` — policy, fork PR, secrets, sandbox, `pull_request_target` guidance.
  - [ ] `docs/workflows.md` — automatic review, mention bot, structured output, CI repair.
  - [ ] `docs/commands.md` — command list and mapping.
  - [ ] `docs/claude-token.md` — `claude setup-token` lifecycle.
  - [ ] `docs/troubleshooting.md` — auth, perm, mapping, output failures.
- [ ] Every workflow example uses explicit job-level `permissions` and pins third-party actions.
- [ ] Add SHA-pinned variants of example workflows under `docs/workflows.md`.

#### Release engineering

- [ ] Release checklist automation script (`scripts/release.ts`) that verifies build/test/typecheck/lint, regenerates `dist/index.js`, and prints a checklist.
- [ ] Tag plan: `v0.1.0`, moving `v0`; reserve `v1` for future.
- [ ] Optional SBOM via `bun audit` placeholder.

### Validation commands

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun run evals   # after harness lands
```

### Completion criteria

- [ ] Build, typecheck, lint, tests all green.
- [ ] Evals pass or regressions accepted explicitly.
- [ ] Redaction tests pass.
- [ ] Fork-PR policy tests pass.
- [ ] `action.yml` points to a fresh compiled `dist/index.js`.
- [ ] Docs cover config, security, workflows, commands, Claude token, troubleshooting.

### Suggested commit split

1. `test(fixtures): GitHub event fixtures`
2. `feat(evals): harness, replay, score`
3. `test(evals): seed eval cases`
4. `test(security): red-team prompt-injection fixtures`
5. `feat(cli): replay command`
6. `docs: README quickstart`
7. `docs: config, security, workflows, commands, claude-token, troubleshooting`
8. `chore(release): release script and v0.1.0 prep`
9. `chore(build): regenerate dist/index.js`

### Risks / decisions

- **Pinned actions in examples.** Pin to SHAs in hardened templates; keep tag-pinned versions in friendlier quickstart.
- **Eval determinism.** Use cached snapshots for model outputs in CI to keep evals reproducible without burning quota.

---

## v0.x Release Slices

These slices map onto the milestones above and form the user-visible cuts.

### v0.1 — Review MVP

Cut after Milestone 4 (and a slice of Milestone 5 if available).

- [ ] GitHub Action.
- [ ] Config parser.
- [ ] PR review mode.
- [ ] Claude Code OAuth/API auth.
- [ ] Local MCP server.
- [ ] PR diff and file tools.
- [ ] Create PR review tool.
- [ ] Warden-style findings schema.
- [ ] Severity thresholds.
- [ ] Setup-token CLI helper.
- [ ] No backend.
- [ ] No dashboard.

### v0.2 — Mentions and Git Writes

Cut after Milestone 6.

- [ ] `@reviewbot` command mode.
- [ ] Progress comments.
- [ ] Restricted shell.
- [ ] Commit/push to bot branch.
- [ ] CI log reader.

### v0.3 — CI Repair and Memory

Cut after Milestones 7 and 8.

- [ ] `fix-ci` loop.
- [ ] PR summary state.
- [ ] Repo learnings, opt-in only.
- [ ] Additional agent drivers, including `codex-cli` before v1.0.

### v0.4 — Evals and Optional Hosted State

Cut after Milestone 9.

- [ ] Eval harness.
- [ ] Optional hosted state backend interface.
- [ ] Optional dashboard exploration.

---

## Security Checklist (gate every release)

- [ ] Every example workflow has explicit least-privilege `permissions`.
- [ ] No broad PAT is required by default.
- [ ] `pull_request_target` is not used by default.
- [ ] Fork PR policy disables secrets, push, and shell by default.
- [ ] Comments, PR bodies, branch names, commit messages, check logs, and fork content are labeled untrusted in prompts.
- [ ] Runtime policy is never prompt-controlled.
- [ ] Tool calls are schema-validated and policy-checked.
- [ ] Shell env is filtered; secrets never pass into prompts.
- [ ] Logs, artifacts, summaries, and errors are redacted.
- [ ] AI approval is disabled unless explicitly configured in a future version (none in v0/v1).
- [ ] Review posting dedupes previous bot comments.
- [ ] High-severity findings fall back to summary body if inline mapping fails.

## Documentation Checklist (per release)

- [ ] `README.md` explains what reviewbot is and provides a secure quickstart.
- [ ] `docs/config.md` documents TOML config and effective resolution order.
- [ ] `docs/security.md` documents policy, fork PR handling, secrets, shell sandbox, `pull_request_target` guidance.
- [ ] `docs/workflows.md` includes automatic review, mention bot, standalone structured output, CI repair examples.
- [ ] `docs/commands.md` documents `@reviewbot` commands and command-to-mode mapping.
- [ ] `docs/claude-token.md` documents `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` handling.
- [ ] `docs/troubleshooting.md` documents common auth, permission, comment mapping, and action-output failures.
- [ ] `AGENTS.md` refreshed with any new operational gotchas.
- [ ] `HANDOFF.md` refreshed before any stop point.

## Final Validation Matrix

| Area | Required validation |
|---|---|
| Build | `bun run build` produces `dist/index.js`. |
| Types | `bun run typecheck` passes. |
| Lint | `bun run lint` passes. |
| Tests | `bun test` passes. |
| Config | Invalid config fails early with clear diagnostics. |
| Policy | Fork and untrusted contexts cannot escalate shell, push, or secrets. |
| Redaction | Known secret strings do not appear in logs, artifacts, summaries, or errors. |
| MCP | Every tool validates schema, checks policy, audits, and redacts. |
| Review | Findings are verified, deduped, thresholded, and line-mapped or summarized. |
| Claude auth | OAuth token and API-key paths both work; OAuth wins when both exist. |
| Sandbox | Restricted shell fails closed when Docker is unavailable. |
| Docs | Quickstart and workflow examples are secure by default. |

## Open Questions / Decisions to Revisit

- **Octokit dependency.** Adopt `@octokit/request` (+ paginator) for real API calls when MCP read tools land. Keep `GitHubClient` as the wrapper to preserve test ergonomics.
- **MCP SDK version pin.** Current dependency is `@modelcontextprotocol/sdk@^1.29.0`. Before v0.1, decide whether to pin exactly for action reproducibility or keep `^` for SDK patch uptake.
- **Prompt versioning.** Once skills land, decide on a per-skill prompt version (e.g., `code-review@v1`) recorded in findings for downstream calibration.
- **Eval result storage.** Decide whether to commit golden eval outputs or treat them as opt-in fixtures fetched at run time. Recommendation: commit small golden snapshots; fetch large ones on demand.

## Implementation Notes for Future Agents

- Implement milestones in order. Do not start the Claude driver before MCP, or review pipeline before context labeling.
- Prefer fake-agent integration tests before real Claude Code execution tests at every milestone.
- Keep `CLAUDE_CODE_OAUTH_TOKEN` handling isolated to `packages/agents/src/auth.ts`, `packages/agents/src/claude-code.ts`, and the CLI auth utilities.
- Do not add a hosted backend in v1 unless explicitly requested.
- External telemetry stays off by default; internal observability artifacts are always written.
- Update `AGENTS.md` and `HANDOFF.md` whenever the repo shape, validation commands, or operational gotchas change.
- Commits stay atomic, conventional, and scoped per the suggested commit splits above. Avoid mega-commits that combine MCP plumbing and agent drivers.
