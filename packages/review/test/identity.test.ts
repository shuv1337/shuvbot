import { describe, expect, test } from "bun:test";
import { createLocalChangeIdentity, createPullRequestChangeIdentity } from "../src/identity.ts";

describe("local change identity", () => {
  test("is independent of checkout path and ref alias spelling after canonical resolution", () => {
    const canonical = {
      repositoryIdentity: "github.com/shuv/shuvbot",
      base: { kind: "branch", name: "refs/heads/main" }
    } as const;

    const fromFirstCheckout = createLocalChangeIdentity(canonical);
    const fromMovedCheckout = createLocalChangeIdentity({ ...canonical });
    const fromResolvedAlias = createLocalChangeIdentity({
      repositoryIdentity: "github.com/shuv/shuvbot",
      base: { kind: "branch", name: "refs/heads/main" }
    });

    expect(fromMovedCheckout).toBe(fromFirstCheckout);
    expect(fromResolvedAlias).toBe(fromFirstCheckout);
    expect(fromFirstCheckout).toMatch(/^local-change:v1:[0-9a-f]{64}$/);
  });

  test("supports detached canonical base commits and rejects abbreviated SHAs", () => {
    const upperSha = "A".repeat(40);
    expect(
      createLocalChangeIdentity({
        repositoryIdentity: "github.com/shuv/shuvbot",
        base: { kind: "commit", sha: upperSha }
      })
    ).toBe(
      createLocalChangeIdentity({
        repositoryIdentity: "github.com/shuv/shuvbot",
        base: { kind: "commit", sha: upperSha.toLowerCase() }
      })
    );
    expect(() =>
      createLocalChangeIdentity({
        repositoryIdentity: "github.com/shuv/shuvbot",
        base: { kind: "commit", sha: "abc123" }
      })
    ).toThrow("full commit SHA");
  });
});

describe("pull request change identity", () => {
  test("is stable across pushes so the finding lifecycle survives a force-push", () => {
    const first = createPullRequestChangeIdentity({
      repositoryFullName: "shuv/shuvbot",
      pullNumber: 22
    });
    const second = createPullRequestChangeIdentity({
      repositoryFullName: "shuv/shuvbot",
      pullNumber: 22
    });

    expect(first).toBe(second);
    expect(first).toStartWith("pull-request:v1:");
  });

  test("distinguishes pull requests and repositories", () => {
    const base = { repositoryFullName: "shuv/shuvbot", pullNumber: 22 };

    expect(createPullRequestChangeIdentity(base)).not.toBe(
      createPullRequestChangeIdentity({ ...base, pullNumber: 23 })
    );
    expect(createPullRequestChangeIdentity(base)).not.toBe(
      createPullRequestChangeIdentity({ ...base, repositoryFullName: "other/shuvbot" })
    );
  });

  test("rejects a pull request number that cannot identify a change", () => {
    expect(() =>
      createPullRequestChangeIdentity({ repositoryFullName: "shuv/shuvbot", pullNumber: 0 })
    ).toThrow("positive integer");
    expect(() =>
      createPullRequestChangeIdentity({ repositoryFullName: "  ", pullNumber: 1 })
    ).toThrow("repositoryFullName");
  });
});
