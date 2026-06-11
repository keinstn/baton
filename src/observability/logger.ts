export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Minimal structured logger (SPEC §13.1-13.2).
 * One JSON object per line. Sink failures never crash orchestration.
 */
export class Logger {
  constructor(
    private readonly fields: LogFields = {},
    private readonly sink: LogSink = defaultSink,
  ) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.fields, ...fields }, this.sink);
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

  private emit(level: string, msg: string, fields?: LogFields): void {
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
