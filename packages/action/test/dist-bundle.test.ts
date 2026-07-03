import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

// GitHub checks out a JS action's repo *as-is* and runs `dist/index.js` with no
// `npm install`, so the committed bundle must be fully self-contained: every
// runtime dependency (including @actions/core) has to be inlined. The first
// production smoke run (2026-07-03, shuv1337/ltc-docs) crashed at startup with
// `ERR_MODULE_NOT_FOUND: Cannot find package '@actions/core'` because tsup left
// `dependencies` external by default. These tests make that regression class
// impossible to reintroduce silently.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_INDEX = join(REPO_ROOT, "dist", "index.js");

// Node built-in modules that a self-contained bundle is allowed to import at
// runtime. Anything else appearing as a live `import ... from "x"` means a
// third-party dependency was left unbundled.
const NODE_BUILTIN = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

function isBuiltin(spec: string): boolean {
  const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
  const top = bare.split("/", 1)[0] ?? bare;
  return NODE_BUILTIN.has(top);
}

describe("dist/index.js self-contained bundle", () => {
  test("has no live imports from non-builtin packages", () => {
    const source = readFileSync(DIST_INDEX, "utf8");
    // Match top-level ESM `import ... from "spec"` and `export ... from "spec"`
    // statements - the shape an unbundled dependency takes in esbuild's output.
    const specifiers = [
      ...source.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/gm)
    ]
      .map((m) => m[1])
      .filter((spec): spec is string => spec !== undefined);
    const external = specifiers.filter((spec) => !isBuiltin(spec));
    expect(external).toEqual([]);
  });

  test("loads in a bare checkout (no node_modules) without a module-resolution crash", () => {
    // Faithfully simulate GitHub's action checkout: the repo's package.json is
    // present (so `type: module` makes this ESM), but node_modules is absent.
    const scratch = mkdtempSync(join(tmpdir(), "reviewbot-dist-bundle-"));
    try {
      cpSync(DIST_INDEX, join(scratch, "index.js"));
      writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));

      // Strip GitHub Actions env so main() takes its own controlled
      // missing-input/event failure path rather than doing real work.
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("GITHUB_") || key.startsWith("RUNNER_") || key.startsWith("INPUT_")) {
          delete env[key];
        }
      }

      const result = spawnSync("node", [join(scratch, "index.js")], {
        encoding: "utf8",
        env,
        timeout: 60_000
      });

      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      // The exact production failure: a bare import that cannot resolve.
      expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
      // esbuild's CJS-in-ESM shim throwing means a bundled CommonJS dep called
      // `require()` and we forgot the createRequire banner.
      expect(output).not.toContain("Dynamic require of");
      expect(output).not.toContain("Cannot use import statement outside a module");

      // Positive proof the bundle actually executed the action's own inlined
      // logic (loaded @actions/core, resolved review mode) before failing on
      // the deliberately-missing GitHub environment.
      expect(output).toMatch(/"mode":\s*"review"/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("is not stale relative to source", () => {
    // Rebuild into a throwaway dir (never touching the committed dist/) and
    // byte-compare. tsup output is deterministic, so any drift means someone
    // changed source without running `bun run build`.
    const scratch = mkdtempSync(join(tmpdir(), "reviewbot-dist-stale-"));
    try {
      const build = spawnSync("bunx", ["tsup", "--out-dir", scratch], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 180_000
      });
      expect(build.status).toBe(0);

      const rebuilt = readFileSync(join(scratch, "index.js"));
      const committed = readFileSync(DIST_INDEX);
      expect(rebuilt.equals(committed)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
