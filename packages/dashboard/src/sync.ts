import { parseDashboardArtifact } from "./artifact-schema.ts";
import { z } from "zod";
import {
  createGitHubAppJwt,
  createInstallationClient,
  DashboardGitHubClient,
  findShuvbotArtifact,
  type DashboardFetch,
  type GitHubAppCredentials,
  listInstallationRepositories,
  listInstallations,
  listWorkflowRuns
} from "./github.ts";
import { ingestDashboardArtifact } from "./ingest.ts";
import { extractDashboardArtifactFiles } from "./zip.ts";

const MAX_INSTALLATIONS = 10;
const MAX_REPOSITORIES = 20;
const MAX_RUNS_PER_REPOSITORY = 10;
const MAX_INGESTED_RUNS = 5;

const githubCredentialsSchema = z
  .object({
    GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID secret is not configured"),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1, "GITHUB_APP_PRIVATE_KEY secret is not configured")
  })
  .transform(({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY }) => ({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY
  }));

export interface DashboardSyncSummary {
  installations: number;
  repositories: number;
  discoveredRuns: number;
  ingestedRuns: number;
  skippedRuns: number;
}

export function isDashboardSyncConfigured(env: Env): boolean {
  return githubCredentialsSchema.safeParse(env).success;
}

export async function syncDashboard(
  env: Env,
  fetchImpl: DashboardFetch = fetch
): Promise<DashboardSyncSummary> {
  const credentials = githubCredentials(env);
  const appClient = new DashboardGitHubClient(createGitHubAppJwt(credentials), fetchImpl);
  const installationIds = (await listInstallations(appClient)).slice(0, MAX_INSTALLATIONS);
  const summary: DashboardSyncSummary = {
    installations: installationIds.length,
    repositories: 0,
    discoveredRuns: 0,
    ingestedRuns: 0,
    skippedRuns: 0
  };

  for (const installationId of installationIds) {
    if (summary.repositories >= MAX_REPOSITORIES) break;
    const client = await createInstallationClient(appClient, installationId, fetchImpl);
    const repositories = await listInstallationRepositories(
      client,
      MAX_REPOSITORIES - summary.repositories
    );
    for (const repository of repositories) {
      summary.repositories += 1;
      const runs = await listWorkflowRuns(client, repository.full_name, MAX_RUNS_PER_REPOSITORY);
      summary.discoveredRuns += runs.length;
      for (const workflowRun of runs) {
        if (summary.ingestedRuns >= MAX_INGESTED_RUNS) return summary;
        if (await isAlreadyIngested(env.DB, workflowRun.id)) {
          summary.skippedRuns += 1;
          continue;
        }
        const artifact = await findShuvbotArtifact(client, repository.full_name, workflowRun.id);
        if (artifact === null) {
          summary.skippedRuns += 1;
          continue;
        }
        try {
          const bytes = await client.downloadArtifact(repository.full_name, artifact.id);
          const files = extractDashboardArtifactFiles(bytes);
          const parsed = parseDashboardArtifact(
            {
              version: 1,
              workflow: {
                id: workflowRun.id,
                htmlUrl: workflowRun.html_url,
                repository: {
                  id: repository.id,
                  fullName: repository.full_name,
                  htmlUrl: repository.html_url,
                  private: repository.private
                },
                artifact: {
                  id: artifact.id,
                  name: artifact.name,
                  sizeBytes: artifact.size_in_bytes,
                  expiresAt: artifact.expires_at
                }
              },
              run: files.run,
              findings: files.findings,
              sessions: files.sessions ?? []
            },
            bytes.byteLength
          );
          await ingestDashboardArtifact(env.DB, parsed);
          summary.ingestedRuns += 1;
        } catch (error) {
          summary.skippedRuns += 1;
          console.warn(
            JSON.stringify({
              message: "dashboard artifact skipped",
              repository: repository.full_name,
              workflowRunId: workflowRun.id,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      }
    }
  }
  return summary;
}

async function isAlreadyIngested(db: D1Database, workflowRunId: number): Promise<boolean> {
  const existing = await db
    .prepare("SELECT artifact_available FROM workflow_runs WHERE id = ?")
    .bind(workflowRunId)
    .first<{ artifact_available: number }>();
  return existing?.artifact_available === 1;
}

function githubCredentials(env: Env): GitHubAppCredentials {
  return githubCredentialsSchema.parse(env) satisfies GitHubAppCredentials;
}
