import { describe, expect, test } from "bun:test";
import type { GitHubClient, GitHubRequestOptions } from "../../github/src/octokit.ts";
import { fetchFileContentAtRef } from "../src/coordinator-review.ts";

const REPO = { owner: "octo", name: "repo" };

function client(
  handler: (route: string, options?: GitHubRequestOptions) => unknown
): GitHubClient & { routes: string[] } {
  const routes: string[] = [];
  return {
    routes,
    async request(route, options) {
      routes.push(route);
      return { status: 200, data: handler(route, options) as never };
    }
  };
}

function fileResponse(content: string): Record<string, unknown> {
  return {
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(content, "utf8"),
    content: Buffer.from(content, "utf8").toString("base64")
  };
}

describe("pull request file content at a ref", () => {
  test("reads a text file at the requested ref", async () => {
    const github = client(() => fileResponse("export const value = 1;\n"));
    const params: GitHubRequestOptions["params"][] = [];
    const recording: GitHubClient = {
      async request(route, options) {
        params.push(options?.params);
        return github.request(route, options);
      }
    };

    await expect(fetchFileContentAtRef(recording, REPO, "src/app.ts", "headsha")).resolves.toBe(
      "export const value = 1;\n"
    );
    expect(github.routes[0]).toBe("GET /repos/octo/repo/contents/src/app.ts");
    expect(params[0]).toEqual({ ref: "headsha" });
  });

  test("encodes each path segment without collapsing the separators", async () => {
    // A whole-path encodeURIComponent turns the separators into %2F and the
    // contents API stops resolving the file at all.
    const github = client(() => fileResponse("body"));
    await fetchFileContentAtRef(github, REPO, "src/a b/c#d.ts", "headsha");
    expect(github.routes[0]).toBe("GET /repos/octo/repo/contents/src/a%20b/c%23d.ts");
  });

  test.each([
    ["a directory listing", [{ type: "file", name: "a.ts" }]],
    ["a submodule", { type: "submodule", encoding: "base64", content: "" }],
    ["a symlink", { type: "symlink", encoding: "base64", content: "" }],
    ["an unencoded blob", { type: "file", encoding: "none", content: "", size: 4 }],
    ["a blob over the API limit", { type: "file", encoding: "base64", size: 2 * 1024 * 1024 }]
  ])("returns nothing for %s", async (_label, body) => {
    const github = client(() => body);
    await expect(
      fetchFileContentAtRef(github, REPO, "src/app.ts", "headsha")
    ).resolves.toBeUndefined();
  });

  test("returns nothing for a blob that is not UTF-8 text", async () => {
    const github = client(() => ({
      type: "file",
      encoding: "base64",
      size: 4,
      content: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64")
    }));
    // Decoding this lossily would hand a reviewer replacement characters and
    // call them the file's content.
    await expect(
      fetchFileContentAtRef(github, REPO, "src/app.bin", "headsha")
    ).resolves.toBeUndefined();
  });
});
