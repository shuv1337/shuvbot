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
const SUMMARY_PATH = join(tmpdir(), "shuvbot-tests-github-step-summary.md");

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

/** What `GET /pulls/1` returns as JSON. `headRepo` decides fork status. */
function pullRequestPayload(headRepo = "octo/repo") {
  return {
    number: 1,
    title: "Add feature",
    body: "",
    state: "open",
    draft: false,
    user: { login: "alice" },
    head: { ref: "topic", sha: "aaa", repo: { full_name: headRepo } },
    base: { ref: "main", sha: "bbb", repo: { full_name: "octo/repo" } }
  };
}

const PR_PAYLOAD = pullRequestPayload();

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
    // GitHub serves the same pull request path as JSON or as a unified diff
    // depending on Accept, and shuvbot relies on both. Let a route opt into the
    // diff representation with a "<key> [diff]" entry, falling back to the
    // plain key so existing single-representation routes keep working.
    const accept = new Headers(init?.headers ?? {}).get("accept") ?? "";
    const route = (accept.includes("diff") ? routes[`${key} [diff]`] : undefined) ?? routes[key];
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
    cwd = await mkdtemp(join(tmpdir(), "shuvbot-e2e-"));
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
    expect(summary).toContain("shuvbot");
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

describe("main() unhandled requests", () => {
  let cwd: string;
  let previousEnv: Record<string, string | undefined>;
  let eventPath: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "shuvbot-unhandled-"));
    const outputPath = join(cwd, "output.txt");
    eventPath = join(cwd, "event.json");
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

    process.env.GITHUB_EVENT_NAME = "issue_comment";
    process.env.GITHUB_EVENT_PATH = eventPath;
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

  async function writeCommentEvent(body: string, opts: { onPullRequest?: boolean } = {}) {
    const onPullRequest = opts.onPullRequest ?? true;
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "created",
        repository: {
          owner: { login: "octo" },
          name: "repo",
          full_name: "octo/repo",
          private: false
        },
        sender: { login: "alice" },
        issue: {
          number: 1,
          title: "Add feature",
          body: "",
          state: "open",
          user: { login: "alice" },
          ...(onPullRequest
            ? { pull_request: { url: "https://api.github.com/repos/octo/repo/pulls/1" } }
            : {})
        },
        comment: { id: 10, body, user: { login: "alice" } }
      })
    );
  }

  /**
   * An inline comment on a diff line. This is `pull_request_review_comment`,
   * a different event from `issue_comment`, even though both are "commenting
   * on a pull request" from the UI. The repository workflow subscribes to
   * both, so both have to actually start a review.
   */
  async function writeReviewCommentEvent(body: string) {
    process.env.GITHUB_EVENT_NAME = "pull_request_review_comment";
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "created",
        repository: {
          owner: { login: "octo" },
          name: "repo",
          full_name: "octo/repo",
          private: false
        },
        sender: { login: "alice" },
        pull_request: pullRequestPayload(),
        comment: {
          id: 11,
          body,
          user: { login: "alice" },
          path: "src/app.ts",
          position: 2
        }
      })
    );
  }

  test("fails loudly when an explicit mention refers to no pull request", async () => {
    await writeCommentEvent("@shuvbot review", { onPullRequest: false });
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      }
    });

    // Understood (mode resolves to review) but there is no pull request to
    // review. A person asked and must be told, not left with a green check.
    await expect(main({ fetchImpl: server.fetchImpl })).rejects.toThrow(/could not run/);

    const summary = await readFile(SUMMARY_PATH, "utf8");
    expect(summary).toContain("Errors");
  });

  test("does not review when a comment never mentioned shuvbot", async () => {
    await writeCommentEvent("just a normal comment, no mention here");
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      "GET /repos/octo/repo/pulls/1": { status: 200, body: PR_PAYLOAD }
    });

    await main({ fetchImpl: server.fetchImpl });

    const outputs = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
    expect(outputs).toContain('"status":"skipped"');
    expect(outputs).toContain("mentions `@shuvbot review`");

    const postedReview = server.calls.find((call) => call.method === "POST");
    expect(postedReview).toBeUndefined();
  });

  test("@shuvbot review on a same-repo pull request comment posts a review", async () => {
    await writeCommentEvent("@shuvbot review");
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      "GET /repos/octo/repo/pulls/1": { status: 200, body: PR_PAYLOAD },
      "GET /repos/octo/repo/pulls/1 [diff]": { status: 200, body: PR_DIFF },
      "GET /repos/octo/repo/pulls/1/files": { status: 200, body: [{ filename: "src/app.ts" }] },
      "GET /repos/octo/repo/pulls/1/comments": { status: 200, body: [] },
      "POST /repos/octo/repo/pulls/1/reviews": {
        status: 200,
        body: { id: 42, html_url: "https://example.test/pr/1#review-42" }
      }
    });

    await main({ driver: scriptedDriver(), fetchImpl: server.fetchImpl });

    const postedReview = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(postedReview).toBeDefined();
    const reviewBody = postedReview!.body as {
      body: string;
      comments: Array<{ path: string; body: string }>;
    };
    expect(reviewBody.comments[0]!.path).toBe("src/app.ts");
    expect(JSON.stringify(reviewBody)).toContain(INJECTED_FINDING.body);
  });

  test("@shuvbot review on an inline diff comment posts a review", async () => {
    await writeReviewCommentEvent("@shuvbot review");
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      "GET /repos/octo/repo/pulls/1 [diff]": { status: 200, body: PR_DIFF },
      "GET /repos/octo/repo/pulls/1/files": { status: 200, body: [{ filename: "src/app.ts" }] },
      "GET /repos/octo/repo/pulls/1/comments": { status: 200, body: [] },
      "POST /repos/octo/repo/pulls/1/reviews": {
        status: 200,
        body: { id: 42, html_url: "https://example.test/pr/1#review-42" }
      }
    });

    await main({ driver: scriptedDriver(), fetchImpl: server.fetchImpl });

    const postedReview = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(postedReview).toBeDefined();
    expect(JSON.stringify(postedReview!.body)).toContain(INJECTED_FINDING.body);
  });

  test("an inline diff comment without a mention reviews nothing", async () => {
    await writeReviewCommentEvent("this line looks wrong to me");
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      }
    });

    await main({ driver: scriptedDriver(), fetchImpl: server.fetchImpl });

    expect(
      server.calls.some(
        (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
      )
    ).toBe(false);
  });

  test("runs the review but refuses to post it when the head is a fork", async () => {
    await writeCommentEvent("@shuvbot review");
    const server = fakeGitHubServer({
      "GET /repos/octo/repo/collaborators/alice/permission": {
        status: 200,
        body: { role_name: "write" }
      },
      // Same pull request number, head in a different repository.
      "GET /repos/octo/repo/pulls/1": {
        status: 200,
        body: pullRequestPayload("mallory/repo")
      },
      "GET /repos/octo/repo/pulls/1 [diff]": { status: 200, body: PR_DIFF },
      "GET /repos/octo/repo/pulls/1/files": { status: 200, body: [{ filename: "src/app.ts" }] },
      "GET /repos/octo/repo/pulls/1/comments": { status: 200, body: [] },
      "POST /repos/octo/repo/pulls/1/reviews": {
        status: 200,
        body: { id: 42, html_url: "https://example.test/pr/1#review-42" }
      }
    });

    await main({ driver: scriptedDriver(), fetchImpl: server.fetchImpl });

    // Fork status came from the fetched pull request, not the comment payload.
    const postedReview = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(postedReview).toBeUndefined();
  });
});
