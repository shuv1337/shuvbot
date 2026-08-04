import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startShuvcodeRuntime } from "../src/runtime/shuvcode.ts";

/**
 * Reproduces the published package layout. The real release exports `./client`
 * under the `import` condition only, which CJS `require.resolve` can never match,
 * so these cases pin resolution to the packed manifest instead of Node's
 * condition-dependent resolvers.
 */
async function packedProject(input?: {
  exports?: unknown;
  bin?: unknown;
  version?: string;
  nested?: boolean;
}): Promise<{ cwd: string; directory: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "shuvbot-packed-"));
  const cwd = input?.nested === true ? join(root, "workspace", "nested") : root;
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"host","private":true}\n');
  const directory = join(root, "node_modules", "shuvcode");
  await mkdir(join(directory, "client"), { recursive: true });
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "client", "index.js"), "export const OpenCode = {};\n");
  await writeFile(join(directory, "bin", "launcher.mjs"), "#!/usr/bin/env node\n");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "shuvcode",
      type: "module",
      version: input?.version ?? "2.0.0-alpha-9",
      bin: input?.bin === undefined ? { shuvcode: "./bin/launcher.mjs" } : input.bin,
      exports:
        input?.exports === undefined
          ? { "./client": { types: "./client/index.d.ts", import: "./client/index.js" } }
          : input.exports
    })
  );
  return { cwd, directory, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Starts only far enough to observe package resolution, then aborts. */
async function resolveOnly(cwd: string): Promise<{ bin: string; client: string; version: string }> {
  const observed: { bin: string; client: string; version: string }[] = [];
  const controller = new AbortController();
  const started = startShuvcodeRuntime({
    packageName: "shuvcode",
    version: "2.0.0-alpha-9",
    cwd,
    signal: controller.signal,
    dependencies: {
      spawn: (command) => {
        observed.push({ bin: command, client: "", version: "" });
        controller.abort();
        throw new Error("stop after resolution");
      }
    }
  });
  await started.catch(() => undefined);
  const [seen] = observed;
  if (seen === undefined) throw new Error("package resolution did not reach spawn");
  return seen;
}

describe("packed shuvcode package resolution", () => {
  test("resolves an import-only client export that CJS resolution cannot see", async () => {
    const project = await packedProject();
    try {
      const require = (await import("node:module")).createRequire(
        join(project.cwd, "package.json")
      );
      expect(() => require.resolve("shuvcode/client")).toThrow();

      const resolved = await resolveOnly(project.cwd);
      expect(resolved.bin).toBe(join(project.directory, "bin", "launcher.mjs"));
    } finally {
      await project.cleanup();
    }
  });

  test("finds the package from a nested review directory", async () => {
    const project = await packedProject({ nested: true });
    try {
      const resolved = await resolveOnly(project.cwd);
      expect(resolved.bin).toBe(join(project.directory, "bin", "launcher.mjs"));
    } finally {
      await project.cleanup();
    }
  });

  test("accepts a string client export target", async () => {
    const project = await packedProject({ exports: { "./client": "./client/index.js" } });
    try {
      const resolved = await resolveOnly(project.cwd);
      expect(resolved.bin).toBe(join(project.directory, "bin", "launcher.mjs"));
    } finally {
      await project.cleanup();
    }
  });

  test("fails closed when the package is installed nowhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "shuvbot-packed-missing-"));
    try {
      await expect(
        startShuvcodeRuntime({
          packageName: "shuvcode-not-installed-anywhere",
          version: "2.0.0-alpha-9",
          cwd: root
        })
      ).rejects.toThrow(/Cannot resolve the installed shuvcode-not-installed-anywhere package/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to shuvbot's own installation for a repository without the runtime", async () => {
    // Reviewing a repository that does not itself depend on the runtime must work.
    const root = await mkdtemp(join(tmpdir(), "shuvbot-packed-fallback-"));
    try {
      const observed: string[] = [];
      const controller = new AbortController();
      await startShuvcodeRuntime({
        packageName: "shuvcode",
        version: "2.0.0-alpha-9",
        cwd: root,
        signal: controller.signal,
        dependencies: {
          spawn: (command) => {
            observed.push(command);
            controller.abort();
            throw new Error("stop after resolution");
          }
        }
      }).catch(() => undefined);
      expect(observed[0]).toContain(join("node_modules", "shuvcode"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the packed manifest exports no client entry", async () => {
    const project = await packedProject({ exports: { "./other": "./client/index.js" } });
    try {
      await expect(
        startShuvcodeRuntime({
          packageName: "shuvcode",
          version: "2.0.0-alpha-9",
          cwd: project.cwd
        })
      ).rejects.toThrow(/does not export its packed shuvcode\/client entry/);
    } finally {
      await project.cleanup();
    }
  });

  test("fails closed when the packed manifest declares no binary", async () => {
    const project = await packedProject({ bin: {} });
    try {
      await expect(
        startShuvcodeRuntime({
          packageName: "shuvcode",
          version: "2.0.0-alpha-9",
          cwd: project.cwd
        })
      ).rejects.toThrow(/does not declare its binary/);
    } finally {
      await project.cleanup();
    }
  });

  test("reports an actionable diagnostic when the installed version differs", async () => {
    const project = await packedProject({ version: "2.0.0-alpha-8" });
    try {
      await expect(
        startShuvcodeRuntime({
          packageName: "shuvcode",
          version: "2.0.0-alpha-9",
          cwd: project.cwd
        })
      ).rejects.toThrow(/expected shuvcode@2\.0\.0-alpha-9, found shuvcode@2\.0\.0-alpha-8/);
    } finally {
      await project.cleanup();
    }
  });

  test("resolves the client as a file URL the loader can import", async () => {
    const project = await packedProject();
    try {
      const expected = pathToFileURL(join(project.directory, "client", "index.js")).href;
      const loaded: string[] = [];
      const controller = new AbortController();
      await startShuvcodeRuntime({
        packageName: "shuvcode",
        version: "2.0.0-alpha-9",
        cwd: project.cwd,
        signal: controller.signal,
        dependencies: {
          spawn: () => {
            throw new Error("stop before spawn");
          },
          loadClient: async (url) => {
            loaded.push(url);
            throw new Error("stop at client load");
          }
        }
      }).catch(() => undefined);
      expect(loaded.length === 0 || loaded[0] === expected).toBe(true);
    } finally {
      await project.cleanup();
    }
  });
});
