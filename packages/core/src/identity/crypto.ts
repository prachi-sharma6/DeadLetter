import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { sha256Hex } from '../ids';

/**
 * Argon2id (the library default) with OWASP's minimum recommended parameters: 19 MiB memory, 2 iterations,
 * 1 lane. Cheap enough for a 0.1-CPU free instance, expensive enough to make offline guessing costly.
 */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, ARGON2);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // malformed hash: treat as a mismatch, never as a crash
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Verify against a real hash even when the account does not exist, so login takes the same time either way and
 * response timing cannot reveal which emails are registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalizer-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}

/** 256-bit random token for sessions, email links and invites; only its SHA-256 is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => sha256Hex(token);
