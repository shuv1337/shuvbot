# HANDOFF

## Objective
- Continue `reviewbot` implementation from the refreshed remaining plan and the newly created GitHub issue queue.

## Current status
- `PLAN-reviewbot-remaining.md` was refreshed against live repo state and is currently modified locally but not committed.
- Milestones 0 and 1 are done. Milestone 2 is partial: MCP SDK, tool execution, policy gating, redacted audit records, and loopback MCP server exist and are tested; concrete MCP tool handlers are still placeholders.
- Milestone 3 is partial scaffold only: agent interfaces, minimal Claude aliases, CLI routing stubs, and placeholder agent modules exist; auth/driver/doctor work remains.
- Created 12 open GitHub issues from the remaining plan, all labeled `enhancement` + `ready-for-agent`: #1 through #12.
- No code implementation changes were made in this handoff pass.

## Key context
- Follow `SPEC.md`, `AGENTS.md`, and `PLAN-reviewbot-remaining.md`; `SPEC.md` is source of truth for product/security behavior.
- Runtime policy remains the only permission authority. Fork PRs must not get shell, push, or secrets. `canApprove` stays disabled for v1.
- Repo learnings stay disabled by default unless `[memory].learnings = true`.
- `dist/index.js` should be regenerated after milestones that change action-visible behavior.
- The next implementation should start with issue #1, then proceed dependency order.

## Important files
- `PLAN-reviewbot-remaining.md` — refreshed milestone checklist and source for the new issue queue.
- `SPEC.md` — product/security/runtime policy source of truth.
- `AGENTS.md` — repo-local operating notes and validation expectations.
- `packages/mcp/src/tool-spec.ts` — partial MCP tool execution foundation.
- `packages/mcp/src/server.ts` — partial loopback MCP server lifecycle.
- `packages/mcp/src/tools/*.ts` — placeholder tool modules to replace.
- `packages/agents/src/*` and `packages/cli/src/*` — partial agent/CLI scaffold for Milestone 3.

## External references
- #1 Complete MCP audit log and tool context foundation
- #2 Implement MCP read-context tools
- #3 Implement MCP GitHub write tools with hidden-marker dedupe
- #4 Implement MCP git, shell, and memory tool stubs with policy gates
- #5 Implement Claude auth, Claude Code driver, setup-token CLI, and doctor checks
- #6 Build Review MVP end to end
- #7 Add Warden-grade review quality pipeline and built-in skills
- #8 Implement mention-driven write-capable mode
- #9 Implement CI repair loop
- #10 Implement optional state and memory backends
- #11 Add hardening fixtures, eval harness, replay CLI, and red-team tests
- #12 Complete docs, workflow examples, and release automation

## Validation
- Previous validation during plan refresh: `bun test` passed with 64 tests.
- Current handoff pass verified open issue list with `gh issue list`.
- No tests were run after writing this handoff because only `HANDOFF.md` changed.

## Next steps
1. Review and commit the doc-only changes if desired: `PLAN-reviewbot-remaining.md` and this `HANDOFF.md`.
2. Start issue #1: finish MCP audit snapshots and expand tool context without redoing existing server/tool-spec work.
3. Run `bun run typecheck`, targeted MCP tests, `bun test`, and `bun run build` before committing implementation.

## Risks / open questions
- `PLAN-reviewbot-remaining.md` is locally modified and uncommitted.
- Decide before v0.1 whether `@modelcontextprotocol/sdk@^1.29.0` should be pinned exactly for action reproducibility.
- Confirm the Claude Code CLI MCP attachment mechanism before implementing issue #5.

## Resume prompt
- Pick up in `/home/shuv/repos/shuvbot`, inspect issue #1 and `PLAN-reviewbot-remaining.md`, then implement the next smallest MCP foundation slice with tests.
