#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const commands = [
  ["bun", ["install"]],
  ["bun", ["run", "typecheck"]],
  ["bun", ["run", "lint"]],
  ["bun", ["test"]],
  ["bun", ["run", "build"]],
  ["bun", ["run", "evals"]]
] as const;

for (const [cmd, args] of commands) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`
Release checklist:
- Verify action.yml uses runs.main: dist/index.js.
- Commit regenerated dist/index.js and dist/index.js.map.
- Tag v0.1.0 at the release commit.
- Move v0 to the same commit after smoke validation.
- Keep v1 reserved for the future stable contract.
- Optional: run bun audit and attach output as SBOM/security notes.
`);
