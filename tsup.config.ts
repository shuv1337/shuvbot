import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "packages/action/src/entry.ts"
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  bundle: true,
  // GitHub checks out a JS action's repo as-is and runs dist/index.js with no
  // `npm install`, so the bundle must be fully self-contained. By default tsup
  // marks everything in `dependencies` as external, which leaves bare imports
  // like `@actions/core` unresolved at runtime (ERR_MODULE_NOT_FOUND). Force
  // every non-builtin dependency to be inlined; Node built-ins stay external.
  noExternal: [/.*/],
  // esbuild emits an ESM bundle, but several inlined deps are CommonJS and call
  // `require(...)` for Node built-ins (e.g. @actions/core does `require("os")`).
  // In an ESM output there is no `require`, so esbuild's shim throws
  // "Dynamic require of X is not supported". Inject a real `require` backed by
  // createRequire so those built-in requires resolve at runtime.
  banner: {
    js: "import { createRequire as __shuvbotCreateRequire } from 'node:module'; const require = __shuvbotCreateRequire(import.meta.url);"
  },
  sourcemap: true,
  clean: true,
  outDir: "dist",
  outExtension: () => ({ js: ".js" })
});
