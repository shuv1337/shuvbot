import { describe, expect, test } from "bun:test";
import { PolicyDeniedError, StructuredOutputError } from "../../core/src/errors.ts";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import type { PolicyInput } from "../../core/src/policy.ts";
import {
  executeTool,
  type ToolAuditRecord,
  type ToolContext,
  type ToolSpec
} from "../src/tool-spec.ts";

interface EchoInput {
  value: string;
}

interface EchoOutput {
  value: string;
}

const echoTool: ToolSpec<EchoInput, EchoOutput> = {
  name: "echo",
  description: "Echoes a value.",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: {
      value: { type: "string", minLength: 1 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["value"],
    properties: {
      value: { type: "string" }
    }
  },
  requiredPolicy: {
    canComment: true
  },
  handler(input) {
    return { value: input.value };
  }
};

describe("tool spec execution", () => {
  test("validates input and returns validated output", async () => {
    const audit: ToolAuditRecord[] = [];
    const result = await executeTool(echoTool, { value: "ok" }, context(audit));

    expect(result).toEqual({ value: "ok" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      runId: "run-1",
      toolName: "echo",
      actor: "maintainer",
      mode: "review",
      status: "success",
      sanitizedInput: { value: "ok" },
      sanitizedOutput: { value: "ok" },
      policyDecision: "allowed"
    });
    expect(audit[0]?.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(audit[0]?.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects invalid tool input before handler execution", async () => {
    const audit: ToolAuditRecord[] = [];
    await expect(executeTool(echoTool, { value: "" }, context(audit))).rejects.toBeInstanceOf(
      StructuredOutputError
    );

    expect(audit).toHaveLength(1);
    expect(audit[0]?.sanitizedError).toContain("input schema failed");
  });

  test("catches invalid tool output", async () => {
    const badOutputTool: ToolSpec<EchoInput, EchoOutput> = {
      ...echoTool,
      handler() {
        return { value: 12 } as unknown as EchoOutput;
      }
    };

    const audit: ToolAuditRecord[] = [];
    await expect(
      executeTool(badOutputTool, { value: "ok" }, context(audit))
    ).rejects.toBeInstanceOf(StructuredOutputError);

    expect(audit[0]?.sanitizedError).toContain("output schema failed");
  });

  test("enforces runtime policy requirements", async () => {
    const writeTool: ToolSpec<EchoInput, EchoOutput> = {
      ...echoTool,
      name: "write_comment",
      requiredPolicy: { canUpdatePullRequest: true }
    };

    const audit: ToolAuditRecord[] = [];
    const deniedContext = context(audit, {
      actor: "reader",
      actorPermission: "read",
      event: "pull_request",
      isFork: true,
      isPrivateRepo: false
    });

    await expect(executeTool(writeTool, { value: "ok" }, deniedContext)).rejects.toBeInstanceOf(
      PolicyDeniedError
    );
    expect(audit[0]).toMatchObject({
      toolName: "write_comment",
      status: "failure",
      errorCode: "POLICY_DENIED",
      policyDecision: "denied"
    });
  });

  test("redacts audit inputs, outputs, and errors", async () => {
    const secretTool: ToolSpec<EchoInput, EchoOutput> = {
      ...echoTool,
      handler() {
        throw new Error("failed with CLAUDE_CODE_OAUTH_TOKEN=secret-token-value");
      }
    };

    const audit: ToolAuditRecord[] = [];
    await expect(
      executeTool(secretTool, { value: "ghp_123456789012345678901234" }, context(audit))
    ).rejects.toThrow("secret-token-value");

    expect(audit[0]?.sanitizedInput).toEqual({ value: "[REDACTED]" });
    expect(audit[0]?.sanitizedError).toContain("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]");
    expect(audit[0]?.sanitizedError).not.toContain("secret-token-value");
    expect(audit[0]?.status).toBe("failure");
  });
});

function context(
  auditRecords: ToolAuditRecord[],
  policyInput: PolicyInput = {
    actor: "maintainer",
    actorPermission: "write",
    event: "issue_comment",
    isFork: false,
    isPrivateRepo: false
  }
): ToolContext {
  return {
    runId: "run-1",
    actor: policyInput.actor,
    mode: "review",
    policy: defaultRuntimePolicy(policyInput),
    redactor: new DefaultRedactor(),
    audit: {
      record(record) {
        auditRecords.push(record);
      }
    },
    now: () => 100
  };
}
