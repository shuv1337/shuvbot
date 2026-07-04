import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import type { ToolContext, ToolSchema, ToolSpec } from "./tool-spec.ts";
import { executeTool } from "./tool-spec.ts";

export interface ReviewbotMcpServer {
  url: URL;
  close(): Promise<void>;
}

export interface StartMcpServerInput {
  tools: readonly ToolSpec<unknown, unknown>[];
  context: ToolContext;
}

export async function startReviewbotMcpServer(
  input: StartMcpServerInput
): Promise<ReviewbotMcpServer> {
  const httpServer = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
      });
      return;
    }

    const server = createMcpServer(input.tools, input.context);
    const transport = new StreamableHTTPServerTransport(STREAMABLE_HTTP_STATELESS_OPTIONS);
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, await readJsonBody(request));
    } catch {
      if (!response.headersSent) {
        writeJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to determine MCP server address");

  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

function createMcpServer(
  tools: readonly ToolSpec<unknown, unknown>[],
  context: ToolContext
): McpServer {
  const server = new McpServer(
    {
      name: "reviewbot-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schemaToZod(tool.inputSchema),
        outputSchema: schemaToZod(tool.outputSchema)
      },
      async (args) => {
        try {
          const output = await executeTool(tool, args, context);
          const structuredContent = toStructuredContent(output);
          return {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: sanitizeError(error, context) }]
          };
        }
      }
    );
  }

  return server;
}

function schemaToZod(schema: ToolSchema): z.ZodType {
  switch (schema.type) {
    case "object": {
      const shape = Object.fromEntries(
        Object.entries(schema.properties).map(([key, property]) => {
          const child = schemaToZod(property);
          return [key, schema.required?.includes(key) ? child : child.optional()];
        })
      );
      const objectSchema = z.object(shape);
      return schema.additionalProperties === true ? objectSchema : objectSchema.strict();
    }
    case "array":
      return z.array(schemaToZod(schema.items));
    case "string": {
      if (schema.enum) {
        return z.enum(
          Object.fromEntries(schema.enum.map((value) => [value, value])) as Record<string, string>
        );
      }
      let stringSchema = z.string();
      if (schema.minLength !== undefined) stringSchema = stringSchema.min(schema.minLength);
      return stringSchema;
    }
    case "number": {
      let numberSchema = z.number();
      if (schema.minimum !== undefined) numberSchema = numberSchema.min(schema.minimum);
      if (schema.maximum !== undefined) numberSchema = numberSchema.max(schema.maximum);
      return numberSchema;
    }
    case "integer": {
      let integerSchema = z.number().int();
      if (schema.minimum !== undefined) integerSchema = integerSchema.min(schema.minimum);
      if (schema.maximum !== undefined) integerSchema = integerSchema.max(schema.maximum);
      return integerSchema;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function toStructuredContent(output: unknown): Record<string, unknown> {
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return { value: output };
}

function sanitizeError(error: unknown, context: ToolContext): string {
  const message = error instanceof Error ? error.message : String(error);
  return context.redactor.redactString(message);
}

const STREAMABLE_HTTP_STATELESS_OPTIONS = {
  sessionIdGenerator: undefined
} as unknown as StreamableHTTPServerTransportOptions;
