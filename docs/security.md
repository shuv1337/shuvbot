# Security

Runtime policy is the only authority for permissions. Prompts, PR bodies, comments, branch names, commit messages, check logs, and fork content are untrusted context.

Hard rules:

- Fork PRs never receive shell, push, or secrets.
- Review mode disables push even for trusted actors.
- AI approval is disabled; `APPROVE` is rejected.
- Claude and provider credentials are masked and are not included in prompts, MCP tool inputs, workflow summaries, or shell subprocesses.
- The MCP server binds to `127.0.0.1` on an ephemeral port.
- Shell execution uses a Docker sandbox, `--network=none`, allowlisted environment variables, command allow/deny lists, and fails closed when Docker is unavailable.
- Repo learnings are off by default and require `[memory].learnings = true`.

Avoid `pull_request_target` unless you fully understand the trust boundary. Prefer `pull_request` plus least-privilege job permissions.
