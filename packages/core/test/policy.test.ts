import { describe, expect, test } from "bun:test";
import { applyRuntimeCaps, defaultRuntimePolicy } from "../src/policy.ts";

describe("policy", () => {
  test("disables shell and push for fork pull request contexts", () => {
    const policy = defaultRuntimePolicy({
      actor: "contributor",
      actorPermission: "write",
      event: "pull_request",
      isFork: true,
      isPrivateRepo: false
    });

    expect(policy.shell).toBe("disabled");
    expect(policy.push).toBe("disabled");
    expect(policy.canReadSecrets).toBe(false);
    expect(policy.canRequestChanges).toBe(false);
  });

  test("allows restricted shell and push for trusted write actors", () => {
    const policy = defaultRuntimePolicy({
      actor: "maintainer",
      actorPermission: "write",
      event: "issue_comment",
      isFork: false,
      isPrivateRepo: false
    });

    expect(policy.shell).toBe("restricted");
    expect(policy.push).toBe("restricted");
    expect(policy.canCreatePr).toBe(true);
  });

  test("caps cannot escalate runtime policy", () => {
    const policy = defaultRuntimePolicy({
      actor: "external",
      actorPermission: "read",
      event: "pull_request",
      isFork: false,
      isPrivateRepo: false
    });

    const capped = applyRuntimeCaps(policy, { shell: "enabled", push: "enabled" });
    expect(capped.shell).toBe("disabled");
    expect(capped.push).toBe("disabled");
  });
});
