# HANDOFF

## Objective
- Continue `reviewbot` toward Milestone 2 (MCP tool server and safe tool execution).

## Current status
- `master` is pushed to `origin/master`; the MCP foundation landed in `212c14d`.
- GitHub issue queue is empty as of 2026-05-18.
- Milestones 0 and 1 remain complete in `PLAN-reviewbot-implementation.md`.
- The first Milestone 2 slice is complete:
  - `packages/mcp/src/tool-spec.ts` defines reviewbot-owned tool contracts, schema validation, policy requirements, sanitized audit records, and `executeTool`.
  - `packages/mcp/src/server.ts` starts a local Streamable HTTP MCP server using `@modelcontextprotocol/sdk`, bound to `127.0.0.1:<ephemeral-port>`.
  - Tool execution is policy-checked, input/output-schema validated, audited, redacted, and MCP-visible errors are sanitized.
  - `packages/mcp/test/tool-spec.test.ts` and `packages/mcp/test/server.test.ts` cover the foundation and a fake SDK client calling a tool.

## Validation
- `bun run typecheck` passed.
- `bun test` passed: 64 tests.
- `bun run lint` passed.
- `bun run build` passed and rebuilt `dist/index.js`.

## Next unblocked Milestone 2 work
1. Implement read-context tool specs and handlers, starting with the lowest-risk local/context tools:
   - `read_file`
   - `search_repo`
   - `git_status`
   - then GitHub-backed tools such as `get_pr`, `get_pr_diff`, and `get_pr_files`.
2. Add tests proving write-capable tools fail under read-only/fork policy.
3. Wire MCP tool-call summaries into `RunRecord` / workflow summary once action-level MCP startup begins.

## Risks / open questions
- The SDK transport has exact-optional TypeScript incompatibilities under this repo config, so `server.ts` and the SDK client test use narrow casts around transport types.
- `@modelcontextprotocol/sdk` and `zod` were added to runtime dependencies.
- No GitHub-backed MCP tools exist yet; the current slice is the safe execution and server foundation only.

## Resume prompt
Review `AGENTS.md`, `HANDOFF.md`, `SPEC.md`, and `PLAN-reviewbot-implementation.md`; verify `git status` and `gh issue list`; then continue Milestone 2 by implementing the next read-context tools with focused tests and validation.
