import type { ToolSchema, ToolSpec } from "../tool-spec.ts";

interface PrSummaryInput {
  pullNumber: number;
}

interface WritePrSummaryInput extends PrSummaryInput {
  summary: string;
}

interface RepoLearningsInput {
  namespace?: string;
}

interface WriteRepoLearningsInput extends RepoLearningsInput {
  learnings: string;
}

const PR_SUMMARY_INPUT_SCHEMA = {
  type: "object",
  required: ["pullNumber"],
  properties: {
    pullNumber: { type: "integer", minimum: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const WRITE_PR_SUMMARY_INPUT_SCHEMA = {
  type: "object",
  required: ["pullNumber", "summary"],
  properties: {
    pullNumber: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const REPO_LEARNINGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    namespace: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const WRITE_REPO_LEARNINGS_INPUT_SCHEMA = {
  type: "object",
  required: ["learnings"],
  properties: {
    namespace: { type: "string", minLength: 1 },
    learnings: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const readPrSummaryTool: ToolSpec<PrSummaryInput, Record<string, unknown>> = {
  name: "read_pr_summary",
  description: "Read a persisted PR summary when memory is configured. Defaults to null.",
  inputSchema: PR_SUMMARY_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const store = context.state?.enabled ? context.state.store : undefined;
    return {
      pullNumber: input.pullNumber,
      summary: store ? await store.readPrSummary(input.pullNumber) : null,
      enabled: Boolean(store),
      reason: store ? "ok" : "state backend is disabled"
    };
  }
};

export const writePrSummaryTool: ToolSpec<WritePrSummaryInput, Record<string, unknown>> = {
  name: "write_pr_summary",
  description: "Persist a PR summary when memory is configured. Defaults to no-op.",
  inputSchema: WRITE_PR_SUMMARY_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const store = context.state?.enabled ? context.state.store : undefined;
    if (store) await store.writePrSummary(input.pullNumber, context.redactor.redactString(input.summary));
    return {
      pullNumber: input.pullNumber,
      written: Boolean(store),
      enabled: Boolean(store),
      reason: store ? "ok" : "state backend is disabled"
    };
  }
};

export const readRepoLearningsTool: ToolSpec<RepoLearningsInput, Record<string, unknown>> = {
  name: "read_repo_learnings",
  description: "Read opt-in repo learnings. Defaults to null.",
  inputSchema: REPO_LEARNINGS_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const store = context.state?.enabled && context.state.learnings ? context.state.store : undefined;
    const namespace = input.namespace ?? "default";
    return {
      namespace,
      learnings: store ? await store.readRepoLearnings(namespace) : null,
      enabled: Boolean(store),
      reason: store ? "ok" : "repo learnings are disabled by default"
    };
  }
};

export const writeRepoLearningsTool: ToolSpec<WriteRepoLearningsInput, Record<string, unknown>> = {
  name: "write_repo_learnings",
  description: "Write opt-in repo learnings. Defaults to no-op.",
  inputSchema: WRITE_REPO_LEARNINGS_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const store = context.state?.enabled && context.state.learnings ? context.state.store : undefined;
    const namespace = input.namespace ?? "default";
    if (store) await store.writeRepoLearnings(namespace, context.redactor.redactString(input.learnings));
    return {
      namespace,
      written: Boolean(store),
      enabled: Boolean(store),
      reason: store ? "ok" : "repo learnings are disabled by default"
    };
  }
};

export const memoryTools = [
  readPrSummaryTool,
  writePrSummaryTool,
  readRepoLearningsTool,
  writeRepoLearningsTool
] as const;
