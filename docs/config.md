# Configuration

Config is TOML and is loaded from the `config` action input or `reviewbot.toml` in CLI flows.

Resolution order:

1. Built-in defaults in `packages/core/src/config.ts`.
2. TOML config file.
3. Action inputs for `agent`, `model`, `mode`, `timeout`, `activity_timeout`, `shell`, and `push`.
4. Runtime policy caps. Inputs can reduce permissions, never escalate them.

Common keys:

```toml
agent = "claude-code"
model = "claude/sonnet"
mode = "review"
timeout = "1h"
activity_timeout = "5m"
fail_on = "high"
fail_check = false
request_changes = false
report_on = "medium"
min_confidence = "medium"
shell = "restricted"
push = "restricted"

[paths]
include = ["**/*"]
ignore = ["dist/**"]

[shell_sandbox]
allow_commands = ["bun", "git"]
deny_commands = ["sudo", "su", "docker", "podman"]

[fix_ci]
max_attempts = 3
max_runtime = "90m"
rerun_checks = true

[memory]
enabled = false
backend = "github"
learnings = false
pr_summaries = true
```

Unknown top-level keys are rejected unless they start with `x-`.

`model` accepts reviewbot aliases such as `claude/sonnet` and `claude/opus`, or a direct provider model ID. The Claude Code driver resolves reviewbot aliases to Claude CLI-compatible model IDs before invoking `claude --print`.
