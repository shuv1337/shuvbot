const MARKER_PREFIX = "<!-- reviewbot:";
const MARKER_SUFFIX = " -->";

export interface MarkerComment {
  id?: number;
  body?: string | null;
}

export function formatMarker(key: string, payload: unknown = {}): string {
  return `${MARKER_PREFIX}${key}:${Buffer.from(JSON.stringify(payload)).toString("base64url")}${MARKER_SUFFIX}`;
}

export function appendMarker(body: string, key: string, payload: unknown = {}): string {
  return `${body.trimEnd()}\n\n${formatMarker(key, payload)}`;
}

export function findExistingMarker<T extends MarkerComment>(comments: readonly T[], key: string): T | undefined {
  const prefix = `${MARKER_PREFIX}${key}:`;
  return comments.find((comment) => typeof comment.body === "string" && comment.body.includes(prefix));
}
