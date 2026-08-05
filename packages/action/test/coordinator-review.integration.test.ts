import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { APPROVED_SHUVCODE_RUNTIME_VERSION } from "../../core/src/config.ts";
import type { CoordinatorEngineResult } from "../../review/src/engine.ts";
import { parseCoordinatorResult } from "../../review/src/results.ts";
import { main } from "../src/main.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "fixtures", "events", "pull_request.synchronize.json");
// See main.integration.test.ts: core.summary memoizes this path per process.
const SUMMARY_PATH = join(tmpdir(), "shuvbot-tests-github-step-summary.md");

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

function pullRequestPayload(headRepo = "octo/repo") {
  return {
    number: 1,
    title: "Add feature",
    body: "",
    state: "open",
    draft: false,
    user: { login: "alice" },
    head: { ref: "topic", sha: "a".repeat(40), repo: { full_name: headRepo } },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "octo/repo" } }
  };
}

const PR_FILES = [
  {
    filename: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1,2 +1,3 @@\n-  return 1;\n+  return 2;\n+  console.log(name);"
  }
];

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "unsafe-log-1",
    reviewer: "security",
    skill: "security",
    title: "Unsanitized input logged",
    body: "The request payload is logged without sanitizing it first.",
    evidence: "src/app.ts:3 logs `name` directly.",
    severity: "high",
    confidence: "high",
    path: "src/app.ts",
    line: 3,
    disposition: "new",
    ...overrides
  };
}

function engineResult(
  options: { findings?: unknown[]; decision?: string; quorumMet?: boolean } = {}
): CoordinatorEngineResult {
  const quorumMet = options.quorumMet ?? true;
  const result = parseCoordinatorResult({
    decision: options.decision ?? (options.findings?.length ? "significant_concerns" : "clean"),
    findings: options.findings ?? [],
    dropped: [],
    coverage: {
      scheduled: ["code-quality", "security"],
      completed: quorumMet ? ["code-quality", "security"] : ["code-quality"],
      failed: quorumMet ? [] : ["security"],
      timedOut: [],
      required: ["code-quality", "security"],
      quorumMet
    },
    summary: "Coordinator result."
  });
  return {
    status: "completed",
    result,
    quorum: { met: quorumMet, required: [], missing: [], reason: "" } as never,
    coverage: result.coverage,
    specialistResults: [],
    sessions: [
      {
        sessionId: "session-1",
        role: "specialist",
        reviewer: "security",
        model: "subscription/default-coding",
        status: "completed",
        retryCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 }
      }
    ],
    retries: 0,
    events: [],
    repairAttempted: false
  };
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
    const accept = new Headers(init?.headers ?? {}).get("accept") ?? "";
    const route = (accept.includes("diff") ? routes[`${key} [diff]`] : undefined) ?? routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no mock route for ${key}` }), { status: 404 });
    }
    const responseBody = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(responseBody, { status: route.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function routes(overrides: Record<string, { status: number; body: unknown }> = {}) {
  return {
    "GET /repos/octo/repo/collaborators/alice/permission": {
      status: 200,
      body: { role_name: "write" }
    },
    "GET /repos/octo/repo/pulls/1": { status: 200, body: pullRequestPayload() },
    "GET /repos/octo/repo/pulls/1 [diff]": { status: 200, body: PR_DIFF },
    "GET /repos/octo/repo/pulls/1/files": { status: 200, body: PR_FILES },
    "GET /repos/octo/repo/pulls/1/comments": { status: 200, body: [] },
    "GET /repos/octo/repo/issues/1/comments": { status: 200, body: [] },
    "POST /repos/octo/repo/issues/1/comments": { status: 201, body: { id: 100 } },
    "POST /repos/octo/repo/pulls/1/reviews": {
      status: 200,
      body: { id: 42, html_url: "https://example.test/pr/1#review-42" }
    },
    ...overrides
  };
}

async function readOutputs(path: string): Promise<Record<string, string>> {
  const raw = await readFile(path, "utf8");
  const outputs: Record<string, string> = {};
  const pattern = /^(\w+)<<(\S+)$\n([\s\S]*?)\n^\2$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) outputs[match[1]!] = match[3]!;
  return outputs;
}

describe("main() coordinator review mode", () => {
  let cwd: string;
  let outputPath: string;
  let configPath: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "shuvbot-coordinator-e2e-"));
    outputPath = join(cwd, "output.txt");
    configPath = join(cwd, "shuvbot.toml");
    await writeFile(SUMMARY_PATH, "");
    await writeFile(outputPath, "");
    await writeFile(
      configPath,
      [
        "[review]",
        'engine = "coordinator"',
        "",
        "[review.shuvcode]",
        'package = "shuvcode"',
        `version = "${APPROVED_SHUVCODE_RUNTIME_VERSION}"`,
        'auth = "environment"',
        ""
      ].join("\n")
    );

    previousEnv = Object.fromEntries(
      [
        "GITHUB_EVENT_NAME",
        "GITHUB_EVENT_PATH",
        "GITHUB_ACTOR",
        "GITHUB_STEP_SUMMARY",
        "GITHUB_OUTPUT",
        "RUNNER_TEMP",
        "INPUT_TOKEN",
        "INPUT_CWD",
        "INPUT_ENGINE",
        "INPUT_CONFIG",
        "CLAUDE_CODE_OAUTH_TOKEN"
      ].map((key) => [key, process.env[key]])
    );

    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = FIXTURE_PATH;
    process.env.GITHUB_ACTOR = "alice";
    process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
    process.env.GITHUB_OUTPUT = outputPath;
    process.env.RUNNER_TEMP = cwd;
    process.env.INPUT_TOKEN = "test-token";
    process.env.INPUT_CWD = cwd;
    process.env.INPUT_ENGINE = "coordinator";
    process.env.INPUT_CONFIG = configPath;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "review-runtime-secret";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  test("runs the coordinator engine and posts findings inline", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ findings: [finding()] }),
        startRuntime: async () => {
          throw new Error("runtime must not start with an injected engine");
        }
      }
    });

    const posted = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect(posted).toBeDefined();
    const body = posted!.body as {
      body: string;
      event: string;
      comments: Array<{ path: string; position: number; body: string }>;
    };
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]?.path).toBe("src/app.ts");
    expect(body.comments[0]?.body).toContain("Unsanitized input logged");
    const marker = body.comments[0]?.body.match(/<!-- shuvbot:([^:]+:[^:]+:[^:]+):/i)?.[1];
    expect(marker).toMatch(/^finding:v1:[a-f0-9]{64}$/);
    expect(body.comments[0]?.body).not.toContain("finding:v1:finding:v1:");
  });

  test("the review runtime credential never reaches GitHub or the outputs", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ findings: [finding()] }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    expect(JSON.stringify(server.calls)).not.toContain("review-runtime-secret");
    const outputs = await readOutputs(outputPath);
    expect(JSON.stringify(outputs)).not.toContain("review-runtime-secret");
    const summary = await readFile(SUMMARY_PATH, "utf8");
    expect(summary).not.toContain("review-runtime-secret");
  });

  test("publishes engine, tier, coverage, and degraded outputs", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ decision: "degraded", quorumMet: false }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    const outputs = await readOutputs(outputPath);
    expect(outputs.review_engine).toBe("coordinator");
    expect(outputs.review_tier).toBeDefined();
    expect(outputs.review_degraded).toBe("true");
    expect(JSON.parse(outputs.review_coverage!)).toMatchObject({ quorumMet: false });
    expect(JSON.parse(outputs.result!)).toMatchObject({ engine: "coordinator", degraded: true });
  });

  test("degraded coverage never requests changes", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () =>
          engineResult({
            decision: "degraded",
            quorumMet: false,
            findings: [finding({ severity: "critical" })]
          }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    const posted = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    expect((posted!.body as { event: string }).event).toBe("COMMENT");
  });

  test("never submits an approval, whatever the result says", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult(),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    for (const call of server.calls) {
      if (call.method !== "POST") continue;
      expect(JSON.stringify(call.body ?? {})).not.toContain("APPROVE");
    }
  });

  test("a fork pull request is reviewed but never posted to", async () => {
    // Fork status is unknowable from an issue_comment payload, so it has to come
    // from the fetched pull request - the same path the legacy fork test takes.
    const eventPath = join(cwd, "issue_comment.json");
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
          pull_request: { url: "https://api.github.com/repos/octo/repo/pulls/1" }
        },
        comment: { id: 5, body: "@shuvbot review", user: { login: "alice" } }
      })
    );
    process.env.GITHUB_EVENT_NAME = "issue_comment";
    process.env.GITHUB_EVENT_PATH = eventPath;

    const server = fakeGitHubServer(
      routes({
        "GET /repos/octo/repo/pulls/1": {
          status: 200,
          body: pullRequestPayload("mallory/repo")
        }
      })
    );

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ findings: [finding()] }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    expect(
      server.calls.some(
        (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
      )
    ).toBe(false);
    expect(
      server.calls.some(
        (call) => call.method === "POST" && call.path === "/repos/octo/repo/issues/1/comments"
      )
    ).toBe(false);
    // The run still has to leave evidence of what it found.
    const findings = JSON.parse(
      await readFile(join(cwd, "shuvbot", "shuvbot-findings.json"), "utf8")
    ) as { findings: unknown[] };
    expect(findings.findings).toHaveLength(1);
  });

  test("writes redacted run, findings, and session artifacts", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ findings: [finding()] }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    const run = JSON.parse(await readFile(join(cwd, "shuvbot", "shuvbot-run.json"), "utf8")) as {
      status: string;
      completedAt?: string;
      review?: { engine: string; tier: string; sessions: unknown[] };
    };
    expect(run.status).toBe("success");
    expect(run.completedAt).toBeDefined();
    expect(run.review?.engine).toBe("coordinator");
    expect(run.review?.sessions).toHaveLength(1);
    const sessions = await readFile(join(cwd, "shuvbot", "shuvbot-review-sessions.json"), "utf8");
    expect(sessions).not.toContain("review-runtime-secret");
  });

  test("persists finding lifecycle state on the pull request", async () => {
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async () => engineResult({ findings: [finding()] }),
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    const stateComment = server.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/issues/1/comments"
    );
    expect(stateComment).toBeDefined();
    expect(JSON.stringify(stateComment!.body)).toContain("shuvbot:review-state:v1:");
    const reviewIndex = server.calls.findIndex(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
    );
    const stateIndex = server.calls.findIndex(
      (call) => call.method === "POST" && call.path === "/repos/octo/repo/issues/1/comments"
    );
    expect(stateIndex).toBeGreaterThan(reviewIndex);
  });

  test("does not persist unseen findings when review posting fails", async () => {
    const server = fakeGitHubServer(
      routes({
        "POST /repos/octo/repo/pulls/1/reviews": {
          status: 422,
          body: { message: "invalid review position" }
        }
      })
    );

    await expect(
      main({
        fetchImpl: server.fetchImpl,
        coordinator: {
          executeCoordinator: async () => engineResult({ findings: [finding()] }),
          startRuntime: async () => {
            throw new Error("unused");
          }
        }
      })
    ).rejects.toThrow("invalid review position");

    expect(
      server.calls.some(
        (call) => call.method === "POST" && call.path === "/repos/octo/repo/issues/1/comments"
      )
    ).toBe(false);
  });

  test("recovers an omitted text patch from the raw pull request diff", async () => {
    const server = fakeGitHubServer(
      routes({
        "GET /repos/octo/repo/pulls/1/files": {
          status: 200,
          body: [{ filename: "src/app.ts", status: "modified", additions: 2, deletions: 1 }]
        }
      })
    );
    let recoveredPatch = "";

    await main({
      fetchImpl: server.fetchImpl,
      coordinator: {
        executeCoordinator: async ({ plan }) => {
          recoveredPatch = plan.diff.entries[0]?.patch ?? "";
          return engineResult();
        },
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    expect(recoveredPatch).toContain("TODO: sanitize");
    expect(recoveredPatch).toContain("console.log(name)");
  });

  test("refuses to run without a non-interactive credential", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const server = fakeGitHubServer(routes());

    await expect(
      main({
        fetchImpl: server.fetchImpl,
        coordinator: {
          executeCoordinator: async () => engineResult(),
          startRuntime: async () => {
            throw new Error("unused");
          }
        }
      })
    ).rejects.toThrow("requires a credential in the environment");
  });

  test("refuses local profile auth on a runner", async () => {
    await writeFile(
      configPath,
      [
        "[review]",
        'engine = "coordinator"',
        "",
        "[review.shuvcode]",
        'package = "shuvcode"',
        `version = "${APPROVED_SHUVCODE_RUNTIME_VERSION}"`,
        'auth = "user"',
        ""
      ].join("\n")
    );
    const server = fakeGitHubServer(routes());

    await expect(
      main({
        fetchImpl: server.fetchImpl,
        coordinator: {
          executeCoordinator: async () => engineResult(),
          startRuntime: async () => {
            throw new Error("unused");
          }
        }
      })
    ).rejects.toThrow('requires review.shuvcode.auth = "environment"');
  });

  test("without the opt-in input the coordinator never runs", async () => {
    delete process.env.INPUT_ENGINE;
    let executed = 0;
    const server = fakeGitHubServer(routes());

    await main({
      fetchImpl: server.fetchImpl,
      driver: {
        id: "claude-code",
        displayName: "scripted",
        supports: {
          mcp: true,
          structuredOutput: false,
          repoEditing: true,
          oauthToken: true,
          apiKey: true
        },
        async prepare() {},
        async run() {
          return { success: true, output: "[]" };
        }
      },
      coordinator: {
        executeCoordinator: async () => {
          executed += 1;
          return engineResult();
        },
        startRuntime: async () => {
          throw new Error("unused");
        }
      }
    });

    expect(executed).toBe(0);
    const outputs = await readOutputs(outputPath);
    expect(outputs.review_engine).toBeUndefined();
  });

  test("a cancelled run aborts instead of posting", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = fakeGitHubServer(routes());

    await expect(
      main({
        fetchImpl: server.fetchImpl,
        signal: controller.signal,
        coordinator: {
          executeCoordinator: async () => engineResult(),
          startRuntime: async () => {
            throw new Error("unused");
          }
        }
      })
    ).rejects.toThrow("cancelled");

    expect(
      server.calls.some(
        (call) => call.method === "POST" && call.path === "/repos/octo/repo/pulls/1/reviews"
      )
    ).toBe(false);
  });
});
