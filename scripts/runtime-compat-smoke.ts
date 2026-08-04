#!/usr/bin/env bun
/**
 * Packed-runtime compatibility smoke (M3 exit criteria).
 *
 * Installs the exact configured shuvcode release from npm into a throwaway
 * project and drives it through shuvbot's isolated runtime adapter: start the
 * pinned process, create the coordinator session and policy-scoped specialist
 * sessions, observe events, reject a widened policy, interrupt, and shut down
 * without leaking the child process.
 *
 * This is deliberately excluded from `bun test`: it downloads a large platform
 * binary from the public registry. Run it explicitly with
 * `bun run smoke:runtime` after moving the approved runtime pin.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVED_SHUVCODE_RUNTIME_VERSION,
  PINNED_SHUVCODE_PACKAGE,
  DEFAULT_CONFIG
} from "../packages/core/src/config.ts";
import {
  REVIEW_SESSION_POLICY,
  startShuvcodeRuntime,
  type ShuvcodeSessionPolicy
} from "../packages/review/src/runtime/shuvcode.ts";

const requested = process.argv.find((argument) => argument.startsWith("--version="));
const version =
  requested?.slice("--version=".length) ??
  APPROVED_SHUVCODE_RUNTIME_VERSION ??
  DEFAULT_CONFIG.review.shuvcode.version;
const packageName = PINNED_SHUVCODE_PACKAGE;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

function policyOf(session: { readonly policy?: ShuvcodeSessionPolicy }): string {
  return JSON.stringify(session.policy ?? null);
}

const root = await mkdtemp(join(tmpdir(), "reviewbot-runtime-smoke-"));
let exitCode = 0;
try {
  await writeFile(
    join(root, "package.json"),
    '{"name":"reviewbot-runtime-smoke","private":true}\n'
  );
  console.log(`Installing ${packageName}@${version} into ${root}`);
  const install = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel", "error", `${packageName}@${version}`],
    { cwd: root, stdio: "inherit" }
  );
  if (install.status !== 0) throw new Error(`npm install exited with ${install.status}`);

  const events: string[] = [];
  const runtime = await startShuvcodeRuntime({
    packageName,
    version,
    cwd: root,
    startupTimeoutMs: 60_000
  });
  record("isolated runtime starts from the pinned package", true, runtime.url);
  const unsubscribe = runtime.subscribe((event) => events.push(event.type));

  try {
    const coordinator = await runtime.createSession({
      title: "reviewbot coordinator",
      location: { directory: root }
    });
    record(
      "coordinator session receives the code-owned read policy",
      policyOf(coordinator) === JSON.stringify(REVIEW_SESSION_POLICY),
      policyOf(coordinator)
    );

    const reader = await runtime.createSession({
      title: "reviewbot specialist read",
      location: { directory: root },
      policy: REVIEW_SESSION_POLICY
    });
    record(
      "specialist session is created without forking the unprompted coordinator",
      reader.id !== coordinator.id && policyOf(reader) === JSON.stringify(REVIEW_SESSION_POLICY),
      reader.id
    );

    const restricted = await runtime.createSession({
      title: "reviewbot specialist no tools",
      location: { directory: root },
      policy: { tools: { allow: [] } }
    });
    record(
      "server enforces a narrowed specialist policy",
      policyOf(restricted) === JSON.stringify({ tools: { allow: [] } }),
      policyOf(restricted)
    );

    let widened = false;
    try {
      await runtime.createSession({
        title: "reviewbot widened",
        location: { directory: root },
        policy: { tools: { allow: [...REVIEW_SESSION_POLICY.tools.allow, "bash"] } }
      });
      widened = true;
    } catch (error) {
      record("widening the review policy is rejected", true, (error as Error).message);
    }
    if (widened) record("widening the review policy is rejected", false, "session was created");

    await runtime.interrupt(coordinator.id);
    record("an active session can be interrupted", true);
    record("runtime events are observed", events.length > 0, events.slice(0, 6).join(","));
  } finally {
    unsubscribe();
    await runtime.close();
  }
  record("runtime shuts down", true);

  const leaked = spawnSync("pgrep", ["-f", `${root}.*serve --stdio`], { encoding: "utf8" });
  record("no runtime process is leaked", leaked.status !== 0, leaked.stdout.trim());
} catch (error) {
  record("packed runtime compatibility", false, (error as Error).message);
} finally {
  await rm(root, { recursive: true, force: true });
}

const failed = checks.filter(({ ok }) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map(({ name }) => name).join(", ")}`);
  exitCode = 1;
}
process.exit(exitCode);
