import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import { asArray, asRecord, readWorkspaceFile, requireClient, requireRepo, stringValue } from "./shared.ts";

interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

interface SearchRepoInput {
  query: string;
  limit?: number;
}

const READ_FILE_INPUT_SCHEMA = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1 },
    maxBytes: { type: "integer", minimum: 1, maximum: 1_000_000 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const SEARCH_REPO_INPUT_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const readFileTool: ToolSpec<ReadFileInput, Record<string, unknown>> = {
  name: "read_file",
  description: "Read a bounded UTF-8 file from the workspace. Absolute paths and path escapes are refused.",
  inputSchema: READ_FILE_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    return readWorkspaceFile(context, input.path, input.maxBytes ?? 128_000);
  }
};

export const searchRepoTool: ToolSpec<SearchRepoInput, Record<string, unknown>> = {
  name: "search_repo",
  description: "Search repository code with a bounded result count.",
  inputSchema: SEARCH_REPO_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const query = `${input.query} repo:${repo.owner}/${repo.name}`;
    const response = await requireClient(context).request("GET /search/code", {
      params: { q: query, per_page: input.limit ?? 20 }
    });
    const data = asRecord(response.data);
    return {
      query,
      totalCount: data.total_count ?? 0,
      incompleteResults: data.incomplete_results ?? false,
      items: asArray(data.items).slice(0, input.limit ?? 20).map((item) => {
        const itemRecord = asRecord(item);
        const repoRecord = asRecord(itemRecord.repository);
        return {
          name: stringValue(itemRecord, "name"),
          path: stringValue(itemRecord, "path"),
          sha: stringValue(itemRecord, "sha"),
          htmlUrl: stringValue(itemRecord, "html_url"),
          repository: stringValue(repoRecord, "full_name")
        };
      })
    };
  }
};

export const filesTools = [readFileTool, searchRepoTool] as const;
