import { describe, expect, test } from "bun:test";
import { PolicyDeniedError } from "../../core/src/errors.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { AuditLog, createToolAuditRecord, summarizeToolAudit } from "../src/audit.ts";

describe("MCP audit log", () => {
  test("creates redacted records with stable digests", () => {
    const redactor = new DefaultRedactor();
    const first = createToolAuditRecord(
      {
        runId: "run-1",
        toolName: "get_pr",
        actor: "maintainer",
        mode: "review",
        status: "success",
        durationMs: 12,
        policyDecision: "allowed",
        input: { token: "secret-value", number: 1 },
        output: { ok: true }
      },
      redactor
    );
    const second = createToolAuditRecord(
      {
        runId: "run-1",
        toolName: "get_pr",
        actor: "maintainer",
        mode: "review",
        status: "success",
        durationMs: 12,
        policyDecision: "allowed",
        input: { number: 1, token: "different-secret" },
        output: { ok: true }
      },
      redactor
    );

    expect(first.sanitizedInput).toEqual({ token: "[REDACTED]", number: 1 });
    expect(first.inputDigest).toBe(second.inputDigest);
    expect(first.outputDigest).toBe(second.outputDigest);
  });

  test("captures sanitized errors and error codes", () => {
    const record = createToolAuditRecord(
      {
        runId: "run-1",
        toolName: "write_comment",
        actor: "reader",
        mode: "review",
        status: "failure",
        durationMs: 5,
        policyDecision: "denied",
        input: { body: "hello" },
        error: new PolicyDeniedError("denied with CLAUDE_CODE_OAUTH_TOKEN=secret-token-value"),
        errorCode: "POLICY_DENIED"
      },
      new DefaultRedactor()
    );

    expect(record.sanitizedError).toBe("denied with CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]");
    expect(record.errorCode).toBe("POLICY_DENIED");
    expect(JSON.stringify(record)).not.toContain("secret-token-value");
  });

  test("snapshots records and aggregate summaries", () => {
    const log = new AuditLog(new DefaultRedactor());
    log.record(
      log.createRecord({
        runId: "run-1",
        toolName: "get_pr",
        actor: "maintainer",
        mode: "review",
        status: "success",
        durationMs: 10,
        policyDecision: "allowed",
        input: {},
        output: { ok: true }
      })
    );
    log.record(
      log.createRecord({
        runId: "run-1",
        toolName: "write_comment",
        actor: "reader",
        mode: "review",
        status: "failure",
        durationMs: 7,
        policyDecision: "denied",
        input: {},
        error: new PolicyDeniedError("denied"),
        errorCode: "POLICY_DENIED"
      })
    );

    const snapshot = log.snapshot();
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.summary).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
      totalDurationMs: 17,
      byTool: {
        get_pr: {
          total: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          totalDurationMs: 10
        },
        write_comment: {
          total: 1,
          succeeded: 0,
          failed: 1,
          denied: 1,
          totalDurationMs: 7
        }
      }
    });
  });

  test("summarizes empty audit lists", () => {
    expect(summarizeToolAudit([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      denied: 0,
      totalDurationMs: 0,
      byTool: {}
    });
  });
});
