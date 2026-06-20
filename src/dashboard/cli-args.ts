import { parsePort } from "../cli-args.js";

export interface DashboardCliArgs {
  configPath: string;
  /** When set, overrides `server.port` from the YAML config. */
  port: number | null;
}

/**
 * Minimal argv parsing for `baton-dashboard [config.yaml] [--port N]`.
 * Accepts `--port 8080`, `--port=8080`, or `-p 8080`.
 */
export function parseDashboardArgs(argv: string[]): DashboardCliArgs {
  let configPath: string | null = null;
  let port: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--port" || a === "-p") {
      const next = argv[i + 1];
      if (!next) throw new Error(`${a} requires an integer argument`);
      port = parsePort(next);
      i += 1;
    } else if (a.startsWith("--port=")) {
      port = parsePort(a.slice("--port=".length));
    } else if (!configPath) {
      configPath = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { configPath: configPath ?? "./baton-dashboard.yaml", port };
}
