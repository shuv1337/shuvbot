import { DefaultRedactor, type Redactor } from "./redaction.ts";

export interface LogEvent {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: unknown;
}

export class RunLogger {
  private readonly events: LogEvent[] = [];

  constructor(private readonly redactor: Redactor = new DefaultRedactor()) {}

  log(level: LogEvent["level"], event: string, data?: unknown): void {
    this.events.push({
      time: new Date().toISOString(),
      level,
      event,
      data: data === undefined ? undefined : this.redactor.redact(data)
    });
  }

  snapshot(): LogEvent[] {
    return [...this.events];
  }
}

export async function timeSpan<T>(
  logger: RunLogger,
  event: string,
  operation: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const result = await operation();
    logger.log("info", `${event}.complete`, { durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logger.log("error", `${event}.failed`, {
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
