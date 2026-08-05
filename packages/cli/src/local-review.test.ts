import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";
import { APPROVED_SHUVCODE_RUNTIME_VERSION, normalizeConfig } from "../../core/src/config.ts";

/** Mirrors the code-approved runtime pin so these fixtures track it as it moves. */
const approvedRuntimeVersion = APPROVED_SHUVCODE_RUNTIME_VERSION ?? "unapproved";
import { createFakeReviewAgent } from "../../core/src/review-runner.ts";
import { evaluateQuorum } from "../../review/src/quorum.ts";
import type {
  CoordinatorEngineProgressEvent,
  CoordinatorEngineResult
} from "../../review/src/engine.ts";
import type { CoordinatedFinding } from "../../review/src/results.ts";
import type { ShuvcodeRuntime } from "../../review/src/runtime/shuvcode.ts";
import type { BuiltInReviewerId } from "../../review/src/types.ts";
import {
  parseReviewDurationMs,
  runLocalGit,
  runLocalReview,
  type CoordinatorLocalReviewResult,
  type LocalReviewDependencies
} from "./local-review.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local review CLI", () => {
  test("routes the default engine to the coordinator before git or runtime work", async () => {
    const secret = "token-do-not-print";
    let dependencyCalls = 0;
    let output = "";

    // The default engine is the coordinator, so the default path must reach a
    // coordinator precondition rather than the legacy driver.
    const config = normalizeConfig({ review: { shuvcode: { use_user_auth: false } } });
    expect(config.review.engine).toBe("coordinator");

    const review = runLocalReview({
      cwd: `/missing/${secret}`,
      base: secret,
      head: "HEAD",
      config,
      stdout: writer((value) => (output += value)),
      dependencies: forbiddenDependencies(() => {
        dependencyCalls += 1;
      })
    });

    await expect(review).rejects.toMatchObject({
      name: "ConfigError",
      code: "CONFIG_ERROR",
      message: expect.stringContaining("use_user_auth")
    });
    try {
      await review;
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(dependencyCalls).toBe(0);
    expect(output).toBe("");
  });

  test("rejects an explicit legacy override before git or coordinator work", async () => {
    let dependencyCalls = 0;

    await expect(
      runLocalReview({
        cwd: "/missing/repository",
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        engine: "legacy",
        dependencies: forbiddenDependencies(() => {
          dependencyCalls += 1;
        })
      })
    ).rejects.toThrow("no safe production agent driver exists");
    expect(dependencyCalls).toBe(0);
  });

  test("runs an injected legacy ReviewAgent end to end", async () => {
    const cwd = await createRepository(1);
    let output = "";
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      engine: "legacy",
      stdout: writer((value) => (output += value)),
      dependencies: { createLegacyAgent: () => createFakeReviewAgent([legacyFinding]) }
    });

    expect("engine" in result).toBe(false);
    if ("engine" in result) throw new Error("expected legacy result");
    expect(result.findings).toHaveLength(1);
    expect(output).toContain("Check behavior");
  });

  test("selects coordinator from config without resolving the legacy agent", async () => {
    const cwd = await createRepository(1);
    const config = coordinatorConfig();
    let coordinatorCalls = 0;
    const dependencies = fakeDependencies(async () => {
      coordinatorCalls += 1;
      return completedExecution(["code-quality"]);
    });
    let legacyAgentCalls = 0;
    dependencies.createLegacyAgent = () => {
      legacyAgentCalls += 1;
      throw new Error("coordinator must not resolve a legacy agent");
    };

    const coordinator = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config,
      json: true,
      dependencies
    });

    expect(coordinatorResult(coordinator).engine).toBe("coordinator");
    expect(coordinatorCalls).toBe(1);
    expect(legacyAgentCalls).toBe(0);
  });

  test.each([
    [1, "trivial"],
    [20, "lite"],
    [120, "full"]
  ] as const)("plans %i changed lines as %s", async (changedLines, tier) => {
    const cwd = await createRepository(changedLines);
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies: fakeDependencies(async (input) =>
        completedExecution(input.plan.assignment.reviewers.map(({ reviewer }) => reviewer))
      )
    });

    expect(coordinatorResult(result).plan.risk.tier).toBe(tier);
    expect(Object.isFrozen(coordinatorResult(result).plan)).toBe(true);
  });

  test("renders human progress and a stable JSON result", async () => {
    const cwd = await createRepository(1);
    let human = "";
    let json = "";
    const dependencies = fakeDependencies(async () => completedExecution(["code-quality"]));

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      stdout: writer((value) => (human += value)),
      dependencies
    });
    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      stdout: writer((value) => (json += value)),
      dependencies
    });

    expect(human).toContain("Review trivial");
    expect(human).toContain("Decision: CLEAN");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "version",
      "engine",
      "status",
      "tier",
      "baseSha",
      "headSha",
      "report",
      "artifacts"
    ]);
    expect(parsed.status).toBe("completed");
  });

  test("streams ordered live transitions, retries, heartbeat, elapsed time, and coverage", async () => {
    const cwd = await createRepository(1);
    let output = "";
    const dependencies = fakeDependencies(async (input) => {
      for (const event of [
        progressEvent("queued", 2_000),
        progressEvent("running", 3_000),
        progressEvent("heartbeat", 33_000),
        progressEvent("running", 34_000, 2),
        progressEvent("completed", 35_000, 2, ["code-quality"])
      ]) {
        await input.onProgress?.(event);
      }
      return completedExecution(["code-quality"]);
    });

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      stdout: writer((value) => (output += value)),
      dependencies
    });

    const progress = output.split("\n").filter((line) => line.startsWith("["));
    expect(progress.map((line) => line.match(/^\[([^\]]+)\]/)?.[1])).toEqual([
      "queued",
      "running",
      "heartbeat",
      "retrying",
      "completed"
    ]);
    expect(progress[2]).toContain("quiet heartbeat");
    expect(progress[2]).toContain("elapsed 31s");
    expect(progress.at(-1)).toContain("coverage 1/1 | required 1/1");
  });

  test("renders failure states without leaking progress or finding secrets", async () => {
    const cwd = await createRepository(1);
    const secret = "token-do-not-print";
    let output = "";
    const dependencies = fakeDependencies(async (input) => {
      for (const status of ["failed", "timed_out", "cancelled"] as const) {
        await input.onProgress?.({
          ...progressEvent(status, 3_000),
          error: {
            code: "REVIEW_PROVIDER_FAILURE",
            category: "provider",
            message: secret,
            retryable: true
          }
        });
      }
      return completedExecution(
        ["code-quality"],
        [{ ...coordinatorFinding, title: `TOKEN=${secret}`, evidence: secret }]
      );
    });

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      stdout: writer((value) => (output += value)),
      dependencies
    });

    expect(output).toContain("[failed]");
    expect(output).toContain("[timed-out]");
    expect(output).toContain("[cancelled]");
    expect(output).toContain("TOKEN=[REDACTED]");
    expect(output).not.toContain(secret);
  });

  test("keeps progress out of JSON and isolates throwing output writers", async () => {
    const cwd = await createRepository(1);
    let json = "";
    let progressAttached = false;
    const dependencies = fakeDependencies(async (input) => {
      progressAttached = input.onProgress !== undefined;
      return completedExecution(["code-quality"]);
    });

    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      stdout: writer((value) => (json += value)),
      dependencies
    });
    expect(progressAttached).toBe(false);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain("[queued]");

    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ incremental: false }),
        stdout: {
          write() {
            throw new Error("terminal closed");
          }
        },
        dependencies: fakeDependencies(async (input) => {
          await input.onProgress?.(progressEvent("running", 3_000));
          return completedExecution(["code-quality"]);
        })
      })
    ).rejects.toThrow("terminal closed");
    expect(coordinatorResult(result).status).toBe("completed");
  });

  test("keeps durable artifacts outside the workspace and unique across sequential runs", async () => {
    const cwd = await createRepository(1);
    const artifactDirectories: string[] = [];
    const dependencies = fakeDependencies(async (input) => {
      const directory = input.artifactDirectory;
      if (directory === undefined) throw new Error("artifact directory missing");
      artifactDirectories.push(directory);
      await mkdir(directory, { recursive: true });
      await Promise.all(
        ["shuvbot-events.jsonl", "shuvbot-review-sessions.json", "shuvbot-review-result.json"].map(
          (name) => writeFile(join(directory, name), '{"secret":"[REDACTED]"}\n')
        )
      );
      return {
        ...completedExecution(["code-quality"]),
        artifacts: { directory, status: "written" as const }
      };
    });
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;

    await runLocalReview(options);
    await runLocalReview(options);

    expect(new Set(artifactDirectories).size).toBe(2);
    for (const directory of artifactDirectories) {
      expect(directory.startsWith(join(cwd, ".shuvbot", "runs") + "/")).toBe(true);
      expect(directory).not.toContain("shuvbot-review-");
      await access(join(directory, "shuvbot-review-result.json"));
      expect(await readFile(join(directory, "shuvbot-events.jsonl"), "utf8")).not.toContain(
        "token-do-not-print"
      );
    }
    expect(await readdir(join(cwd, ".shuvbot", "runs"))).toHaveLength(2);
    expect(await readdir(join(cwd, ".shuvbot", "state", "reviews"))).toHaveLength(1);
  });

  test("reports degraded coverage honestly", async () => {
    const cwd = await createRepository(1);
    let output = "";
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      stdout: writer((value) => (output += value)),
      dependencies: fakeDependencies(async () => degradedExecution(["code-quality"]))
    });

    expect(coordinatorResult(result).status).toBe("degraded");
    expect(output).toContain("DEGRADED - REVIEW INCOMPLETE");
    expect(output).not.toContain("Decision: CLEAN");
  });

  test("persists and reconciles a second incremental run", async () => {
    const cwd = await createRepository(1);
    const dependencies = fakeDependencies(async () =>
      completedExecution(["code-quality"], [coordinatorFinding])
    );
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;

    const first = coordinatorResult(await runLocalReview(options));
    const second = coordinatorResult(await runLocalReview(options));

    expect(first.reconciliation?.activeFindings[0]?.disposition).toBe("new");
    expect(second.reconciliation?.activeFindings[0]?.disposition).toBe("unresolved");
    expect(second.reconciliation?.state.headSha).toBe(second.headSha);
  });

  test("rediscovers a finding after title drift through the CLI", async () => {
    const cwd = await createRepository(1);
    let run = 0;
    const dependencies = fakeDependencies(async () =>
      completedExecution(
        ["code-quality"],
        [{ ...coordinatorFinding, title: run++ === 0 ? "Original title" : "Clearer title" }]
      )
    );
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;

    await runLocalReview(options);
    let output = "";
    const second = coordinatorResult(
      await runLocalReview({ ...options, stdout: writer((value) => (output += value)) })
    );

    expect(second.reconciliation?.activeFindings).toHaveLength(1);
    expect(second.reconciliation?.activeFindings[0]).toMatchObject({
      title: "Clearer title",
      disposition: "unresolved"
    });
    expect(JSON.parse(output).report.counts).toMatchObject({ new: 0, unresolved: 1 });
  });

  test("reports fixed and user-resolved transitions without making them actionable", async () => {
    const cwd = await createRepository(1);
    const acknowledged = {
      ...coordinatorFinding,
      id: "acknowledged",
      title: "Acknowledged behavior",
      fingerprint: "acknowledged-fingerprint"
    };
    let run = 0;
    const dependencies = fakeDependencies(async () =>
      completedExecution(
        ["code-quality"],
        run++ === 0 ? [coordinatorFinding, acknowledged] : [acknowledged]
      )
    );
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;
    await runLocalReview(options);
    const statePath = await onlyStatePath(cwd);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.findings.find(
      (finding: { fingerprint: string }) => finding.fingerprint === acknowledged.fingerprint
    ).status = "user_resolved";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    let json = "";
    await runLocalReview({ ...options, stdout: writer((value) => (json += value)) });
    const report = JSON.parse(json).report;

    expect(report.counts).toMatchObject({ active: 0, fixed: 1, userResolved: 1 });
    expect(report.findings).toEqual([]);
    expect(report.lifecycle.fixed).toEqual([coordinatorFinding.fingerprint]);
    expect(report.lifecycle.userResolved).toEqual([acknowledged.fingerprint]);
  });

  test("keeps same-title distinct findings separate", async () => {
    const cwd = await createRepository(1);
    const other = {
      ...coordinatorFinding,
      id: "two",
      body: "A different defect has the same summary.",
      evidence: "A separate changed line demonstrates it.",
      line: 2
    };
    const result = coordinatorResult(
      await runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        json: true,
        dependencies: fakeDependencies(async () =>
          completedExecution(["code-quality"], [coordinatorFinding, other])
        )
      })
    );

    expect(result.reconciliation?.activeFindings).toHaveLength(2);
    expect(
      new Set(result.reconciliation?.activeFindings.map(({ fingerprint }) => fingerprint)).size
    ).toBe(2);
  });

  test("shares identity across base aliases, moved checkouts, and linked worktrees", async () => {
    const cwd = await createRepository(1);
    const dependencies = fakeDependencies(async () =>
      completedExecution(["code-quality"], [coordinatorFinding])
    );
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;
    await runLocalReview(options);

    const moved = `${cwd}-moved`;
    temporaryRepositories.splice(temporaryRepositories.indexOf(cwd), 1);
    temporaryRepositories.push(moved);
    await rename(cwd, moved);
    const afterMove = coordinatorResult(
      await runLocalReview({ ...options, cwd: moved, base: "refs/heads/main" })
    );
    expect(afterMove.reconciliation?.activeFindings[0]?.disposition).toBe("unresolved");

    const linked = `${cwd}-linked`;
    temporaryRepositories.push(linked);
    await git(moved, ["worktree", "add", "--detach", linked, "HEAD"]);
    const fromLinked = coordinatorResult(await runLocalReview({ ...options, cwd: linked }));
    expect(fromLinked.reconciliation?.activeFindings[0]?.disposition).toBe("unresolved");
    expect(await readdir(join(moved, ".shuvbot", "state", "reviews"))).toHaveLength(1);
    await expect(access(join(linked, ".shuvbot", "state"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("sanitizes credential-bearing remotes and keeps state paths opaque and bounded", async () => {
    const cwd = await createRepository(1);
    const secret = "remote-password-do-not-print";
    const remote = `https://private-user:${secret}@git.example.test/team/private.git?token=${secret}#fragment`;
    await git(cwd, ["remote", "add", "origin", remote]);
    let output = "";
    let artifactDirectory = "";

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      stdout: writer((value) => (output += value)),
      dependencies: fakeDependencies(async (input) => {
        artifactDirectory = input.artifactDirectory ?? "";
        return completedExecution(["code-quality"], [coordinatorFinding]);
      })
    });

    const stateDirectory = join(cwd, ".shuvbot", "state", "reviews");
    const names = await readdir(stateDirectory);
    expect(names).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    const persisted = await readFile(join(stateDirectory, names[0]!), "utf8");
    expect(`${output}${persisted}${artifactDirectory}`).not.toContain(secret);
    expect(`${output}${persisted}${artifactDirectory}`).not.toContain("private-user");
    expect(artifactDirectory.startsWith(join(cwd, ".shuvbot", "runs") + "/")).toBe(true);
    expect(artifactDirectory).not.toContain("git.example.test");
  });

  test("separates unrelated local repositories and protects fallback identity files", async () => {
    const first = await createRepository(1);
    const second = await createRepository(1);
    const dependencies = fakeDependencies(async () =>
      completedExecution(["code-quality"], [coordinatorFinding])
    );
    for (const cwd of [first, second]) {
      await runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        json: true,
        dependencies
      });
    }

    const firstState = JSON.parse(await readFile(await onlyStatePath(first), "utf8"));
    const secondState = JSON.parse(await readFile(await onlyStatePath(second), "utf8"));
    expect(firstState.changeId).not.toBe(secondState.changeId);
    for (const cwd of [first, second]) {
      const identityPath = join(cwd, ".git", "shuvbot", "repository-id");
      expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
      expect((await readFile(identityPath, "utf8")).trim()).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("does not mark missing findings fixed after a degraded run", async () => {
    const cwd = await createRepository(1);
    let run = 0;
    const dependencies = fakeDependencies(async () =>
      run++ === 0
        ? completedExecution(["code-quality"], [coordinatorFinding])
        : degradedExecution(["code-quality"])
    );
    const options = {
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    } as const;
    await runLocalReview(options);
    let output = "";
    const second = coordinatorResult(
      await runLocalReview({ ...options, stdout: writer((value) => (output += value)) })
    );

    expect(second.status).toBe("degraded");
    expect(second.reconciliation?.fixedFingerprints).toEqual([]);
    expect(second.reconciliation?.state.findings[0]?.status).toBe("new");
    expect(JSON.parse(output).report.counts.fixed).toBe(0);
  });

  test("rejects invalid refs and hard timeout values before runtime startup", async () => {
    const cwd = await createRepository(1);
    let executions = 0;
    const dependencies = fakeDependencies(async () => {
      executions += 1;
      return completedExecution(["code-quality"]);
    });
    await expect(
      runLocalReview({
        cwd,
        base: "--help",
        head: "HEAD",
        config: coordinatorConfig(),
        dependencies
      })
    ).rejects.toThrow("Invalid git revision");
    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ overallTimeout: "forever" }),
        dependencies
      })
    ).rejects.toThrow("review.overall_timeout");
    expect(() => parseReviewDurationMs("1h30m")).not.toThrow();
    expect(parseReviewDurationMs("1h30m")).toBe(5_400_000);
    expect(() => parseReviewDurationMs("0s")).toThrow();
    expect(executions).toBe(0);
  });

  test("rejects disabled user auth before git, workspace, or runtime startup", async () => {
    const cwd = await createRepository(1);
    let dependencyCalls = 0;
    const dependencies: Partial<LocalReviewDependencies> = {
      git: async () => {
        dependencyCalls += 1;
        return "";
      },
      executeCoordinator: async () => {
        dependencyCalls += 1;
        return completedExecution(["code-quality"]);
      },
      startRuntime: async () => {
        dependencyCalls += 1;
        throw new Error("runtime must not start");
      },
      stateStore: () => {
        dependencyCalls += 1;
        throw new Error("state store must not start");
      }
    };

    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({
          shuvcode: { ...coordinatorConfig().review.shuvcode, useUserAuth: false }
        }),
        dependencies
      })
    ).rejects.toThrow("use_user_auth = true");
    expect(dependencyCalls).toBe(0);
  });

  test("delegates exact runtime startup and cleanup through the engine seam", async () => {
    const cwd = await createRepository(1);
    let startedPackage = "";
    let startedVersion = "";
    let closed = false;
    const runtime = {
      async close() {
        closed = true;
      }
    } as ShuvcodeRuntime;
    const dependencies = fakeDependencies(async (input) => {
      const started = await input.runtimeFactory({ signal: new AbortController().signal });
      await started.close();
      return completedExecution(input.plan.assignment.reviewers.map(({ reviewer }) => reviewer));
    });
    dependencies.startRuntime = async (options) => {
      startedPackage = options.packageName;
      startedVersion = options.version;
      return runtime;
    };

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies
    });

    expect(startedPackage).toBe("shuvcode");
    expect(startedVersion).toBe(approvedRuntimeVersion);
    expect(closed).toBe(true);
  });

  test("collects patches larger than Node's old default execFile buffer", async () => {
    const cwd = await createRepository(1);
    await writeFile(join(cwd, "a.ts"), `${"const large = 'xxxxxxxxxxxxxxxx';\n".repeat(40_000)}`);
    await git(cwd, ["commit", "-am", "large patch"]);
    let patchBytes = 0;

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      dependencies: fakeDependencies(async (input) => {
        patchBytes = Buffer.byteLength(input.plan.diff.entries[0]?.patch ?? "");
        return completedExecution(input.plan.assignment.reviewers.map(({ reviewer }) => reviewer));
      })
    });

    expect(patchBytes).toBeGreaterThan(1024 * 1024);
  });

  test("uses consistent rename/copy detection and handles all Git path and file statuses", async () => {
    const cwd = await createSpecialRepository();
    let captured: CoordinatorLocalReviewResult["plan"] | undefined;

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      dependencies: fakeDependencies(async (input) => {
        captured = input.plan;
        return completedExecution(input.plan.assignment.reviewers.map(({ reviewer }) => reviewer));
      })
    });

    const entries = captured?.diff.entries ?? [];
    expect(entries.find(({ path }) => path === "renamed.ts")).toMatchObject({
      previousPath: "old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0
    });
    expect(entries.find(({ path }) => path === "copied.ts")).toMatchObject({
      previousPath: "source.ts",
      status: "copied"
    });
    expect(entries.find(({ path }) => path === "deleted.ts")?.status).toBe("deleted");
    expect(entries.find(({ path }) => path === "binary.dat")?.binary).toBe(true);
    for (const path of ["tab\tname.ts", "line\nname.ts", "unicodé.ts", "-leading.ts"]) {
      expect(entries.find((entry) => entry.path === path)?.status).toBe("added");
    }
    expect(entries.every(({ patch }) => patch !== undefined)).toBe(true);
  });

  test("returns a no-change result without planning, state, workspace, or runtime work", async () => {
    const cwd = await createRepository(1);
    let calls = 0;
    let output = "";
    const result = await runLocalReview({
      cwd,
      base: "HEAD",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      stdout: writer((value) => (output += value)),
      dependencies: {
        approvedShuvcodeVersion: approvedRuntimeVersion,
        executeCoordinator: async () => {
          calls += 1;
          return completedExecution([]);
        },
        startRuntime: async () => {
          calls += 1;
          throw new Error("runtime must not start");
        },
        stateStore: () => {
          calls += 1;
          throw new Error("state store must not be created");
        }
      }
    });

    expect(result).toMatchObject({
      engine: "coordinator",
      status: "no_changes",
      report: { decision: "not_run", reason: "no_changes", findings: [] }
    });
    const json = JSON.parse(output) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain("quorum");
    expect(JSON.stringify(json)).not.toContain("coverage");
    expect(calls).toBe(0);
    await expect(access(join(cwd, ".shuvbot"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports an actionable deterministic error when the reviewed diff bound is exceeded", async () => {
    const cwd = await createRepository(1);
    await writeFile(join(cwd, "a.ts"), "changed output\n".repeat(1_000));
    await git(cwd, ["commit", "-am", "bounded patch"]);

    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        dependencies: {
          approvedShuvcodeVersion: approvedRuntimeVersion,
          git: (args, repository) => runLocalGit(args, repository, 256)
        }
      })
    ).rejects.toMatchObject({
      name: "ConfigError",
      code: "CONFIG_ERROR",
      message: expect.stringContaining("narrow the base...head range")
    });
  });

  test("materialises content from the reviewed revision, not the working tree", async () => {
    const cwd = await createRepository(1);
    // A dirty working tree is the local equivalent of the Action's checkout
    // being a different revision from the one under review.
    await writeFile(join(cwd, "a.ts"), "const uncommitted = true;\n");
    let materialised: string | undefined;

    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      stdout: writer(() => {}),
      dependencies: {
        approvedShuvcodeVersion: approvedRuntimeVersion,
        executeCoordinator: async ({ workspace }) => {
          const entry = workspace.manifest.files.find(({ path }) => path === "a.ts");
          materialised =
            entry?.contentPath === undefined
              ? undefined
              : await readFile(join(workspace.root, entry.contentPath), "utf8");
          return completedExecution(["code-quality"]);
        }
      }
    });

    expect(materialised).toBe("const value0 = 0;\n");
  });

  test("rejects malformed NUL-delimited Git metadata before execution", async () => {
    const cwd = await createRepository(1);
    let executions = 0;
    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        dependencies: {
          approvedShuvcodeVersion: approvedRuntimeVersion,
          git: async (args, repository) =>
            args[0] === "rev-parse" ? runLocalGit(args, repository) : "R100\0old.ts\0",
          executeCoordinator: async () => {
            executions += 1;
            return completedExecution([]);
          }
        }
      })
    ).rejects.toThrow("missing destination path");
    expect(executions).toBe(0);
  });

  test("rejects an unapproved runtime pin before any Git work", async () => {
    let calls = 0;
    await expect(
      runLocalReview({
        cwd: "/missing",
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        dependencies: {
          ...forbiddenDependencies(() => {
            calls += 1;
          }),
          approvedShuvcodeVersion: null
        }
      })
    ).rejects.toThrow("corrected published shuvcode release");
    expect(calls).toBe(0);
  });

  test("runs only when an explicit approved exact pin is injected", async () => {
    const cwd = await createRepository(1);
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig(),
      json: true,
      dependencies: fakeDependencies(async () => completedExecution(["code-quality"]))
    });
    expect(result).toMatchObject({ engine: "coordinator", status: "completed" });

    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig(),
        dependencies: { approvedShuvcodeVersion: "9.9.9" }
      })
    ).rejects.toThrow("code-approved executable runtime pin 9.9.9");
  });

  test("times out preprocessing and forwards cancellation to Git", async () => {
    let aborted = false;
    await expect(
      runLocalReview({
        cwd: "/missing",
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ overallTimeout: "10ms", incremental: false }),
        dependencies: {
          approvedShuvcodeVersion: approvedRuntimeVersion,
          git: async (args, _cwd, _limit, signal) => {
            if (args[0] === "rev-parse") return "a".repeat(40);
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true }
              );
            });
            return "";
          }
        }
      })
    ).rejects.toThrow("overall_timeout");
    expect(aborted).toBe(true);
  });

  test("bounds changed files and Git preprocessing processes", async () => {
    const run = (count: number) =>
      runLocalReview({
        cwd: "/repository",
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ incremental: false }),
        dependencies: {
          approvedShuvcodeVersion: approvedRuntimeVersion,
          git: async (args) =>
            args[0] === "rev-parse"
              ? "a".repeat(40)
              : Array.from({ length: count }, (_, index) => `M\0src/file-${index}.ts\0`).join("")
        }
      });

    await expect(run(1_001)).rejects.toThrow("Changed file count exceeds");
    await expect(run(751)).rejects.toThrow("process limit");
  });

  test("reviews the Jujutsu working-copy commit through resolved git commits", async () => {
    const cwd = await createRepository(1);
    const jjCalls: string[][] = [];
    const revisions = new Map([
      ["fork_point(trunk() | @)", "1".repeat(40)],
      ["@", "2".repeat(40)]
    ]);
    const gitRanges: string[] = [];
    const dependencies = fakeDependencies(async () => completedExecution(["code-quality"]));
    dependencies.detectVcs = async () => "jj";
    dependencies.jj = async (args) => {
      jjCalls.push([...args]);
      if (args[0] === "util") return "";
      const revision = args[args.indexOf("-r") + 1] ?? "";
      return `${revisions.get(revision) ?? "3".repeat(40)}\n`;
    };
    dependencies.git = async (args, repository, limit, signal) => {
      const range = args.find((arg) => arg.includes("..."));
      if (range !== undefined) gitRanges.push(range);
      // Report the reviewed range as one changed file so preprocessing proceeds.
      if (args.includes("--name-status")) return "M\u0000a.txt\u0000";
      if (args.includes("--numstat")) return "1\t0\ta.txt\u0000";
      if (args.includes("--binary")) return "diff --git a/a.txt b/a.txt\n+change\n";
      return runLocalGit(args, repository, limit, signal);
    };

    await runLocalReview({ cwd, config: coordinatorConfig(), dependencies });

    // The working copy is recorded before any revision is read, so the review
    // sees the files on disk rather than the last snapshot.
    expect(jjCalls[0]).toEqual(["util", "snapshot"]);
    expect(jjCalls.some((call) => call.includes("commit_id"))).toBe(true);
    // Jujutsu revsets are never handed to git; only resolved commits are.
    expect(gitRanges[0]).toBe(`${"1".repeat(40)}...${"2".repeat(40)}`);
    expect(gitRanges.every((range) => !range.includes("@"))).toBe(true);
  });

  test("reports an actionable error when jj is a workspace but not installed", async () => {
    const cwd = await createRepository(1);
    const dependencies = fakeDependencies(async () => completedExecution(["code-quality"]));
    dependencies.detectVcs = async () => "jj";
    dependencies.jj = async () => {
      throw Object.assign(new Error("spawn jj ENOENT"), { code: "ENOENT" });
    };

    await expect(
      runLocalReview({ cwd, base: "@-", head: "@", config: coordinatorConfig(), dependencies })
    ).rejects.toThrow(/Jujutsu workspace but the jj executable was not found/);
  });

  test("passes remaining budget and all configured model refs to the engine", async () => {
    const cwd = await createRepository(1);
    let captured: Parameters<LocalReviewDependencies["executeCoordinator"]>[0] | undefined;
    const dependencies = fakeDependencies(async (input) => {
      captured = input;
      return completedExecution(["code-quality"]);
    });
    const originalGit = runLocalGit;
    dependencies.git = async (args, repository, limit, signal) => {
      await Bun.sleep(2);
      return originalGit(args, repository, limit, signal);
    };
    const config = coordinatorConfig({ overallTimeout: "1s", incremental: false });
    await runLocalReview({ cwd, base: "main", head: "HEAD", config, json: true, dependencies });

    expect(captured?.models).toEqual({
      coordinator: "subscription/default-reasoning",
      standard: "subscription/default-coding",
      light: "subscription/default-fast"
    });
    expect(captured?.overallTimeoutMs).toBeLessThan(1_000);
    expect(captured?.overallTimeoutMs).toBeGreaterThan(0);
  });

  test("returns no_reviewable_changes without state, workspace, runtime, or false quorum", async () => {
    const cwd = await createRepository(1);
    let output = "";
    let executions = 0;
    const config = coordinatorConfig({ incremental: true });
    config.paths = { include: ["docs/**"], ignore: [] };
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config,
      json: true,
      stdout: writer((value) => (output += value)),
      dependencies: {
        approvedShuvcodeVersion: approvedRuntimeVersion,
        executeCoordinator: async () => {
          executions += 1;
          return completedExecution([]);
        }
      }
    });

    expect(result).toMatchObject({
      status: "no_reviewable_changes",
      report: { decision: "not_run", reason: "no_reviewable_changes", findings: [] }
    });
    expect(output).not.toContain("quorum");
    expect(output).not.toContain("clean");
    expect(executions).toBe(0);
    await expect(access(join(cwd, ".shuvbot"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("persists redacted contract run and findings artifacts with accounting", async () => {
    const cwd = await createRepository(1);
    const secret = "ghp_123456789012345678901234567890";
    let directory = "";
    await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      dependencies: fakeDependencies(async (input) => {
        directory = input.artifactDirectory!;
        return completedExecution(
          ["code-quality"],
          [{ ...coordinatorFinding, title: secret, evidence: secret }]
        );
      })
    });

    const run = JSON.parse(await readFile(join(directory, "shuvbot-run.json"), "utf8"));
    const findings = await readFile(join(directory, "shuvbot-findings.json"), "utf8");
    // One canonical findings shape, identical to the one the Action writes, so
    // a reader does not meet two schemas behind a single filename.
    expect(JSON.parse(findings)).toMatchObject({
      version: 1,
      baseSha: expect.any(String),
      headSha: expect.any(String),
      decision: expect.any(String),
      degraded: expect.any(Boolean),
      coverage: expect.objectContaining({ quorumMet: expect.any(Boolean) }),
      counts: expect.any(Object),
      findings: expect.any(Array),
      lifecycle: expect.any(Object),
      dropped: expect.any(Array)
    });
    expect(run.review).toMatchObject({
      engine: "coordinator",
      tier: "trivial",
      quorumMet: true,
      findingAccounting: { active: 1, new: 1 }
    });
    expect(run.timings).toEqual({
      preprocessingMs: expect.any(Number),
      engineMs: expect.any(Number),
      totalMs: expect.any(Number)
    });
    expect(findings).toContain("[REDACTED]");
    expect(findings).not.toContain(secret);
    expect(findings).not.toContain("evidence");
  });

  test("surfaces contract artifact persistence failure as command failure", async () => {
    const cwd = await createRepository(1);
    let output = "";
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      json: true,
      stdout: writer((value) => (output += value)),
      dependencies: fakeDependencies(async (input) => {
        await mkdir(dirname(input.artifactDirectory!), { recursive: true });
        await writeFile(input.artifactDirectory!, "not a directory");
        return completedExecution(["code-quality"]);
      })
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(JSON.parse(output)).toMatchObject({ status: "failed", artifacts: { status: "failed" } });
  });

  test("bounds delayed local artifact writes and removes atomic temp files", async () => {
    const cwd = await createRepository(1);
    let directory = "";
    const delayedWrite = (async (path: Parameters<typeof writeFile>[0], ...args: unknown[]) => {
      await (writeFile as (...values: unknown[]) => Promise<void>)(path, ...args);
      if (String(path).includes("shuvbot-run.json")) {
        await new Promise<void>(() => undefined);
      }
    }) as typeof writeFile;

    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ overallTimeout: "100ms", incremental: false }),
        json: true,
        dependencies: {
          ...fakeDependencies(async (input) => {
            directory = input.artifactDirectory!;
            return completedExecution(["code-quality"]);
          }),
          fileSystem: { mkdir, rename, rm, writeFile: delayedWrite }
        }
      })
    ).rejects.toThrow("overall_timeout");

    expect(directory).not.toBe("");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("bounds hanging incremental state writes before local artifacts or output", async () => {
    const cwd = await createRepository(1);
    let output = "";
    let writeStarted = false;
    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ overallTimeout: "100ms", incremental: true }),
        json: true,
        stdout: writer((value) => (output += value)),
        dependencies: {
          ...fakeDependencies(async () => completedExecution(["code-quality"])),
          stateStore: () => ({
            async readReviewState() {
              return null;
            },
            async writeReviewState() {
              writeStarted = true;
              await new Promise<void>(() => undefined);
            }
          })
        }
      })
    ).rejects.toThrow("overall_timeout");
    expect(writeStarted).toBe(true);
    expect(output).toBe("");
  });

  test("propagates a final output stall that crosses the absolute deadline", async () => {
    const cwd = await createRepository(1);
    await expect(
      runLocalReview({
        cwd,
        base: "main",
        head: "HEAD",
        config: coordinatorConfig({ overallTimeout: "100ms", incremental: false }),
        json: true,
        stdout: writer(() => {
          const until = Date.now() + 120;
          while (Date.now() < until) {
            // Simulate a pathological synchronous output sink.
          }
        }),
        dependencies: fakeDependencies(async () => completedExecution(["code-quality"]))
      })
    ).rejects.toThrow("overall_timeout");
  });

  test("cancellation aborts execution and cleans the temporary workspace", async () => {
    const cwd = await createRepository(1);
    const controller = new AbortController();
    let workspaceRoot = "";
    const review = runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      config: coordinatorConfig({ incremental: false }),
      signal: controller.signal,
      dependencies: fakeDependencies(async (input) => {
        workspaceRoot = input.workspace.root;
        controller.abort("test cancellation");
        throw new Error("cancelled");
      })
    });

    await expect(review).rejects.toThrow("was cancelled");
    expect(workspaceRoot).not.toBe("");
    await expect(access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function coordinatorConfig(review: Partial<ReturnType<typeof normalizeConfig>["review"]> = {}) {
  const config = normalizeConfig({ review: { engine: "coordinator" } });
  return { ...config, review: { ...config.review, ...review } };
}

function fakeDependencies(
  execute: LocalReviewDependencies["executeCoordinator"]
): Partial<LocalReviewDependencies> {
  let now = 1_000;
  return {
    executeCoordinator: execute,
    now: () => new Date((now += 1_000)),
    approvedShuvcodeVersion: approvedRuntimeVersion
  };
}

function forbiddenDependencies(onCall: () => void): Partial<LocalReviewDependencies> {
  return {
    git: async () => {
      onCall();
      return "";
    },
    executeCoordinator: async () => {
      onCall();
      return completedExecution([]);
    },
    startRuntime: async () => {
      onCall();
      throw new Error("runtime must not start");
    },
    stateStore: () => {
      onCall();
      throw new Error("state store must not be created");
    }
  };
}

function completedExecution(
  reviewers: readonly BuiltInReviewerId[],
  findings: readonly CoordinatedFinding[] = []
): CoordinatorEngineResult {
  const required: BuiltInReviewerId[] = reviewers.includes("security")
    ? ["code-quality", "security"]
    : ["code-quality"];
  const coverage = {
    scheduled: [...reviewers],
    completed: [...reviewers],
    failed: [],
    timedOut: [],
    required,
    quorumMet: true
  };
  return {
    status: "completed",
    result: {
      decision: findings.length === 0 ? "clean" : "comments",
      findings: [...findings],
      dropped: [],
      coverage,
      summary: findings.length === 0 ? "No findings." : "Findings reported."
    },
    quorum: evaluateQuorum({
      tier: reviewers.includes("security") ? "full" : reviewers.length > 1 ? "lite" : "trivial",
      coordinatorSucceeded: true,
      scheduledReviewers: reviewers,
      successfulReviewers: reviewers
    }),
    coverage,
    specialistResults: [],
    sessions: reviewers.map((reviewer) => ({
      sessionId: `specialist:${reviewer}`,
      role: "specialist" as const,
      reviewer,
      model: "subscription/default-coding",
      status: "completed" as const,
      retryCount: 0
    })),
    retries: 0,
    events: [],
    repairAttempted: false
  };
}

function degradedExecution(reviewers: readonly BuiltInReviewerId[]): CoordinatorEngineResult {
  const result = completedExecution(reviewers);
  const coverage = {
    ...result.coverage,
    completed: [],
    failed: [...reviewers],
    quorumMet: false
  };
  return {
    ...result,
    result: {
      ...result.result,
      decision: "degraded",
      coverage,
      summary: "Review incomplete."
    },
    quorum: evaluateQuorum({
      tier: "trivial",
      coordinatorSucceeded: false,
      scheduledReviewers: reviewers,
      successfulReviewers: []
    }),
    coverage,
    sessions: result.sessions.map((session) => ({ ...session, status: "failed" }))
  };
}

async function createRepository(changedLines: number): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "shuvbot-local-review-"));
  temporaryRepositories.push(cwd);
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "shuvbot@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "shuvbot"], { cwd });
  await writeFile(join(cwd, "a.ts"), "const initial = true;\n");
  await execFileAsync("git", ["add", "a.ts"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature"], { cwd });
  await writeFile(
    join(cwd, "a.ts"),
    `${Array.from({ length: changedLines }, (_, index) => `const value${index} = ${index};`).join("\n")}\n`
  );
  await execFileAsync("git", ["commit", "-am", "change"], { cwd });
  return cwd;
}

async function createSpecialRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "shuvbot-local-review-paths-"));
  temporaryRepositories.push(cwd);
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "shuvbot@example.com"]);
  await git(cwd, ["config", "user.name", "shuvbot"]);
  await Promise.all([
    writeFile(join(cwd, "old.ts"), "export const renamed = true;\n"),
    writeFile(join(cwd, "source.ts"), "export const copied = true;\n"),
    writeFile(join(cwd, "deleted.ts"), "delete me\n"),
    writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3]))
  ]);
  await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "-m", "initial"]);
  await git(cwd, ["checkout", "-b", "feature"]);
  await git(cwd, ["config", "diff.renames", "false"]);
  await rename(join(cwd, "old.ts"), join(cwd, "renamed.ts"));
  await copyFile(join(cwd, "source.ts"), join(cwd, "copied.ts"));
  await rm(join(cwd, "deleted.ts"));
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 9, 8, 7]));
  await Promise.all(
    ["tab\tname.ts", "line\nname.ts", "unicodé.ts", "-leading.ts"].map((path) =>
      writeFile(join(cwd, path), "export {};\n")
    )
  );
  await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "-m", "special paths"]);
  return cwd;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

async function onlyStatePath(cwd: string): Promise<string> {
  const directory = join(cwd, ".shuvbot", "state", "reviews");
  const names = await readdir(directory);
  if (names.length !== 1) throw new Error(`expected one state file, found ${names.length}`);
  return join(directory, names[0]!);
}

function coordinatorResult(result: Awaited<ReturnType<typeof runLocalReview>>) {
  if (!("engine" in result)) throw new Error("expected coordinator result");
  return result as CoordinatorLocalReviewResult;
}

function writer(write: (value: string) => void) {
  return {
    write(value: string) {
      write(value);
      return true;
    }
  };
}

function progressEvent(
  status: CoordinatorEngineProgressEvent["status"],
  atMs: number,
  attempt = 1,
  completed: BuiltInReviewerId[] = []
): CoordinatorEngineProgressEvent {
  return {
    status,
    sessionId: "specialist:code-quality",
    role: "specialist",
    reviewer: "code-quality",
    model: "subscription/default-coding",
    attempt,
    atMs,
    coverage: {
      scheduled: ["code-quality"],
      completed,
      failed: [],
      timedOut: [],
      cancelled: []
    }
  };
}

const legacyFinding = {
  id: "one",
  skill: "code-review",
  title: "Check behavior",
  body: "Review this change.",
  severity: "medium",
  confidence: "high",
  path: "a.ts",
  line: 1,
  tags: ["correctness"]
};

const coordinatorFinding: CoordinatedFinding = {
  id: "one",
  reviewer: "code-quality",
  skill: "code-quality",
  title: "Incorrect behavior",
  body: "The changed behavior is incorrect.",
  evidence: "The changed line returns the wrong value.",
  severity: "medium",
  confidence: "high",
  path: "a.ts",
  line: 1,
  disposition: "new",
  fingerprint: "stable-fingerprint"
};
