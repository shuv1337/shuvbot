import type { AgentId } from "../../core/src/types.ts";

export interface AgentContext {
  cwd: string;
}

export interface AgentRunInput {
  prompt: string;
  systemPrompt?: string;
  mcpServerUrl?: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
  activityTimeoutMs: number;
  env: Record<string, string | undefined>;
}

export interface AgentRunResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface AgentDriver {
  id: AgentId;
  displayName: string;
  prepare(ctx: AgentContext): Promise<void>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  supports: {
    mcp: boolean;
    structuredOutput: boolean;
    repoEditing: boolean;
    oauthToken: boolean;
    apiKey: boolean;
  };
}
