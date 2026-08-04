import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { ReviewSessionLog } from "../src/session-log.ts";

describe("review session log", () => {
  test("buffers allowlisted redacted events and flushes JSONL atomically", async () => {
    const log = new ReviewSessionLog({
      redactor: new DefaultRedactor(),
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });
    log.append({
      event: "session.failed",
      sessionId: "specialist-1",
      role: "specialist",
      reviewer: "security",
      model: "subscription/default-coding",
      attempt: 1,
      error: {
        code: "REVIEW_PROVIDER_FAILURE",
        message: "CLAUDE_CODE_OAUTH_TOKEN=private-token",
        retryable: true
      }
    });

    const dir = await mkdtemp(join(tmpdir(), "shuvbot-session-log-"));
    const path = join(dir, "sessions.jsonl");
    await log.flush(path);
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain("private-token");
    expect(JSON.parse(contents)).toMatchObject({
      time: "2026-08-03T00:00:00.000Z",
      reviewer: "security",
      error: { message: "CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]" }
    });
  });

  test("rejects invalid role metadata and bounded-buffer overflow", () => {
    const log = new ReviewSessionLog({ redactor: new DefaultRedactor(), maxEvents: 1 });
    expect(() =>
      log.append({
        event: "session.started",
        sessionId: "coordinator",
        role: "coordinator",
        reviewer: "security",
        model: "subscription/default-reasoning",
        attempt: 1
      })
    ).toThrow("cannot identify");

    log.append({
      event: "session.queued",
      sessionId: "specialist-1",
      role: "specialist",
      reviewer: "tests",
      model: "subscription/default-coding",
      attempt: 1
    });
    expect(() =>
      log.append({
        event: "session.started",
        sessionId: "specialist-1",
        role: "specialist",
        reviewer: "tests",
        model: "subscription/default-coding",
        attempt: 1
      })
    ).toThrow("event limit");
  });
});
