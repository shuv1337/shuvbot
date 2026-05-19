import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { runDoctor } from "./doctor.ts";

describe("doctor", () => {
  test("prints expected checks without leaking auth values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-doctor-"));
    let output = "";
    const checks = await runDoctor({
      cwd,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value" },
      stdout: {
        write(value: string) {
          output += value;
          return true;
        }
      },
      spawnSyncImpl(command) {
        return { status: 0, stdout: `${command} ok`, stderr: "" };
      }
    });

    expect(checks.map((check) => check.name)).toEqual([
      "config",
      "gh auth",
      "claude",
      "claude auth",
      "git",
      "bun",
      "node",
      "mcp",
      "redaction"
    ]);
    expect(output).toContain("[pass] claude auth: Using oauth");
    expect(output).not.toContain("secret-token-value");
  });
});
