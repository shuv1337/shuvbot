import { ConfigError } from "../../../core/src/errors.ts";
import { resolveReviewModel } from "./model-catalog.ts";
import {
  SHUVCODE_CREDENTIAL_ENV_NAMES,
  type ShuvcodeCredentialName,
  type ShuvcodeRuntimeCredential
} from "./shuvcode.ts";

export type ShuvcodeAuthMode = "user" | "environment";

/**
 * The provider each accepted credential authenticates. Both names shuvbot
 * forwards are Anthropic credentials, so environment auth can reach exactly one
 * provider - which is the whole reason the check below exists.
 */
const CREDENTIAL_PROVIDERS: Readonly<Record<ShuvcodeCredentialName, string>> = Object.freeze({
  CLAUDE_CODE_OAUTH_TOKEN: "anthropic",
  ANTHROPIC_API_KEY: "anthropic"
});

/**
 * Refuses a model roster the supplied credential cannot reach.
 *
 * Environment auth forwards a single credential, but the default roster spans
 * three providers: the coordinator is Anthropic while every specialist is xAI
 * and the light role is OpenAI. On a developer machine that works, because the
 * operator's shuvcode profile has all three authenticated. In CI it does not,
 * and the failure is miserable to diagnose - every specialist fails about half a
 * second in with a sanitised "Provider request failed", the review degrades to
 * zero coverage, and nothing says why. Found by the first real Action run.
 *
 * Only applies to environment auth. Under `user` auth shuvbot knows nothing
 * about which providers the operator has configured, and must not guess.
 */
export function assertReviewModelsReachable(input: {
  readonly credential: ShuvcodeRuntimeCredential;
  readonly models: Readonly<Record<string, string>>;
}): void {
  const available = CREDENTIAL_PROVIDERS[input.credential.name];
  const unreachable: string[] = [];

  for (const [role, ref] of Object.entries(input.models)) {
    let providerID: string;
    try {
      providerID = resolveReviewModel(ref as `${string}/${string}`).providerID;
    } catch {
      // Name resolution owns its own diagnostics; do not mask them here.
      continue;
    }
    if (providerID !== available) unreachable.push(`${role} (${ref} needs ${providerID})`);
  }

  if (unreachable.length === 0) return;
  throw new ConfigError(
    `review.shuvcode.auth = "environment" supplies a ${available} credential via ` +
      `${input.credential.name}, but these review models need another provider: ` +
      `${unreachable.join(", ")}. Configure [review.models] with ${available} models, ` +
      "or authenticate the review runtime with a profile that has those providers."
  );
}

/**
 * Resolves the credential the review runtime should authenticate with.
 *
 * `user` mode returns nothing: the runtime authenticates from the operator's own
 * shuvcode profile on disk, and shuvbot never reads or forwards those
 * credentials. `environment` mode is the non-interactive path, where the
 * credential is supplied deliberately by the caller (a workflow secret) rather
 * than inherited, and is the only mode under which anything is injected.
 */
export function resolveShuvcodeCredential(input: {
  readonly mode: ShuvcodeAuthMode;
  readonly env: NodeJS.ProcessEnv;
}): ShuvcodeRuntimeCredential | undefined {
  if (input.mode === "user") return undefined;

  for (const name of SHUVCODE_CREDENTIAL_ENV_NAMES) {
    const value = input.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return { name, value };
    }
  }

  throw new ConfigError(
    'review.shuvcode.auth = "environment" requires a credential in the environment, but none ' +
      `of ${SHUVCODE_CREDENTIAL_ENV_NAMES.join(", ")} is set. Provide one from a workflow secret, ` +
      'or set review.shuvcode.auth = "user" to authenticate from a local shuvcode profile.'
  );
}
