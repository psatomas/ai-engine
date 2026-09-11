import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
}

/** Appends JSONL to a file, creating parent directories on first write. */
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
    for (const sink of this.sinks) void sink.write(line);
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
