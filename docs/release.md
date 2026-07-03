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
- `dist/index.js` must stay committed and fully self-contained: GitHub runs JS actions from the checkout with no `npm install`, so runtime dependencies must be inlined by `tsup.config.ts` rather than left as bare package imports.
- Before moving a release tag, run `bun test packages/action/test/dist-bundle.test.ts` (or the full test suite) to confirm the committed bundle loads in a bare checkout and is byte-for-byte fresh relative to source.
