import { createHash } from "node:crypto";

export type CanonicalReviewBase =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "commit"; readonly sha: string };

export function createLocalChangeIdentity(input: {
  readonly repositoryIdentity: string;
  readonly base: CanonicalReviewBase;
}): string {
  const repository = requireCanonicalValue(input.repositoryIdentity, "repositoryIdentity");
  const base =
    input.base.kind === "branch"
      ? `branch:${requireCanonicalValue(input.base.name, "base.name")}`
      : `commit:${canonicalSha(input.base.sha)}`;
  const digest = createHash("sha256").update([repository, base].join("\0"), "utf8").digest("hex");
  return `local-change:v1:${digest}`;
}

function requireCanonicalValue(value: string, field: string): string {
  const canonical = value.normalize("NFKC").trim();
  if (canonical.length === 0 || canonical.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty canonical value`);
  }
  return canonical;
}

function canonicalSha(value: string): string {
  const sha = requireCanonicalValue(value, "base.sha").toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new TypeError("base.sha must be a full commit SHA");
  return sha;
}
