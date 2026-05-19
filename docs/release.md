# Release

Run:

```bash
bun scripts/release.ts
```

The script runs install, typecheck, lint, tests, build, and evals, then prints the release checklist.

Tag plan:

- `v0.1.0` points at the first reviewbot v0 release commit.
- `v0` is a moving major tag updated only after release smoke validation.
- `v1` is reserved for the future stable contract.

Current validation matrix:

- `bun run typecheck`
- `bun run lint`
- `bun test`
- `bun run build`
- `bun run evals`
- `action.yml` must keep `runs.main: dist/index.js`.
