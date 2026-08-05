import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { APPROVED_SHUVCODE_RUNTIME_VERSION, loadConfigFile } from "../../core/src/config.ts";
import { assertReviewModelsReachable } from "../../review/src/runtime/auth.ts";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/shuvbot.yml"
);
const CI_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "../../../.github/shuvbot.ci.toml");

describe("repository review workflow security", () => {
  test("executes only trusted default-branch code with the provider credential", async () => {
    const source = await readFile(WORKFLOW, "utf8");

    expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(source).toContain("uses: ./");
    expect(source).not.toContain("refs/pull/");
    expect(source).not.toContain("steps.target.outputs.ref");
  });

  test("every model in the CI config is reachable with the credential the job supplies", async () => {
    // The first real Action run degraded to 0/6 coverage because the default
    // roster spans three providers while environment auth forwards one
    // credential. This asserts the committed CI config cannot regress to that.
    const config = await loadConfigFile(CI_CONFIG);
    expect(config.review.shuvcode.auth).toBe("environment");

    const workflow = await readFile(WORKFLOW, "utf8");
    expect(workflow).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "test-token" },
        models: config.review.models
      })
    ).not.toThrow();
  });

  test("the CI config pins the approved runtime", async () => {
    const config = await loadConfigFile(CI_CONFIG);
    // Null would mean no approved release exists, which the pin must never be.
    expect(APPROVED_SHUVCODE_RUNTIME_VERSION).not.toBeNull();
    expect(config.review.shuvcode.version).toBe(APPROVED_SHUVCODE_RUNTIME_VERSION!);
  });
});
