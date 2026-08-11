import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { useTemporaryDirectories } from "../../test-support/temp-directories.ts";
import { ConfigError } from "../../core/src/errors.ts";
import { parseReviewOptions, runDoctorCommand, runReviewCommand } from "./index.ts";
import { runLocalReview, type LocalReviewOptions } from "./local-review.ts";

const mkdtemp = useTemporaryDirectories();

describe("review command routing", () => {
  test("auto-loads shuvbot.toml from cwd", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "shuvbot.toml"), '[review]\nengine = "coordinator"\n');

    const received = await captureReview(cwd, []);

    expect(received.config?.review.engine).toBe("coordinator");
  });

  test("uses normalized defaults when shuvbot.toml is absent", async () => {
    const cwd = await temporaryDirectory();
    let loads = 0;

    const received = await captureReview(cwd, [], {
      loadConfig: async () => {
        loads += 1;
        throw new Error("unexpected load");
      }
    });

    expect(received.config?.review.engine).toBe("coordinator");
    expect(loads).toBe(0);
  });

  test("explicit config wins over the cwd default and is resolved from cwd", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "shuvbot.toml"), '[review]\nengine = "legacy"\n');
    await writeFile(join(cwd, "chosen.toml"), '[review]\nengine = "coordinator"\n');
    let loadedPath = "";

    const received = await captureReview(cwd, ["--config", "chosen.toml"], {
      loadConfig: async (path) => {
        loadedPath = path;
        const { loadConfigFile } = await import("../../core/src/config.ts");
        return loadConfigFile(path);
      }
    });

    expect(loadedPath).toBe(join(cwd, "chosen.toml"));
    expect(received.config?.review.engine).toBe("coordinator");
  });

  test("explicit engine wins over loaded config", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "shuvbot.toml"), '[review]\nengine = "coordinator"\n');

    const received = await captureReview(cwd, ["--engine", "legacy"]);

    expect(received.config?.review.engine).toBe("coordinator");
    expect(received.engine).toBe("legacy");
  });

  test.each([
    [["--wat"], "Unknown review option"],
    [["base"], "Unknown review option"],
    [["--base"], "--base requires a value"],
    [["--config", ""], "--config requires a value"],
    [["--head", "--json"], "--head requires a value"],
    [["--engine", "invalid"], "--engine must be legacy or coordinator"],
    [["--config", "one.toml", "--config", "two.toml"], "--config may only be specified once"],
    [["--engine", "legacy", "--engine", "coordinator"], "--engine may only be specified once"],
    [["--json", "--json"], "--json may only be specified once"]
  ])("rejects malformed or ambiguous review arguments: %j", (values, message) => {
    expect(() => parseReviewOptions(values)).toThrow(message);
  });

  test("config diagnostics include the resolved path without leaking config secrets", async () => {
    const cwd = await temporaryDirectory();
    const secret = "token-do-not-print";
    const path = join(cwd, "private.toml");
    await writeFile(path, `unknown = "${secret}"\n[review]\nengine = "coordinator"\n`);

    let error: unknown;
    try {
      await captureReview(cwd, ["--config", "private.toml"]);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).not.toContain(secret);
  });

  test("reports an actionable error for a missing explicit config", async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, "missing.toml");

    await expect(captureReview(cwd, ["--config", "missing.toml"])).rejects.toThrow(
      `Unable to load review config at ${JSON.stringify(path)}. The file does not exist.`
    );
  });
});

describe("doctor command routing", () => {
  test("returns a nonzero status when any check fails", async () => {
    const status = await runDoctorCommand({
      stdout: { write: () => true },
      doctor: async () => [
        { name: "warning", status: "warn", message: "unsupported" },
        { name: "failure", status: "fail", message: "broken" }
      ]
    });

    expect(status).toBe(1);
  });

  test("returns zero for warnings and skips without failures", async () => {
    const status = await runDoctorCommand({
      stdout: { write: () => true },
      doctor: async () => [
        { name: "warning", status: "warn", message: "unsupported" },
        { name: "healthy", status: "pass", message: "available" }
      ]
    });

    expect(status).toBe(0);
  });
});

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shuvbot-cli-index-"));
}

async function captureReview(
  cwd: string,
  values: string[],
  dependencies: Parameters<typeof runReviewCommand>[1]["dependencies"] = {}
): Promise<LocalReviewOptions> {
  let received: LocalReviewOptions | undefined;
  const review: typeof runLocalReview = async (options) => {
    received = options;
    return { findings: [] } as unknown as Awaited<ReturnType<typeof runLocalReview>>;
  };
  await runReviewCommand(values, {
    cwd,
    stdout: { write: () => true },
    dependencies: { ...dependencies, review }
  });
  if (received === undefined) throw new Error("review was not called");
  return received;
}
