import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AuthError, AgentActivityTimeoutError, AgentTimeoutError } from "../../core/src/errors.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { Redactor } from "../../core/src/redaction.ts";
import type { AgentContext, AgentDriver, AgentRunInput, AgentRunResult } from "./driver.ts";
import { maskSecret, resolveClaudeAuth } from "./auth.ts";

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
  const spawnImpl = options.spawnImpl ?? ((cmd, args, spawnOptions) => spawn(cmd, [...args], spawnOptions));
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
        throw new AuthError(`Claude CLI not available: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const auth = resolveClaudeAuth(input.env);
      for (const value of Object.values(auth.env)) maskSecret(value, "Claude auth", options.masker);

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...auth.env
      };
      const args = buildClaudeArgs(input);
      const result = await runProcess({
        command,
        args,
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
      const error = result.stderr || (result.exitCode === 0 ? undefined : `Claude exited with ${result.exitCode}`);
      if (error !== undefined) runResult.error = error;
      return runResult;
    }
  };
}

export const claudeCodeDriver = createClaudeCodeDriver();

function buildClaudeArgs(input: AgentRunInput): string[] {
  const args = ["--print", "--output-format", "text", "--no-session-persistence"];
  if (input.model) args.push("--model", input.model);
  if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
  if (input.mcpServerUrl) {
    args.push("--mcp-config", JSON.stringify(toMcpConfig(input.mcpServerUrl)), "--strict-mcp-config");
  }
  args.push(input.prompt);
  return args;
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
        finish(() => reject(new AgentActivityTimeoutError(`Claude produced no output for ${input.activityTimeoutMs}ms`)));
      }, input.activityTimeoutMs);
    };

    const totalTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new AgentTimeoutError(`Claude timed out after ${input.timeoutMs}ms`)));
    }, input.timeoutMs);
    let activityTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new AgentActivityTimeoutError(`Claude produced no output for ${input.activityTimeoutMs}ms`)));
    }, input.activityTimeoutMs);

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
  });
}
