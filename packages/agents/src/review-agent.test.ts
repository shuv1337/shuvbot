import { describe, expect, test } from "bun:test";
import { RunLogger } from "../../core/src/observability.ts";
import type { AgentDriver, AgentRunInput, AgentRunResult } from "./driver.ts";
import { createDriverReviewAgent } from "./review-agent.ts";

function fakeDriver(handler: (input: AgentRunInput) => AgentRunResult): AgentDriver {
  return {
    id: "claude-code",
    displayName: "fake",
    supports: { mcp: true, structuredOutput: false, repoEditing: true, oauthToken: true, apiKey: true },
    async prepare() {},
    async run(input) {
      return handler(input);
    }
  };
}

const BASE_OPTIONS = {
  cwd: "/tmp",
  env: {},
  timeoutMs: 1_000,
  activityTimeoutMs: 1_000
};

describe("createDriverReviewAgent", () => {
  test("extracts a JSON findings array embedded in prose", async () => {
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => ({
        success: true,
        output: `Here is my review:\n[{"id":"f1","skill":"code-review","title":"t","body":"b","severity":"high","confidence":"high","path":"a.ts"}]\nDone.`
      }))
    });

    const findings = await agent.run({ prompt: "diff", skillPrompt: "skill", skillId: "code-review" });
    expect(findings).toEqual([
      { id: "f1", skill: "code-review", title: "t", body: "b", severity: "high", confidence: "high", path: "a.ts" }
    ]);
  });

  test("passes the skill id through the system prompt", async () => {
    let capturedSystemPrompt = "";
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver((input) => {
        capturedSystemPrompt = input.systemPrompt ?? "";
        return { success: true, output: "[]" };
      })
    });

    await agent.run({ prompt: "diff", skillPrompt: "You are the security-review skill.", skillId: "security-review" });
    expect(capturedSystemPrompt).toContain("security-review");
  });

  test("returns no findings when the driver run fails", async () => {
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => ({ success: false, error: "boom" }))
    });

    const findings = await agent.run({ prompt: "diff", skillPrompt: "skill", skillId: "code-review" });
    expect(findings).toEqual([]);
  });

  test("returns no findings when the driver throws", async () => {
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: {
        id: "claude-code",
        displayName: "fake",
        supports: { mcp: true, structuredOutput: false, repoEditing: true, oauthToken: true, apiKey: true },
        async prepare() {},
        async run() {
          throw new Error("spawn failed");
        }
      }
    });

    const findings = await agent.run({ prompt: "diff", skillPrompt: "skill", skillId: "code-review" });
    expect(findings).toEqual([]);
  });

  test("verify keeps only ids returned by the driver", async () => {
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => ({ success: true, output: '["kept"]' }))
    });

    const ids = await agent.verify?.({
      prompt: "diff",
      findings: [
        { id: "kept", skill: "code-review", title: "t", body: "b", severity: "high", confidence: "high", path: "a.ts" },
        { id: "dropped", skill: "code-review", title: "t2", body: "b2", severity: "high", confidence: "high", path: "a.ts" }
      ]
    });
    expect(ids).toEqual(["kept"]);
  });

  test("verify fails closed and logs when the driver fails", async () => {
    const logger = new RunLogger();
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => ({ success: false, error: "boom" })),
      logger
    });

    const ids = await agent.verify?.({
      prompt: "diff",
      findings: [{ id: "a", skill: "code-review", title: "t", body: "b", severity: "high", confidence: "high", path: "a.ts" }]
    });
    expect(ids).toEqual([]);
    expect(logger.snapshot()).toContainEqual(expect.objectContaining({ level: "warn", event: "review.verify_failed", data: { error: "boom" } }));
  });

  test("verify fails closed and logs when the driver throws", async () => {
    const logger = new RunLogger();
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => {
        throw new Error("spawn failed");
      }),
      logger
    });

    const ids = await agent.verify?.({
      prompt: "diff",
      findings: [{ id: "a", skill: "code-review", title: "t", body: "b", severity: "high", confidence: "high", path: "a.ts" }]
    });
    expect(ids).toEqual([]);
    expect(logger.snapshot()).toContainEqual(
      expect.objectContaining({ level: "warn", event: "review.verify_error", data: { error: "spawn failed" } })
    );
  });

  test("verify short-circuits with no findings", async () => {
    const agent = createDriverReviewAgent({
      ...BASE_OPTIONS,
      driver: fakeDriver(() => {
        throw new Error("should not be called");
      })
    });

    const ids = await agent.verify?.({ prompt: "diff", findings: [] });
    expect(ids).toEqual([]);
  });
});
