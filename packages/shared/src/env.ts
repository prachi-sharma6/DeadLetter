import type { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
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
