export class ShuvbotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AUTH_ERROR", options);
  }
}

export class ConfigError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIG_ERROR", options);
  }
}

export class PolicyDeniedError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "POLICY_DENIED", options);
  }
}

export class GitHubApiError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "GITHUB_API_ERROR", options);
  }
}

export class AgentTimeoutError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AGENT_TIMEOUT", options);
  }
}

export class AgentActivityTimeoutError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AGENT_ACTIVITY_TIMEOUT", options);
  }
}

export class StructuredOutputError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STRUCTURED_OUTPUT_ERROR", options);
  }
}

export class ReviewPostingError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "REVIEW_POSTING_ERROR", options);
  }
}

export class ToolExecutionError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "TOOL_EXECUTION_ERROR", options);
  }
}

/**
 * A run was explicitly requested (an `@shuvbot <command>` mention) but no
 * handler matched the resolved mode and event. Distinct from a policy denial:
 * nothing refused the work, the combination simply is not wired up.
 */
export class UnsupportedRequestError extends ShuvbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "UNSUPPORTED_REQUEST", options);
  }
}
