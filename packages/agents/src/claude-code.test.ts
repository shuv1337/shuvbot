import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { AgentActivityTimeoutError } from "../../core/src/errors.ts";
import { createClaudeCodeDriver, type SpawnImpl } from "./claude-code.ts";

describe("Claude Code driver", () => {
  test("passes MCP config, masks auth, and redacts streamed output", async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const stdinWrites: string[] = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      const child = fakeProcess("CLAUDE_CODE_OAUTH_TOKEN=secret-token-value done", "", 0);
      child.stdin.on("data", (chunk) => stdinWrites.push(chunk.toString("utf8")));
      return child;
    };
    const masked: string[] = [];
    const driver = createClaudeCodeDriver({
      spawnImpl,
      masker: {
        setSecret(value) {
          masked.push(value);
        }
      }
    });

    const result = await driver.run({
      prompt: "review",
      systemPrompt: "system",
      mcpServerUrl: "http://127.0.0.1:1234/mcp",
      cwd: process.cwd(),
      model: "claude/sonnet",
      timeoutMs: 1_000,
      activityTimeoutMs: 1_000,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value" }
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]");
    expect(result.output).not.toContain("secret-token-value");
    expect(masked).toEqual(["secret-token-value"]);
    expect(calls[0]?.args).toContain("--mcp-config");
    expect(calls[0]?.args).toContain("--strict-mcp-config");
    const toolsIndex = calls[0]?.args.indexOf("--tools") ?? -1;
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.args[toolsIndex + 1]).toBe("");
    expect(calls[0]?.args).not.toContain("--disallowedTools");
    expect(calls[0]?.args).not.toContain("review");
    expect(stdinWrites.join("")).toBe("review");
    expect(calls[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("secret-token-value");
    expect(calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("enforces activity timeout", async () => {
    const driver = createClaudeCodeDriver({
      spawnImpl() {
        return fakeHangingProcess();
      },
      masker: { setSecret() {} }
    });

    await expect(
      driver.run({
        prompt: "review",
        cwd: process.cwd(),
        timeoutMs: 1_000,
        activityTimeoutMs: 5,
        env: { ANTHROPIC_API_KEY: "api-key-value" }
      })
    ).rejects.toBeInstanceOf(AgentActivityTimeoutError);
  });
});

function fakeProcess(stdout: string, stderr: string, exitCode: number): ReturnType<SpawnImpl> {
  const child = new EventEmitter() as ReturnType<SpawnImpl>;
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  child.stdin = new PassThrough() as ReturnType<SpawnImpl>["stdin"];
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.kill = (() => true) as ReturnType<SpawnImpl>["kill"];
  queueMicrotask(() => {
    stdoutStream.write(stdout);
    stderrStream.write(stderr);
    stdoutStream.end();
    stderrStream.end();
    child.emit("close", exitCode);
  });
  return child;
}

function fakeHangingProcess(): ReturnType<SpawnImpl> {
  const child = new EventEmitter() as ReturnType<SpawnImpl>;
  child.stdin = new PassThrough() as ReturnType<SpawnImpl>["stdin"];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (() => true) as ReturnType<SpawnImpl>["kill"];
  return child;
}
