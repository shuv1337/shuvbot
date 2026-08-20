import { createSign } from "node:crypto";
import { z } from "zod";
import { DASHBOARD_MAX_ARTIFACT_BYTES } from "./artifact-schema.ts";

const API_URL = "https://api.github.com";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
const MAX_ARTIFACT_REDIRECTS = 3;

const githubHtmlUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  }, "URL must be an HTTPS github.com URL");

const installationSchema = z.object({ id: z.number().int().positive() });
const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1).max(512),
  html_url: githubHtmlUrl,
  private: z.boolean()
});
const workflowRunSchema = z.object({
  id: z.number().int().positive(),
  html_url: githubHtmlUrl
});
const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(512),
  size_in_bytes: z.number().int().nonnegative().max(DASHBOARD_MAX_ARTIFACT_BYTES),
  expired: z.boolean(),
  expires_at: z.string().datetime().nullable()
});

export type GitHubRepository = z.infer<typeof repositorySchema>;
export type GitHubWorkflowRun = z.infer<typeof workflowRunSchema>;
export type GitHubArtifact = z.infer<typeof artifactSchema>;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

interface JwtHeader {
  alg: "RS256";
  typ: "JWT";
}

interface JwtPayload {
  iat: number;
  exp: number;
  iss: string;
}

export type DashboardFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export class DashboardGitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: DashboardFetch = fetch
  ) {}

  async json<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "shuvbot-dashboard",
        "x-github-api-version": "2022-11-28",
        ...init.headers
      }
    });
    const bytes = await readBoundedBody(response, MAX_JSON_BYTES);
    const text = new TextDecoder().decode(bytes);
    let data = {};
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`GitHub returned invalid JSON (${response.status})`);
      }
    }
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return schema.parse(data);
  }

  async downloadArtifact(repository: string, artifactId: number): Promise<Uint8Array> {
    const repositoryPath = encodeRepositoryPath(repository);
    let response = await this.fetchImpl(
      `${API_URL}/repos/${repositoryPath}/actions/artifacts/${artifactId}/zip`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "user-agent": "shuvbot-dashboard",
          "x-github-api-version": "2022-11-28"
        },
        redirect: "manual"
      }
    );
    for (let redirects = 0; isRedirect(response.status); redirects += 1) {
      if (redirects >= MAX_ARTIFACT_REDIRECTS) {
        throw new Error("GitHub artifact download exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      if (location === null) throw new Error("GitHub artifact redirect has no location");
      const redirectUrl = new URL(location, response.url || API_URL);
      assertArtifactRedirectUrl(redirectUrl);
      response = await this.fetchImpl(redirectUrl, {
        headers: { "user-agent": "shuvbot-dashboard" },
        redirect: "manual"
      });
    }
    if (!response.ok) throw new Error(`GitHub artifact download failed (${response.status})`);
    return readBoundedBody(response, DASHBOARD_MAX_ARTIFACT_BYTES);
  }
}

export function createGitHubAppJwt(credentials: GitHubAppCredentials, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 600, iss: credentials.appId });
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(credentials.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function listInstallations(client: DashboardGitHubClient): Promise<number[]> {
  const data = await client.json(
    "/app/installations?per_page=100",
    z.array(installationSchema).max(100)
  );
  return data.map(({ id }) => id);
}

export async function createInstallationClient(
  appClient: DashboardGitHubClient,
  installationId: number,
  fetchImpl: DashboardFetch = fetch
): Promise<DashboardGitHubClient> {
  const data = await appClient.json(
    `/app/installations/${installationId}/access_tokens`,
    z.object({ token: z.string().min(1) }),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: { actions: "read", metadata: "read" } })
    }
  );
  const { token } = data;
  return new DashboardGitHubClient(token, fetchImpl);
}

export async function listInstallationRepositories(
  client: DashboardGitHubClient,
  maximum: number
): Promise<GitHubRepository[]> {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= MAX_PAGES && repositories.length < maximum; page += 1) {
    const data = await client.json(
      `/installation/repositories?per_page=100&page=${page}`,
      z.object({ repositories: z.array(repositorySchema).max(100) })
    );
    const parsed = data.repositories;
    repositories.push(...parsed.slice(0, maximum - repositories.length));
    if (parsed.length < 100) break;
  }
  return repositories;
}

export async function listWorkflowRuns(
  client: DashboardGitHubClient,
  repository: string,
  maximum: number
): Promise<GitHubWorkflowRun[]> {
  const repositoryPath = encodeRepositoryPath(repository);
  const data = await client.json(
    `/repos/${repositoryPath}/actions/workflows/shuvbot.yml/runs?status=completed&per_page=${maximum}`,
    z.object({ workflow_runs: z.array(workflowRunSchema).max(maximum) })
  );
  return data.workflow_runs;
}

export async function findShuvbotArtifact(
  client: DashboardGitHubClient,
  repository: string,
  runId: number
): Promise<GitHubArtifact | null> {
  const repositoryPath = encodeRepositoryPath(repository);
  const data = await client.json(
    `/repos/${repositoryPath}/actions/runs/${runId}/artifacts?per_page=100&name=shuvbot`,
    z.object({ artifacts: z.array(artifactSchema).max(100) })
  );
  const artifacts = data.artifacts;
  return artifacts.find((artifact) => artifact.name === "shuvbot" && !artifact.expired) ?? null;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximum) {
    await response.body?.cancel();
    throw new RangeError(`Response exceeds the ${maximum}-byte limit`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new RangeError(`Response exceeds the ${maximum}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function assertArtifactRedirectUrl(url: URL): void {
  const allowedHost =
    url.hostname === "objects.githubusercontent.com" ||
    url.hostname.endsWith(".actions.githubusercontent.com") ||
    url.hostname.endsWith(".blob.core.windows.net");
  if (url.protocol !== "https:" || !allowedHost) {
    throw new Error("GitHub artifact download redirected to an untrusted URL");
  }
}

function encodeJson(value: JwtHeader | JwtPayload): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function encodeRepositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new TypeError("GitHub repository name is invalid");
  }
  return parts.map(encodeURIComponent).join("/");
}
