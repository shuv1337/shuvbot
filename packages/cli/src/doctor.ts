import { existsSync } from "node:fs";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { loadConfigFile } from "../../core/src/config.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { startReviewbotMcpServer } from "../../mcp/src/server.ts";
import { AuditLog } from "../../mcp/src/audit.ts";
import { resolveClaudeAuth } from "../../agents/src/auth.ts";
import { spawnSyncLike, type SpawnSyncLike } from "./auth/claude-import.ts";

export interface DoctorOptions {
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  spawnSyncImpl?: SpawnSyncLike;
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnSyncImpl ?? spawnSyncLike;
  const checks: DoctorCheck[] = [];

  const configPath = options.configPath ?? "reviewbot.toml";
  if (existsSync(configPath)) {
    await loadConfigFile(configPath);
    checks.push(pass("config", `Config valid: ${configPath}`));
  } else {
    checks.push(warn("config", `Config not found: ${configPath}`));
  }

  checks.push(commandCheck("gh auth", spawnImpl("gh", ["auth", "status"], { cwd, encoding: "utf8" })));
  checks.push(commandCheck("claude", spawnImpl("claude", ["--version"], { cwd, encoding: "utf8" })));
  try {
    const auth = resolveClaudeAuth(env);
    checks.push(pass("claude auth", `Using ${auth.kind}`));
  } catch (error) {
    checks.push(fail("claude auth", error instanceof Error ? error.message : String(error)));
  }
  checks.push(commandCheck("git", spawnImpl("git", ["status", "--short"], { cwd, encoding: "utf8" })));
  checks.push(commandCheck("bun", spawnImpl("bun", ["--version"], { cwd, encoding: "utf8" })));
  checks.push(commandCheck("node", spawnImpl("node", ["--version"], { cwd, encoding: "utf8" })));

  const redactor = new DefaultRedactor();
  const server = await startReviewbotMcpServer({
    tools: [],
    context: {
      runId: "doctor",
      actor: "doctor",
      mode: "review",
      policy: defaultRuntimePolicy({
        actor: "doctor",
        actorPermission: "write",
        event: "workflow_dispatch",
        isFork: false,
        isPrivateRepo: false
      }),
      redactor,
      audit: new AuditLog(redactor)
    }
  });
  await server.close();
  checks.push(pass("mcp", "MCP server starts and stops"));

  const redacted = redactor.redactString("CLAUDE_CODE_OAUTH_TOKEN=fake-secret-token-value");
  checks.push(redacted.includes("fake-secret-token-value") ? fail("redaction", "Secret redaction failed") : pass("redaction", "Secret redaction works"));

  for (const check of checks) {
    options.stdout?.write(`[${check.status}] ${check.name}: ${check.message}\n`);
  }
  return checks;
}

export const doctorCommandName = "doctor";

function commandCheck(name: string, result: ReturnType<SpawnSyncLike>): DoctorCheck {
  if (result.status === 0) return pass(name, "available");
  return fail(name, String(result.stderr || result.stdout || "not available"));
}

function pass(name: string, message: string): DoctorCheck {
  return { name, status: "pass", message };
}

function warn(name: string, message: string): DoctorCheck {
  return { name, status: "warn", message };
}

function fail(name: string, message: string): DoctorCheck {
  return { name, status: "fail", message };
}
