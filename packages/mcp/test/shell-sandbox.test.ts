import { describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../core/src/errors.ts";
import { assertDockerSandboxAvailable, filterShellEnv } from "../src/tools/shell-sandbox.ts";

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
});
