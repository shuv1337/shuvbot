import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import {
  classifyReviewError,
  type ClassifiedReviewError,
  type ReviewErrorCategory
} from "../errors.ts";

export type ShuvcodeEvent = {
  readonly type: string;
  readonly data?: { readonly sessionID?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
};

export interface ShuvcodeSession {
  readonly id: string;
  readonly policy?: ShuvcodeSessionPolicy;
  readonly [key: string]: unknown;
}

export interface ShuvcodeSessionPolicy {
  readonly tools: { readonly allow: readonly string[] };
}

export const REVIEW_SESSION_POLICY: ShuvcodeSessionPolicy = Object.freeze({
  tools: Object.freeze({ allow: Object.freeze(["read"]) })
});

export interface ShuvcodeSessionCreateInput {
  readonly id?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string };
  readonly location?: { readonly directory: string; readonly workspaceID?: string };
  /**
   * Optional narrowing of the code-owned review policy. Omitted requests receive
   * the full read-only review policy; supplied policies may only narrow it.
   */
  readonly policy?: ShuvcodeSessionPolicy;
}

interface ShuvcodeClientSessionCreateInput extends ShuvcodeSessionCreateInput {
  readonly policy: ShuvcodeSessionPolicy;
}

export interface ShuvcodePromptInput {
  readonly sessionID: string;
  readonly text: string;
  readonly output?: {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly name?: string;
    readonly description?: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly delivery?: "steer" | "queue";
  readonly resume?: boolean;
}

interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ShuvcodeClient {
  readonly health: { get(options?: RequestOptions): Promise<unknown> };
  readonly session: {
    create(
      input: ShuvcodeClientSessionCreateInput,
      options?: RequestOptions
    ): Promise<ShuvcodeSession>;
    fork(
      input: {
        readonly sessionID: string;
        readonly boundary: { readonly type: "through" };
        readonly policy: ShuvcodeSessionPolicy;
      },
      options?: RequestOptions
    ): Promise<ShuvcodeSession>;
    switchAgent?(
      input: { readonly sessionID: string; readonly agent: string },
      options?: RequestOptions
    ): Promise<void>;
    switchModel?(
      input: {
        readonly sessionID: string;
        readonly model: {
          readonly id: string;
          readonly providerID: string;
          readonly variant?: string;
        };
      },
      options?: RequestOptions
    ): Promise<void>;
    prompt(input: ShuvcodePromptInput, options?: RequestOptions): Promise<unknown>;
    interrupt(input: { readonly sessionID: string }, options?: RequestOptions): Promise<void>;
  };
  readonly event: { subscribe(options?: RequestOptions): AsyncIterable<ShuvcodeEvent> };
}

/** A concrete model the runtime can route, discovered from its public catalog. */
export interface ShuvcodeModel {
  readonly providerID: string;
  readonly id: string;
}

export interface ShuvcodeClientModule {
  readonly OpenCode: {
    make(options: {
      readonly baseUrl: string;
      readonly headers: Readonly<Record<string, string>>;
    }): ShuvcodeClient;
  };
}

export interface ShuvcodeProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly stdin: { end(): void };
  readonly exited: Promise<number | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface ResolvedShuvcodePackage {
  readonly name: string;
  readonly version: string;
  readonly bin: string;
  readonly client: string;
}

export interface ShuvcodeRuntimeDependencies {
  resolvePackage(packageName: string, cwd: string): Promise<ResolvedShuvcodePackage>;
  loadClient(url: string): Promise<ShuvcodeClientModule>;
  spawn(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
  ): ShuvcodeProcess;
  password(): string;
}

export interface StartShuvcodeRuntimeOptions {
  readonly packageName: string;
  readonly version: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly dependencies?: Partial<ShuvcodeRuntimeDependencies>;
}

export interface ShuvcodeRuntime {
  readonly url: string;
  createSession(input?: ShuvcodeSessionCreateInput): Promise<ShuvcodeSession>;
  /**
   * Forks an existing review session. The runtime resolves the fork boundary from
   * the parent's persisted messages, so the parent must already have been prompted;
   * forking a freshly created session fails with an `empty_session` request error.
   * Review specialists therefore use {@link ShuvcodeRuntime.createSession} with an
   * explicitly narrowed policy instead of forking the unprompted coordinator.
   */
  forkSession(sessionID: string, policy: ShuvcodeSessionPolicy): Promise<ShuvcodeSession>;
  configureSession(
    sessionID: string,
    input: {
      readonly agent?: string;
      readonly model?: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
    }
  ): Promise<void>;
  prompt(input: ShuvcodePromptInput): Promise<unknown>;
  wait(sessionID: string, options?: { readonly signal?: AbortSignal }): Promise<ShuvcodeEvent>;
  interrupt(sessionID: string): Promise<void>;
  subscribe(listener: (event: ShuvcodeEvent) => void): () => void;
  close(): Promise<void>;
}

export class ShuvcodeSessionError extends Error implements ClassifiedReviewError {
  readonly code: ClassifiedReviewError["code"];
  readonly retryable: boolean;

  constructor(
    readonly category: ReviewErrorCategory,
    message = safeFailureMessage(category)
  ) {
    super(message);
    this.name = "ShuvcodeSessionError";
    const classified = classifyReviewError({ category, message });
    this.code = classified.code;
    this.retryable = classified.retryable;
  }
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Structural seam matching the generated Promise API packed at `shuvcode/client`. */
export async function startShuvcodeRuntime(
  options: StartShuvcodeRuntimeOptions
): Promise<ShuvcodeRuntime> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const cwd = resolve(options.cwd);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const startupDeadline = Date.now() + startupTimeoutMs;
  const installed = await startupStage(
    dependencies.resolvePackage(options.packageName, cwd),
    startupDeadline,
    options.signal,
    "package resolution"
  );
  if (installed.name !== options.packageName || installed.version !== options.version) {
    throw new Error(
      `Incompatible shuvcode runtime: expected ${options.packageName}@${options.version}, ` +
        `found ${installed.name}@${installed.version}. Install the exact configured release in ${cwd}.`
    );
  }

  const password = dependencies.password();
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnvironment(options.environment ?? process.env),
    OPENCODE_PASSWORD: password
  };
  const child = dependencies.spawn(installed.bin, ["serve", "--stdio", "--port", "0"], {
    cwd,
    env
  });
  const eventController = new AbortController();
  const activeSessions = new Set<string>();
  const sessionPolicies = new Map<string, ShuvcodeSessionPolicy>();
  const listeners = new Set<(event: ShuvcodeEvent) => void>();
  const structuredSessions = new Set<string>();
  const waiters = new Map<
    string,
    Set<{ resolve(event: ShuvcodeEvent): void; reject(error: Error): void; cleanup(): void }>
  >();
  const terminalEvents = new Map<string, ShuvcodeEvent | ShuvcodeSessionError>();
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  let closePromise: Promise<void> | undefined;
  let removeOuterAbort = (): void => {};
  let client: ShuvcodeClient | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      removeOuterAbort();
      eventController.abort();
      for (const pending of waiters.values()) {
        for (const waiter of pending) {
          waiter.cleanup();
          waiter.reject(new ShuvcodeSessionError("cancellation", "Shuvcode runtime closed"));
        }
      }
      waiters.clear();
      await settlesWithin(
        Promise.allSettled(
          [...activeSessions].map((sessionID) =>
            client?.session.interrupt({ sessionID }).catch(() => undefined)
          )
        ),
        shutdownGraceMs
      );
      activeSessions.clear();
      child.stdin.end();
      child.kill("SIGTERM");
      if (!(await exitsWithin(child.exited, shutdownGraceMs))) {
        child.kill("SIGKILL");
        await exitsWithin(child.exited, shutdownGraceMs);
      }
    })();
    return closePromise;
  };

  if (options.signal !== undefined) {
    const abort = (): void => void close();
    if (options.signal.aborted) {
      await close();
      throw new Error("Shuvcode runtime startup cancelled");
    }
    options.signal.addEventListener("abort", abort, { once: true });
    removeOuterAbort = () => options.signal?.removeEventListener("abort", abort);
  }

  try {
    const url = await startupStage(
      readStartupUrl(
        child,
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        eventController.signal
      ),
      startupDeadline,
      options.signal,
      "startup output"
    );
    const module = await startupStage(
      dependencies.loadClient(installed.client),
      startupDeadline,
      options.signal,
      "client loading"
    );
    client = module.OpenCode.make({
      baseUrl: url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    });
    assertPolicyClient(client, options.packageName, options.version);
    const health = await startupStage(
      client.health.get({ signal: eventController.signal }),
      startupDeadline,
      options.signal,
      "health check"
    );
    const healthVersion = recordString(health, "version");
    if (!isRecord(health) || health.healthy !== true) {
      throw new Error("Shuvcode health check reported an unhealthy runtime.");
    }
    if (healthVersion !== options.version) {
      throw new Error(
        `Shuvcode health version mismatch: expected ${options.version}, received ${healthVersion ?? "missing"}.`
      );
    }

    void pumpEvents(client, eventController.signal, (sourceEvent) => {
      const event = sanitizeEvent(sourceEvent);
      for (const listener of listeners) listener(event);
      const sessionID = event.data?.sessionID;
      if (sessionID === undefined) return;
      const terminal = terminalResult(sourceEvent, structuredSessions.has(sessionID), event);
      if (terminal === undefined) return;
      activeSessions.delete(sessionID);
      structuredSessions.delete(sessionID);
      const pending = waiters.get(sessionID);
      if (pending === undefined) {
        if (!terminalEvents.has(sessionID)) terminalEvents.set(sessionID, terminal);
        return;
      }
      waiters.delete(sessionID);
      for (const waiter of pending) {
        waiter.cleanup();
        if (terminal instanceof ShuvcodeSessionError) waiter.reject(terminal);
        else waiter.resolve(terminal);
      }
    }).catch((error: unknown) => {
      if (eventController.signal.aborted) return;
      void error;
      const failure = new ShuvcodeSessionError("service", "Shuvcode event subscription failed");
      for (const pending of waiters.values()) {
        for (const waiter of pending) {
          waiter.cleanup();
          waiter.reject(failure);
        }
      }
      waiters.clear();
    });

    const runtimeClient = client;
    return {
      url,
      async createSession(input) {
        ensureOpen(closePromise);
        const { policy: requested, ...rest } = input ?? {};
        const policy = requested ?? REVIEW_SESSION_POLICY;
        assertReviewPolicy(policy, REVIEW_SESSION_POLICY);
        const session = await runtimeClient.session.create(
          { ...rest, policy },
          {
            signal: eventController.signal
          }
        );
        activeSessions.add(session.id);
        assertInstalledPolicy(session, policy, options.packageName, options.version);
        ensureOpen(closePromise);
        sessionPolicies.set(session.id, policy);
        return session;
      },
      async forkSession(sessionID, policy) {
        ensureOpen(closePromise);
        const parentPolicy = sessionPolicies.get(sessionID);
        if (parentPolicy === undefined) {
          throw new Error(`Cannot fork unprotected or unknown review session: ${sessionID}`);
        }
        assertReviewPolicy(policy, parentPolicy);
        const session = await runtimeClient.session.fork(
          {
            sessionID,
            boundary: { type: "through" },
            policy
          },
          { signal: eventController.signal }
        );
        activeSessions.add(session.id);
        assertInstalledPolicy(session, policy, options.packageName, options.version);
        ensureOpen(closePromise);
        sessionPolicies.set(session.id, policy);
        return session;
      },
      async configureSession(sessionID, input) {
        ensureOpen(closePromise);
        ensureProtectedSession(sessionPolicies, sessionID);
        if (input.agent !== undefined) {
          if (runtimeClient.session.switchAgent === undefined) {
            throw new Error("Shuvcode client does not support session agent selection");
          }
          await runtimeClient.session.switchAgent(
            { sessionID, agent: input.agent },
            { signal: eventController.signal }
          );
          ensureOpen(closePromise);
        }
        if (input.model !== undefined) {
          if (runtimeClient.session.switchModel === undefined) {
            throw new Error("Shuvcode client does not support session model selection");
          }
          await runtimeClient.session.switchModel(
            { sessionID, model: input.model },
            { signal: eventController.signal }
          );
          ensureOpen(closePromise);
        }
      },
      async prompt(input) {
        ensureOpen(closePromise);
        ensureProtectedSession(sessionPolicies, input.sessionID);
        activeSessions.add(input.sessionID);
        if (input.output !== undefined) structuredSessions.add(input.sessionID);
        try {
          const result = await runtimeClient.session.prompt(input, {
            signal: eventController.signal
          });
          ensureOpen(closePromise);
          return result;
        } catch (error) {
          activeSessions.delete(input.sessionID);
          structuredSessions.delete(input.sessionID);
          if (closePromise !== undefined || eventController.signal.aborted) {
            throw new ShuvcodeSessionError("cancellation");
          }
          throw safeClientError(error);
        }
      },
      wait(sessionID, waitOptions = {}) {
        ensureOpen(closePromise);
        const completed = terminalEvents.get(sessionID);
        if (completed !== undefined) {
          terminalEvents.delete(sessionID);
          return completed instanceof ShuvcodeSessionError
            ? Promise.reject(completed)
            : Promise.resolve(completed);
        }
        return new Promise((resolveWait, rejectWait) => {
          let settled = false;
          const cleanup = (): void => waitOptions.signal?.removeEventListener("abort", abort);
          const waiter = {
            resolve(event: ShuvcodeEvent) {
              if (settled) return;
              settled = true;
              resolveWait(event);
            },
            reject(error: Error) {
              if (settled) return;
              settled = true;
              rejectWait(error);
            },
            cleanup
          };
          const pending = waiters.get(sessionID) ?? new Set();
          pending.add(waiter);
          waiters.set(sessionID, pending);
          const abort = (): void => {
            if (settled) return;
            pending.delete(waiter);
            if (pending.size === 0) waiters.delete(sessionID);
            activeSessions.delete(sessionID);
            structuredSessions.delete(sessionID);
            void (async () => {
              await settlesWithin(
                runtimeClient.session.interrupt({ sessionID }).catch(() => undefined),
                shutdownGraceMs
              );
              waiter.reject(
                new ShuvcodeSessionError("cancellation", `Shuvcode session ${sessionID} cancelled`)
              );
            })();
          };
          if (waitOptions.signal?.aborted) abort();
          else waitOptions.signal?.addEventListener("abort", abort, { once: true });
        });
      },
      async interrupt(sessionID) {
        activeSessions.delete(sessionID);
        structuredSessions.delete(sessionID);
        await runtimeClient.session.interrupt({ sessionID }, { signal: eventController.signal });
      },
      subscribe(listener) {
        ensureOpen(closePromise);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function assertPolicyClient(client: ShuvcodeClient, packageName: string, version: string): void {
  if (
    typeof client.session?.create !== "function" ||
    typeof client.session?.fork !== "function" ||
    typeof client.session?.prompt !== "function"
  ) {
    throw policyCompatibilityError(packageName, version);
  }
}

function assertInstalledPolicy(
  session: ShuvcodeSession,
  expected: ShuvcodeSessionPolicy,
  packageName: string,
  version: string
): void {
  const actual = session.policy?.tools.allow;
  if (
    actual === undefined ||
    actual.length !== expected.tools.allow.length ||
    actual.some((tool, index) => tool !== expected.tools.allow[index])
  ) {
    throw policyCompatibilityError(packageName, version);
  }
}

function assertReviewPolicy(
  policy: ShuvcodeSessionPolicy,
  parentPolicy: ShuvcodeSessionPolicy
): void {
  const baseline = new Set(parentPolicy.tools.allow);
  if (
    !Array.isArray(policy.tools.allow) ||
    new Set(policy.tools.allow).size !== policy.tools.allow.length ||
    policy.tools.allow.some((tool) => !baseline.has(tool))
  ) {
    throw new Error("Review child session policy may only narrow the code-owned read policy");
  }
}

function ensureProtectedSession(
  policies: ReadonlyMap<string, ShuvcodeSessionPolicy>,
  sessionID: string
): void {
  if (!policies.has(sessionID)) {
    throw new Error(`Refusing to use unprotected or unknown review session: ${sessionID}`);
  }
}

function policyCompatibilityError(packageName: string, version: string): Error {
  return new Error(
    `Incompatible shuvcode runtime: ${packageName}@${version} does not expose the required ` +
      "server-enforced immutable session policy API. Install the exact corrected release configured by review.shuvcode.version."
  );
}

const defaultDependencies: ShuvcodeRuntimeDependencies = {
  resolvePackage: resolveInstalledPackage,
  loadClient: (url) => import(url) as Promise<ShuvcodeClientModule>,
  spawn(command, args, options) {
    const child = spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      exited: new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      }),
      kill: (signal) => void child.kill(signal)
    };
  },
  password: () => randomBytes(32).toString("base64url")
};

/**
 * Resolves the installed runtime from its packed manifest instead of Node module
 * resolution. The published package exports `./client` under the `import`
 * condition only, so CJS `require.resolve` can never match it, and `import.meta`
 * resolution cannot be re-parented onto the review directory. Reading the packed
 * manifest consumes the same public contract without depending on either
 * resolver's conditions.
 */
async function resolveInstalledPackage(
  packageName: string,
  cwd: string
): Promise<ResolvedShuvcodePackage> {
  const directory = await findInstalledPackageDirectory(packageName, resolve(cwd));
  const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!isRecord(manifest) || manifest.name !== packageName) {
    throw new Error(`Installed ${packageName} manifest is invalid at ${directory}`);
  }
  const version = typeof manifest.version === "string" ? manifest.version : "unknown";
  const bin = isRecord(manifest.bin) ? manifest.bin[packageName] : undefined;
  if (typeof bin !== "string") throw new Error(`${packageName} does not declare its binary`);
  const client = clientEntry(manifest.exports);
  if (client === undefined) {
    throw new Error(
      `${packageName}@${version} does not export its packed ${packageName}/client entry. ` +
        "Install the exact corrected release configured by review.shuvcode.version."
    );
  }
  return {
    name: packageName,
    version,
    bin: resolve(directory, bin),
    client: pathToFileURL(resolve(directory, client)).href
  };
}

/** Selects the packed `./client` module target from a manifest export map. */
function clientEntry(exports: unknown): string | undefined {
  if (!isRecord(exports)) return undefined;
  const entry = exports["./client"];
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return undefined;
  for (const condition of ["import", "default", "node"]) {
    const target = entry[condition];
    if (typeof target === "string") return target;
  }
  return undefined;
}

/** Walks `node_modules` from the review directory upward, as Node resolution would. */
async function findInstalledPackageDirectory(packageName: string, cwd: string): Promise<string> {
  let directory = cwd;
  while (true) {
    const candidate = join(directory, "node_modules", packageName);
    if (await isFile(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Cannot resolve the installed ${packageName} package from ${cwd}. ` +
      `Install the exact configured ${packageName} release in ${cwd}.`
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readStartupUrl(
  child: ShuvcodeProcess,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new Error("maxOutputBytes must be positive");
  void drain(child.stderr, () => undefined, signal).catch(() => undefined);
  return parseStartupLine(await firstLine(child.stdout, maxBytes, signal));
}

function remainingStartupMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Shuvcode startup timed out");
  return remaining;
}

async function startupStage<T>(
  operation: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  if (signal?.aborted) throw new Error("Shuvcode runtime startup cancelled");
  const remaining = remainingStartupMs(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = (): void => {};
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Shuvcode ${label} timed out`)), remaining);
  });
  const cancelled = new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    const abort = (): void => reject(new Error("Shuvcode runtime startup cancelled"));
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    return await Promise.race([operation, timeout, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
  }
}

async function firstLine(
  stream: AsyncIterable<string | Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  let buffer = "";
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await abortableNext(iterator, signal);
      if (result.done) throw new Error("Shuvcode exited before reporting startup JSON");
      const chunk =
        typeof result.value === "string"
          ? result.value
          : Buffer.from(result.value).toString("utf8");
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBytes) {
        throw new Error("Shuvcode startup output exceeded limit");
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) return buffer.slice(0, newline).replace(/\r$/, "");
    }
  } finally {
    await iterator.return?.();
  }
}

async function drain(
  stream: AsyncIterable<string | Uint8Array>,
  consume: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (!signal?.aborted) {
      const result =
        signal === undefined ? await iterator.next() : await abortableNext(iterator, signal);
      if (result.done) return;
      consume(
        typeof result.value === "string" ? result.value : Buffer.from(result.value).toString("utf8")
      );
    }
  } finally {
    await iterator.return?.();
  }
}

async function abortableNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new Error("Shuvcode runtime startup cancelled");
  let removeAbort = (): void => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new Error("Shuvcode runtime startup cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([iterator.next(), cancelled]);
  } finally {
    removeAbort();
  }
}

function parseStartupLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error("Invalid shuvcode startup JSON", { cause });
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.url !== "string") {
    throw new Error('Invalid shuvcode startup JSON: expected exactly {"url":"..."}');
  }
  const url = new URL(parsed.url);
  if (
    url.protocol !== "http:" ||
    !isLoopback(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Invalid shuvcode startup URL: expected an unauthenticated loopback HTTP URL");
  }
  return url.href;
}

async function pumpEvents(
  client: ShuvcodeClient,
  signal: AbortSignal,
  receive: (event: ShuvcodeEvent) => void
): Promise<void> {
  for await (const event of client.event.subscribe({ signal })) receive(event);
}

/**
 * Decides whether an event ends a session. Failures are classified from the
 * source event because sanitization intentionally reduces an error payload to a
 * category and status, which is enough to log but not enough to tell an
 * unroutable model apart from an invalid structured response. Successful
 * terminals still resolve with the sanitized event so callers only ever observe
 * the public value.
 */
function terminalResult(
  event: ShuvcodeEvent,
  structured: boolean,
  sanitized: ShuvcodeEvent = event
): ShuvcodeEvent | ShuvcodeSessionError | undefined {
  if (event.type === "session.structured.completed") return sanitized;
  if (event.type === "session.execution.interrupted") {
    return new ShuvcodeSessionError("cancellation");
  }
  if (
    event.type === "session.structured.failed" ||
    event.type === "session.execution.failed" ||
    event.type === "session.error"
  ) {
    return new ShuvcodeSessionError(classifyFailure(event));
  }
  if (event.type !== "session.idle" && event.type !== "session.execution.succeeded") {
    return undefined;
  }
  return structured
    ? new ShuvcodeSessionError("schema", "Session completed without a structured result")
    : sanitized;
}

function sanitizeEvent(event: ShuvcodeEvent): ShuvcodeEvent {
  const sessionID = event.data?.sessionID;
  if (sessionID === undefined) return { type: event.type };
  const data: Record<string, unknown> = { sessionID };
  if (event.type === "session.structured.completed" && "value" in (event.data ?? {})) {
    data.value = event.data?.value;
  }
  const usage = sanitizeUsage(event.data);
  if (usage !== undefined) Object.assign(data, usage);
  if (isFailureType(event.type)) {
    const category = classifyFailure(event);
    data.error = { type: category, ...sanitizeFailureStatus(event.data?.error) };
  }
  if (event.type === "session.execution.interrupted") {
    const reason = recordString(event.data, "reason");
    if (reason === "user" || reason === "shutdown" || reason === "superseded") {
      data.reason = reason;
    }
  }
  return { type: event.type, data };
}

function sanitizeUsage(data: ShuvcodeEvent["data"]): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  const direct = isRecord(data.usage) ? data.usage : undefined;
  const tokens = isRecord(data.tokens)
    ? data.tokens
    : isRecord(direct?.tokens)
      ? direct.tokens
      : undefined;
  const input = finiteNumber(direct?.inputTokens) ?? finiteNumber(tokens?.input);
  const output = finiteNumber(direct?.outputTokens) ?? finiteNumber(tokens?.output);
  const cost = finiteNumber(direct?.cost) ?? finiteNumber(data.cost);
  if (input === undefined || output === undefined) return undefined;
  return {
    usage: { inputTokens: input, outputTokens: output, ...(cost === undefined ? {} : { cost }) }
  };
}

function classifyFailure(event: ShuvcodeEvent): ReviewErrorCategory {
  if (event.type === "session.execution.interrupted") return "cancellation";
  const error = isRecord(event.data?.error) ? event.data.error : undefined;
  const data = isRecord(error?.data) ? error.data : undefined;
  const status = finiteNumber(error?.status) ?? finiteNumber(data?.statusCode);
  const signature = [error?.type, error?.name, error?.message, data?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  // A model the runtime cannot route is a configuration fault, not a transient
  // provider outage and not an invalid structured response. It must stay
  // non-retryable so the operator is pointed at the configured model. A
  // transport status still wins, because a 5xx or timeout carrying similar
  // wording is an outage that should stay retryable.
  const transient = status !== undefined && (status === 408 || status >= 500);
  if (
    !transient &&
    /no.?route|model unavailable|unknown model|model not found|no such model|provider not found/.test(
      signature
    )
  ) {
    return "config";
  }
  if (event.type === "session.structured.failed") return "schema";
  if (
    status === 401 ||
    status === 403 ||
    /auth|credential|unauthori[sz]ed|forbidden/.test(signature)
  )
    return "auth";
  if (status === 429 || /rate.?limit|quota|too many requests/.test(signature)) return "rateLimit";
  if (/context|output.?length|token.?limit|too long/.test(signature)) return "context";
  if (/schema|structured.?output|invalid.?json|validation/.test(signature)) return "schema";
  if (/policy|permission|content.?filter|safety|denied|blocked/.test(signature)) return "policy";
  if (/abort|cancel|interrupt|shutdown|superseded/.test(signature)) return "cancellation";
  if (status !== undefined && (status === 408 || status >= 500)) return "service";
  if (/unavailable|overload|timeout|timed out|connection|network/.test(signature)) return "service";
  return "provider";
}

function safeClientError(error: unknown): ShuvcodeSessionError {
  return new ShuvcodeSessionError(
    classifyFailure({
      type: "session.error",
      data: { error: isRecord(error) ? error : undefined }
    })
  );
}

function isFailureType(type: string): boolean {
  return (
    type === "session.structured.failed" ||
    type === "session.execution.failed" ||
    type === "session.error"
  );
}

function sanitizeFailureStatus(value: unknown): { readonly status?: number } {
  const error = isRecord(value) ? value : undefined;
  const data = isRecord(error?.data) ? error.data : undefined;
  const status = finiteNumber(error?.status) ?? finiteNumber(data?.statusCode);
  return status === undefined ? {} : { status };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeFailureMessage(category: ReviewErrorCategory): string {
  return {
    provider: "Provider request failed",
    rateLimit: "Provider rate limit reached",
    service: "Provider service unavailable",
    auth: "Provider authentication failed",
    context: "Model context limit exceeded",
    schema: "Structured response was invalid",
    policy: "Runtime policy denied the operation",
    cancellation: "Review session was cancelled",
    config: "Configured review model is not routable by the runtime"
  }[category];
}

function ensureOpen(closePromise: Promise<void> | undefined): void {
  if (closePromise !== undefined) throw new Error("Shuvcode runtime is closed");
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

const RUNTIME_ENV_ALLOWLIST = new Set([
  "CI",
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "USER",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT"
]);

function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        RUNTIME_ENV_ALLOWLIST.has(entry[0]) && entry[1] !== undefined
    )
  );
}

async function exitsWithin(exited: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(
        () => true,
        () => true
      ),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), graceMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
