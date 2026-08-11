import { mkdtemp as createTemporaryDirectory, rm } from "node:fs/promises";
import { afterEach } from "bun:test";

/**
 * Tracks temporary directories created by one test module and removes them
 * after every test, including failed tests. The file-scoped registry assumes
 * serial tests; do not share it with `test.concurrent`.
 */
export function useTemporaryDirectories(): (prefix: string) => Promise<string> {
  const directories = new Set<string>();

  afterEach(async () => {
    const pending = [...directories];
    directories.clear();

    const results = await Promise.allSettled(
      pending.map((directory) => rm(directory, { recursive: true, force: true }))
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [new Error(`Unable to remove test directory ${pending[index]}`, { cause: result.reason })]
        : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Unable to clean temporary test directories");
    }
  });

  return async (prefix: string) => {
    const directory = await createTemporaryDirectory(prefix);
    directories.add(directory);
    return directory;
  };
}
