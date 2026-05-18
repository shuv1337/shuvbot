import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "packages/action/src/entry.ts"
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  bundle: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  outExtension: () => ({ js: ".js" })
});
