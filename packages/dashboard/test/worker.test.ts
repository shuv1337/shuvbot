import { expect, test } from "bun:test";
import { handleRequest } from "../src/index.ts";

test("dashboard browser surface is read-only", async () => {
  const response = await handleRequest(
    new Request("https://dashboard.test/api/runs", { method: "POST" })
  );
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, HEAD");
});

test("dashboard HEAD responses have no body", async () => {
  const env: Env = Object.create(null);
  const response = await handleRequest(
    new Request("https://dashboard.test/missing", { method: "HEAD" }),
    env
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
});
