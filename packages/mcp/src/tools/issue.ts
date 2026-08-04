import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import {
  asArray,
  asRecord,
  labelsValue,
  numberValue,
  requireClient,
  requireRepo,
  stringValue
} from "./shared.ts";

interface NumberInput {
  number: number;
}

const NUMBER_INPUT_SCHEMA = {
  type: "object",
  required: ["number"],
  properties: {
    number: { type: "integer", minimum: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const getIssueTool: ToolSpec<NumberInput, Record<string, unknown>> = {
  name: "get_issue",
  description: "Return issue metadata, body, state, author, and labels.",
  inputSchema: NUMBER_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      {
        params: { owner: repo.owner, repo: repo.name, issue_number: input.number }
      }
    );
    const issue = asRecord(response.data);
    return {
      number: numberValue(issue, "number"),
      title: stringValue(issue, "title"),
      body: stringValue(issue, "body"),
      state: stringValue(issue, "state"),
      htmlUrl: stringValue(issue, "html_url"),
      user: stringValue(asRecord(issue.user), "login"),
      labels: labelsValue(issue),
      untrusted: true
    };
  }
};

export const getIssueCommentsTool: ToolSpec<NumberInput, Record<string, unknown>> = {
  name: "get_issue_comments",
  description: "Return issue or pull request timeline comments for an issue number.",
  inputSchema: NUMBER_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        params: { owner: repo.owner, repo: repo.name, issue_number: input.number, per_page: 100 }
      }
    );
    return {
      number: input.number,
      comments: asArray(response.data).map((comment) => {
        const commentRecord = asRecord(comment);
        return {
          id: numberValue(commentRecord, "id"),
          body: stringValue(commentRecord, "body"),
          user: stringValue(asRecord(commentRecord.user), "login"),
          createdAt: stringValue(commentRecord, "created_at"),
          updatedAt: stringValue(commentRecord, "updated_at"),
          htmlUrl: stringValue(commentRecord, "html_url"),
          untrusted: true
        };
      })
    };
  }
};

export const getReviewCommentsTool: ToolSpec<NumberInput, Record<string, unknown>> = {
  name: "get_review_comments",
  description:
    "Return pull request review comments, including path and position data where present.",
  inputSchema: NUMBER_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        params: { owner: repo.owner, repo: repo.name, pull_number: input.number, per_page: 100 }
      }
    );
    return {
      number: input.number,
      comments: asArray(response.data).map((comment) => {
        const commentRecord = asRecord(comment);
        return {
          id: numberValue(commentRecord, "id"),
          body: stringValue(commentRecord, "body"),
          path: stringValue(commentRecord, "path"),
          position: commentRecord.position ?? null,
          line: commentRecord.line ?? null,
          side: commentRecord.side ?? null,
          user: stringValue(asRecord(commentRecord.user), "login"),
          createdAt: stringValue(commentRecord, "created_at"),
          updatedAt: stringValue(commentRecord, "updated_at"),
          htmlUrl: stringValue(commentRecord, "html_url"),
          untrusted: true
        };
      })
    };
  }
};

export const issueTools = [getIssueTool, getIssueCommentsTool, getReviewCommentsTool] as const;
