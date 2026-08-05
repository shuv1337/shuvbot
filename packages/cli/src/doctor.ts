import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { DEFAULT_CONFIG, loadConfigFile, type ShuvbotConfig } from "../../core/src/config.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { startShuvbotMcpServer } from "../../mcp/src/server.ts";
import { AuditLog } from "../../mcp/src/audit.ts";
import { resolveClaudeAuth } from "../../agents/src/auth.ts";
import { resolveShuvcodeCredential } from "../../review/src/runtime/auth.ts";
import {
  startShuvcodeRuntime,
  type ShuvcodeRuntimeCredential
} from "../../review/src/runtime/shuvcode.ts";
import { spawnSyncLike, type SpawnSyncLike } from "./auth/claude-import.ts";

export interface CoordinatorDiagnosticRuntime {
  readonly version: string;
  readonly healthy: boolean;
  inspectLocalSubscriptionAuth(): Promise<CoordinatorAuthStatus>;
  resolveModel(model: string): Promise<"resolved" | "missing" | "unsupported">;
  close(): Promise<void>;
}

export interface CoordinatorAuthProfile {
  readonly providerID: string;
  readonly profileID?: string;
  readonly source: "stored" | "environment";
  readonly type: "key" | "oauth" | "unknown";
  readonly usable: boolean;
  readonly reason: "configured" | "expired" | "empty" | "malformed";
}

export interface CoordinatorAuthStatus {
  readonly ready: boolean;
  readonly storage: "available" | "unavailable";
  readonly verification: "not_performed";
  readonly profiles: readonly CoordinatorAuthProfile[];
}

export interface CoordinatorDiagnosticOperations {
  inspectPackage(input: {
    packageName: string;
    cwd: string;
  }): Promise<{ packageName: string; version: string }>;
  inspectCapabilities(input: {
    packageName: string;
    cwd: string;
  }): Promise<{ authStatus: boolean; modelCatalog: boolean }>;
  launch(input: {
    packageName: string;
    version: string;
    cwd: string;
    env: Record<string, string | undefined>;
    credential?: ShuvcodeRuntimeCredential;
  }): Promise<CoordinatorDiagnosticRuntime>;
}

export interface DoctorOptions {
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  spawnSyncImpl?: SpawnSyncLike;
  coordinatorDiagnostics?: CoordinatorDiagnosticOperations;
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
  const coordinatorDiagnostics = options.coordinatorDiagnostics ?? defaultCoordinatorDiagnostics;
  const checks: DoctorCheck[] = [];
  let config: ShuvbotConfig = structuredClone(DEFAULT_CONFIG);

  const configPath = options.configPath ?? "shuvbot.toml";
  const resolvedConfigPath = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  if (existsSync(resolvedConfigPath)) {
    config = await loadConfigFile(resolvedConfigPath);
    checks.push(pass("config", `Config valid: ${configPath}`));
  } else {
    checks.push(warn("config", `Config not found: ${configPath}`));
  }

  checks.push(
    commandCheck("gh auth", spawnImpl("gh", ["auth", "status"], { cwd, encoding: "utf8" }))
  );
  checks.push(
    commandCheck("claude", spawnImpl("claude", ["--version"], { cwd, encoding: "utf8" }))
  );
  try {
    const auth = resolveClaudeAuth(env);
    checks.push(pass("claude auth", `Using ${auth.kind}`));
  } catch (error) {
    checks.push(fail("claude auth", error instanceof Error ? error.message : String(error)));
  }
  checks.push(
    commandCheck("git", spawnImpl("git", ["status", "--short"], { cwd, encoding: "utf8" }))
  );
  checks.push(commandCheck("bun", spawnImpl("bun", ["--version"], { cwd, encoding: "utf8" })));
  checks.push(commandCheck("node", spawnImpl("node", ["--version"], { cwd, encoding: "utf8" })));

  const redactor = new DefaultRedactor();
  const server = await startShuvbotMcpServer({
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
  checks.push(
    redacted.includes("fake-secret-token-value")
      ? fail("redaction", "Secret redaction failed")
      : pass("redaction", "Secret redaction works")
  );

  if (config.review.engine === "coordinator") {
    checks.push(...(await coordinatorChecks(config, cwd, env, coordinatorDiagnostics, redactor)));
  } else {
    const skipped = "Skipped because review.engine is not coordinator";
    checks.push(warn("coordinator package", skipped));
    checks.push(warn("coordinator auth", skipped));
    checks.push(warn("coordinator runtime", skipped));
    for (const role of ["coordinator", "standard", "light"] as const) {
      checks.push(warn(`coordinator model ${role}`, skipped));
    }
  }

  const safeChecks = checks.map((check) => ({
    ...check,
    message: redactDiagnostic(check.message, redactor, env, cwd)
  }));
  for (const check of safeChecks) {
    options.stdout?.write(`[${check.status}] ${check.name}: ${check.message}\n`);
  }
  return safeChecks;
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

async function coordinatorChecks(
  config: ShuvbotConfig,
  cwd: string,
  env: Record<string, string | undefined>,
  operations: CoordinatorDiagnosticOperations,
  redactor: DefaultRedactor
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const expected = config.review.shuvcode;
  let packageMatches = false;
  try {
    const installed = await operations.inspectPackage({ packageName: expected.package, cwd });
    packageMatches =
      installed.packageName === expected.package && installed.version === expected.version;
    checks.push(
      packageMatches
        ? pass("coordinator package", `Found exact ${expected.package}@${expected.version}`)
        : fail(
            "coordinator package",
            `Expected ${expected.package}@${expected.version}, found ${installed.packageName}@${installed.version}; install the exact configured release`
          )
    );
  } catch (error) {
    checks.push(
      fail(
        "coordinator package",
        `Cannot resolve ${expected.package}@${expected.version}: ${safeError(error, redactor, env, cwd)}`
      )
    );
  }

  let authSupported = false;
  let modelCatalogSupported = false;
  const profileAuthUsable = expected.auth === "environment" || expected.useUserAuth;
  let diagnosticCredential: ShuvcodeRuntimeCredential | undefined;
  if (expected.auth === "environment") {
    // Report whether the configured non-interactive credential is actually
    // present, without ever printing the value.
    try {
      diagnosticCredential = resolveShuvcodeCredential({ mode: "environment", env });
      checks.push(
        pass(
          "coordinator auth",
          `Non-interactive credential supplied via ${diagnosticCredential?.name}`
        )
      );
    } catch (error) {
      checks.push(fail("coordinator auth", safeError(error, redactor, env, cwd)));
    }
  }
  if (!profileAuthUsable) {
    checks.push(
      fail(
        "coordinator auth",
        "Local subscription auth is disabled; set review.shuvcode.use_user_auth = true " +
          'or review.shuvcode.auth = "environment"'
      )
    );
  } else {
    try {
      const capabilities = await operations.inspectCapabilities({
        packageName: expected.package,
        cwd
      });
      authSupported = capabilities.authStatus;
      modelCatalogSupported = capabilities.modelCatalog;
      checks.push(
        authSupported
          ? pass("coordinator auth capability", "Public auth.status() capability is available")
          : fail(
              "coordinator auth capability",
              `Incompatible ${expected.package} client: public auth.status() is unavailable; install the exact corrected release configured by review.shuvcode.version`
            )
      );
    } catch (error) {
      checks.push(
        fail(
          "coordinator auth capability",
          `Could not inspect packed client capabilities: ${safeError(error, redactor, env, cwd)}`
        )
      );
    }
  }

  if (!packageMatches || !authSupported) {
    const reason = !packageMatches
      ? "the exact package pin is unavailable"
      : "the packed public client lacks the required auth.status() capability";
    if (profileAuthUsable && expected.auth === "user") {
      checks.push(warn("coordinator auth", `Skipped because ${reason}`));
    }
    checks.push(warn("coordinator runtime", `Skipped because ${reason}`));
    for (const role of ["coordinator", "standard", "light"] as const) {
      checks.push(warn(`coordinator model ${role}`, `Skipped because ${reason}`));
    }
    return checks;
  }

  let runtime: CoordinatorDiagnosticRuntime;
  try {
    runtime = await operations.launch({
      packageName: expected.package,
      version: expected.version,
      cwd,
      env,
      // Diagnose the runtime the way a real run would authenticate it, so an
      // environment-auth check cannot pass here and fail during a review.
      ...(diagnosticCredential === undefined ? {} : { credential: diagnosticCredential })
    });
    if (!runtime.healthy || runtime.version !== expected.version) {
      checks.push(
        fail(
          "coordinator runtime",
          `Runtime health/version mismatch: expected healthy ${expected.version}, received ${runtime.healthy ? "healthy" : "unhealthy"} ${runtime.version}`
        )
      );
      for (const role of ["coordinator", "standard", "light"] as const) {
        checks.push(warn(`coordinator model ${role}`, "Skipped because runtime health failed"));
      }
      await runtime.close().catch(() => undefined);
      return checks;
    }
    checks.push(pass("coordinator runtime", `Isolated runtime is healthy at ${runtime.version}`));
  } catch (error) {
    checks.push(
      fail(
        "coordinator runtime",
        `Isolated runtime failed to launch: ${safeError(error, redactor, env, cwd)}`
      )
    );
    for (const role of ["coordinator", "standard", "light"] as const) {
      checks.push(warn(`coordinator model ${role}`, "Skipped because runtime launch failed"));
    }
    return checks;
  }

  try {
    let authUsable = false;
    try {
      const status = await runtime.inspectLocalSubscriptionAuth();
      if (!isAuthStatus(status)) {
        checks.push(
          fail(
            "coordinator auth",
            "Public auth.status() returned an invalid secret-safe readiness response; install the exact corrected shuvcode release"
          )
        );
      } else {
        const usableProviders = new Set(
          status.profiles.filter((profile) => profile.usable).map((profile) => profile.providerID)
        ).size;
        authUsable = status.ready && usableProviders > 0;
        checks.push(
          authUsable
            ? pass(
                "coordinator auth",
                `Local auth is configured and structurally usable for ${usableProviders} provider${usableProviders === 1 ? "" : "s"}; storage: ${status.storage}; verification: not_performed (external validity is not verified)`
              )
            : fail(
                "coordinator auth",
                `No structurally usable local provider auth is configured; storage: ${status.storage}; verification: not_performed (external validity is not verified); sign in with shuvcode`
              )
        );
      }
    } catch {
      checks.push(
        fail(
          "coordinator auth",
          "Could not inspect secret-safe local auth readiness; run shuvcode auth setup and retry"
        )
      );
    }

    for (const role of ["coordinator", "standard", "light"] as const) {
      const model = config.review.models[role];
      if (!modelCatalogSupported) {
        checks.push(
          fail(
            `coordinator model ${role}`,
            "Packed shuvcode/client does not expose public provider.list() and model.list() catalog operations"
          )
        );
        continue;
      }
      try {
        const resolved = await runtime.resolveModel(model);
        checks.push(
          resolved === "resolved"
            ? pass(`coordinator model ${role}`, `Resolved ${model}`)
            : resolved === "missing"
              ? fail(
                  `coordinator model ${role}`,
                  `Cannot resolve configured model ${model}; verify the subscription model name and account access`
                )
              : fail(
                  `coordinator model ${role}`,
                  "Packed shuvcode/client model catalog capability became unavailable"
                )
        );
      } catch (error) {
        checks.push(
          fail(
            `coordinator model ${role}`,
            `Cannot resolve configured model ${model}: ${safeError(error, redactor, env, cwd)}`
          )
        );
      }
    }
  } finally {
    await runtime.close().catch(() => undefined);
  }
  return checks;
}

interface PublicShuvcodeClient {
  readonly auth?: {
    status(
      input?: { readonly location?: { readonly directory?: string; readonly workspace?: string } },
      options?: { signal?: AbortSignal }
    ): Promise<{ readonly data: CoordinatorAuthStatus }>;
  };
  readonly provider?: { list(input?: { location?: { directory: string } }): Promise<unknown> };
  readonly model?: { list(input?: { location?: { directory: string } }): Promise<unknown> };
}

interface PublicShuvcodeClientModule {
  readonly OpenCode: {
    make(options: {
      baseUrl: string;
      headers?: Readonly<Record<string, string>>;
    }): PublicShuvcodeClient;
  };
}

interface DefaultCoordinatorDiagnosticDependencies {
  loadClient(url: string): Promise<PublicShuvcodeClientModule>;
  startRuntime: typeof startShuvcodeRuntime;
  password(): string;
}

export function createDefaultCoordinatorDiagnostics(
  dependencies: Partial<DefaultCoordinatorDiagnosticDependencies> = {}
): CoordinatorDiagnosticOperations {
  const resolvedDependencies: DefaultCoordinatorDiagnosticDependencies = {
    loadClient: (url) => import(url) as Promise<PublicShuvcodeClientModule>,
    startRuntime: startShuvcodeRuntime,
    password: () => randomBytes(32).toString("base64url"),
    ...dependencies
  };
  return {
    async inspectPackage({ packageName, cwd }) {
      const installed = await resolveDiagnosticPackage(packageName, cwd);
      return { packageName: installed.packageName, version: installed.version };
    },
    async inspectCapabilities({ packageName, cwd }) {
      const installed = await resolveDiagnosticPackage(packageName, cwd);
      const module = await resolvedDependencies.loadClient(installed.clientUrl);
      const client = module.OpenCode.make({ baseUrl: "http://127.0.0.1" });
      return {
        authStatus: typeof client.auth?.status === "function",
        modelCatalog:
          typeof client.provider?.list === "function" && typeof client.model?.list === "function"
      };
    },
    async launch({ packageName, version, cwd, env, credential }) {
      const installed = await resolveDiagnosticPackage(packageName, cwd);
      const password = resolvedDependencies.password();
      const runtime = await resolvedDependencies.startRuntime({
        packageName,
        version,
        cwd,
        environment: env,
        ...(credential === undefined ? {} : { credential }),
        dependencies: { password: () => password }
      });
      try {
        const module = await resolvedDependencies.loadClient(installed.clientUrl);
        const client = module.OpenCode.make({
          baseUrl: runtime.url,
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
          }
        });
        return {
          version,
          healthy: true,
          async inspectLocalSubscriptionAuth() {
            if (client.auth?.status === undefined) {
              throw new Error("Packed public client auth.status() capability is unavailable");
            }
            const result = await client.auth.status({ location: { directory: cwd } });
            return result.data;
          },
          async resolveModel(model) {
            if (client.provider?.list === undefined || client.model?.list === undefined) {
              return "unsupported";
            }
            const separator = model.indexOf("/");
            if (separator <= 0 || separator === model.length - 1) return "missing";
            const providerID = model.slice(0, separator);
            const modelID = model.slice(separator + 1);
            const [providerResult, modelResult] = await Promise.all([
              client.provider.list({ location: { directory: cwd } }),
              client.model.list({ location: { directory: cwd } })
            ]);
            const providers = catalogData(providerResult);
            const models = catalogData(modelResult);
            const provider = providers.find(
              (item) => item.id === providerID && item.disabled !== true
            );
            const found = models.find(
              (item) =>
                item.providerID === providerID &&
                (item.modelID === modelID || item.id === modelID) &&
                item.enabled !== false
            );
            return provider !== undefined && found !== undefined ? "resolved" : "missing";
          },
          close: () => runtime.close()
        };
      } catch (error) {
        await runtime.close().catch(() => undefined);
        throw error;
      }
    }
  };
}

const defaultCoordinatorDiagnostics = createDefaultCoordinatorDiagnostics();

async function resolveDiagnosticPackage(
  packageName: string,
  cwd: string
): Promise<{
  packageName: string;
  version: string;
  clientUrl: string;
}> {
  const require = createRequire(join(cwd, "package.json"));
  const client = require.resolve(`${packageName}/client`);
  let directory = dirname(client);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === packageName && typeof manifest.version === "string") {
        return {
          packageName,
          version: manifest.version,
          clientUrl: pathToFileURL(client).href
        };
      }
    } catch {
      // Continue toward the filesystem root until the package manifest is found.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate the installed ${packageName} package manifest`);
}

function catalogData(value: unknown): Array<Record<string, unknown>> {
  return isRecord(value) && Array.isArray(value.data) ? value.data.filter(isRecord) : [];
}

function isAuthStatus(value: unknown): value is CoordinatorAuthStatus {
  if (
    !isRecord(value) ||
    typeof value.ready !== "boolean" ||
    (value.storage !== "available" && value.storage !== "unavailable") ||
    value.verification !== "not_performed" ||
    !Array.isArray(value.profiles)
  ) {
    return false;
  }
  const profilesValid = value.profiles.every(
    (profile) =>
      isRecord(profile) &&
      typeof profile.providerID === "string" &&
      profile.providerID.length > 0 &&
      (profile.source === "stored" || profile.source === "environment") &&
      (profile.type === "key" || profile.type === "oauth" || profile.type === "unknown") &&
      typeof profile.usable === "boolean" &&
      ["configured", "expired", "empty", "malformed"].includes(String(profile.reason))
  );
  return profilesValid && value.ready === value.profiles.some((profile) => profile.usable === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(
  error: unknown,
  redactor: DefaultRedactor,
  env: Record<string, string | undefined>,
  cwd: string
): string {
  return redactDiagnostic(
    error instanceof Error ? error.message : String(error),
    redactor,
    env,
    cwd
  );
}

function redactDiagnostic(
  message: string,
  redactor: DefaultRedactor,
  env: Record<string, string | undefined>,
  cwd: string
): string {
  let result = redactor.redactString(message);
  for (const [name, value] of Object.entries(env)) {
    if (value && /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name)) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  const paths = [resolve(cwd), env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]
    .filter((value): value is string => typeof value === "string" && value.length > 1)
    .sort((left, right) => right.length - left.length);
  for (const path of paths) result = result.split(path).join("[PATH]");
  return result;
}
