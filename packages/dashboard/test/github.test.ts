import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createGitHubAppJwt, DashboardGitHubClient, listWorkflowRuns } from "../src/github.ts";

describe("dashboard GitHub client", () => {
  test("creates a short-lived RS256 GitHub App JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const token = createGitHubAppJwt(
      { appId: "123", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
      now
    );
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
      iss: "123"
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url")
      )
    ).toBe(true);
  });

  test("uses only validated repository names in API paths", async () => {
    let requested = "";
    const client = new DashboardGitHubClient("token", async (input) => {
      requested = String(input);
      return Response.json({ workflow_runs: [] });
    });
    await expect(listWorkflowRuns(client, "example/repo", 10)).resolves.toEqual([]);
    expect(requested).toContain("/repos/example/repo/actions/workflows/shuvbot.yml/runs");
    await expect(listWorkflowRuns(client, "example/repo?token=leak", 10)).rejects.toThrow(
      "repository name is invalid"
    );
  });

  test("rejects oversized GitHub responses before buffering", async () => {
    const client = new DashboardGitHubClient("token", async () =>
      Response.json([], { headers: { "content-length": String(1024 * 1024 + 1) } })
    );
    await expect(client.json("/app/installations", z.array(z.never()))).rejects.toThrow(
      "Response exceeds"
    );
  });
});
