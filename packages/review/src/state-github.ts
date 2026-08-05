import { appendMarker, findExistingMarker } from "../../github/src/comments.ts";
import type { GitHubClient } from "../../github/src/octokit.ts";
import { readReviewFindingThreads, type ReviewFindingThread } from "../../github/src/reviews.ts";
import type { Redactor } from "../../core/src/redaction.ts";
import {
  parsePersistedReviewState,
  type PersistedFindingState,
  type PersistedReviewState,
  type ReviewStateOperationOptions,
  type ReviewStateStore
} from "./state.ts";

/**
 * Bounds on what is persisted into a single GitHub comment.
 *
 * A comment body is capped at 65536 characters, and review state is the only
 * thing standing between a re-review and reposting every finding, so it must
 * never fail to write. Findings are bounded, untrusted reply text is bounded
 * harder, and if the body still does not fit the least severe findings are
 * dropped rather than the write being abandoned.
 */
export interface GitHubReviewStateLimits {
  readonly maxBodyBytes: number;
  readonly maxFindings: number;
  readonly maxEvidenceChars: number;
  readonly maxRepliesPerFinding: number;
  readonly maxReplyChars: number;
}

export const DEFAULT_GITHUB_REVIEW_STATE_LIMITS: Readonly<GitHubReviewStateLimits> = Object.freeze({
  maxBodyBytes: 60_000,
  maxFindings: 200,
  maxEvidenceChars: 1_000,
  maxRepliesPerFinding: 10,
  maxReplyChars: 500
});

const STATE_MARKER_KEY = "review-state:v1";
const STATE_FENCE = "shuvbot-review-state";
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 100;

export interface GitHubReviewStateStoreInput {
  readonly client: GitHubClient;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly pullNumber: number;
  readonly redactor: Redactor;
  /** Login whose review comments own finding threads, for reply ingestion. */
  readonly botLogin: string;
  readonly limits?: Partial<GitHubReviewStateLimits>;
  /** Injected in tests; defaults to real thread ingestion. */
  readonly readThreads?: typeof readReviewFindingThreads;
}

/**
 * Finding-lifecycle state stored GitHub-natively, in a hidden marker comment on
 * the pull request, with no backend of any kind.
 *
 * Reading also ingests the bot's own finding threads, because a maintainer's
 * reply or a resolved thread is the only signal that a finding was handled by a
 * human rather than by a code change. Without that merge, `user_resolved` is
 * unreachable and a dismissed finding returns on the next push.
 */
export class GitHubReviewStateStore implements ReviewStateStore {
  private readonly limits: GitHubReviewStateLimits;

  constructor(private readonly input: GitHubReviewStateStoreInput) {
    this.limits = { ...DEFAULT_GITHUB_REVIEW_STATE_LIMITS, ...input.limits };
  }

  async readReviewState(
    changeId: string,
    options: ReviewStateOperationOptions = {}
  ): Promise<PersistedReviewState | null> {
    const stored = await withinDeadline(
      this.readStoredState(changeId),
      options.deadlineAtMs,
      "review state read"
    );
    if (stored === null) return null;

    // Thread ingestion is best effort: losing reply signal degrades a
    // re-review to reposting, while failing the read would lose the state
    // entirely and repost everything.
    let threads: readonly ReviewFindingThread[] = [];
    try {
      threads = await withinDeadline(
        (this.input.readThreads ?? readReviewFindingThreads)({
          client: this.input.client,
          repo: this.input.repo,
          pullNumber: this.input.pullNumber,
          botLogin: this.input.botLogin
        }),
        options.deadlineAtMs,
        "review thread ingestion"
      );
    } catch {
      return stored;
    }

    return { ...stored, findings: this.mergeThreadSignals(stored.findings, threads) };
  }

  async writeReviewState(
    changeId: string,
    state: PersistedReviewState,
    options: ReviewStateOperationOptions = {}
  ): Promise<void> {
    const validated = parsePersistedReviewState(state, changeId);
    const body = this.renderBody(this.input.redactor.redact(this.bound(validated)));
    const existing = findExistingMarker(await this.issueComments(), STATE_MARKER_KEY);

    if (existing?.id !== undefined) {
      await withinDeadline(
        this.input.client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          params: {
            owner: this.input.repo.owner,
            repo: this.input.repo.name,
            comment_id: existing.id
          },
          body: { body }
        }),
        options.deadlineAtMs,
        "review state update"
      );
      return;
    }

    await withinDeadline(
      this.input.client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        params: {
          owner: this.input.repo.owner,
          repo: this.input.repo.name,
          issue_number: this.input.pullNumber
        },
        body: { body }
      }),
      options.deadlineAtMs,
      "review state creation"
    );
  }

  private async readStoredState(changeId: string): Promise<PersistedReviewState | null> {
    const existing = findExistingMarker(await this.issueComments(), STATE_MARKER_KEY);
    const encoded = typeof existing?.body === "string" ? extractState(existing.body) : undefined;
    if (encoded === undefined) return null;
    try {
      return parsePersistedReviewState(JSON.parse(encoded), changeId);
    } catch {
      // A damaged or foreign state comment must not fail the review. Treating
      // it as absent costs one round of duplicate findings; throwing costs the
      // whole run.
      return null;
    }
  }

  /**
   * Applies human signal from the bot's finding threads onto stored findings.
   * Reply text is untrusted: it is bounded and redacted, and it can only move a
   * finding to `user_resolved`, never re-open or escalate one.
   */
  private mergeThreadSignals(
    findings: readonly PersistedFindingState[],
    threads: readonly ReviewFindingThread[]
  ): PersistedFindingState[] {
    const byFingerprint = new Map(threads.map((thread) => [thread.fingerprint, thread]));
    return findings.map((finding) => {
      const thread = byFingerprint.get(finding.fingerprint);
      if (thread === undefined) return finding;

      const replies = thread.replies
        .map((reply) => reply.body)
        .filter((body): body is string => typeof body === "string" && body.trim().length > 0)
        .slice(-this.limits.maxRepliesPerFinding)
        .map((body) => this.input.redactor.redactString(body.slice(0, this.limits.maxReplyChars)));

      const merged: PersistedFindingState = {
        ...finding,
        priorCommentId: String(thread.commentId),
        userReplies: replies
      };
      if (thread.resolution === "resolved" && finding.status !== "dismissed") {
        merged.status = "user_resolved";
      }
      return merged;
    });
  }

  /** Trims state to what a single comment can hold, severest findings first. */
  private bound(state: PersistedReviewState): PersistedReviewState {
    const ranked = [...state.findings]
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
      .slice(0, this.limits.maxFindings)
      .map((finding) => ({
        ...finding,
        evidence: finding.evidence.slice(0, this.limits.maxEvidenceChars),
        userReplies: finding.userReplies
          .slice(-this.limits.maxRepliesPerFinding)
          .map((reply) => reply.slice(0, this.limits.maxReplyChars))
      }));

    let findings = ranked;
    while (
      findings.length > 0 &&
      Buffer.byteLength(this.renderBody({ ...state, findings }), "utf8") > this.limits.maxBodyBytes
    ) {
      findings = findings.slice(0, Math.max(0, findings.length - Math.ceil(findings.length / 10)));
    }
    return { ...state, findings };
  }

  private renderBody(state: PersistedReviewState): string {
    const dropped = state.findings.length;
    const summary =
      "shuvbot review state. This comment lets shuvbot avoid reposting findings you have " +
      `already seen or resolved; deleting it makes the next review start fresh. Tracking ${dropped} ` +
      `finding${dropped === 1 ? "" : "s"}.`;
    const payload = [
      `<details><summary>Review state (do not edit)</summary>`,
      "",
      "```" + STATE_FENCE,
      JSON.stringify(state),
      "```",
      "",
      "</details>"
    ].join("\n");
    return appendMarker(`${summary}\n\n${payload}`, STATE_MARKER_KEY);
  }

  private async issueComments(): Promise<Array<{ id?: number; body?: string | null }>> {
    const comments: unknown[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const response = await this.input.client.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          params: {
            owner: this.input.repo.owner,
            repo: this.input.repo.name,
            issue_number: this.input.pullNumber,
            per_page: COMMENTS_PER_PAGE,
            page
          }
        }
      );
      const batch = Array.isArray(response.data) ? response.data : [];
      comments.push(
        ...batch.filter((comment) => {
          if (typeof comment !== "object" || comment === null) return false;
          const user = (comment as Record<string, unknown>).user;
          if (typeof user !== "object" || user === null) return false;
          const login = (user as Record<string, unknown>).login;
          return (
            typeof login === "string" && login.toLowerCase() === this.input.botLogin.toLowerCase()
          );
        })
      );
      if (page === MAX_COMMENT_PAGES && batch.length === COMMENTS_PER_PAGE) {
        throw new Error("Review state comment lookup exceeded its bounded page limit");
      }
      if (batch.length < COMMENTS_PER_PAGE) break;
    }
    return comments.map((comment) => {
      const record = (typeof comment === "object" && comment !== null ? comment : {}) as Record<
        string,
        unknown
      >;
      return {
        ...(typeof record.id === "number" ? { id: record.id } : {}),
        body: typeof record.body === "string" ? record.body : null
      };
    });
  }
}

function extractState(body: string): string | undefined {
  const match = body.match(new RegExp("```" + STATE_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "m"));
  return match?.[1];
}

function severityRank(severity: PersistedFindingState["severity"]): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadlineAtMs: number | undefined,
  stage: string
): Promise<T> {
  if (deadlineAtMs === undefined) return operation;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new Error(`${stage} exceeded the overall deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${stage} exceeded the overall deadline`)),
          remaining
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
