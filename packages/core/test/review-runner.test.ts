import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../src/config.ts";
import { defaultRuntimePolicy } from "../src/policy.ts";
import { createFakeReviewAgent, runReview, type ReviewAgent } from "../src/review-runner.ts";
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
          line: 1,
          tags: ["correctness"]
        }
      ])
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.pipeline.inlineFindings[0]?.inline).toMatchObject({ path: "src/a.ts", line: 1 });
    expect(result.context.manifest.sections.some((section) => section.untrusted)).toBe(true);
  });

  test("continues with successful skill findings when some skills fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-runner-partial-fail-"));
    let firstSkill = true;
    const agent: ReviewAgent = {
      async run({ skillId }) {
        if (!firstSkill) throw new Error(`${skillId} failed`);
        firstSkill = false;
        return [
          {
            id: "kept",
            skill: skillId,
            title: "Changed constant",
            body: "Check this behavior.",
            severity: "high",
            confidence: "high",
            path: "src/a.ts",
            line: 1,
            tags: ["correctness"]
          }
        ];
      },
      async verify() {
        return ["kept"];
      }
    };

    const result = await runReview({
      cwd,
      repo: "octo/reviewbot",
      event: event(),
      files: [{ filename: "src/a.ts" }],
      diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
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
      agent
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.pipeline.dropped).toEqual([]);
    expect(result.findings.map((finding) => finding.id)).toEqual(["kept"]);
  });

  test("throws when all review skills fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-runner-all-fail-"));
    const agent: ReviewAgent = {
      async run({ skillId }) {
        throw new Error(`${skillId} failed`);
      }
    };

    await expect(
      runReview({
        cwd,
        repo: "octo/reviewbot",
        event: event(),
        files: [{ filename: "src/a.ts" }],
        diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
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
        agent
      })
    ).rejects.toThrow("All review skills failed");
  });

  test("runs verification before pipeline filtering", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-runner-verify-"));
    const findings = [
      {
        id: "kept",
        skill: "code-review",
        title: "Security bug",
        body: "Security regression.",
        severity: "high",
        confidence: "high",
        path: "src/a.ts",
        line: 1,
        tags: ["security"]
      },
      {
        id: "dropped",
        skill: "code-review",
        title: "Security bug two",
        body: "Security regression.",
        severity: "high",
        confidence: "high",
        path: "src/a.ts",
        line: 1,
        tags: ["security"]
      }
    ];
    const agent: ReviewAgent = {
      async run() {
        return findings;
      },
      async verify() {
        return ["kept"];
      }
    };

    const result = await runReview({
      cwd,
      repo: "octo/reviewbot",
      event: event(),
      files: [{ filename: "src/a.ts" }],
      diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
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
      agent
    });

    expect(result.findings.map((finding) => finding.id)).toEqual(["kept"]);
    expect(result.pipeline.dropped.map((entry) => entry.reason)).toContain("not verified");
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
