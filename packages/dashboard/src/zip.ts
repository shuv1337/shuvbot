import { inflateRawSync } from "node:zlib";
import { DASHBOARD_MAX_FILE_BYTES } from "./artifact-schema.ts";
import type { JsonValue } from "./json.ts";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 1_000;
const TARGETS = new Set([
  "shuvbot-run.json",
  "shuvbot-findings.json",
  "shuvbot-review-sessions.json"
]);

export interface DashboardArtifactFiles {
  run: JsonValue;
  findings: JsonValue;
  sessions?: JsonValue;
}

export function extractDashboardArtifactFiles(bytes: Uint8Array): DashboardArtifactFiles {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount > MAX_ENTRIES) throw new RangeError("Artifact ZIP has too many entries");
  if (centralOffset + centralSize > eocd)
    throw new TypeError("Artifact ZIP central directory is invalid");

  const files = new Map<string, string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(view, offset, 46);
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new TypeError("Artifact ZIP central directory is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    assertRange(view, offset + 46, nameLength + extraLength + commentLength);
    const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength));
    validateEntryName(name);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new TypeError("ZIP64 artifacts are not supported");
    }
    if ((flags & 1) !== 0) throw new TypeError("Encrypted artifact ZIP entries are not supported");
    if (TARGETS.has(name)) {
      if (files.has(name)) throw new TypeError(`Artifact ZIP contains duplicate ${name}`);
      files.set(
        name,
        extractEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize)
      );
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const runText = files.get("shuvbot-run.json");
  const findingsText = files.get("shuvbot-findings.json");
  if (runText === undefined || findingsText === undefined) {
    throw new TypeError("Artifact ZIP is missing dashboard run or findings data");
  }
  const sessionsText = files.get("shuvbot-review-sessions.json");
  const result: DashboardArtifactFiles = {
    run: parseJson(runText, "shuvbot-run.json"),
    findings: parseJson(findingsText, "shuvbot-findings.json")
  };
  if (sessionsText !== undefined) {
    result.sessions = parseJson(sessionsText, "shuvbot-review-sessions.json");
  }
  return result;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new TypeError("Artifact is not a supported ZIP file");
}

function extractEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number
): string {
  if (uncompressedSize > DASHBOARD_MAX_FILE_BYTES) {
    throw new RangeError(`Artifact file exceeds the ${DASHBOARD_MAX_FILE_BYTES}-byte limit`);
  }
  assertRange(view, localOffset, 30);
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new TypeError("Artifact ZIP local entry is invalid");
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  assertRange(view, dataOffset, compressedSize);
  const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
  let output: Uint8Array;
  if (method === 0) output = compressed;
  else if (method === 8)
    output = inflateRawSync(compressed, { maxOutputLength: DASHBOARD_MAX_FILE_BYTES });
  else throw new TypeError(`Artifact ZIP compression method ${method} is not supported`);
  if (output.byteLength !== uncompressedSize)
    throw new TypeError("Artifact ZIP entry size is invalid");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(output);
}

function validateEntryName(name: string): void {
  if (name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
    throw new TypeError("Artifact ZIP contains an unsafe path");
  }
  if (name.split("/").some((part) => part === "..")) {
    throw new TypeError("Artifact ZIP contains an unsafe path");
  }
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function parseJson(text: string, name: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
}

function assertRange(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new TypeError("Artifact ZIP is truncated");
  }
}
