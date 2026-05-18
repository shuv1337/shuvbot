# HANDOFF

## Objective
- Continue `reviewbot` after the Milestone 0 scaffold toward Milestone 1 GitHub event core and runtime policy.

## Current status
- Milestone 0 scaffold is implemented and committed to `master`.
- All changes were pushed to `origin/master` as 7 atomic conventional commits.
- The repo has TypeScript/Bun project metadata, `action.yml`, compiled `dist/index.js`, package folders, docs stubs, sample config, and focused tests.
- `decisions-reviewbot-spec.html` was removed.

## Key context
- Build target: TypeScript, Bun, ESLint, Prettier, `tsup` targeting Node 24.
- `action.yml` uses `runs.using: node24` and `runs.main: dist/index.js`.
- Config parser lives in `packages/core/src/config.ts`; it validates TOML, rejects unknown top-level keys except `x-*`, validates enums/glob basics, and defaults repo learnings to disabled.
- Policy skeleton lives in `packages/core/src/policy.ts`; untrusted contexts cannot escalate shell/push.
- Redaction, observability, run-record scaffolding, minimal Claude aliases, action input parsing, workflow summary shell, and CLI stubs are present.
- `reviewbot.sample.toml` is the current sample for `reviewbot config validate`.

## Important files
- `PLAN-reviewbot-implementation.md` — Milestone 0 checked off; Milestone 1 is next.
- `packages/core/src/config.ts` — config defaults and validation.
- `packages/core/src/policy.ts` — default permission matrix skeleton.
- `packages/core/test/*.test.ts` — config, policy, and redaction tests.
- `packages/action/src/*` — GitHub Action entry/main/input/summary shell.
- `packages/cli/src/index.ts` — command stubs and config validation.
- `dist/index.js` — built action output.

## Next steps
1. Start Milestone 1 in `PLAN-reviewbot-implementation.md`: normalized GitHub events, actor permission derivation, runtime policy construction, and workflow summaries without invoking agents.
2. Replace placeholder modules incrementally instead of broad rewrites.
3. Confirm whether the stray `Test` line in `SPEC.md` should be removed before touching it.

## Risks / open questions
- Do not treat placeholder files as implemented behavior; they only establish the planned structure.
- Keep credential isolation and deterministic policy as hard constraints.
