# Claude Token

Status: incomplete stub for Milestone 0.

Claude Code is the first-class initial agent driver. `CLAUDE_CODE_OAUTH_TOKEN`
must be isolated behind the agent driver and kept out of prompts, logs, shell
subprocesses, and workflow summaries unless explicitly required by that driver.
