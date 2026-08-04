import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DefaultRedactor } from "../../core/src/redaction.ts";
import { defaultRuntimePolicy } from "../../core/src/policy.ts";
import { startShuvbotMcpServer, type ShuvbotMcpServer } from "../src/server.ts";
import type { ToolAuditRecord, ToolContext, ToolSpec } from "../src/tool-spec.ts";

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
      value: { type: "string" }
    }
  },
  outputSchema: {
    type: "object",
    required: ["value"],
    properties: {
      value: { type: "string" }
    }
  },
  requiredPolicy: { canComment: true },
  handler(input) {
    return { value: input.value };
  }
};

let server: ShuvbotMcpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("MCP server", () => {
  test("binds to 127.0.0.1 on an ephemeral port and serves registered tools", async () => {
    const audit: ToolAuditRecord[] = [];
    server = await startShuvbotMcpServer({
      tools: [echoTool as ToolSpec<unknown, unknown>],
      context: context(audit)
    });

    expect(server.url.hostname).toBe("127.0.0.1");
    expect(Number(server.url.port)).toBeGreaterThan(0);

    const client = new Client({ name: "fake-agent", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(server.url);
    await client.connect(transport as Transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("echo");

    const result = await client.callTool({ name: "echo", arguments: { value: "hello" } });
    expect(result.structuredContent).toEqual({ value: "hello" });
    expect(audit[0]).toMatchObject({
      toolName: "echo",
      policyDecision: "allowed"
    });

    await client.close();
  });

  test("returns sanitized MCP tool errors", async () => {
    const secretTool: ToolSpec<EchoInput, EchoOutput> = {
      ...echoTool,
      handler() {
        throw new Error("failed with CLAUDE_CODE_OAUTH_TOKEN=secret-token-value");
      }
    };
    const audit: ToolAuditRecord[] = [];
    server = await startShuvbotMcpServer({
      tools: [secretTool as ToolSpec<unknown, unknown>],
      context: context(audit)
    });

    const client = new Client({ name: "fake-agent", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(server.url);
    await client.connect(transport as Transport);

    const result = await client.callTool({ name: "echo", arguments: { value: "hello" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]).toMatchObject({
      type: "text",
      text: "failed with CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]"
    });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(audit[0]?.sanitizedError).not.toContain("secret-token-value");

    await client.close();
  });
});

function context(auditRecords: ToolAuditRecord[]): ToolContext {
  return {
    runId: "run-1",
    actor: "maintainer",
    mode: "review",
    policy: defaultRuntimePolicy({
      actor: "maintainer",
      actorPermission: "write",
      event: "issue_comment",
      isFork: false,
      isPrivateRepo: false
    }),
    redactor: new DefaultRedactor(),
    audit: {
      record(record) {
        auditRecords.push(record);
      }
    }
  };
}
