import { describe, expect, test } from "bun:test";
import { runReplay } from "./replay.ts";

describe("replay CLI", () => {
  test("runs a fixture in dry-run mode", async () => {
    let output = "";
    const result = await runReplay({
      fixture: "fixtures/events/issue_comment.mention.json",
      dryRun: true,
      stdout: {
        write(value: string) {
          output += value;
          return true;
        }
      }
    });
    expect(result.command).toBe("implement");
    expect(output).toContain('"dryRun": true');
  });
});
