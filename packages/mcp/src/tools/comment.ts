import { appendMarker, findExistingMarker } from "../../../github/src/comments.ts";
import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import { asArray, asRecord, numberValue, requireClient, requireRepo, stringValue } from "./shared.ts";

interface CreateIssueCommentInput {
  issueNumber: number;
  body: string;
  markerKey?: string;
  markerPayload?: unknown;
}

interface EditIssueCommentInput {
  commentId: number;
  body: string;
}

interface UpdatePullRequestBodyInput {
  number: number;
  body: string;
}

interface ReplyToReviewCommentInput {
  commentId: number;
  body: string;
}

const CREATE_COMMENT_INPUT_SCHEMA = {
  type: "object",
  required: ["issueNumber", "body"],
  properties: {
    issueNumber: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 },
    markerKey: { type: "string", minLength: 1 },
    markerPayload: { type: "object", properties: {}, additionalProperties: true }
  },
  additionalProperties: false
} satisfies ToolSchema;

const EDIT_COMMENT_INPUT_SCHEMA = {
  type: "object",
  required: ["commentId", "body"],
  properties: {
    commentId: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const UPDATE_PR_BODY_INPUT_SCHEMA = {
  type: "object",
  required: ["number", "body"],
  properties: {
    number: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const REPLY_REVIEW_COMMENT_INPUT_SCHEMA = {
  type: "object",
  required: ["commentId", "body"],
  properties: {
    commentId: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const createIssueCommentTool: ToolSpec<CreateIssueCommentInput, Record<string, unknown>> = {
  name: "create_issue_comment",
  description: "Create or update a deduped issue/PR comment using an optional reviewbot hidden marker.",
  inputSchema: CREATE_COMMENT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canComment: true },
  async handler(input, context) {
    const repo = requireRepo(context);
    const client = requireClient(context);
    const body =
      input.markerKey !== undefined ? appendMarker(input.body, input.markerKey, input.markerPayload ?? {}) : input.body;

    if (input.markerKey !== undefined) {
      const existing = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        params: { owner: repo.owner, repo: repo.name, issue_number: input.issueNumber, per_page: 100 }
      });
      const existingComment = findExistingMarker(
        asArray(existing.data).map((comment) => {
          const record = asRecord(comment);
          return { id: numberValue(record, "id"), body: stringValue(record, "body") };
        }),
        input.markerKey
      );
      if (existingComment?.id !== undefined) {
        const response = await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          params: { owner: repo.owner, repo: repo.name, comment_id: existingComment.id },
          body: { body }
        });
        return summarizeCommentResponse(response.data, true);
      }
    }

    const response = await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      params: { owner: repo.owner, repo: repo.name, issue_number: input.issueNumber },
      body: { body }
    });
    return summarizeCommentResponse(response.data, false);
  }
};

export const editIssueCommentTool: ToolSpec<EditIssueCommentInput, Record<string, unknown>> = {
  name: "edit_issue_comment",
  description: "Edit an existing issue comment.",
  inputSchema: EDIT_COMMENT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canComment: true },
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      params: { owner: repo.owner, repo: repo.name, comment_id: input.commentId },
      body: { body: input.body }
    });
    return summarizeCommentResponse(response.data, false);
  }
};

export const replyToReviewCommentTool: ToolSpec<ReplyToReviewCommentInput, Record<string, unknown>> = {
  name: "reply_to_review_comment",
  description: "Reply to an existing pull request review comment.",
  inputSchema: REPLY_REVIEW_COMMENT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canReview: true },
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request(
      "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies",
      {
        params: { owner: repo.owner, repo: repo.name, comment_id: input.commentId },
        body: { body: input.body }
      }
    );
    return summarizeCommentResponse(response.data, false);
  }
};

export const updatePullRequestBodyTool: ToolSpec<UpdatePullRequestBodyInput, Record<string, unknown>> = {
  name: "update_pull_request_body",
  description: "Update a pull request body.",
  inputSchema: UPDATE_PR_BODY_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canUpdatePullRequest: true },
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      params: { owner: repo.owner, repo: repo.name, pull_number: input.number },
      body: { body: input.body }
    });
    const pr = asRecord(response.data);
    return {
      number: numberValue(pr, "number"),
      body: stringValue(pr, "body"),
      htmlUrl: stringValue(pr, "html_url")
    };
  }
};

export const commentTools = [
  createIssueCommentTool,
  editIssueCommentTool,
  replyToReviewCommentTool,
  updatePullRequestBodyTool
] as const;

function summarizeCommentResponse(data: unknown, deduped: boolean): Record<string, unknown> {
  const record = asRecord(data);
  return {
    id: numberValue(record, "id"),
    htmlUrl: stringValue(record, "html_url"),
    body: stringValue(record, "body"),
    deduped
  };
}
