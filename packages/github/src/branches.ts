import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function deriveReviewbotBranch(input: {
  mode: string;
  runId: string;
  requestedBy: string;
  task: string;
}): string {
  const slug = slugify(`${input.mode}-${input.requestedBy}-${input.task}`);
  const digest = createHash("sha256").update(input.runId).digest("hex").slice(0, 8);
  return `reviewbot/${slug.slice(0, 48)}-${digest}`;
}

export function assertReviewbotBranchName(branch: string): void {
  if (!branch.startsWith("reviewbot/") || branch.length <= "reviewbot/".length || branch.includes("..")) {
    throw new Error("branch must be under reviewbot/");
  }
}

export async function createOrFastForwardReviewbotBranch(input: {
  cwd: string;
  branch: string;
  startPoint: string;
  exec?: (file: string, args: string[], options: { cwd: string }) => Promise<unknown>;
}): Promise<{ branch: string; startPoint: string }> {
  assertReviewbotBranchName(input.branch);
  const run = input.exec ?? ((file, args, options) => execFileAsync(file, args, options));
  await run("git", ["fetch", "--no-tags", "origin", input.startPoint], { cwd: input.cwd });
  await run("git", ["checkout", "-B", input.branch, "FETCH_HEAD"], { cwd: input.cwd });
  return { branch: input.branch, startPoint: input.startPoint };
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "task";
}
