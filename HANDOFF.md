# HANDOFF

## Objective
- Continue `reviewbot` toward Milestone 2 (MCP tool server and safe tool execution) now that Milestone 1 is in.

## Current status
- Milestones 0 and 1 are checked off in `PLAN-reviewbot-implementation.md`.
- Stray `Test` line was removed from `SPEC.md` line 7.
- Repo has normalized GitHub event types, mention/command parser, auto-mode inference, runtime policy builder with the SPEC §9.2 matrix, envelope validator that rejects forbidden runtime fields, and an expanded workflow summary that includes runtime policy.
- `dist/index.js` rebuilt against the new flow; `bun run typecheck`, `bun test`, and `bun run lint` all pass (57 tests).
- Nothing has been committed yet for Milestone 1 — diff is staged in the working tree.

## Key context
- Modes are now the SPEC-aligned set: `auto`, `review`, `implement`, `fix-ci`, `triage`, `release-notes`. `auto` is for the action input only; runtime always resolves it to a concrete mode.
- Command parser lives in `packages/core/src/commands.ts` with the supported command list from SPEC §20.2 and a `findCommandInEvent` helper. Mode mapping is in `packages/core/src/modes.ts`.
- `packages/core/src/policy.ts` exports `buildRuntimePolicy({event, mode, actor, configCaps, inputCaps})`. It seeds from a context default matrix (fork/PR/comment/schedule/dispatch), applies config and input caps as restrictions only (never escalation), then enforces hard event/mode restrictions. Approval is hard-disabled. Reasons are recorded for telemetry.
- `packages/github/src/permissions.ts` returns an `ActorContext` and includes `fetchActorPermission` which calls `GET /repos/{owner}/{repo}/collaborators/{username}/permission` using the minimal `GitHubClient` interface from `packages/github/src/octokit.ts`.
- `packages/action/src/main.ts` now reads `GITHUB_EVENT_PATH`, normalizes the event, parses any `@reviewbot` command, resolves the mode, derives the actor (defaults to `none` if no token), builds the runtime policy, and writes a richer workflow summary. No agent or MCP is started.
- `RunRecord` now carries `trigger`, `eventAction`, `filesConsidered`, `filesIgnored`, `toolCalls`, `errors`, and an optional `policy` summary.

## Important files
- `packages/core/src/events.ts` — normalized BotEvent types, `normalizeEvent`, `validateEnvelope`, `EventNormalizationError`, `EnvelopeError`.
- `packages/core/src/commands.ts` — `parseCommand`, `findCommandInEvent`, supported command list, configurable prefix.
- `packages/core/src/modes.ts` — `resolveMode`, command-to-mode map, keyword inference for `auto`.
- `packages/core/src/policy.ts` — `buildRuntimePolicy`, `applyRuntimeCaps`, `defaultRuntimePolicy`, reasons trail.
- `packages/core/src/types.ts` — updated MODES + `ActorPermission` enum.
- `packages/core/src/run-record.ts` — `recordPolicy`, `summarizePolicy`, expanded fields.
- `packages/github/src/octokit.ts` — fetch-based `GitHubClient` + `createGitHubClient` factory.
- `packages/github/src/permissions.ts` — fork/private detection, actor permission derivation.
- `packages/action/src/main.ts` — full Milestone 1 flow without agents.
- `packages/action/src/workflow-summary.ts` — full policy/files/tools/errors summary.
- New tests:
  - `packages/core/test/events.test.ts`
  - `packages/core/test/commands.test.ts`
  - `packages/core/test/modes.test.ts`
  - `packages/core/test/policy-matrix.test.ts`
  - `packages/github/test/permissions.test.ts`

## Next steps
1. Commit the Milestone 1 work in conventional, atomic commits (suggested split: types/events, commands+modes, policy, github client/permissions, action wiring, tests, plan/handoff updates) and push to `origin/master`.
2. Start Milestone 2 (`packages/mcp/`):
   - Implement `tool-spec.ts` with `ToolSpec`, `ToolContext`, schema validation helpers, and policy requirement helpers.
   - Implement `server.ts` using the official MCP TypeScript SDK on a `127.0.0.1` ephemeral port.
   - Build read-context tools first (`get_pr`, `get_pr_diff`, …), then write tools, then git/shell/memory stubs.
   - Add audit-log + redaction hooks for every tool call.
3. Decide whether to add a real Octokit dependency now (needed once MCP tools start hitting the API in earnest) or keep the lightweight `GitHubClient` interface and back it with `@octokit/request` later.

## Risks / open questions
- The `GitHubClient` interface is intentionally minimal; the route-template helper handles `{owner}/{repo}/{username}` substitution but only naively supports JSON payloads. Audit it before tool handlers start using POST/PATCH routes.
- `resolveMode` auto-inference uses lightweight keyword heuristics. Expand cautiously; do not let it override explicit command/event signals.
- Untrusted envelope/PR text reaches the prompt path eventually. Keep `validateEnvelope` invocations on every external entry point before plumbing prompts into agent drivers.
