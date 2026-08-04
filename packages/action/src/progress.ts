export interface ProgressCommentState {
  id?: number;
  body: string;
  updatedAtMs: number;
  failed?: boolean;
}

export function createProgressBody(input: {
  requestedTask: string;
  status: string;
  runId: string;
}): string {
  return [
    `shuvbot ${input.status}`,
    "",
    `Requested task: ${input.requestedTask}`,
    `Run-id: ${input.runId}`,
    "<!-- shuvbot:progress -->"
  ].join("\n");
}

export function shouldUpdateProgress(input: {
  previous?: ProgressCommentState;
  nowMs: number;
  debounceMs: number;
  force?: boolean;
}): boolean {
  if (!input.previous) return true;
  if (input.force) return true;
  return input.nowMs - input.previous.updatedAtMs >= input.debounceMs;
}

export function completeProgress(input: {
  previous: ProgressCommentState;
  body: string;
  nowMs: number;
  failed?: boolean;
}): ProgressCommentState {
  const result: ProgressCommentState = {
    ...input.previous,
    body: input.body,
    updatedAtMs: input.nowMs
  };
  if (input.failed !== undefined) result.failed = input.failed;
  return result;
}
