#!/usr/bin/env bun
import { loadConfigFile } from "../../core/src/config.ts";
import { ConfigError } from "../../core/src/errors.ts";
import { runDoctor } from "./doctor.ts";
import { runClaudeSetupToken } from "./auth/claude-setup-token.ts";
import { runClaudeImport } from "./auth/claude-import.ts";
import { runLocalReview } from "./local-review.ts";
import { runReplay } from "./replay.ts";

const [, , ...args] = process.argv;

async function run(): Promise<void> {
  const command = args[0];
  const subcommand = args[1];

  if (command === "config" && subcommand === "validate") {
    const path = args[2] ?? "reviewbot.toml";
    await loadConfigFile(path);
    console.log(`Config valid: ${path}`);
    return;
  }

  if (command === "init") return stub("reviewbot init");
  if (command === "review") {
    await runLocalReview({
      cwd: process.cwd(),
      base: optionValue(args, "--base") ?? "main",
      head: optionValue(args, "--head") ?? "HEAD",
      stdout: process.stdout
    });
    return;
  }
  if (command === "run") return stub("reviewbot run");
  if (command === "doctor") {
    await runDoctor({ stdout: process.stdout });
    return;
  }
  if (command === "replay") {
    const fixture = optionValue(args, "--fixture") ?? args[1];
    if (!fixture) throw new ConfigError("reviewbot replay requires --fixture <path>.");
    await runReplay({ fixture, dryRun: args.includes("--dry-run"), stdout: process.stdout });
    return;
  }
  if (command === "auth" && subcommand === "claude" && args[2] === "setup-token") {
    runClaudeSetupToken({ ...parseRepoSecretArgs(args.slice(3)), stdout: process.stdout });
    return;
  }
  if (command === "auth" && subcommand === "claude" && args[2] === "import") {
    await runClaudeImport({ ...parseRepoSecretArgs(args.slice(3)), stdin: process.stdin, stdout: process.stdout });
    return;
  }

  printHelp();
  process.exitCode = command === undefined ? 0 : 1;
}

function stub(name: string): void {
  console.log(`${name}: not implemented yet`);
}

function printHelp(): void {
  console.log(`reviewbot

Commands:
  init
  review
  run
  auth claude setup-token
  auth claude import
  doctor
  replay
  config validate [path]
`);
}

function parseRepoSecretArgs(values: string[]): { repo?: string; secret?: string } {
  const result: { repo?: string; secret?: string } = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--repo") {
      const repo = values[index + 1];
      if (repo) result.repo = repo;
      index += 1;
    } else if (value === "--secret") {
      const secret = values[index + 1];
      if (secret) result.secret = secret;
      index += 1;
    }
  }
  return result;
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

run().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
