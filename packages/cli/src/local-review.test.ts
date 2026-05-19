import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { runLocalReview } from "./local-review.ts";

const execFileAsync = promisify(execFile);

describe("local review CLI", () => {
  test("runs review mode against a local base/head pair", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewbot-local-review-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd });
    await execFileAsync("git", ["config", "user.email", "reviewbot@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "reviewbot"], { cwd });
    await writeFile(join(cwd, "a.ts"), "const a = 1;\n");
    await execFileAsync("git", ["add", "a.ts"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd });
    await writeFile(join(cwd, "a.ts"), "const a = 2;\n");
    await execFileAsync("git", ["commit", "-am", "change"], { cwd });

    let output = "";
    const result = await runLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      stdout: {
        write(value: string) {
          output += value;
          return true;
        }
      },
      agentFindings: [
        {
          id: "one",
          skill: "code-review",
          title: "Check behavior",
          body: "Review this change.",
          severity: "medium",
          confidence: "high",
          path: "a.ts",
          line: 1
        }
      ]
    });

    expect(result.findings).toHaveLength(1);
    expect(output).toContain("Check behavior");
  });
});
