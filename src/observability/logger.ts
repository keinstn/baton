export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return "info";
}

const defaultSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Minimal structured logger (SPEC §13.1-13.2).
 * One JSON object per line. Sink failures never crash orchestration.
 *
 * Log level filtering is controlled by the `LOG_LEVEL` environment variable
 * (debug | info | warn | error). Default is `info`. Set `LOG_LEVEL=debug`
 * to enable verbose diagnostic output.
 */
export class Logger {
  private readonly minLevel: LogLevel;

  constructor(
    private readonly fields: LogFields = {},
    private readonly sink: LogSink = defaultSink,
    minLevel?: LogLevel,
  ) {
    this.minLevel = minLevel ?? resolveMinLevel();
  }

  child(fields: LogFields): Logger {
    return new Logger({ ...this.fields, ...fields }, this.sink, this.minLevel);
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

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    try {
      this.sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          msg,
          ...this.fields,
          ...fields,
        }),
      );
    } catch {
      // SPEC §13.2: a failing log sink must not crash the service.
    }
  }
}
