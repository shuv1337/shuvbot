import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/shuvbot.yml"
);

describe("repository review workflow security", () => {
  test("executes only trusted default-branch code with the provider credential", async () => {
    const source = await readFile(WORKFLOW, "utf8");

    expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(source).toContain("uses: ./");
    expect(source).not.toContain("refs/pull/");
    expect(source).not.toContain("steps.target.outputs.ref");
  });
});
