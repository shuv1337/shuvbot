#!/usr/bin/env bun
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfigFile, normalizeConfig, type ShuvbotConfig } from "../../core/src/config.ts";
import { ConfigError } from "../../core/src/errors.ts";
import { runDoctor } from "./doctor.ts";
import { runClaudeSetupToken } from "./auth/claude-setup-token.ts";
import { runClaudeImport } from "./auth/claude-import.ts";
import { runLocalReview } from "./local-review.ts";
import { runReplay } from "./replay.ts";

const [, , ...args] = process.argv;

interface ReviewCommandDependencies {
  configExists(path: string): Promise<boolean>;
  loadConfig(path: string): Promise<ShuvbotConfig>;
  review: typeof runLocalReview;
}

interface ReviewCommandOptions {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  dependencies?: Partial<ReviewCommandDependencies>;
}

interface ParsedReviewOptions {
  /** Left unset when not supplied, so the detected VCS decides the default. */
  base?: string;
  head?: string;
  configPath?: string;
  engine?: "legacy" | "coordinator";
  json: boolean;
}

interface DoctorCommandOptions {
  stdout: Pick<NodeJS.WriteStream, "write">;
  doctor?: typeof runDoctor;
}

async function run(): Promise<void> {
  const command = args[0];
  const subcommand = args[1];

  if (command === "config" && subcommand === "validate") {
    const path = args[2] ?? "shuvbot.toml";
    await loadConfigFile(path);
    console.log(`Config valid: ${path}`);
    return;
  }

  if (command === "init") return stub("shuvbot init");
  if (command === "review") {
    const result = await runReviewCommand(args.slice(1), {
      cwd: process.cwd(),
      stdout: process.stdout
    });
    if ("engine" in result && ["failed", "timed_out", "cancelled"].includes(result.status)) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "run") return stub("shuvbot run");
  if (command === "doctor") {
    process.exitCode = await runDoctorCommand({ stdout: process.stdout });
    return;
  }
  if (command === "replay") {
    const fixture = optionValue(args, "--fixture") ?? args[1];
    if (!fixture) throw new ConfigError("shuvbot replay requires --fixture <path>.");
    await runReplay({ fixture, dryRun: args.includes("--dry-run"), stdout: process.stdout });
    return;
  }
  if (command === "auth" && subcommand === "claude" && args[2] === "setup-token") {
    runClaudeSetupToken({ ...parseRepoSecretArgs(args.slice(3)), stdout: process.stdout });
    return;
  }
  if (command === "auth" && subcommand === "claude" && args[2] === "import") {
    await runClaudeImport({
      ...parseRepoSecretArgs(args.slice(3)),
      stdin: process.stdin,
      stdout: process.stdout
    });
    return;
  }

  printHelp();
  process.exitCode = command === undefined ? 0 : 1;
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<0 | 1> {
  const checks = await (options.doctor ?? runDoctor)({ stdout: options.stdout });
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export async function runReviewCommand(
  values: string[],
  options: ReviewCommandOptions
): Promise<Awaited<ReturnType<typeof runLocalReview>>> {
  const parsed = parseReviewOptions(values);
  const dependencies: ReviewCommandDependencies = {
    configExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (isMissingFileError(error)) return false;
        throw new ConfigError(`Unable to check for review config at ${JSON.stringify(path)}.`, {
          cause: error
        });
      }
    },
    loadConfig: loadConfigFile,
    review: runLocalReview,
    ...options.dependencies
  };
  const explicitConfigPath = parsed.configPath;
  const configPath = resolve(options.cwd, explicitConfigPath ?? "shuvbot.toml");
  const shouldLoad =
    explicitConfigPath !== undefined || (await dependencies.configExists(configPath));
  let config = normalizeConfig({});
  if (shouldLoad) {
    try {
      config = await dependencies.loadConfig(configPath);
    } catch (error) {
      const detail = configLoadErrorDetail(error);
      throw new ConfigError(
        `Unable to load review config at ${JSON.stringify(configPath)}. ${detail}`,
        { cause: error }
      );
    }
  }
  return dependencies.review({
    cwd: options.cwd,
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
    ...(parsed.head === undefined ? {} : { head: parsed.head }),
    config,
    ...(parsed.engine === undefined ? {} : { engine: parsed.engine }),
    json: parsed.json,
    stdout: options.stdout
  });
}

export function parseReviewOptions(values: string[]): ParsedReviewOptions {
  const parsed: ParsedReviewOptions = { json: false };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--json") {
      rejectDuplicateOption(seen, option);
      parsed.json = true;
      continue;
    }
    if (
      option !== "--base" &&
      option !== "--head" &&
      option !== "--config" &&
      option !== "--engine"
    ) {
      throw new ConfigError(`Unknown review option: ${JSON.stringify(option)}.`);
    }
    rejectDuplicateOption(seen, option);
    const value = values[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new ConfigError(`${option} requires a value.`);
    }
    index += 1;
    if (option === "--base") parsed.base = value;
    if (option === "--head") parsed.head = value;
    if (option === "--config") parsed.configPath = value;
    if (option === "--engine") {
      if (value !== "legacy" && value !== "coordinator") {
        throw new ConfigError("--engine must be legacy or coordinator.");
      }
      parsed.engine = value;
    }
  }
  return parsed;
}

function rejectDuplicateOption(seen: Set<string>, option: string): void {
  if (seen.has(option)) throw new ConfigError(`${option} may only be specified once.`);
  seen.add(option);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function configLoadErrorDetail(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (isMissingFileError(error)) return "The file does not exist.";
  if (error instanceof Error && "code" in error && error.code === "EACCES") {
    return "Permission denied.";
  }
  return "Check that the file is readable and valid TOML.";
}

function stub(name: string): void {
  console.log(`${name}: not implemented yet`);
}

function printHelp(): void {
  console.log(`shuvbot - GitHub-native code review and coding agent

Usage: shuvbot <command> [options]

Review:
  review [--base <rev>] [--head <rev>] [--config <path>]
         [--engine coordinator|legacy] [--json]
         Review a range. Defaults to main...HEAD under Git, and the trunk
         fork point through the working-copy commit @ under Jujutsu.

Setup:
  doctor                    Check prerequisites, auth, runtime, and models
  auth claude setup-token   Mint a Claude Code OAuth token
  auth claude import        Import a token from stdin
  config validate [path]    Validate a shuvbot config file

Development:
  replay --fixture <path> [--dry-run]   Replay a recorded GitHub event

Not implemented yet:
  init, run
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

if (import.meta.main) {
  run().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}
