import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import {
  asArray,
  asRecord,
  boundedString,
  booleanValue,
  labelsValue,
  numberValue,
  requireClient,
  requireRepo,
  stringValue
} from "./shared.ts";

interface NumberInput {
  number: number;
}

interface DiffInput extends NumberInput {
  maxBytes?: number;
}

const NUMBER_INPUT_SCHEMA = {
  type: "object",
  required: ["number"],
  properties: {
    number: { type: "integer", minimum: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const DIFF_INPUT_SCHEMA = {
  type: "object",
  required: ["number"],
  properties: {
    number: { type: "integer", minimum: 1 },
    maxBytes: { type: "integer", minimum: 1, maximum: 1_000_000 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const getPrTool: ToolSpec<NumberInput, Record<string, unknown>> = {
  name: "get_pr",
  description: "Return pull request metadata, merge state, and labels for the current repository.",
  inputSchema: NUMBER_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      params: { owner: repo.owner, repo: repo.name, pull_number: input.number }
    });
    const pr = asRecord(response.data);
    const head = asRecord(pr.head);
    const base = asRecord(pr.base);
    return {
      number: numberValue(pr, "number"),
      title: stringValue(pr, "title"),
      body: stringValue(pr, "body"),
      state: stringValue(pr, "state"),
      draft: booleanValue(pr, "draft"),
      htmlUrl: stringValue(pr, "html_url"),
      mergeable: pr.mergeable ?? null,
      mergeStateStatus: pr.mergeable_state ?? null,
      labels: labelsValue(pr),
      head: {
        ref: stringValue(head, "ref"),
        sha: stringValue(head, "sha"),
        repoFullName: stringValue(asRecord(head.repo), "full_name")
      },
      base: {
        ref: stringValue(base, "ref"),
        sha: stringValue(base, "sha"),
        repoFullName: stringValue(asRecord(base.repo), "full_name")
      }
    };
  }
};

export const getPrDiffTool: ToolSpec<DiffInput, Record<string, unknown>> = {
  name: "get_pr_diff",
  description: "Return the raw unified diff for a pull request, optionally truncated by maxBytes.",
  inputSchema: DIFF_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request<string>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      params: { owner: repo.owner, repo: repo.name, pull_number: input.number },
      headers: { accept: "application/vnd.github.v3.diff" },
      responseType: "text"
    });
    const maxBytes = input.maxBytes ?? 256_000;
    const bounded = boundedString(response.data, maxBytes);
    return {
      number: input.number,
      diff: bounded.text,
      truncated: bounded.truncated,
      bytes: bounded.bytes,
      untrusted: true
    };
  }
};

export const getPrFilesTool: ToolSpec<NumberInput, Record<string, unknown>> = {
  name: "get_pr_files",
  description: "Return changed files for a pull request with minimal per-file metadata.",
  inputSchema: NUMBER_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      params: { owner: repo.owner, repo: repo.name, pull_number: input.number, per_page: 100 }
    });
    return {
      number: input.number,
      files: asArray(response.data).map((file) => {
        const fileRecord = asRecord(file);
        return {
          filename: stringValue(fileRecord, "filename"),
          status: stringValue(fileRecord, "status"),
          additions: numberValue(fileRecord, "additions"),
          deletions: numberValue(fileRecord, "deletions"),
          patch: stringValue(fileRecord, "patch")
        };
      })
    };
  }
};

export const prTools = [getPrTool, getPrDiffTool, getPrFilesTool] as const;
