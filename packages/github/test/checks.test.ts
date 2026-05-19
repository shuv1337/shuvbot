import { describe, expect, test } from "bun:test";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import type { GitHubClient } from "../src/octokit.ts";
import { fetchCheckLog, findFailedCheckRuns } from "../src/checks.ts";

describe("check helpers", () => {
  test("discovers failed check runs and fetches redacted truncated logs", async () => {
    const client = {
      async request(route: string) {
        if (route.includes("check-runs")) {
          return {
            status: 200,
            headers: {},
            data: {
              check_runs: [
                { id: 1, name: "test", conclusion: "failure", html_url: "https://example.test/1" },
                { id: 2, name: "lint", conclusion: "success" }
              ]
            }
          };
        }
        return { status: 200, headers: {}, data: `TOKEN=ghp_abcdefghijklmnopqrstuvwxyz\n${"x".repeat(50)}` };
      }
    } as GitHubClient;

    await expect(findFailedCheckRuns(client, { owner: "octo", name: "repo" }, "abc")).resolves.toEqual([
      { id: 1, name: "test", conclusion: "failure", htmlUrl: "https://example.test/1" }
    ]);
    const log = await fetchCheckLog({
      client,
      repo: { owner: "octo", name: "repo" },
      runId: 1,
      maxBytes: 20,
      redactor: new DefaultRedactor()
    });
    expect(log.truncated).toBe(true);
    expect(log.untrusted).toBe(true);
    expect(log.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});
