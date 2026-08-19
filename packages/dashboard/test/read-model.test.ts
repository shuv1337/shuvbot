import { describe, expect, test } from "bun:test";
import { parseRunFilters } from "../src/read-model.ts";

describe("dashboard run filters", () => {
  test("parses and normalizes bounded filters", () => {
    const filters = parseRunFilters(
      new URL(
        "https://dashboard.test/api/runs?repository=example%2Frepo&subject_kind=pull_request&subject_number=3&status=success&command=review&severity=high&from=2026-08-01&to=2026-08-20&limit=25"
      )
    );
    expect(filters).toMatchObject({
      repository: "example/repo",
      subjectKind: "pull_request",
      subjectNumber: 3,
      status: "success",
      command: "review",
      severity: "high",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-20T23:59:59.999Z",
      limit: 25
    });
  });

  test("rejects unbounded and unknown filters", () => {
    expect(() => parseRunFilters(new URL("https://dashboard.test/api/runs?limit=101"))).toThrow(
      "limit must be at most 100"
    );
    expect(() =>
      parseRunFilters(new URL("https://dashboard.test/api/runs?severity=emergency"))
    ).toThrow("severity is invalid");
  });
});
