export interface CliArgs {
  workflowPath: string;
  /** When set, overrides `server.port` from front matter (SPEC §13.7). */
  port: number | null;
}

/**
 * Minimal argv parsing for `baton [WORKFLOW.md] [--port N]` (SPEC §17.7/§13.7).
 * Accepts `--port 8080`, `--port=8080`, or `-p 8080`. CLI takes precedence over
 * the workflow's `server.port` front matter key.
 */
export function parseArgs(argv: string[]): CliArgs {
  let workflowPath: string | null = null;
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
    } else if (!workflowPath) {
      workflowPath = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { workflowPath: workflowPath ?? "./WORKFLOW.md", port };
}

function parsePort(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid --port value: ${s}`);
  }
  return n;
}
