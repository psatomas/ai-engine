import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFields {
  taskId?: string;
  workflowState?: string;
  role?: string;
  providerId?: string;
  operation?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface LogSink {
  write(line: string): void | Promise<void>;
  /**
   * Entries below this level are never passed to `write` for this sink. Optional and
   * `undefined` by default, meaning "everything" — existing sinks/callers that never set
   * this see no behavior change. Added for guided-mode CLI output (see @ai-engine/cli's
   * `ai start`): the console can be quieted to warn/error while the file sink keeps
   * receiving every entry unconditionally, so full observability is never lost, only the
   * console's share of it is reduced for a specific invocation.
   */
  minLevel?: LogLevel;
}

/** Appends JSONL to a file, creating parent directories on first write. Never filtered by
 *  level — this is the durable, complete record; only ConsoleSink (or a caller's own sink)
 *  should ever set `minLevel`. */
export class FileSink implements LogSink {
  private ready: Promise<void> | undefined;

  constructor(private readonly path: string) {}

  private async ensureDir(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    }
    return this.ready;
  }

  async write(line: string): Promise<void> {
    await this.ensureDir();
    await appendFile(this.path, line + "\n", "utf8");
  }
}

export class ConsoleSink implements LogSink {
  /** Defaults to "debug" (everything) — the exact prior behavior for any existing caller
   *  that doesn't pass a level explicitly. */
  constructor(readonly minLevel: LogLevel = "debug") {}

  write(line: string): void {
    // Human-readable console mirror is handled by the CLI; sinks stay machine-format.
    process.stderr.write(line + "\n");
  }
}

/**
 * Structured logger. Every entry is a single JSON object with a fixed
 * envelope (`ts`, `level`, `msg`, plus arbitrary fields) so logs are
 * grep/jq-able and can answer "what happened / which agent / what changed /
 * why did it fail" without re-deriving anything from chat transcripts.
 * All field values pass through `redact` before serialization.
 */
export class Logger {
  constructor(
    private readonly sinks: LogSink[],
    private readonly bound: LogFields = {}
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.sinks, { ...this.bound, ...fields });
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact({ ...this.bound, ...fields }) as Record<string, unknown>)
    };
    const line = JSON.stringify(entry);
    for (const sink of this.sinks) {
      if (sink.minLevel && LEVEL_ORDER[level] < LEVEL_ORDER[sink.minLevel]) continue;
      void sink.write(line);
    }
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }
}

export function createLogger(sinks: LogSink[], bound: LogFields = {}): Logger {
  return new Logger(sinks, bound);
}
