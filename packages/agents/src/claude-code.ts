import type { AgentDriver } from "./driver.ts";

export const claudeCodeDriverPlaceholder: Pick<AgentDriver, "id" | "displayName" | "supports"> = {
  id: "claude-code",
  displayName: "Claude Code",
  supports: {
    mcp: true,
    structuredOutput: false,
    repoEditing: true,
    oauthToken: true,
    apiKey: false
  }
};
