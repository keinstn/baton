import type { Logger } from "../observability/logger.js";

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  stopPoller: () => void;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  logger: Logger;
  /** Override for tests; defaults to SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Returns a signal handler that is idempotent and bounded. */
export function makeShutdown(deps: ShutdownDeps): (signal: string) => void {
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;
  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info("shutting down", { signal });
    deps.stopPoller();
    void Promise.race([
      deps.closeServer().catch((err) => {
        deps.logger.warn("dashboard close failed", {
          signal,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]).then(() => {
      deps.exit(0);
    });
  };
}
