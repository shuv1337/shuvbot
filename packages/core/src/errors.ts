export class ReviewbotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AUTH_ERROR", options);
  }
}

export class ConfigError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIG_ERROR", options);
  }
}

export class PolicyDeniedError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "POLICY_DENIED", options);
  }
}

export class GitHubApiError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "GITHUB_API_ERROR", options);
  }
}

export class AgentTimeoutError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AGENT_TIMEOUT", options);
  }
}

export class AgentActivityTimeoutError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "AGENT_ACTIVITY_TIMEOUT", options);
  }
}

export class StructuredOutputError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STRUCTURED_OUTPUT_ERROR", options);
  }
}

export class ReviewPostingError extends ReviewbotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "REVIEW_POSTING_ERROR", options);
  }
}
