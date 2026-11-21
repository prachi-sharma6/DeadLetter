import { createHash, randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp + randomness, so ids sort by creation time (good for B-tree indexes).
 * Used for rows inserted with raw SQL; Prisma generates the same format for `@default(uuid(7))`.
 * A 12-bit counter keeps ids from one process strictly increasing within the same millisecond.
 */
export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1; // counter wrapped: borrow the next millisecond
    now = lastMs;
  } else {
    lastMs = now;
    seq = 0;
  }
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (seq >> 8); // version 7 + high bits of the counter
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f); // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic JSON: object keys sorted recursively, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

export const sha256Hex = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

export const hashJson = (value: unknown) => sha256Hex(canonicalJson(value));
