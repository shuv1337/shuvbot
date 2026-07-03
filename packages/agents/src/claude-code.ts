import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AuthError, AgentActivityTimeoutError, AgentTimeoutError } from "../../core/src/errors.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { Redactor } from "../../core/src/redaction.ts";
import type { AgentContext, AgentDriver, AgentRunInput, AgentRunResult } from "./driver.ts";
import { maskSecret, resolveClaudeAuth } from "./auth.ts";
import { resolveModelId } from "./model-registry.ts";

/** Max characters of each stream (stdout/stderr) kept in a failure diagnostic. */
const MAX_DIAGNOSTIC_CHARS = 2000;

export interface ClaudeCodeDriverOptions {
  command?: string;
  spawnImpl?: SpawnImpl;
  redactor?: Redactor;
  masker?: { setSecret(value: string): void };
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;

export function createClaudeCodeDriver(options: ClaudeCodeDriverOptions = {}): AgentDriver {
  const command = options.command ?? "claude";
  const spawnImpl =
    options.spawnImpl ?? ((cmd, args, spawnOptions) => spawn(cmd, [...args], spawnOptions));
  const redactor = options.redactor ?? new DefaultRedactor();

  return {
    id: "claude-code",
    displayName: "Claude Code",
    supports: {
      mcp: true,
      structuredOutput: false,
      repoEditing: true,
      oauthToken: true,
      apiKey: true
    },
    async prepare(ctx: AgentContext): Promise<void> {
      await runProcess({
        command,
        args: ["--version"],
        cwd: ctx.cwd,
        env: process.env,
        timeoutMs: 10_000,
        activityTimeoutMs: 10_000,
        spawnImpl,
        redactor
      }).catch((error: unknown) => {
        throw new AuthError(
          `Claude CLI not available: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    },
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const auth = resolveClaudeAuth(input.env);
      const secrets = Object.values(auth.env);
      for (const value of secrets) maskSecret(value, "Claude auth", options.masker);

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...auth.env
      };
      const args = buildClaudeArgs(input);
      const result = await runProcess({
        command,
        args,
        stdin: input.prompt,
        cwd: input.cwd,
        env,
        timeoutMs: input.timeoutMs,
        activityTimeoutMs: input.activityTimeoutMs,
        spawnImpl,
        redactor
      });
      const runResult: AgentRunResult = {
        success: result.exitCode === 0,
        output: result.stdout
      };
      // On failure the CLI frequently prints its real error (auth, model access,
      // bad flags) to STDOUT with an EMPTY stderr, so a bare exit code is
      // useless for triage. Surface a bounded, secret-scrubbed tail of both
      // streams. stdout/stderr are already pattern-redacted as they stream in;
      // scrubSecrets adds an exact-value pass in case a token was split across
      // stream chunks and slipped past the pattern redactor.
      if (result.exitCode === 0) {
        if (result.stderr) runResult.error = result.stderr;
      } else {
        runResult.error = formatFailureDiagnostics(result, secrets);
      }
      return runResult;
    }
  };
}

export const claudeCodeDriver = createClaudeCodeDriver();

function buildClaudeArgs(input: AgentRunInput): string[] {
  const args = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "text",
    "--no-session-persistence"
  ];
  // The config uses reviewbot slugs like "claude/sonnet"; the Claude CLI only
  // accepts its own aliases ("sonnet") or full model ids ("claude-sonnet-4-5").
  // Passing the raw slug makes the CLI exit 1 ("model may not exist") even with
  // valid auth, so resolve through the registry before handing it off.
  if (input.model) args.push("--model", resolveModelId(input.model).model);
  if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
  if (input.mcpServerUrl) {
    args.push(
      "--mcp-config",
      JSON.stringify(toMcpConfig(input.mcpServerUrl)),
      "--strict-mcp-config",
      "--tools",
      ""
    );
  }
  return args;
}

function formatFailureDiagnostics(result: RunProcessResult, secrets: readonly string[]): string {
  const stderrTail = boundedTail(scrubSecrets(result.stderr, secrets));
  const stdoutTail = boundedTail(scrubSecrets(result.stdout, secrets));
  return [
    `Claude exited with ${result.exitCode ?? "null"}`,
    `stderr: ${stderrTail || "<empty>"}`,
    `stdout: ${stdoutTail || "<empty>"}`
  ].join("\n");
}

function boundedTail(text: string, max = MAX_DIAGNOSTIC_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…[${trimmed.length - max} chars omitted]…\n${trimmed.slice(-max)}`;
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) => (secret ? current.split(secret).join("[REDACTED]") : current),
    text
  );
}

function toMcpConfig(url: string): Record<string, unknown> {
  return {
    mcpServers: {
      reviewbot: {
        type: "http",
        url
      }
    }
  };
}

interface RunProcessInput {
  command: string;
  args: readonly string[];
  stdin?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  activityTimeoutMs: number;
  spawnImpl: SpawnImpl;
  redactor: Redactor;
}

interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runProcess(input: RunProcessInput): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = input.spawnImpl(input.command, input.args, { cwd: input.cwd, env: input.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const totalTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new AgentTimeoutError(`Claude timed out after ${input.timeoutMs}ms`)));
    }, input.timeoutMs);
    let activityTimer: ReturnType<typeof setTimeout>;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(activityTimer);
      callback();
    };

    const resetActivity = (): void => {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new AgentActivityTimeoutError(
              `Claude produced no output for ${input.activityTimeoutMs}ms`
            )
          )
        );
      }, input.activityTimeoutMs);
    };

    activityTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new AgentActivityTimeoutError(
            `Claude produced no output for ${input.activityTimeoutMs}ms`
          )
        )
      );
    }, input.activityTimeoutMs);

    child.stdin.on("error", (error) => {
      finish(() => reject(error));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      resetActivity();
      stdout += input.redactor.redactString(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      resetActivity();
      stderr += input.redactor.redactString(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (exitCode) => {
      finish(() => resolve({ stdout, stderr, exitCode }));
    });

    if (input.stdin !== undefined) child.stdin.end(input.stdin);
  });
}
