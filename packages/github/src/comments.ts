const MARKER_PREFIX = "<!-- shuvbot:";
const MARKER_SUFFIX = " -->";

export interface MarkerComment {
  id?: number;
  body?: string | null;
}

export interface ShuvbotMarker {
  key: string;
  payload: unknown;
}

export function formatMarker(key: string, payload: unknown = {}): string {
  return `${MARKER_PREFIX}${key}:${Buffer.from(JSON.stringify(payload)).toString("base64url")}${MARKER_SUFFIX}`;
}

export function appendMarker(body: string, key: string, payload: unknown = {}): string {
  return `${body.trimEnd()}\n\n${formatMarker(key, payload)}`;
}

export function parseMarker(body: string): ShuvbotMarker | undefined {
  const markerPattern = /<!-- shuvbot:([^>\s]+):([A-Za-z0-9_-]+) -->/g;
  for (const match of body.matchAll(markerPattern)) {
    const key = match[1];
    const encodedPayload = match[2];
    if (!key || !encodedPayload) continue;
    try {
      const payloadBuffer = Buffer.from(encodedPayload, "base64url");
      if (payloadBuffer.toString("base64url") !== encodedPayload) continue;
      return { key, payload: JSON.parse(payloadBuffer.toString("utf8")) as unknown };
    } catch {
      // Marker-like user text and damaged markers are not shuvbot identities.
    }
  }
  return undefined;
}

export function parseTrailingMarker(body: string): ShuvbotMarker | undefined {
  const match = body.match(/<!-- shuvbot:([^>\s]+):([A-Za-z0-9_-]+) -->\s*$/);
  if (!match?.[1] || !match[2]) return undefined;
  return decodeMarker(match[1], match[2]);
}

function decodeMarker(key: string, encodedPayload: string): ShuvbotMarker | undefined {
  try {
    const payloadBuffer = Buffer.from(encodedPayload, "base64url");
    if (payloadBuffer.toString("base64url") !== encodedPayload) return undefined;
    return { key, payload: JSON.parse(payloadBuffer.toString("utf8")) as unknown };
  } catch {
    return undefined;
  }
}

export function findExistingMarker<T extends MarkerComment>(
  comments: readonly T[],
  key: string
): T | undefined {
  const prefix = `${MARKER_PREFIX}${key}:`;
  return comments.find(
    (comment) => typeof comment.body === "string" && comment.body.includes(prefix)
  );
}
