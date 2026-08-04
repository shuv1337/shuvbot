import { describe, expect, test } from "bun:test";
import { createLocalChangeIdentity } from "../src/identity.ts";

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
