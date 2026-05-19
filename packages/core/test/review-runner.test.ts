import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../src/config.ts";
import { defaultRuntimePolicy } from "../src/policy.ts";
import { createFakeReviewAgent, runReview } from "../src/review-runner.ts";
import type { PullRequestEvent } from "../src/events.ts";

describe("review runner", () => {
  test("runs a fake-agent PR review end to end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-runner-"));
    await writeFile(join(cwd, "AGENTS.md"), "Use focused findings.");
    const result = await runReview({
      cwd,
      repo: "octo/reviewbot",
      event: event(),
      files: [{ filename: "src/a.ts" }],
      diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;`,
      config: normalizeConfig({}),
      policy: defaultRuntimePolicy({
        actor: "alice",
        actorPermission: "write",
        event: "pull_request",
        isFork: false,
        isPrivateRepo: false
      }),
      agent: createFakeReviewAgent([
        {
          id: "finding-1",
          skill: "code-review",
          title: "Changed constant",
          body: "Check this behavior.",
          severity: "medium",
          confidence: "high",
          path: "src/a.ts",
          line: 1
        }
      ])
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.pipeline.inlineFindings[0]?.inline).toMatchObject({ path: "src/a.ts", line: 1 });
    expect(result.context.manifest.sections.some((section) => section.untrusted)).toBe(true);
  });
});

function event(): PullRequestEvent {
  return {
    kind: "pull_request",
    name: "pull_request",
    action: "opened",
    repo: { owner: "octo", name: "reviewbot", fullName: "octo/reviewbot", isPrivate: false },
    sender: { login: "alice" },
    raw: { pull_request: { body: "untrusted" } },
    pullRequest: {
      number: 1,
      title: "PR",
      body: "Body",
      state: "open",
      draft: false,
      user: { login: "alice" },
      baseRef: "main",
      baseSha: "base",
      headRef: "feature",
      headSha: "head",
      headRepoFullName: "octo/reviewbot",
      isFork: false
    }
  };
}
