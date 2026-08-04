import { disambiguateFindingFingerprint, type CoordinatedFinding } from "./results.ts";
import type { PersistedFindingState, PersistedReviewState } from "./state.ts";

export interface ReconcileReviewStateInput {
  changeId: string;
  baseSha: string;
  headSha: string;
  findings: readonly CoordinatedFinding[];
  previous: PersistedReviewState | null;
  degraded: boolean;
  now?: () => Date;
}

export interface ReconcileReviewStateResult {
  state: PersistedReviewState;
  activeFindings: CoordinatedFinding[];
  fixedFingerprints: string[];
  preservedResolvedFingerprints: string[];
}

export function reconcileReviewState(input: ReconcileReviewStateInput): ReconcileReviewStateResult {
  if (input.previous && input.previous.changeId !== input.changeId) {
    throw new TypeError("previous review state belongs to a different change");
  }
  const previousByFingerprint = new Map(
    (input.previous?.findings ?? []).map((finding) => [finding.fingerprint, finding])
  );
  const findings = resolveFingerprintCollisions(input.findings);
  const currentByFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));

  const activeFindings: CoordinatedFinding[] = [];
  const persisted: PersistedFindingState[] = [];
  const fixedFingerprints: string[] = [];
  const preservedResolvedFingerprints: string[] = [];

  for (const finding of findings) {
    const previous = previousByFingerprint.get(finding.fingerprint);
    const resolved = previous?.status === "user_resolved" || previous?.status === "dismissed";
    if (resolved && !materiallyWorsened(previous, finding)) {
      persisted.push({
        ...toPersistedFinding(finding),
        status: previous.status,
        userReplies: previous.userReplies
      });
      preservedResolvedFingerprints.push(finding.fingerprint);
      continue;
    }

    const status = previous && previous.status !== "fixed" ? "unresolved" : "new";
    persisted.push({
      ...toPersistedFinding(finding),
      status,
      userReplies: previous?.userReplies ?? [],
      ...(previous?.priorCommentId === undefined ? {} : { priorCommentId: previous.priorCommentId })
    });
    activeFindings.push({ ...finding, disposition: status });
  }

  for (const previous of input.previous?.findings ?? []) {
    if (currentByFingerprint.has(previous.fingerprint)) continue;
    if (input.degraded) {
      persisted.push(structuredClone(previous));
      continue;
    }
    if (previous.status === "unresolved" || previous.status === "new") {
      persisted.push({ ...structuredClone(previous), status: "fixed" });
      fixedFingerprints.push(previous.fingerprint);
    } else {
      persisted.push(structuredClone(previous));
    }
  }

  return {
    state: {
      version: 1,
      changeId: input.changeId,
      baseSha: input.baseSha,
      headSha: input.headSha,
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
      degraded: input.degraded,
      findings: persisted
    },
    activeFindings,
    fixedFingerprints,
    preservedResolvedFingerprints
  };
}

function resolveFingerprintCollisions(
  findings: readonly CoordinatedFinding[]
): CoordinatedFinding[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.fingerprint, (counts.get(finding.fingerprint) ?? 0) + 1);
  }

  const resolved = new Map<string, CoordinatedFinding>();
  for (const finding of findings) {
    const fingerprint =
      counts.get(finding.fingerprint) === 1
        ? finding.fingerprint
        : disambiguateFindingFingerprint(finding.fingerprint, finding);
    // Byte-identical rediscoveries are duplicates, not separate lifecycle items.
    if (!resolved.has(fingerprint)) resolved.set(fingerprint, { ...finding, fingerprint });
  }
  return [...resolved.values()];
}

function materiallyWorsened(
  previous: PersistedFindingState | undefined,
  current: CoordinatedFinding
): boolean {
  if (previous === undefined) return false;
  const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
  return severityRank[current.severity] > severityRank[previous.severity];
}

function toPersistedFinding(
  finding: CoordinatedFinding
): Omit<PersistedFindingState, "status" | "userReplies"> {
  return {
    fingerprint: finding.fingerprint,
    reviewer: finding.reviewer,
    title: finding.title,
    path: finding.path,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    severity: finding.severity,
    evidence: finding.evidence
  };
}
