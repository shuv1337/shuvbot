import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { extractDashboardArtifactFiles } from "../src/zip.ts";

describe("dashboard artifact ZIP", () => {
  test("extracts only required top-level files", () => {
    const bytes = zip([
      ["shuvbot-run.json", '{"runId":"run-1"}'],
      ["shuvbot-findings.json", '{"version":1,"findings":[]}'],
      ["shuvbot-review-sessions.json", "[]"],
      ["coordinator/shuvbot-run.json", '{"runId":"wrong"}']
    ]);
    expect(extractDashboardArtifactFiles(bytes)).toEqual({
      run: { runId: "run-1" },
      findings: { version: 1, findings: [] },
      sessions: []
    });
  });

  test("rejects traversal entries and duplicate top-level files", () => {
    expect(() =>
      extractDashboardArtifactFiles(
        zip([
          ["../shuvbot-run.json", "{}"],
          ["shuvbot-findings.json", "[]"]
        ])
      )
    ).toThrow("unsafe path");
    expect(() =>
      extractDashboardArtifactFiles(
        zip([
          ["shuvbot-run.json", "{}"],
          ["shuvbot-run.json", "{}"],
          ["shuvbot-findings.json", "[]"]
        ])
      )
    ).toThrow("duplicate shuvbot-run.json");
  });

  test("rejects mismatched local and central entry names", () => {
    const bytes = zip([
      ["shuvbot-run.json", "{}"],
      ["shuvbot-findings.json", "[]"]
    ]);
    bytes[30] = "x".charCodeAt(0);
    expect(() => extractDashboardArtifactFiles(bytes)).toThrow("entry names do not match");
  });

  test("bounds the total extracted content", () => {
    const largeJson = JSON.stringify("x".repeat(6 * 1024 * 1024));
    expect(() =>
      extractDashboardArtifactFiles(
        zip([
          ["shuvbot-run.json", largeJson],
          ["shuvbot-findings.json", largeJson],
          ["shuvbot-review-sessions.json", largeJson]
        ])
      )
    ).toThrow("total limit");
  });
});

function zip(entries: Array<[string, string]>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name);
    const source = Buffer.from(contents);
    const compressed = deflateRawSync(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
