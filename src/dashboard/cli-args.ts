export interface DashboardCliArgs {
  configPath: string;
  /** When set, overrides `server.port` from config. */
  port: number | null;
}

/**
 * Minimal argv parsing for `baton-dashboard [config.yaml] [--port N]`.
 * Accepts `--port 8080`, `--port=8080`, or `-p 8080`. CLI `--port` takes
 * precedence over `server.port` in the config file. Port 0 is valid (OS picks).
 */
export function parseDashboardArgs(argv: string[]): DashboardCliArgs {
  let configPath: string | null = null;
  let port: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--port" || a === "-p") {
      const next = argv[i + 1];
      if (!next) throw new Error(`${a} requires an integer argument`);
      port = parseDashboardPort(next);
      i += 1;
    } else if (a.startsWith("--port=")) {
      port = parseDashboardPort(a.slice("--port=".length));
    } else if (!configPath) {
      configPath = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { configPath: configPath ?? "./baton-dashboard.yaml", port };
}

function parseDashboardPort(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid --port value: ${s}`);
  }
  return n;
}
