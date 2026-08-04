import { describe, expect, test } from "bun:test";
import { classifyReviewError } from "../src/errors.ts";
import { runSessionTasks, type SessionTask } from "../src/scheduler.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("session task scheduler", () => {
  test("rejects duplicate task IDs", async () => {
    const task = {
      id: "duplicate",
      async run() {
        return { status: "completed" as const, value: 1 };
      }
    };
    await expect(runSessionTasks([task, task], { taskTimeoutMs: 1_000 })).rejects.toThrow("unique");
  });

  test("caps specialist concurrency at three", async () => {
    let active = 0;
    let maximumActive = 0;
    const tasks = Array.from(
      { length: 7 },
      (_, index): SessionTask<number> => ({
        id: `task-${index}`,
        async run() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await sleep(10);
          active -= 1;
          return { status: "completed", value: index };
        }
      })
    );

    await runSessionTasks(tasks, { maxConcurrency: 10, taskTimeoutMs: 1_000 });

    expect(maximumActive).toBe(3);
  });

  test("preserves input order when tasks finish out of order", async () => {
    const delays = [30, 5, 15];
    const tasks = delays.map(
      (delay, index): SessionTask<number> => ({
        id: `task-${index}`,
        async run() {
          await sleep(delay);
          return { status: "completed", value: index };
        }
      })
    );

    const records = await runSessionTasks(tasks, { taskTimeoutMs: 1_000 });

    expect(records.map((record) => record.id)).toEqual(["task-0", "task-1", "task-2"]);
    expect(records.map((record) => record.value)).toEqual([0, 1, 2]);
  });

  test("permits only one retry through review retry eligibility", async () => {
    let attempts = 0;
    const retryable = classifyReviewError({ category: "service", message: "unavailable" });

    const [record] = await runSessionTasks(
      [
        {
          id: "retrying",
          async run() {
            attempts += 1;
            return { status: "failed" as const, error: retryable };
          }
        }
      ],
      { taskTimeoutMs: 100_000 }
    );

    expect(attempts).toBe(2);
    expect(record?.attempts).toHaveLength(2);
    expect(record?.transitions.map((event) => event.status)).toEqual([
      "queued",
      "running",
      "failed",
      "running",
      "failed"
    ]);
  });

  test("heartbeats do not extend the hard task deadline", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let interrupts = 0;
    let heartbeats = 0;
    const startedAt = Date.now();

    const [record] = await runSessionTasks(
      [
        {
          id: "heartbeat",
          run({ heartbeat }) {
            interval = setInterval(heartbeat, 2);
            return new Promise(() => {});
          },
          interrupt() {
            interrupts += 1;
            if (interval !== undefined) clearInterval(interval);
          }
        }
      ],
      { taskTimeoutMs: 25, onHeartbeat: () => (heartbeats += 1) }
    );

    expect(record?.status).toBe("timed_out");
    expect(heartbeats).toBeGreaterThan(0);
    expect(interrupts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test("cancellation interrupts active tasks and cancels queued tasks", async () => {
    const controller = new AbortController();
    const interrupted: string[] = [];
    const observedAbort: string[] = [];
    const started: string[] = [];
    const tasks = Array.from({ length: 4 }, (_, index): SessionTask<number> => {
      const id = `task-${index}`;
      return {
        id,
        run({ signal }) {
          started.push(id);
          signal.addEventListener("abort", () => observedAbort.push(id), { once: true });
          return new Promise(() => {});
        },
        interrupt() {
          interrupted.push(id);
        }
      };
    });

    const running = runSessionTasks(tasks, {
      maxConcurrency: 2,
      taskTimeoutMs: 1_000,
      signal: controller.signal
    });
    await sleep(10);
    controller.abort();
    const records = await running;

    expect(started).toEqual(["task-0", "task-1"]);
    expect(interrupted.sort()).toEqual(["task-0", "task-1"]);
    expect(observedAbort.sort()).toEqual(["task-0", "task-1"]);
    expect(records.map((record) => record.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled"
    ]);
    expect(records[2]?.attempts).toEqual([]);
    expect(records[3]?.attempts).toEqual([]);
  });

  test.each(["throws", "hangs"] as const)(
    "bounds cleanup when interrupt %s and does not reuse the worker slot",
    async (behavior) => {
      let secondStarted = false;
      const records = await runSessionTasks(
        [
          {
            id: "stuck",
            run: () => new Promise(() => {}),
            interrupt() {
              if (behavior === "throws") throw new Error("interrupt failed");
              return new Promise(() => {});
            }
          },
          {
            id: "queued",
            async run() {
              secondStarted = true;
              return { status: "completed" as const, value: 2 };
            }
          }
        ],
        { maxConcurrency: 1, taskTimeoutMs: 10, interruptTimeoutMs: 10 }
      );

      expect(secondStarted).toBe(false);
      expect(records.map((record) => record.status)).toEqual(["timed_out", "cancelled"]);
    }
  );
});
