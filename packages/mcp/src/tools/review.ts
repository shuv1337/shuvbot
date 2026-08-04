import { appendMarker, findExistingMarker } from "../../../github/src/comments.ts";
import { ToolExecutionError } from "../../../core/src/errors.ts";
import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import {
  asArray,
  asRecord,
  numberValue,
  requireClient,
  requireRepo,
  stringValue
} from "./shared.ts";

interface ReviewCommentInput {
  path: string;
  position: number;
  body: string;
}

interface CreatePullRequestReviewInput {
  number: number;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  comments?: ReviewCommentInput[];
  markerKey?: string;
  markerPayload?: unknown;
}

const REVIEW_COMMENT_INPUT_SCHEMA = {
  type: "object",
  required: ["path", "position", "body"],
  properties: {
    path: { type: "string", minLength: 1 },
    position: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} satisfies ToolSchema;

const CREATE_REVIEW_INPUT_SCHEMA = {
  type: "object",
  required: ["number", "body", "event"],
  properties: {
    number: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 },
    event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"] },
    comments: { type: "array", items: REVIEW_COMMENT_INPUT_SCHEMA },
    markerKey: { type: "string", minLength: 1 },
    markerPayload: { type: "object", properties: {}, additionalProperties: true }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const createPullRequestReviewTool: ToolSpec<
  CreatePullRequestReviewInput,
  Record<string, unknown>
> = {
  name: "create_pull_request_review",
  description: "Create a pull request review. APPROVE is rejected for v1.",
  inputSchema: CREATE_REVIEW_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canReview: true },
  async handler(input, context) {
    if (input.event === "APPROVE") {
      throw new ToolExecutionError("create_pull_request_review rejects APPROVE in v1");
    }
    const repo = requireRepo(context);
    const client = requireClient(context);

    if (input.markerKey !== undefined) {
      const existing = await client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
          params: { owner: repo.owner, repo: repo.name, pull_number: input.number, per_page: 100 }
        }
      );
      const existingComment = findExistingMarker(
        asArray(existing.data).map((comment) => {
          const record = asRecord(comment);
          return { id: numberValue(record, "id"), body: stringValue(record, "body") };
        }),
        input.markerKey
      );
      if (existingComment !== undefined) {
        return {
          id: existingComment.id ?? 0,
          deduped: true,
          event: input.event
        };
      }
    }

    const markerBody =
      input.markerKey !== undefined
        ? appendMarker(input.body, input.markerKey, input.markerPayload ?? {})
        : input.body;
    const comments = (input.comments ?? []).map((comment, index) => ({
      path: comment.path,
      position: comment.position,
      body:
        input.markerKey !== undefined && index === 0
          ? appendMarker(comment.body, input.markerKey, input.markerPayload ?? {})
          : comment.body
    }));
    const response = await client.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        params: { owner: repo.owner, repo: repo.name, pull_number: input.number },
        body: {
          body: markerBody,
          event: input.event,
          comments
        }
      }
    );
    const review = asRecord(response.data);
    return {
      id: numberValue(review, "id"),
      htmlUrl: stringValue(review, "html_url"),
      state: stringValue(review, "state"),
      event: input.event,
      deduped: false
    };
  }
};

export const reviewTools = [createPullRequestReviewTool] as const;
