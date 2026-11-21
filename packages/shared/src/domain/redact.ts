/** Keys redacted everywhere, compared case-insensitively and ignoring `-`, `_` and spaces. */
export const DEFAULT_REDACT_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'ssn',
  'privatekey',
  'clientsecret',
] as const;

export const REDACTED = '[REDACTED]';

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const DL_KEY = /\bdl_(?:live|test)_[A-Za-z0-9_-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const normalizeKey = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');

/** Remove credentials that appear inside free text such as error messages and stack traces. */
export function redactText(text: string): string {
  return text.replace(BEARER, `$1 ${REDACTED}`).replace(DL_KEY, REDACTED);
}

/** Mask email addresses in free text (applied before sending anything to an external AI provider). */
export const maskEmails = (text: string) => text.replace(EMAIL, '[EMAIL]');

export interface RedactOptions {
  extraKeys?: readonly string[];
  maxDepth?: number;
  /** Total nodes visited; protects against huge or hostile payloads. */
  maxNodes?: number;
  maxStringLength?: number;
}

/**
 * Deep-redact a JSON value: values under sensitive keys become [REDACTED], credentials inside strings are removed, and
 * depth, node count and string length are bounded.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  const keys = new Set([...DEFAULT_REDACT_KEYS, ...(opts.extraKeys ?? [])].map(normalizeKey));
  const maxDepth = opts.maxDepth ?? 12;
  const maxString = opts.maxStringLength ?? 10_000;
  let budget = opts.maxNodes ?? 20_000;
  const walk = (v: unknown, depth: number): unknown => {
    if (--budget < 0) return '[TRUNCATED]';
    if (typeof v === 'string') {
      const s = redactText(v);
      return s.length > maxString ? `${s.slice(0, maxString)}…[${s.length - maxString} more chars]` : s;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return '[MAX_DEPTH]';
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = keys.has(normalizeKey(k)) ? REDACTED : walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
