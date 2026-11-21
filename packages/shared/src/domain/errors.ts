const HTTP_CONTEXT = /\b(http|https|status|response|responded|code)\b/i;

/**
 * Normalize an error message so messages that differ only in variable data (ids, numbers, emails, URLs, hashes,
 * timestamps, quoted values) map to the same string. HTTP status codes are kept when the message is about HTTP,
 * because `429` and `503` are different failures.
 */
export function normalizeErrorMessage(message: string | null | undefined): string {
  if (!message) return '';
  const keepHttpCodes = HTTP_CONTEXT.test(message);
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
    .replace(/https?:\/\/[^\s'")]+/g, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b([a-z]+)[_-](?=[a-z0-9]*\d)[a-z0-9]+\b/gi, '$1_<id>')
    .replace(/(?<![A-Za-z_<])\d+(?:\.\d+)?/g, (n) => (keepHttpCodes && /^[1-5]\d\d$/.test(n) ? n : '<n>'))
    .replace(/(["'])(?:(?!\1).){1,80}\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Stack signature: the top `frames` application frames as `function@dir/file`, without line/column numbers and
 * without node_modules or Node internals, so the same code path groups together across deploys and machines.
 */
export function stackSignature(stack: string | null | undefined, frames = 3): string {
  if (!stack) return '';
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::\d+)?(?::\d+)?\)?\s*$/.exec(line);
    if (!m) continue;
    const fn = m[1] ?? '<anonymous>';
    const file = (m[2] ?? '').replace(/\\/g, '/');
    if (file.includes('/node_modules/') || file.startsWith('node:') || file === 'native') continue;
    out.push(`${fn}@${file.split('/').slice(-2).join('/')}`);
    if (out.length >= frames) break;
  }
  return out.join('|');
}

/** Short human title for an error group, e.g. `TimeoutError: Gateway timed out after <n>ms`. */
export function errorGroupTitle(errorType: string, normalizedMessage: string): string {
  const msg = normalizedMessage.length > 80 ? `${normalizedMessage.slice(0, 77)}...` : normalizedMessage;
  return msg ? `${errorType}: ${msg}` : errorType;
}
