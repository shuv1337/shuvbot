import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ContextSection {
  id: string;
  title: string;
  content: string;
  untrusted: boolean;
}

export interface ContextManifestEntry {
  id: string;
  title: string;
  bytes: number;
  untrusted: boolean;
}

export interface ContextManifest {
  sections: ContextManifestEntry[];
  totalBytes: number;
}

export function buildContextManifest(sections: readonly ContextSection[]): ContextManifest {
  const entries = sections.map((section) => ({
    id: section.id,
    title: section.title,
    bytes: Buffer.byteLength(section.content, "utf8"),
    untrusted: section.untrusted
  }));
  return {
    sections: entries,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0)
  };
}

export async function writeContextManifest(dir: string, manifest: ContextManifest): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "reviewbot-context-manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
