import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  createDefaultCoordinatorDiagnostics,
  runDoctor,
  type CoordinatorAuthStatus,
  type CoordinatorDiagnosticOperations,
  type CoordinatorDiagnosticRuntime
} from "./doctor.ts";

const legacyConfig = `[review]
engine = "legacy"
`;

const coordinatorConfig = `[review]
engine = "coordinator"

[review.shuvcode]
package = "shuvcode"
version = "1.18.4"
use_user_auth = true

[review.models]
coordinator = "subscription/default-reasoning"
standard = "subscription/default-coding"
light = "subscription/default-fast"
`;

describe("doctor", () => {
  test("preserves legacy checks and clearly skips coordinator diagnostics", async () => {
    const { checks, output } = await runFixture({ legacy: true });

    expect(checks.map((check) => check.name)).toEqual([
      "config",
      "gh auth",
      "claude",
      "claude auth",
      "git",
      "bun",
      "node",
      "mcp",
      "redaction",
      "coordinator package",
      "coordinator auth",
      "coordinator runtime",
      "coordinator model coordinator",
      "coordinator model standard",
      "coordinator model light"
    ]);
    expect(checks.slice(-6).every((check) => check.status === "warn")).toBe(true);
    expect(output).toContain("Skipped because review.engine is not coordinator");
    expect(output).toContain("[pass] claude auth: Using oauth");
    expect(output).not.toContain("secret-token-value");
  });

  test("passes package, auth, isolated runtime, and model diagnostics", async () => {
    const resolved: string[] = [];
    let closed = false;
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({
        runtime: {
          version: "1.18.4",
          healthy: true,
          async inspectLocalSubscriptionAuth() {
            return authStatus();
          },
          async resolveModel(model) {
            resolved.push(model);
            return "resolved";
          },
          async close() {
            closed = true;
          }
        }
      })
    });

    expect(coordinatorChecks(checks).every((check) => check.status === "pass")).toBe(true);
    expect(resolved).toEqual([
      "subscription/default-reasoning",
      "subscription/default-coding",
      "subscription/default-fast"
    ]);
    expect(closed).toBe(true);
  });

  test("distinguishes an installed package version mismatch", async () => {
    let launched = false;
    const ops = diagnostics({ installedVersion: "1.18.3" });
    const originalLaunch = ops.launch;
    ops.launch = async (input) => {
      launched = true;
      return originalLaunch(input);
    };
    const { checks } = await runFixture({ coordinator: true, diagnostics: ops });

    expect(find(checks, "coordinator package")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator package").message).toContain(
      "Expected shuvcode@1.18.4, found shuvcode@1.18.3"
    );
    expect(find(checks, "coordinator runtime")).toMatchObject({ status: "warn" });
    expect(launched).toBe(false);
  });

  test("reports unavailable local subscription auth without launching", async () => {
    let launched = false;
    const ops = diagnostics({ authSupported: false });
    ops.launch = async () => {
      launched = true;
      throw new Error("should not launch");
    };
    const { checks } = await runFixture({ coordinator: true, diagnostics: ops });

    expect(find(checks, "coordinator auth capability")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator auth capability").message).toContain(
      "public auth.status() is unavailable"
    );
    expect(find(checks, "coordinator runtime")).toMatchObject({ status: "warn" });
    expect(launched).toBe(false);
  });

  test("distinguishes isolated runtime launch failures", async () => {
    const ops = diagnostics();
    ops.launch = async () => {
      throw new Error("health endpoint unavailable");
    };
    const { checks } = await runFixture({ coordinator: true, diagnostics: ops });

    expect(find(checks, "coordinator runtime")).toEqual({
      name: "coordinator runtime",
      status: "fail",
      message: "Isolated runtime failed to launch: health endpoint unavailable"
    });
    expect(find(checks, "coordinator model standard")).toMatchObject({ status: "warn" });
  });

  test("reports each unresolved configured model", async () => {
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({ unresolvedModels: new Set(["subscription/default-coding"]) })
    });

    expect(find(checks, "coordinator model coordinator")).toMatchObject({ status: "pass" });
    expect(find(checks, "coordinator model standard")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator model standard").message).toContain(
      "Cannot resolve configured model subscription/default-coding"
    );
    expect(find(checks, "coordinator model light")).toMatchObject({ status: "pass" });
  });

  test("fails with no usable auth, still checks quota-free catalogs, and always closes", async () => {
    let closed = false;
    const resolved: string[] = [];
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({
        authStatus: authStatus({ ready: false, profiles: [] }),
        resolvedModels: resolved,
        runtimeClosed() {
          closed = true;
        }
      })
    });

    expect(find(checks, "coordinator auth")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator auth").message).toContain("No structurally usable");
    expect(find(checks, "coordinator auth").message).toContain("verification: not_performed");
    expect(find(checks, "coordinator model coordinator")).toMatchObject({ status: "pass" });
    expect(resolved).toHaveLength(3);
    expect(closed).toBe(true);
  });

  test("reports usable configured auth without claiming external verification", async () => {
    const { checks } = await runFixture({ coordinator: true, diagnostics: diagnostics() });

    const auth = find(checks, "coordinator auth");
    expect(auth).toMatchObject({ status: "pass" });
    expect(auth.message).toContain("configured and structurally usable for 1 provider");
    expect(auth.message).toContain("verification: not_performed");
    expect(auth.message).toContain("external validity is not verified");
    expect(auth.message).not.toContain("valid subscription");
  });

  test("fails when configured profiles are structurally unusable", async () => {
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({
        authStatus: authStatus({
          ready: false,
          profiles: [
            {
              ...usableProfile(),
              usable: false,
              reason: "expired"
            }
          ]
        })
      })
    });

    const auth = find(checks, "coordinator auth");
    expect(auth).toMatchObject({ status: "fail" });
    expect(auth.message).toContain("No structurally usable");
    expect(auth.message).not.toContain("profile-id");
  });

  test("reports multiple usable providers without exposing profile identifiers", async () => {
    const secretProfile = "profile-secret-fragment";
    const { checks, output } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({
        authStatus: authStatus({
          profiles: [
            usableProfile("anthropic", secretProfile),
            usableProfile("openai", "another-private-profile")
          ]
        })
      })
    });

    expect(find(checks, "coordinator auth").message).toContain("2 providers");
    expect(JSON.stringify(checks)).not.toContain(secretProfile);
    expect(output).not.toContain(secretProfile);
  });

  test("fails closed on an internally inconsistent auth response", async () => {
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({
        authStatus: authStatus({ ready: true, profiles: [] })
      })
    });

    expect(find(checks, "coordinator auth")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator auth").message).toContain(
      "invalid secret-safe readiness response"
    );
  });

  test("reports a distinct blocker when the public model catalog is unavailable", async () => {
    const { checks } = await runFixture({
      coordinator: true,
      diagnostics: diagnostics({ modelCatalogSupported: false })
    });

    expect(find(checks, "coordinator model coordinator")).toMatchObject({ status: "fail" });
    expect(find(checks, "coordinator model coordinator").message).toContain(
      "provider.list() and model.list()"
    );
  });

  test("default operations use public auth and catalog calls without creating a session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-doctor-default-"));
    const packageDirectory = join(cwd, "node_modules", "shuvcode");
    await Bun.write(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "shuvcode",
        version: "1.18.4",
        type: "module",
        exports: { "./client": "./client.js" }
      })
    );
    await Bun.write(join(packageDirectory, "client.js"), "export const placeholder = true;\n");
    const calls: string[] = [];
    let closed = false;
    const operations = createDefaultCoordinatorDiagnostics({
      password: () => "doctor-password",
      async loadClient() {
        return {
          OpenCode: {
            make() {
              return {
                auth: {
                  async status() {
                    calls.push("auth.status");
                    return { data: authStatus() };
                  }
                },
                provider: {
                  async list() {
                    calls.push("provider.list");
                    return { data: [{ id: "subscription", disabled: false }] };
                  }
                },
                model: {
                  async list() {
                    calls.push("model.list");
                    return {
                      data: [
                        {
                          id: "subscription/default-coding",
                          modelID: "default-coding",
                          providerID: "subscription",
                          enabled: true
                        }
                      ]
                    };
                  }
                }
              };
            }
          }
        };
      },
      async startRuntime() {
        calls.push("runtime.start");
        return {
          url: "http://127.0.0.1:3210",
          async createSession() {
            calls.push("session.create");
            return { id: "unexpected" };
          },
          async forkSession() {
            throw new Error("unused");
          },
          async configureSession() {},
          async prompt() {},
          async wait() {
            throw new Error("unused");
          },
          async interrupt() {},
          subscribe() {
            return () => undefined;
          },
          async close() {
            closed = true;
          }
        };
      }
    });

    expect(await operations.inspectPackage({ packageName: "shuvcode", cwd })).toEqual({
      packageName: "shuvcode",
      version: "1.18.4"
    });
    expect(await operations.inspectCapabilities({ packageName: "shuvcode", cwd })).toEqual({
      authStatus: true,
      modelCatalog: true
    });
    const runtime = await operations.launch({
      packageName: "shuvcode",
      version: "1.18.4",
      cwd,
      env: {}
    });
    expect(await runtime.inspectLocalSubscriptionAuth()).toEqual(authStatus());
    expect(await runtime.resolveModel("subscription/default-coding")).toBe("resolved");
    expect(await runtime.resolveModel("subscription/missing")).toBe("missing");
    await runtime.close();

    expect(calls).toEqual([
      "runtime.start",
      "auth.status",
      "provider.list",
      "model.list",
      "provider.list",
      "model.list"
    ]);
    expect(calls).not.toContain("session.create");
    expect(closed).toBe(true);
  });

  test("redacts secrets from coordinator failures and returned checks", async () => {
    const secret = "coordinator-secret-value";
    const privatePath = "/private/home/coordinator-user";
    const ops = diagnostics();
    ops.launch = async () => {
      throw new Error(`launch rejected token ${secret} from ${privatePath}/auth.json`);
    };
    const { checks, output } = await runFixture({
      coordinator: true,
      diagnostics: ops,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value",
        SHUVCODE_AUTH_TOKEN: secret,
        HOME: privatePath
      }
    });

    expect(JSON.stringify(checks)).not.toContain(secret);
    expect(JSON.stringify(checks)).not.toContain(privatePath);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(privatePath);
    expect(find(checks, "coordinator runtime").message).toContain("[REDACTED]");
    expect(find(checks, "coordinator runtime").message).toContain("[PATH]");
  });

  test("does not expose raw auth storage errors", async () => {
    const secret = "storage-secret-value";
    const privatePath = "/private/auth/store.json";
    const runtime = diagnostics();
    runtime.launch = async () => ({
      version: "1.18.4",
      healthy: true,
      async inspectLocalSubscriptionAuth() {
        throw new Error(`cannot decrypt ${privatePath} with ${secret}`);
      },
      async resolveModel() {
        return "resolved";
      },
      async close() {}
    });
    const { checks, output } = await runFixture({ coordinator: true, diagnostics: runtime });

    expect(find(checks, "coordinator auth")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(checks)).not.toContain(secret);
    expect(JSON.stringify(checks)).not.toContain(privatePath);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(privatePath);
  });
});

function diagnostics(
  options: {
    installedVersion?: string;
    authSupported?: boolean;
    authStatus?: CoordinatorAuthStatus;
    modelCatalogSupported?: boolean;
    unresolvedModels?: ReadonlySet<string>;
    resolvedModels?: string[];
    runtime?: CoordinatorDiagnosticRuntime;
    runtimeClosed?(): void;
  } = {}
): CoordinatorDiagnosticOperations {
  return {
    async inspectPackage({ packageName }) {
      return { packageName, version: options.installedVersion ?? "1.18.4" };
    },
    async inspectCapabilities() {
      return {
        authStatus: options.authSupported ?? true,
        modelCatalog: options.modelCatalogSupported ?? true
      };
    },
    async launch() {
      return (
        options.runtime ?? {
          version: "1.18.4",
          healthy: true,
          async inspectLocalSubscriptionAuth() {
            return options.authStatus ?? authStatus();
          },
          async resolveModel(model: string) {
            options.resolvedModels?.push(model);
            return options.unresolvedModels?.has(model) ? "missing" : "resolved";
          },
          async close() {
            options.runtimeClosed?.();
          }
        }
      );
    }
  };
}

function usableProfile(providerID = "anthropic", profileID = "profile-id") {
  return {
    providerID,
    profileID,
    source: "stored" as const,
    type: "oauth" as const,
    usable: true,
    reason: "configured" as const
  };
}

function authStatus(overrides: Partial<CoordinatorAuthStatus> = {}): CoordinatorAuthStatus {
  return {
    ready: true,
    storage: "available",
    verification: "not_performed",
    profiles: [usableProfile()],
    ...overrides
  };
}

async function runFixture(
  options: {
    coordinator?: boolean;
    legacy?: boolean;
    diagnostics?: CoordinatorDiagnosticOperations;
    env?: Record<string, string | undefined>;
  } = {}
) {
  const cwd = await mkdtemp(join(tmpdir(), "reviewbot-doctor-"));
  if (options.coordinator) await writeFile(join(cwd, "reviewbot.toml"), coordinatorConfig);
  if (options.legacy) await writeFile(join(cwd, "reviewbot.toml"), legacyConfig);
  let output = "";
  const checks = await runDoctor({
    cwd,
    env: options.env ?? { CLAUDE_CODE_OAUTH_TOKEN: "secret-token-value" },
    stdout: {
      write(value: string) {
        output += value;
        return true;
      }
    },
    spawnSyncImpl(command) {
      return { status: 0, stdout: `${command} ok`, stderr: "" };
    },
    ...(options.diagnostics === undefined ? {} : { coordinatorDiagnostics: options.diagnostics })
  });
  return { checks, output };
}

function coordinatorChecks(checks: Awaited<ReturnType<typeof runDoctor>>) {
  return checks.filter((check) => check.name.startsWith("coordinator"));
}

function find(checks: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  return checks.find((check) => check.name === name)!;
}
