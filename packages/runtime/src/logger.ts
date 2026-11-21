import { pino, type Logger, type LoggerOptions } from 'pino';

/** Paths that must never reach logs, wherever they appear in a logged object. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.secret',
];

export function createLogger(opts: { service: string; level: string; pretty?: boolean }): Logger {
  const options: LoggerOptions = {
    level: opts.level,
    base: { service: opts.service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  // Pretty output is a dev-only convenience; production always logs one JSON object per line to stdout.
  if (opts.pretty)
    options.transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } };
  return pino(options);
}

export type { Logger };
