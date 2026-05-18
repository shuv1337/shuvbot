#!/usr/bin/env bun
import { loadConfigFile } from "../../core/src/config.ts";
import { ConfigError } from "../../core/src/errors.ts";

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
  if (command === "review") return stub("reviewbot review");
  if (command === "run") return stub("reviewbot run");
  if (command === "doctor") return stub("reviewbot doctor");
  if (command === "replay") return stub("reviewbot replay");
  if (command === "auth" && subcommand === "claude" && args[2] === "setup-token") {
    return stub("reviewbot auth claude setup-token");
  }
  if (command === "auth" && subcommand === "claude" && args[2] === "import") {
    return stub("reviewbot auth claude import");
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

run().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
