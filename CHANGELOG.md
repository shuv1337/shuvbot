# Changelog

All notable changes to reviewbot are documented here. This project follows
[Semantic Versioning](https://semver.org/). The moving `v0` tag always points at
the newest `0.x` release; `v0.1.0` is an immutable point release.

## [0.1.0] - 2026-07-03

First tagged release of reviewbot (`shuv1337/shuvbot`). Pull-request review mode
is production-capable and smoke-verified end-to-end against a planted
vulnerability (real inline security findings posted; ltc-docs prod smoke #3,
2026-07-03).

### Added

- **PR review action.** A GitHub-native action that reviews pull requests with a
  real Claude Code driver against the local MCP tool server and posts real
  inline findings. Trusted `@reviewbot` mentions are classified deterministically;
  all runtime authority stays in policy code rather than prompts or GitHub
  payloads (#14).
- Self-contained, committed `dist/index.js` bundle plus a regression guard that
  scans for live bare imports, loads the bundle in a bare (no `node_modules`)
  checkout, and byte-compares a fresh rebuild to catch staleness (#15).

### Fixed

- Resolve reviewbot Claude model slugs (e.g. `claude/sonnet`) to CLI-valid model
  ids before invoking the `claude` CLI, and surface a bounded, secret-scrubbed
  tail of agent failure output instead of a bare exit code. Root cause of prod
  smoke #2's undiagnosable "Claude exited with 1" (#16).

### Notes

- `implement` and `fix-ci` modes exist end-to-end (policy, branch prep,
  commit/PR tooling) but are not yet wired to a real agent — they currently
  no-op and say so in their run summary. See `docs/workflows.md`.
- Consumers should pin `uses: shuv1337/shuvbot@v0` for the moving major line, or
  an exact commit SHA for reproducible, paranoid pinning.

[0.1.0]: https://github.com/shuv1337/shuvbot/releases/tag/v0.1.0
