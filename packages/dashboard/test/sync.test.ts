import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { syncDashboard } from "../src/sync.ts";

describe("dashboard synchronization", () => {
  test("continues after a repository without the shuvbot workflow", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requested: string[] = [];
    const fetchImpl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/app/installations?")) return Response.json([{ id: 1 }]);
      if (url.endsWith("/app/installations/1/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/installation/repositories?")) {
        return Response.json({
          repositories: [
            repository(1, "example/no-workflow"),
            repository(2, "example/with-workflow")
          ]
        });
      }
      if (url.includes("/repos/example/no-workflow/")) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (url.includes("/repos/example/with-workflow/")) {
        return Response.json({ workflow_runs: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const db: D1Database = Object.create(null);
    const env: Env & { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string } = {
      DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    };

    await expect(syncDashboard(env, fetchImpl)).resolves.toMatchObject({
      repositories: 2,
      discoveredRuns: 0,
      ingestedRuns: 0
    });
    expect(requested.some((url) => url.includes("example/with-workflow"))).toBe(true);
  });
});

function repository(id: number, fullName: string) {
  return {
    id,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    private: true
  };
}
