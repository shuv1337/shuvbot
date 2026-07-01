import { describe, expect, test } from "bun:test";
import { runEvalHarness } from "./harness.ts";
import { replayGithubEventFixture } from "./replay-github-event.ts";
import { scoreResults } from "./score.ts";

describe("eval harness", () => {
  test("replays fixtures, scores cases, and preserves safety boundaries", async () => {
    const result = await runEvalHarness();
    expect(result.results.length).toBeGreaterThanOrEqual(17);
    expect(result.table).toContain("| total |");
    expect(scoreResults(result.results).failed).toBe(0);

    const replay = await replayGithubEventFixture("fixtures/events/pull_request.synchronize.json");
    expect(replay.redactedPayload).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(replay.canApprove).toBe(false);
    expect(replay.push).toBe("disabled");
  });

  test("hardening cases actually run a code sample through the review pipeline", async () => {
    const result = await runEvalHarness();
    const commandInjection = result.results.find((entry) => entry.id === "case:command-injection");
    expect(commandInjection?.passed).toBe(true);
    // Not vacuous: notes report which skill actually fired for the seeded diff,
    // not just that the case file declared a non-empty `expected` array.
    expect(commandInjection?.notes.join(" ")).toContain("found=security-review");
  });
});
