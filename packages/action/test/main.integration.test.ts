import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentDriver, AgentRunInput } from "../../agents/src/driver.ts";
import { main } from "../src/main.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "fixtures", "events", "pull_request.synchronize.json");

// @actions/core's `core.summary` is a process-wide singleton that memoizes
// GITHUB_STEP_SUMMARY's file path on first use and ignores later env changes
// (see node_modules/@actions/core/lib/summary.js). Pointing it at a fresh
// per-test temp dir and deleting that dir afterward poisons every later
// summary-writing test in the same process with an ENOENT. Use one fixed,
// never-deleted path for the whole process instead - see workflow-summary.test.ts.
const SUMMARY_PATH = join(tmpdir(), "reviewbot-tests-github-step-summary.md");

const INJECTED_FINDING = {
  id: "sql-injection-1",
  skill: "code-review",
  title: "Unsanitized user input logged to console",
  body: "This logs the raw request payload without sanitizing it first.",
  severity: "high",
  confidence: "high",
  path: "src/app.ts",
  line: 3,
  side: "RIGHT",
  tags: ["security"]
};

const PR_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index abc1234..def5678 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " function greet(name) {",
  '-  return "hi " + name;',
  '+  return "hi " + name; // TODO: sanitize',
  "+  console.log(name);",
  " }"
].join("\n");

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

async function listMcpToolNames(url: string): Promise<string[]> {
  await postMcp(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "scripted-test-driver", version: "0.0.0" }
    }
  });
  const response = await postMcp(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (response as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  return tools.map((tool) => tool.name).sort();
}

async function postMcp(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP request failed: ${response.status} ${text}`);
  const jsonText =
    text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length) ?? text;
  return JSON.parse(jsonText);
}

function fakeGitHubServer(routes: Record<string, { status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const route = routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no mock route registered for ${key}` }), {
        status: 404
      });
    }
    const responseBody = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(responseBody, { status: route.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function scriptedDriver(observedToolNames?: string[][]): AgentDriver {
  return {
    id: "claude-code",
    displayName: "scripted-test-driver",
    supports: {
      mcp: true,
      structuredOutput: false,
      repoEditing: true,
      oauthToken: true,
      apiKey: true
    },
    async prepare() {},
    async run(input: AgentRunInput) {
      if (input.mcpServerUrl && observedToolNames) {
        observedToolNames.push(await listMcpToolNames(input.mcpServerUrl));
      }
      if (input.systemPrompt?.includes("Candidate findings:")) {
        return { success: true, output: JSON.stringify([INJECTED_FINDING.id]) };
      }
      return { success: true, output: JSON.stringify([INJECTED_FINDING]) };
    }
  };
}

describe("main() end to end (review mode)", () => {
  let cwd: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "reviewbot-e2e-"));
    const outputPath = join(cwd, "output.txt");
    await writeFile(SUMMARY_PATH, "");
    await writeFile(outputPath, "");

    previousEnv = {
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
      GITHUB_ACTOR: process.env.GITHUB_ACTOR,
      GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      INPUT_TOKEN: process.env.INPUT_TOKEN,
      INPUT_CWD: process.env.INPUT_CWD
    };

    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = FIXTURE_PATH;
    process.env.GITHUB_ACTOR = "alice";
    process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
    process.env.GITHUB_OUTPUT = outputPath;
    process.env.RUNNER_TEMP = cwd;
    process.env.INPUT_TOKEN = "test-token";
    process.env.INPUT_CWD = cwd;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  test("reviews a real PR fixture end to end and posts a review with the agent's finding", async () => {
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      "GET /repos/octo/repo/pulls/1": { status: 200, body: PR_DIFF },
      "GET /repos/octo/repo/pulls/1/files": { status: 200, body: [{ filename: "src/app.ts" }] },
      "GET /repos/octo/repo/pulls/1/comments": { status: 200, body: [] },
      "POST /repos/octo/repo/pulls/1/reviews": {
        status: 200,
        body: { id: 42, html_url: "https://example.test/pr/1#review-42" }
      }
    });

    const observedToolNames: string[][] = [];

    await main({ driver: scriptedDriver(observedToolNames), fetchImpl: server.fetchImpl });

    const postedReview = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(postedReview).toBeDefined();
    const reviewBody = postedReview!.body as {
      body: string;
      event: string;
      comments: Array<{ path: string; position: number; body: string }>;
    };

    const allPostedText = [
      reviewBody.body,
      ...reviewBody.comments.map((comment) => comment.body)
    ].join("\n");
    expect(allPostedText).toContain(INJECTED_FINDING.body);
    expect(
      reviewBody.comments.some((comment) => comment.path === "src/app.ts" && comment.position === 4)
    ).toBe(true);
    expect(reviewBody.event === "COMMENT" || reviewBody.event === "REQUEST_CHANGES").toBe(true);
    expect(observedToolNames.length).toBeGreaterThan(0);
    expect(observedToolNames[0]).toEqual([
      "get_check_logs",
      "get_check_runs",
      "get_issue",
      "get_issue_comments",
      "get_pr",
      "get_pr_diff",
      "get_pr_files",
      "get_review_comments",
      "read_file",
      "search_repo"
    ]);

    const output = await readFile(join(cwd, "output.txt"), "utf8");
    expect(output).toContain("review_findings");
    expect(output).toContain(INJECTED_FINDING.title);

    const summary = await readFile(SUMMARY_PATH, "utf8");
    expect(summary).toContain("reviewbot");
  });

  test("records the failure and still writes a workflow summary when the driver can't prepare", async () => {
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      "GET /repos/octo/repo/pulls/1": { status: 200, body: PR_DIFF },
      "GET /repos/octo/repo/pulls/1/files": { status: 200, body: [{ filename: "src/app.ts" }] }
    });
    const failingDriver: AgentDriver = {
      id: "claude-code",
      displayName: "failing-test-driver",
      supports: {
        mcp: true,
        structuredOutput: false,
        repoEditing: true,
        oauthToken: true,
        apiKey: true
      },
      async prepare() {
        throw new Error("claude CLI not found on PATH");
      },
      async run() {
        throw new Error("unreachable");
      }
    };

    await expect(main({ driver: failingDriver, fetchImpl: server.fetchImpl })).rejects.toThrow(
      "claude CLI not found on PATH"
    );

    const summary = await readFile(SUMMARY_PATH, "utf8");
    expect(summary).toContain("claude CLI not found on PATH");
    expect(summary).toContain("Errors");

    const postedReview = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(postedReview).toBeUndefined();
  });
});
