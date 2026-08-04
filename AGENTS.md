# shuvbot / reviewbot Project Notes

`reviewbot` is a GitHub-native code review and coding-agent bot. **Review mode
is live**: `packages/action/src/main.ts` wires the real `claude-code`
driver + MCP tool server into every PR review run (as of the "wire real
agent" work, see git log around the `feat(action): wire real Claude Code
driver into review mode` commit). `implement` and `fix-ci` modes are _not_
wired to a real agent yet - they run their full policy/branch/tooling path
and end in a documented no-op agent step. See `docs/workflows.md` for the
current per-mode status; don't trust older commit messages/docs that imply
otherwise without checking `main.ts` directly.

## Current repository shape

- `SPEC.md` is the source specification for the intended product. It describes
  the full eventual design (including unimplemented pieces like
  `output_schema`, `[telemetry]`, and the nested/versioned config schema it
  used to show in §7.2) - sections that don't match shipped behavior are
  annotated inline with "Not implemented" notes rather than deleted. Check the
  actual code before trusting a SPEC section as current behavior.
- `PLAN-*.md` files capture implementation plans derived from the spec. They
  are historical planning artifacts, not live status - `git log` and the code
  are authoritative over their checkboxes.
- `packages/` contains the TypeScript implementation: the action entrypoint,
  CLI, core runtime, agent drivers, GitHub helpers, MCP tools, and eval
  harness.
- `packages/review/` contains deterministic preprocessing, plugin assembly,
  specialist/coordinator execution, quorum, incremental state, scheduling,
  observability, and the isolated shuvcode adapter. The local CLI routes to
  this coordinator path, but the GitHub Action does not.
- **Local review runs the coordinator by default.** The code-approved shuvcode
  runtime pin is `2.0.0-alpha-9` (`APPROVED_SHUVCODE_RUNTIME_VERSION` in
  `packages/core/src/config.ts`), verified against the published release by
  `bun run smoke:runtime`. It needs `review.shuvcode.use_user_auth` and a local
  shuvcode profile; a mismatched or null pin still rejects before any Git work.
  `shuvcode` is a devDependency, and the runtime resolves from the reviewed
  repository first and from reviewbot's own install second, so reviewing a
  repository that does not depend on shuvcode works. `legacy` still fails
  closed - it has no safe production driver and only tests inject fake agents.
  None of this affects the live Claude-backed GitHub Action review path, which
  calls `runReview` directly and never reads `review.engine`.
- `dist/index.js` is the compiled GitHub Action output produced by
  `bun run build`. It is committed but only regenerated periodically via a
  dedicated `chore(build): regenerate dist/index.js`-style commit, not on
  every source change - check `git log -- dist/index.js` before assuming it's
  in sync with source, or just rebuild and diff.
- `dist/index.js` MUST be a fully self-contained bundle: GitHub checks out a JS
  action's repo as-is and runs it with `node24` and **no `npm install`**, so
  every runtime dep (e.g. `@actions/core`) has to be inlined. The first prod
  smoke (2026-07-03) crashed with `ERR_MODULE_NOT_FOUND` because tsup leaves
  `dependencies` external by default. `tsup.config.ts` fixes this with
  `noExternal: [/.*/]` (inline all non-builtin deps) **plus** a `createRequire`
  banner - several inlined deps are CommonJS and call `require()` for Node
  built-ins, which esbuild's ESM output otherwise rejects with "Dynamic require
  of X is not supported". Don't remove either without re-running the bundle
  guard. `packages/action/test/dist-bundle.test.ts` enforces all of this: it
  scans for live bare imports, loads the bundle in a bare (no-node_modules)
  checkout, and byte-compares a fresh rebuild to catch staleness. Regenerate
  with `bun run build`; verify self-containment with
  `bun test packages/action/test/dist-bundle.test.ts`. Caveat: the guard only
  byte-compares `dist/index.js`, **not** `dist/index.js.map`. The map embeds
  source text via `sourcesContent`, so a whitespace/formatting-only change to
  source (e.g. a prettier pass) leaves `index.js` byte-identical while the
  committed map drifts. The map is deterministic given the source, so just run
  `bun run build` and commit the regenerated map alongside `index.js` in the
  same dist commit rather than chasing the diff.

## Intended technology stack

- TypeScript
- Bun for install/build/test commands
- ESLint and Prettier for the initial lint/format baseline
- `tsup` targeting Node 24 for compiled GitHub Action output
- Compiled GitHub Action output in `dist/index.js`
- Local MCP tool server for GitHub, git, shell, filesystem, and output tools, implemented with the official MCP TypeScript SDK behind reviewbot-owned tool contracts
- Claude Code as the first-class initial agent driver
- A separately spawned, exact-version shuvcode runtime for local coordinator review sessions; consume only its packed public CLI and `shuvcode/client` contracts.

## Operating principles

- Do not let model prompts or GitHub event payloads grant permissions; deterministic runtime policy must decide.
- Treat PR bodies, comments, branch names, commit messages, check logs, and fork content as untrusted context.
- Keep `CLAUDE_CODE_OAUTH_TOKEN` and all provider credentials out of prompts, logs, shell subprocesses, and workflow summaries unless explicitly required by an agent driver.
- Prefer GitHub-native state and artifacts for v1; avoid a mandatory backend.
- Keep repo learnings disabled by default; require explicit `[memory].learnings = true` before reading or writing them.
- Telemetry/observability is a day-zero requirement: every run should produce structured run records, redacted logs, timings, tool-call summaries, and failure diagnostics. External telemetry export should remain explicit/opt-in for GitHub Action users.
- `review.engine` defaults to `"coordinator"` (approved 2026-08-04, after the release, the packed-runtime smoke, and a real subscription dogfood). `legacy` remains selectable but has no safe production driver and fails closed, so treat it as a historical path rather than a fallback.
- The coordinator is the working local review path, but it is not finished: the GitHub Action still does not route to it, GitHub-native coordinator writes do not exist, and the documented dogfood matrix has not been recorded. Don't describe it as production-hardened.

## Repository automation

- `.github/workflows/reviewbot.yml` dogfoods the published `shuv1337/shuvbot@v0` action on pull requests targeting `master`. It is advisory only: leave `fail_check`/`request_changes` unset unless the repository deliberately chooses to make reviewbot blocking.
- The workflow uses `pull_request` plus a same-repository, non-draft job guard so this public repository skips fork PRs that cannot receive `CLAUDE_CODE_OAUTH_TOKEN` and waits to review draft PRs until `ready_for_review` fires.
- Keep its top-level `permissions: {}` deny-by-default posture, job-level least-privilege permissions, mandatory Claude Code install/verify steps, SHA-pinned third-party actions, and artifact upload for `$RUNNER_TEMP/reviewbot`.

## Expected validation commands

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun run evals
```

## Notes for future agents

- When implementing from a plan, keep edits aligned with `SPEC.md` and update both the plan checkboxes and this file if repository reality changes.
- Commit atomically per logical slice - don't combine unrelated concerns into mega-commits (this repo's own convention, see git log).
- Testing `main()` directly: `packages/action/src/main.ts`'s `main()` takes an
  optional `overrides: { driver?, fetchImpl? }` param purely for tests -
  inject a scripted `AgentDriver` instead of spawning a real `claude` CLI
  subprocess, and a hand-rolled `fetchImpl` instead of hitting the real
  GitHub API. `entry.ts` still calls `main()` with no args in production. See
  `packages/action/test/main.integration.test.ts`.
- **`@actions/core`'s `core.summary` gotcha**: it's a process-wide singleton
  that memoizes `GITHUB_STEP_SUMMARY`'s file path on first use per process and
  ignores later env var changes (`node_modules/@actions/core/lib/summary.js`).
  Any test that points `GITHUB_STEP_SUMMARY` at a fresh per-test temp dir and
  deletes that dir afterward will poison every _later_ summary-writing test in
  the same `bun test` process with an ENOENT. Use one fixed, never-deleted
  path for the whole test process instead - see
  `packages/action/src/workflow-summary.test.ts` and
  `packages/action/test/main.integration.test.ts` for the pattern.
  `core.setOutput`/`GITHUB_OUTPUT` does not have this problem - it reads the
  env var fresh on every call.
- **Config model slugs must be resolved before hitting the Claude CLI.** The
  config default `model` is `claude/sonnet` (a reviewbot slug), but the
  `claude` CLI only accepts its own aliases (`sonnet`, `opus`, `haiku`) or full
  ids (`claude-sonnet-4-5`). Passing the raw `claude/…` slug makes the CLI exit
  `1` with **empty stderr** and its real message on **stdout** ("issue with the
  selected model … may not exist"), even with valid auth. `claude-code.ts`'s
  `buildClaudeArgs` runs `input.model` through `resolveModelId()`
  (`agents/src/model-registry.ts`) before `--model`; keep the registry's
  target ids CLI-valid. This was the root cause of production smoke #2's
  "Claude exited with 1" (run 28684751856) - not a bad token (a freshly minted
  token failed identically). Verified against `claude 2.1.201`; all other
  driver flags (`--print`, `--input-format/--output-format text`,
  `--no-session-persistence`, `--mcp-config`, `--strict-mcp-config`,
  `--tools ""`) still exist and behave.
- **The Claude driver surfaces failure output; keep it that way.** On non-zero
  exit `claude-code.ts` puts a bounded, secret-scrubbed tail of stdout+stderr
  into `AgentRunResult.error` (the CLI writes auth/model errors to stdout with
  empty stderr, so a bare exit code is undiagnosable). `main.ts`'s review
  branch redacts that again, logs a bounded tail via `core.error`, and writes
  `$RUNNER_TEMP/reviewbot/reviewbot-agent-error.txt` via
  `writeFailureDiagnostics` so failures leave an artifact even though the
  pipeline throws before normal artifacts are written. Redaction is
  defense-in-depth: the streaming `DefaultRedactor` is pattern-based (can miss
  a token split across stream chunks), so the driver also does an exact-value
  scrub against the resolved auth values - never remove that.
- **Local review is VCS-aware, and Jujutsu is authoritative in a colocated
  repo.** `packages/cli/src/vcs.ts` detects a `.jj` workspace. This matters
  because Git's `HEAD` in a colocated repo is the **parent** of the working-copy
  commit, so reading through Git silently omits the change being worked on -
  which is exactly the "reviews only see committed work" complaint. Under
  Jujutsu the default range is `fork_point(trunk() | @)`..`@` (or `@-`..`@`
  without a trunk), the working copy is recorded with `jj util snapshot` first,
  and revisions are resolved with `jj log -T commit_id`. Jujutsu writes a real
  Git commit for every revision **including `@`**, so once resolved, the entire
  existing Git diff pipeline is reused unchanged - don't reimplement diffing
  against `jj diff`. `--base`/`--head` accept revsets, so revision validation
  permits spaces and parentheses under Jujutsu; nothing is ever passed through a
  shell.
- **Real coordinator reviews work, and four prompt-path faults were only ever
  visible in a real run.** All four are fixed and covered by tests; keep them
  in mind before changing the session or prompt path:
  1. **`subscription/…` is a reviewbot-owned abstract namespace, not a runtime
     provider.** Names resolve through the curated catalog in
     `packages/review/src/runtime/model-catalog.ts` before a session selects a
     model; that file is also where models, role defaults, and each model's
     accepted reasoning efforts are maintained. `session.switchModel` accepts
     _any_ model **and any variant** without validation, so an unresolved name
     only fails later as `provider.no-route`, and an unsupported effort only
     fails as `Variant unavailable`. Both are curated so they fail before the
     review starts. Same bug class as the Claude CLI model-slug note above.
  2. **Strip `$schema` from generated JSON Schemas.** `z.toJSONSchema` emits a
     dialect declaration and the runtime rejects it with
     `structured_output.schema`, failing every structured prompt in ~1s before
     any model is reached. `toRuntimeJsonSchema` in `engine.ts` removes it.
  3. **Do not select a runtime agent.** Sessions used to set `agent: "review"`;
     nothing creates that agent, so the runtime failed with `Agent not found`.
     Reviewbot's instructions come from its own prompts and tool authorization
     comes from the server-enforced session policy.
  4. **Classify failures from the source event.** `sanitizeEvent` reduces an
     error to a category and status, so classifying the sanitized event cannot
     tell an unroutable model from an invalid structured response.
- **Two packed shuvcode runtime constraints the fake runtime cannot show you.**
  Both were found only by running `bun run smoke:runtime` against the real
  published release, and both are now covered by tests
  (`packages/review/test/runtime-package-resolution.test.ts` and the
  fork-precondition case in `packages/review/test/engine.test.ts`):
  1. The release's manifest exports `shuvcode/client` under the **`import`
     condition only**, so CJS `require.resolve("shuvcode/client")` always fails
     with `ERR_PACKAGE_PATH_NOT_EXPORTED`. `resolveInstalledPackage` therefore
     walks `node_modules` and reads the packed manifest's own `bin`/`exports`
     fields instead of using any condition-dependent resolver. Don't "simplify"
     it back to `createRequire().resolve`.
  2. `Session.fork` resolves its boundary from the parent's rows in
     `SessionMessageTable`, so **forking a session that has never been prompted
     fails** with `InvalidRequestError … kind: "empty_session"`. `session.synthetic`
     does not satisfy it (different record type) and `session.message` is a
     getter, not an append. The coordinator session is prompted only _after_
     specialists finish, so specialists must be created with
     `createSession({ policy })`, not forked. `createSession` rejects any policy
     that widens `REVIEW_SESSION_POLICY` before the server enforces it.
- The eval harness's 10 "hardening" cases (`packages/evals/cases/*`) run a
  real diff through the actual review pipeline with a scripted agent that
  only answers for the case's expected skill id - this proves skill
  path/trigger routing, not live-agent detection accuracy (that needs a real
  network call, which the offline eval suite deliberately doesn't make). Add
  a `diff`/`files` payload to any new case, not just `{id, expected,
description}`, or the case is checking nothing.
