import {
  buildReviewerPrompt,
  type ReviewerPromptDefinition,
  type ReviewerPromptInput
} from "../prompts/reviewer-shared.ts";

export const SECURITY_REVIEWER: ReviewerPromptDefinition = {
  id: "security",
  name: "Security",
  purpose:
    "Find exploitable or concretely dangerous trust-boundary failures introduced by the change.",
  whatToFlag: [
    "Authorization or authentication bypasses with a specific attacker-controlled path.",
    "Injection, secret exposure, unsafe deserialization, path traversal, or cryptographic misuse with concrete impact.",
    "Permission or trust-boundary changes that grant unintended access or execute untrusted input."
  ],
  whatNotToFlag: [
    "Generic hardening advice without a reachable attack path.",
    "Hypothetical vulnerabilities that depend on unsupported assumptions about deployment or callers.",
    "Non-security correctness, style, or dependency freshness concerns without a relevant vulnerability."
  ]
};

export function buildSecurityPrompt(input: ReviewerPromptInput): string {
  return buildReviewerPrompt(SECURITY_REVIEWER, input);
}
