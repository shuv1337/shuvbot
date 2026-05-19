import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createRunRecord } from "../../core/src/run-record.ts";
import { writeReviewArtifacts } from "../src/artifacts.ts";

describe("review artifacts", () => {
  test("writes run, findings, and context manifest artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reviewbot-artifacts-"));
    const artifacts = await writeReviewArtifacts({
      runnerTemp: dir,
      runRecord: createRunRecord({
        event: "pull_request",
        actor: "alice",
        mode: "review",
        agent: "claude-code",
        model: "claude/sonnet"
      }),
      findings: [],
      contextManifest: { sections: [], totalBytes: 0 }
    });

    await expect(readFile(artifacts.runPath, "utf8")).resolves.toContain("\"runId\"");
    await expect(readFile(artifacts.findingsPath, "utf8")).resolves.toBe("[]\n");
    await expect(readFile(artifacts.contextManifestPath, "utf8")).resolves.toContain("\"sections\"");
  });
});
