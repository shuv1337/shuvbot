# shuvbot / reviewbot Project Notes

This repository is currently in its Milestone 0 scaffold for `reviewbot`, a GitHub-native code review and coding-agent bot.

## Current repository shape

- `SPEC.md` is the source specification for the intended product.
- `PLAN-*.md` files capture implementation plans derived from the spec.
- `packages/` contains the initial TypeScript scaffold for the action, CLI, core runtime, agent drivers, GitHub helpers, MCP tools, and eval harness.
- `dist/index.js` is the compiled GitHub Action output produced by `bun run build`.

## Intended technology stack

- TypeScript
- Bun for install/build/test commands
- ESLint and Prettier for the initial lint/format baseline
- `tsup` targeting Node 24 for compiled GitHub Action output
- Compiled GitHub Action output in `dist/index.js`
- Local MCP tool server for GitHub, git, shell, filesystem, and output tools, implemented with the official MCP TypeScript SDK behind reviewbot-owned tool contracts
- Claude Code as the first-class initial agent driver

## Operating principles

- Do not let model prompts or GitHub event payloads grant permissions; deterministic runtime policy must decide.
- Treat PR bodies, comments, branch names, commit messages, check logs, and fork content as untrusted context.
- Keep `CLAUDE_CODE_OAUTH_TOKEN` and all provider credentials out of prompts, logs, shell subprocesses, and workflow summaries unless explicitly required by an agent driver.
- Prefer GitHub-native state and artifacts for v1; avoid a mandatory backend.
- Keep repo learnings disabled by default; require explicit `[memory].learnings = true` before reading or writing them.
- Telemetry/observability is a day-zero requirement: every run should produce structured run records, redacted logs, timings, tool-call summaries, and failure diagnostics. External telemetry export should remain explicit/opt-in for GitHub Action users.

## Expected validation commands once scaffolded

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
```

## Notes for future agents

- When implementing from a plan, keep edits aligned with `SPEC.md` and update both the plan checkboxes and this file if repository reality changes.
- Use small milestones: skeleton/config plus policy skeleton first, then event/policy core, then MCP tools, then agent drivers, then review posting.
- For the first scaffold, create all required docs as honest stubs rather than leaving the docs tree absent.
