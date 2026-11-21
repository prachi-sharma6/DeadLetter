import type { Logger } from './logger';

export type ShutdownStep = { name: string; run: () => unknown };

/**
 * Run cleanup steps in order on SIGTERM/SIGINT, then exit. A hard timeout guarantees the process exits even if a step
 * hangs, so the platform's restart is never blocked. Returns a function to trigger shutdown manually.
 */
export function installGracefulShutdown(opts: { logger: Logger; steps: ShutdownStep[]; timeoutMs?: number }) {
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.logger.info({ reason }, 'shutting down');
    const timer = setTimeout(() => {
      opts.logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, opts.timeoutMs ?? 25_000);
    timer.unref();
    let failed = false;
    for (const step of opts.steps) {
      try {
        await step.run();
      } catch (err) {
        failed = true;
        opts.logger.error({ step: step.name, err: (err as Error).message }, 'shutdown step failed');
      }
    }
    opts.logger.info('shutdown complete');
    process.exit(failed ? 1 : 0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return shutdown;
}

/** Log and exit on programming errors that escaped every handler; the platform restarts the process cleanly. */
export function installCrashHandlers(logger: Logger) {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.stack }, 'uncaught exception');
    process.exit(1);
  });
}
