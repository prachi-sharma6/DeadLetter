import type { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Resolve the running build's commit into GIT_SHA: an explicit GIT_SHA (Docker build arg) wins; otherwise fall back to
 * the commit the hosting platform reports (Render sets RENDER_GIT_COMMIT at runtime).
 */
export function withBuildVersion(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const explicit = source.GIT_SHA && source.GIT_SHA !== 'unknown' ? source.GIT_SHA : undefined;
  return { ...source, GIT_SHA: explicit ?? source.RENDER_GIT_COMMIT };
}

/**
 * Validate an environment object against a Zod schema. Fails fast with every problem listed at once, and never
 * echoes values (they may be secrets), only variable names and what is wrong with them.
 */
export function parseEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined>): z.output<S> {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the schema default.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
