import type { DiffFilterReason } from "./types.ts";

export interface ChangedFileForFiltering {
  path: string;
  patch?: string;
  content?: string;
}

export interface DiffFilterDecision<T extends ChangedFileForFiltering = ChangedFileForFiltering> {
  file: T;
  accepted: boolean;
  reason?: DiffFilterReason;
}

export interface DiffFilterPartition<T extends ChangedFileForFiltering = ChangedFileForFiltering> {
  accepted: T[];
  filtered: Array<{ file: T; reason: DiffFilterReason }>;
}

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
  "package-lock.json",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock"
]);

const MANIFEST_NAMES = new Set([
  "cargo.toml",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "flake.nix",
  "gemfile",
  "go.mod",
  "go.work",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "mix.exs",
  "package.json",
  "packages.config",
  "pipfile",
  "pom.xml",
  "pubspec.yaml",
  "pyproject.toml",
  "requirements.txt"
]);

const GENERATED_MARKERS = [
  /\bcode generated\b.*\bdo not edit\b/i,
  /\b(?:auto|automatically)[ -]generated\b.*\bdo not edit\b/i,
  /\bgenerated (?:file|source)\b.*\bdo not edit\b/i,
  /\bthis (?:file|code) (?:is|was) generated\b.*\bdo not edit\b/i,
  /^[ +]?\s*(?:\/[/*]|#|<!--|\*)?\s*@generated\b/im
];

/** Classifies a changed file without consulting mutable repository state. */
export function classifyDiffFile<T extends ChangedFileForFiltering>(
  file: T
): DiffFilterDecision<T> {
  const path = normalizeForMatching(file.path);
  const name = path.slice(path.lastIndexOf("/") + 1);

  // These files can alter runtime, deployment, or public contracts even when generated.
  if (mustReview(path, name)) return { file, accepted: true };

  if (LOCKFILE_NAMES.has(name)) return rejected(file, "lockfile");
  if (/(^|\/)(?:node_modules|bower_components|vendor|vendors|third[_-]party)(\/|$)/.test(path)) {
    return rejected(file, "vendored_dependency");
  }
  if (/\.(?:css|js|mjs|cjs)\.map$/.test(path)) {
    return rejected(file, "source_map");
  }
  if (isBundledAsset(path)) return rejected(file, "minified_or_bundled_asset");

  const markerText = `${file.content ?? ""}\n${file.patch ?? ""}`.slice(0, 64 * 1024);
  if (GENERATED_MARKERS.some((marker) => marker.test(markerText))) {
    return rejected(file, "generated_file");
  }

  return { file, accepted: true };
}

export function filterDiffFiles<T extends ChangedFileForFiltering>(
  files: readonly T[]
): DiffFilterPartition<T> {
  const result: DiffFilterPartition<T> = { accepted: [], filtered: [] };
  for (const file of files) {
    const decision = classifyDiffFile(file);
    if (decision.accepted) {
      result.accepted.push(file);
    } else {
      result.filtered.push({ file, reason: decision.reason as DiffFilterReason });
    }
  }
  return result;
}

function rejected<T extends ChangedFileForFiltering>(
  file: T,
  reason: DiffFilterReason
): DiffFilterDecision<T> {
  return { file, accepted: false, reason };
}

function normalizeForMatching(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function mustReview(path: string, name: string): boolean {
  if (/(^|\/)(?:migrations?|db\/changelog)(\/|$)/.test(path)) return true;
  if (MANIFEST_NAMES.has(name)) return true;

  if (
    /(^|\/)(?:\.github\/workflows|\.github\/actions|\.changeset|deploy|deployment|helm|release)(\/|$)/.test(
      path
    ) ||
    /(^|\/)(?:dockerfile|compose\.ya?ml|\.gitlab-ci\.ya?ml)$/.test(path) ||
    /(?:^|\/)(?:release-please-config\.json|\.releaserc(?:\.[^.]+)?|semantic-release\.config\.[^.]+)$/.test(
      path
    )
  ) {
    return true;
  }

  return (
    /(^|\/)(?:api|apis|schema|schemas|proto|generated-api|generated-schema)(\/|$)/.test(path) ||
    /(^|\/)generated\/(?:[^/]+\/)*(?:api|client|schema)[^/]*\.[^/]+$/.test(path) ||
    /(?:^|[._-])(?:openapi|swagger|graphql|schema)(?:[._-]|$)/.test(name) ||
    /\.(?:proto|avsc)$/.test(name)
  );
}

function isBundledAsset(path: string): boolean {
  return (
    /(?:\.min|\.bundle)+(?:\.[a-f0-9]{8,})?\.(?:css|js|mjs|cjs)$/.test(path) ||
    /(?:^|\/)(?:assets|static)\/[^/]+\.[a-f0-9]{8,}\.(?:css|js|mjs)$/.test(path) ||
    /(?:^|[.-])chunk(?:\.[a-f0-9]{8,})?\.(?:css|js|mjs)$/.test(path)
  );
}
