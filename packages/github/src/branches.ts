import { createHash } from "node:crypto";

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

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "task";
}
