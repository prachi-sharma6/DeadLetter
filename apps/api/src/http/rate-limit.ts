import type { Logger, Redis } from '@deadletter/runtime';

export interface RateLimitRule {
  /** Short name, part of the Redis key, e.g. `login-ip`. */
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/** INCR the window counter and set its expiry on first use, atomically. Returns [count, ttlMs]. */
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { n, redis.call('PTTL', KEYS[1]) }`;

/**
 * Fixed-window rate limiter shared by all API instances through Redis. If Redis is unreachable it falls back to a
 * per-process in-memory window rather than failing every request or silently disabling protection.
 */
export class RateLimiter {
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly enabled = true,
  ) {}

  async hit(rule: RateLimitRule, subject: string): Promise<RateLimitResult> {
    if (!this.enabled) return { allowed: true, remaining: rule.limit, retryAfterMs: 0 };
    const key = `dl:rl:${rule.name}:${subject}`;
    try {
      const [count, ttl] = (await this.redis.eval(SCRIPT, 1, key, rule.windowMs)) as [number, number];
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        retryAfterMs: Math.max(ttl, 0),
      };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'rate limiter: Redis unavailable, using in-memory fallback');
      return this.hitLocal(key, rule);
    }
  }

  private hitLocal(key: string, rule: RateLimitRule): RateLimitResult {
    const now = Date.now();
    let w = this.local.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + rule.windowMs };
      this.local.set(key, w);
    }
    w.count++;
    if (this.local.size > 10_000) {
      for (const [k, v] of this.local) if (v.resetAt <= now) this.local.delete(k);
    }
    return {
      allowed: w.count <= rule.limit,
      remaining: Math.max(0, rule.limit - w.count),
      retryAfterMs: w.resetAt - now,
    };
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Limits per subject. Tuned for humans: generous for normal use, tight for guessing and abuse. */
export const RULES = {
  globalIp: { name: 'global-ip', limit: 600, windowMs: MIN },
  signupIp: { name: 'signup-ip', limit: 5, windowMs: HOUR },
  loginIp: { name: 'login-ip', limit: 20, windowMs: 15 * MIN },
  loginEmail: { name: 'login-email', limit: 10, windowMs: 15 * MIN },
  forgotIp: { name: 'forgot-ip', limit: 5, windowMs: HOUR },
  forgotEmail: { name: 'forgot-email', limit: 3, windowMs: HOUR },
  tokenIp: { name: 'token-ip', limit: 30, windowMs: HOUR },
  resendUser: { name: 'resend-user', limit: 3, windowMs: HOUR },
  sensitiveUser: { name: 'sensitive-user', limit: 10, windowMs: HOUR },
  inviteUser: { name: 'invite-user', limit: 30, windowMs: HOUR },
} satisfies Record<string, RateLimitRule>;
