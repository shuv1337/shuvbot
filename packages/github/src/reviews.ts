import { appendMarker, findExistingMarker } from "./comments.ts";
import type { GitHubClient } from "./octokit.ts";
import type { PipelineFinding } from "../../core/src/review-pipeline.ts";

export interface ReviewCommentDraft {
  path: string;
  position: number;
  body: string;
  markerKey: string;
}

export interface PostReviewInput {
  client: GitHubClient;
  repo: { owner: string; name: string };
  pullNumber: number;
  body: string;
  comments: ReviewCommentDraft[];
  event: "COMMENT" | "REQUEST_CHANGES";
}

export interface PostReviewResult {
  id: number;
  htmlUrl: string;
  dedupedComments: number;
  postedComments: number;
}

export async function postReview(input: PostReviewInput): Promise<PostReviewResult> {
  const existing = await input.client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
    params: {
      owner: input.repo.owner,
      repo: input.repo.name,
      pull_number: input.pullNumber,
      per_page: 100
    }
  });
  const existingComments = Array.isArray(existing.data)
    ? existing.data.map((comment) => asMarkerComment(comment))
    : [];
  const comments = input.comments.filter((comment) => !findExistingMarker(existingComments, comment.markerKey));
  const response = await input.client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    params: {
      owner: input.repo.owner,
      repo: input.repo.name,
      pull_number: input.pullNumber
    },
    body: {
      body: input.body,
      event: input.event,
      comments: comments.map((comment) => ({
        path: comment.path,
        position: comment.position,
        body: appendMarker(comment.body, comment.markerKey)
      }))
    }
  });
  const review = asRecord(response.data);
  return {
    id: numberValue(review.id),
    htmlUrl: stringValue(review.html_url),
    dedupedComments: input.comments.length - comments.length,
    postedComments: comments.length
  };
}

export function fallbackToSummary(finding: PipelineFinding): string {
  const line = finding.line ?? finding.startLine;
  const location = line !== undefined ? `${finding.path}:${line}` : finding.path;
  return `- **${finding.severity}/${finding.confidence}** ${finding.title} (${location})\n  ${finding.body}`;
}

export function dedupePreviousFindings(existingComments: readonly { body?: string | null }[], findings: readonly PipelineFinding[]): PipelineFinding[] {
  return findings.filter((finding) => !findExistingMarker(existingComments, finding.markerKey));
}

function asMarkerComment(value: unknown): { id?: number; body?: string | null } {
  const record = asRecord(value);
  const result: { id?: number; body?: string | null } = {
    body: typeof record.body === "string" ? record.body : null
  };
  if (typeof record.id === "number") result.id = record.id;
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
