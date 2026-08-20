import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createGitHubAppJwt,
  createInstallationClient,
  DashboardGitHubClient,
  listWorkflowRuns
} from "../src/github.ts";

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

  test("calls fetch implementations with the global receiver", async () => {
    const client = new DashboardGitHubClient("token", async function (this: typeof globalThis) {
      expect(this).toBe(globalThis);
      return Response.json([]);
    });

    await client.json("/app/installations", z.array(z.never()));
  });

  test("follows trusted artifact redirects without forwarding authorization", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new DashboardGitHubClient("installation-token", async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://results.actions.githubusercontent.com/artifact.zip?signature=opaque"
          }
        });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });

    await expect(client.downloadArtifact("example/repo", 7)).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer installation-token");
    expect(requests[1]?.headers.get("authorization")).toBeNull();
  });

  test("rejects artifact redirects outside GitHub-owned storage", async () => {
    const client = new DashboardGitHubClient(
      "installation-token",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/artifact.zip" }
        })
    );

    await expect(client.downloadArtifact("example/repo", 7)).rejects.toThrow("untrusted URL");
  });

  test("rejects unrelated Azure Blob storage accounts", async () => {
    const client = new DashboardGitHubClient(
      "installation-token",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.blob.core.windows.net/artifact.zip" }
        })
    );

    await expect(client.downloadArtifact("example/repo", 7)).rejects.toThrow("untrusted URL");
  });

  test("requests an installation token with read-only permissions", async () => {
    let body = "";
    const appClient = new DashboardGitHubClient("app-token", async (_input, init) => {
      body = String(init?.body);
      return Response.json({ token: "installation-token" });
    });
    await createInstallationClient(appClient, 1, async () => Response.json({}));
    expect(JSON.parse(body)).toEqual({ permissions: { actions: "read", metadata: "read" } });
  });

  test("rejects non-GitHub browser URLs", async () => {
    const client = new DashboardGitHubClient("token", async () =>
      Response.json({ workflow_runs: [{ id: 1, html_url: "javascript:alert(1)" }] })
    );
    await expect(listWorkflowRuns(client, "example/repo", 10)).rejects.toThrow("HTTPS github.com");
  });
});
