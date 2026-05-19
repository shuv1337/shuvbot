import { replayGithubEventFixture } from "../../evals/src/replay-github-event.ts";

export interface ReplayOptions {
  fixture: string;
  dryRun?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

export async function runReplay(options: ReplayOptions): Promise<Awaited<ReturnType<typeof replayGithubEventFixture>>> {
  const result = await replayGithubEventFixture(options.fixture);
  options.stdout?.write(`${JSON.stringify({ ...result, dryRun: options.dryRun ?? true }, null, 2)}\n`);
  return result;
}
