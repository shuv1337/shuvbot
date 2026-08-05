import { appendMarker, findExistingMarker, parseTrailingMarker } from "./comments.ts";
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
  botLogin: string;
}

export interface PostReviewResult {
  id: number;
  htmlUrl: string;
  dedupedComments: number;
  postedComments: number;
}

export type ReviewThreadResolution = "resolved" | "unresolved" | "unknown";

export interface ReviewFindingReply {
  id: number;
  body: string | null;
  authorLogin: string | null;
  createdAt: string | null;
  untrusted: true;
}

export interface ReviewFindingThread {
  fingerprint: string;
  markerKey: string;
  commentId: number;
  threadId?: number | string;
  path: string | null;
  line: number | null;
  resolution: ReviewThreadResolution;
  replies: ReviewFindingReply[];
}

export interface ReviewCommentsPage {
  comments: readonly unknown[];
  nextPage?: number | null;
}

export interface ReviewFindingIngestionLimits {
  maxPages: number;
  maxRootComments: number;
  maxRepliesPerRoot: number;
  maxTotalRecords: number;
}

export const DEFAULT_REVIEW_FINDING_INGESTION_LIMITS: Readonly<ReviewFindingIngestionLimits> =
  Object.freeze({
    maxPages: 100,
    maxRootComments: 10_000,
    maxRepliesPerRoot: 1_000,
    maxTotalRecords: 20_000
  });

export type ReviewFindingIngestionErrorCode =
  | "invalid_limit"
  | "invalid_page"
  | "page_limit_exceeded"
  | "root_comment_limit_exceeded"
  | "reply_limit_exceeded"
  | "total_record_limit_exceeded";

export class ReviewFindingIngestionError extends Error {
  override readonly name = "ReviewFindingIngestionError";

  constructor(
    readonly code: ReviewFindingIngestionErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface ReadReviewFindingThreadsInput {
  client: GitHubClient;
  repo: { owner: string; name: string };
  pullNumber: number;
  botLogin: string;
  limits?: Partial<ReviewFindingIngestionLimits>;
  loadPage?: (page: number) => Promise<ReviewCommentsPage>;
}

export async function readReviewFindingThreads(
  input: ReadReviewFindingThreadsInput
): Promise<ReviewFindingThread[]> {
  const limits = resolveIngestionLimits(input.limits);
  const roots: Record<string, unknown>[] = [];
  const repliesByRoot = new Map<number, ReviewFindingReply[]>();
  const seenPages = new Set<number>();
  let totalRecords = 0;
  let page: number | null = 1;

  while (page !== null) {
    if (seenPages.size >= limits.maxPages) {
      throw ingestionError(
        "page_limit_exceeded",
        "Review comment pagination exceeded limits.maxPages; increase the trusted ingestion limit or narrow the review history."
      );
    }
    if (!isPageNumber(page) || seenPages.has(page)) {
      throw ingestionError(
        "invalid_page",
        "Review comment pagination returned an invalid or repeated cursor; retry the GitHub request."
      );
    }
    seenPages.add(page);
    const result: ReviewCommentsPage = input.loadPage
      ? await input.loadPage(page)
      : await loadReviewCommentsPage(input, page);
    if (!Array.isArray(result.comments)) {
      throw ingestionError("invalid_page", "Review comment pagination returned an invalid page.");
    }
    if (totalRecords + result.comments.length > limits.maxTotalRecords) {
      throw ingestionError(
        "total_record_limit_exceeded",
        "Review comment ingestion exceeded limits.maxTotalRecords; increase the trusted ingestion limit or narrow the review history."
      );
    }
    totalRecords += result.comments.length;

    for (const value of result.comments) {
      const comment = asRecord(value);
      const rootId = optionalNumber(comment.in_reply_to_id);
      const id = optionalNumber(comment.id);
      if (rootId === undefined) {
        if (roots.length >= limits.maxRootComments) {
          throw ingestionError(
            "root_comment_limit_exceeded",
            "Review comment ingestion exceeded limits.maxRootComments; increase the trusted ingestion limit or narrow the review history."
          );
        }
        roots.push(comment);
        continue;
      }
      if (id === undefined) continue;
      const replies = repliesByRoot.get(rootId) ?? [];
      if (replies.length >= limits.maxRepliesPerRoot) {
        throw ingestionError(
          "reply_limit_exceeded",
          "A review thread exceeded limits.maxRepliesPerRoot; increase the trusted ingestion limit or narrow the review history."
        );
      }
      replies.push({
        id,
        body: nullableString(comment.body),
        authorLogin: authorLogin(comment),
        createdAt: nullableString(comment.created_at),
        untrusted: true
      });
      repliesByRoot.set(rootId, replies);
    }

    const nextPage = result.nextPage ?? null;
    if (nextPage !== null && (!isPageNumber(nextPage) || nextPage <= page)) {
      throw ingestionError(
        "invalid_page",
        "Review comment pagination returned a non-monotonic cursor; retry the GitHub request."
      );
    }
    page = nextPage;
  }

  const findings = new Map<string, ReviewFindingThread>();
  for (const comment of roots) {
    if (authorLogin(comment)?.toLowerCase() !== input.botLogin.toLowerCase()) continue;
    const id = optionalNumber(comment.id);
    const body = nullableString(comment.body);
    if (id === undefined || body === null) continue;
    const marker = parseTrailingMarker(body);
    if (marker === undefined) continue;
    const fingerprint = parseFindingFingerprint(marker.key);
    if (fingerprint === undefined || findings.has(fingerprint)) continue;

    const threadId = readThreadId(comment);
    findings.set(fingerprint, {
      fingerprint,
      markerKey: marker.key,
      commentId: id,
      ...(threadId === undefined ? {} : { threadId }),
      path: nullableString(comment.path),
      line: readLine(comment),
      resolution: readResolution(comment),
      replies: repliesByRoot.get(id) ?? []
    });
  }
  return [...findings.values()];
}

function parseFindingFingerprint(markerKey: string): string | undefined {
  if (/^finding:v1:[a-f0-9]{64}(?::collision:[a-f0-9]{64})?$/.test(markerKey)) {
    return markerKey;
  }
  const legacy = markerKey.match(/^finding:([a-f0-9]{64})$/);
  return legacy?.[1];
}

function resolveIngestionLimits(
  configured: Partial<ReviewFindingIngestionLimits> | undefined
): ReviewFindingIngestionLimits {
  const limits = { ...DEFAULT_REVIEW_FINDING_INGESTION_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw ingestionError(
        "invalid_limit",
        `Review comment ingestion ${name} must be a positive safe integer.`
      );
    }
  }
  return limits;
}

function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function ingestionError(
  code: ReviewFindingIngestionErrorCode,
  message: string
): ReviewFindingIngestionError {
  return new ReviewFindingIngestionError(code, message);
}

export async function postReview(input: PostReviewInput): Promise<PostReviewResult> {
  const existingComments: ReturnType<typeof asMarkerComment>[] = [];
  for (let page = 1; page <= DEFAULT_REVIEW_FINDING_INGESTION_LIMITS.maxPages; page += 1) {
    const existing = await input.client.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        params: {
          owner: input.repo.owner,
          repo: input.repo.name,
          pull_number: input.pullNumber,
          per_page: 100,
          page
        }
      }
    );
    const batch = Array.isArray(existing.data) ? existing.data : [];
    existingComments.push(
      ...batch
        .filter(
          (comment) =>
            authorLogin(asRecord(comment))?.toLowerCase() === input.botLogin.toLowerCase()
        )
        .map((comment) => asMarkerComment(comment))
    );
    if (
      page === DEFAULT_REVIEW_FINDING_INGESTION_LIMITS.maxPages &&
      batch.length === 100
    ) {
      throw ingestionError(
        "page_limit_exceeded",
        "Review comment lookup exceeded limits.maxPages; narrow the review history."
      );
    }
    if (batch.length < 100) break;
  }
  const comments = input.comments.filter(
    (comment) => !findExistingMarker(existingComments, comment.markerKey)
  );
  const response = await input.client.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
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
    }
  );
  // Publish the new review first. Existing comments are updated only after
  // GitHub accepts the review, so a rejected position cannot partially publish.
  for (const comment of input.comments) {
    const existing = findExistingMarker(existingComments, comment.markerKey);
    if (existing?.id === undefined) continue;
    const body = appendMarker(comment.body, comment.markerKey);
    if (existing.body === body) continue;
    await input.client.request("PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}", {
      params: {
        owner: input.repo.owner,
        repo: input.repo.name,
        comment_id: existing.id
      },
      body: { body }
    });
  }
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

export function dedupePreviousFindings(
  existingComments: readonly { body?: string | null }[],
  findings: readonly PipelineFinding[]
): PipelineFinding[] {
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

async function loadReviewCommentsPage(
  input: ReadReviewFindingThreadsInput,
  page: number
): Promise<ReviewCommentsPage> {
  const perPage = 100;
  const response = await input.client.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    {
      params: {
        owner: input.repo.owner,
        repo: input.repo.name,
        pull_number: input.pullNumber,
        per_page: perPage,
        page
      }
    }
  );
  const comments = Array.isArray(response.data) ? response.data : [];
  return { comments, nextPage: comments.length === perPage ? page + 1 : null };
}

function authorLogin(comment: Record<string, unknown>): string | null {
  return nullableString(asRecord(comment.user).login);
}

function readLine(comment: Record<string, unknown>): number | null {
  return optionalNumber(comment.line) ?? optionalNumber(comment.original_line) ?? null;
}

function readThreadId(comment: Record<string, unknown>): number | string | undefined {
  const thread = asRecord(comment.thread);
  return (
    optionalIdentifier(comment.thread_id) ??
    optionalIdentifier(comment.pull_request_review_thread_id) ??
    optionalIdentifier(thread.id)
  );
}

function readResolution(comment: Record<string, unknown>): ReviewThreadResolution {
  const thread = asRecord(comment.thread);
  const value =
    typeof comment.is_resolved === "boolean"
      ? comment.is_resolved
      : typeof comment.resolved === "boolean"
        ? comment.resolved
        : typeof thread.isResolved === "boolean"
          ? thread.isResolved
          : typeof thread.is_resolved === "boolean"
            ? thread.is_resolved
            : undefined;
  return value === true ? "resolved" : value === false ? "unresolved" : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalIdentifier(value: unknown): number | string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return optionalNumber(value);
}
