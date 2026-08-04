export type GitHubMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GitHubRequestOptions {
  method?: GitHubMethod;
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: "json" | "text";
}

export interface GitHubResponse<T = unknown> {
  status: number;
  data: T;
}

export interface GitHubClient {
  request<T = unknown>(route: string, options?: GitHubRequestOptions): Promise<GitHubResponse<T>>;
}

export interface CreateGitHubClientInput {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.github.com";

export function createGitHubClient(input: CreateGitHubClientInput): GitHubClient {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const userAgent = input.userAgent ?? "shuvbot";
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async request<T = unknown>(
      route: string,
      options: GitHubRequestOptions = {}
    ): Promise<GitHubResponse<T>> {
      const { method, path } = parseRoute(route, options.method ?? "GET");
      const url = applyParams(
        `${baseUrl}${path}`,
        options.params,
        method === "GET" ? "query" : "path"
      );
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "user-agent": userAgent,
        "x-github-api-version": "2022-11-28",
        ...options.headers
      };
      const init: RequestInit = {
        method,
        headers
      };
      if (options.body !== undefined && method !== "GET") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      const response = await fetchImpl(url, init);
      const text = await response.text();
      const data = (
        options.responseType === "text" ? text : text.length > 0 ? JSON.parse(text) : {}
      ) as T;
      if (!response.ok) {
        const message =
          data && typeof data === "object" && "message" in (data as Record<string, unknown>)
            ? String((data as Record<string, unknown>).message)
            : response.statusText;
        throw new GitHubRequestError(
          `GitHub request failed (${response.status}): ${message}`,
          response.status,
          data
        );
      }
      return { status: response.status, data };
    }
  };
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: unknown
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

function parseRoute(
  route: string,
  fallbackMethod: GitHubMethod
): { method: GitHubMethod; path: string } {
  const trimmed = route.trim();
  if (!trimmed) return { method: fallbackMethod, path: "/" };
  const match = trimmed.match(/^([A-Z]+)\s+(.*)$/);
  if (match && match[1] && match[2]) {
    return { method: match[1] as GitHubMethod, path: ensureLeadingSlash(match[2]) };
  }
  return { method: fallbackMethod, path: ensureLeadingSlash(trimmed) };
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function applyParams(
  url: string,
  params: Record<string, unknown> | undefined,
  mode: "query" | "path"
): string {
  if (!params) return url;
  let resolved = url;
  const queryEntries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const token = `{${key}}`;
    if (resolved.includes(token)) {
      resolved = resolved.replace(token, encodeURIComponent(String(value)));
    } else if (mode === "query") {
      queryEntries.push([key, String(value)]);
    }
  }
  if (queryEntries.length === 0) return resolved;
  const search = new URLSearchParams(queryEntries).toString();
  return resolved.includes("?") ? `${resolved}&${search}` : `${resolved}?${search}`;
}
