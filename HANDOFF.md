# HANDOFF

## Objective
- Continue `reviewbot` after the Milestone 0 scaffold toward Milestone 1 GitHub event core and runtime policy.

## Current status
- Milestone 0 scaffold is implemented and checked off in `PLAN-reviewbot-implementation.md`.
- The repo now has TypeScript/Bun project metadata, `action.yml`, compiled `dist/index.js`, package folders, docs stubs, sample config, and focused tests.
- Decision HTML artifacts were reconciled into canonical docs and removed. `decisions-reviewbot-spec.html` is tracked as deleted; `decisions-reviewbot-build-start.html` was untracked and is gone.
- `SPEC.md` still has a pre-existing unexplained `Test` line near the top; it was intentionally left untouched.

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

## Validation
- `bun install` — passed, no changes after lockfile creation.
- `bun run typecheck` — passed.
- `bun run lint` — passed.
- `bun test` — passed, 12 tests.
- `bun run build` — passed, produced `dist/index.js`.
- `bun packages/cli/src/index.ts config validate reviewbot.sample.toml` — passed.

## Next steps
1. Start Milestone 1 in `PLAN-reviewbot-implementation.md`: normalized GitHub events, actor permission derivation, runtime policy construction, and workflow summaries without invoking agents.
2. Replace placeholder modules incrementally instead of broad rewrites.
3. Confirm whether the stray `Test` line in `SPEC.md` should be removed before touching it.

## Risks / open questions
- Do not treat placeholder files as implemented behavior; they only establish the planned structure.
- Keep credential isolation and deterministic policy as hard constraints.
