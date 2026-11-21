import type { Request, Response } from 'express';
import { parse } from 'cookie';
import { SESSION_IDLE_TTL_MS } from '@deadletter/core';
import type { ApiConfig } from '../config';

/**
 * Over HTTPS the cookie uses the `__Host-` prefix: browsers only accept it when it is Secure, has Path=/ and no Domain,
 * so it can never be set or shadowed by a sibling subdomain. Plain-http development uses an unprefixed name.
 */
export const sessionCookieName = (config: ApiConfig) =>
  config.APP_ORIGIN.startsWith('https://') ? '__Host-dl_session' : 'dl_session';

const cookieOptions = (config: ApiConfig) => ({
  httpOnly: true,
  secure: config.APP_ORIGIN.startsWith('https://'),
  sameSite: 'lax' as const,
  path: '/',
});

export function readSessionToken(req: Request, config: ApiConfig): string | undefined {
  const header = req.headers.cookie;
  return header ? parse(header)[sessionCookieName(config)] : undefined;
}

export function setSessionCookie(res: Response, config: ApiConfig, token: string) {
  res.cookie(sessionCookieName(config), token, { ...cookieOptions(config), maxAge: SESSION_IDLE_TTL_MS });
}

export function clearSessionCookie(res: Response, config: ApiConfig) {
  res.clearCookie(sessionCookieName(config), cookieOptions(config));
}
