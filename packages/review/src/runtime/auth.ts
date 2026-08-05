import { ConfigError } from "../../../core/src/errors.ts";
import { SHUVCODE_CREDENTIAL_ENV_NAMES, type ShuvcodeRuntimeCredential } from "./shuvcode.ts";

export type ShuvcodeAuthMode = "user" | "environment";

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
