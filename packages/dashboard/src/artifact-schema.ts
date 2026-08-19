import { z } from "zod";
import type { JsonValue } from "./json.ts";

export const DASHBOARD_ARTIFACT_SCHEMA_VERSION = 1;
export const DASHBOARD_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const DASHBOARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_SHORT_STRING = 512;
const MAX_FINDINGS = 100;
const MAX_SESSIONS = 20;

const shortString = z.string().max(MAX_SHORT_STRING);
const text = z.string().max(MAX_STRING);
const positiveInteger = z.number().int().positive();
const optionalUsage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional()
  })
  .optional();

const findingSchema = z.object({
  id: shortString.min(1),
  title: text.min(1),
  body: text.optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  confidence: z.enum(["high", "medium", "low"]),
  path: text,
  line: z.number().int().nullable().optional(),
  reviewer: z
    .enum(["code-quality", "security", "performance", "tests", "documentation", "release"])
    .optional(),
  disposition: z.enum(["new", "unresolved", "fixed", "user_resolved", "dismissed"]).optional(),
  fingerprint: text.optional()
});

const sessionSchema = z.object({
  sessionId: shortString.min(1),
  role: z.enum(["coordinator", "specialist"]),
  reviewer: shortString.optional(),
  model: shortString,
  status: z.enum(["queued", "running", "completed", "failed", "timed_out", "cancelled"]),
  retryCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: optionalUsage,
  error: z
    .object({
      code: shortString,
      message: text,
      retryable: z.boolean().optional()
    })
    .optional()
});

const runSchema = z.object({
  runId: shortString.min(1),
  repo: shortString.min(1),
  subject: z
    .object({
      kind: z.enum(["issue", "pull_request"]),
      number: positiveInteger,
      commentId: positiveInteger
    })
    .optional(),
  command: z
    .object({
      name: shortString,
      args: text
    })
    .optional(),
  event: shortString,
  actor: shortString,
  mode: shortString,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(["running", "success", "failure"]),
  findings: z.array(findingSchema).max(MAX_FINDINGS).optional(),
  review: z
    .object({
      decision: shortString,
      quorumMet: z.boolean(),
      sessions: z.array(sessionSchema).max(MAX_SESSIONS)
    })
    .optional(),
  failure: z
    .object({
      class: shortString,
      message: text
    })
    .optional()
});

const workflowSchema = z.object({
  id: positiveInteger,
  htmlUrl: z.string().url().max(2048),
  repository: z.object({
    id: positiveInteger,
    fullName: shortString.min(1),
    htmlUrl: z.string().url().max(2048),
    private: z.boolean()
  }),
  artifact: z.object({
    id: positiveInteger,
    name: shortString,
    sizeBytes: z.number().int().nonnegative().max(DASHBOARD_MAX_ARTIFACT_BYTES),
    expiresAt: z.string().datetime().nullable()
  })
});

const ingestionSchema = z.object({
  version: z.literal(DASHBOARD_ARTIFACT_SCHEMA_VERSION),
  workflow: workflowSchema,
  run: runSchema,
  findings: z.union([
    z.array(findingSchema).max(MAX_FINDINGS),
    z.object({
      version: z.literal(1),
      findings: z.array(findingSchema).max(MAX_FINDINGS)
    })
  ]),
  sessions: z.array(sessionSchema).max(MAX_SESSIONS).optional()
});

export type DashboardArtifact = z.infer<typeof ingestionSchema> & {
  findings: z.infer<typeof findingSchema>[];
  sessions: z.infer<typeof sessionSchema>[];
};

export function parseDashboardArtifact(value: JsonValue, encodedBytes?: number): DashboardArtifact {
  if (encodedBytes !== undefined && encodedBytes > DASHBOARD_MAX_ARTIFACT_BYTES) {
    throw new RangeError(`Artifact exceeds the ${DASHBOARD_MAX_ARTIFACT_BYTES}-byte limit`);
  }
  const parsed = ingestionSchema.parse(value);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : parsed.findings.findings;
  return {
    ...parsed,
    findings,
    sessions: parsed.sessions ?? parsed.run.review?.sessions ?? []
  };
}
