import {
  changePassword,
  deleteAccount,
  exportAccount,
  listActiveSessions,
  listMyOrgs,
  login,
  publicUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  revokeOtherSessions,
  revokeSession,
  signup,
  updateProfile,
  verifyEmail,
  NotFoundError,
  writeAudit,
} from '@deadletter/core';
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
  updateProfileSchema,
} from '@deadletter/shared';
import { requestMeta, requireAuth } from '../http/context';
import { RULES } from '../http/rate-limit';
import { ok, parse, route } from '../http/registry';
import { clearSessionCookie, setSessionCookie } from '../http/session-cookie';

/** Email from the body (lower-cased) for per-account rate limits; null when absent so only the IP limit applies. */
const bodyEmail = (body: unknown) => {
  const e = (body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' && e.length <= 254 ? e.trim().toLowerCase() : null;
};

export const authRoutes = [
  route({
    method: 'post',
    path: '/auth/signup',
    scope: 'public',
    summary: 'Create an account (and its own organization) and sign in',
    limits: [(req) => [RULES.signupIp, req.ip ?? '']],
    handler: async (req, res, deps) => {
      const input = parse(signupSchema, req.body);
      const r = await signup(deps.identity, input, requestMeta(req));
      setSessionCookie(res, deps.config, r.sessionToken);
      return ok(
        res,
        {
          user: publicUser(r.user),
          verificationEmailSent: r.emailSent,
          emailConfigured: deps.identity.mailer.configured,
        },
        201,
      );
    },
  }),
  route({
    method: 'post',
    path: '/auth/login',
    scope: 'public',
    summary: 'Sign in with email and password',
    limits: [
      (req) => [RULES.loginIp, req.ip ?? ''],
      (req) => (bodyEmail(req.body) ? [RULES.loginEmail, bodyEmail(req.body)!] : null),
    ],
    handler: async (req, res, deps) => {
      const input = parse(loginSchema, req.body);
      const r = await login(deps.identity, input, requestMeta(req));
      setSessionCookie(res, deps.config, r.sessionToken);
      return { user: publicUser(r.user) };
    },
  }),
  route({
    method: 'post',
    path: '/auth/logout',
    scope: 'public',
    summary: 'Sign out of this session',
    handler: async (req, res, deps) => {
      if (req.auth) await revokeSession(deps.db, req.auth.user.id, req.auth.session.id);
      clearSessionCookie(res, deps.config);
      return { loggedOut: true };
    },
  }),
  route({
    method: 'get',
    path: '/auth/me',
    scope: 'user',
    summary: 'The signed-in user and their organizations',
    handler: async (req, _res, deps) => {
      const { user } = requireAuth(req);
      return {
        user: publicUser(user),
        orgs: await listMyOrgs(deps.db, user.id),
        emailConfigured: deps.identity.mailer.configured,
      };
    },
  }),
  route({
    method: 'patch',
    path: '/auth/me',
    scope: 'user',
    summary: 'Update profile',
    handler: async (req, _res, deps) => {
      const { actor } = requireAuth(req);
      return { user: publicUser(await updateProfile(deps.identity, actor, parse(updateProfileSchema, req.body))) };
    },
  }),
  route({
    method: 'post',
    path: '/auth/verify-email',
    scope: 'public',
    summary: 'Confirm an email address with the emailed token',
    limits: [(req) => [RULES.tokenIp, req.ip ?? '']],
    handler: async (req, _res, deps) => {
      const { token } = parse(tokenSchema, req.body);
      return { user: publicUser(await verifyEmail(deps.identity, token, requestMeta(req))) };
    },
  }),
  route({
    method: 'post',
    path: '/auth/resend-verification',
    scope: 'user',
    summary: 'Send a new verification email',
    limits: [(req) => (req.auth ? [RULES.resendUser, req.auth.user.id] : null)],
    handler: async (req, _res, deps) => resendVerification(deps.identity, requireAuth(req).user),
  }),
  route({
    method: 'post',
    path: '/auth/forgot-password',
    scope: 'public',
    summary: 'Email a password-reset link (same answer whether or not the account exists)',
    limits: [
      (req) => [RULES.forgotIp, req.ip ?? ''],
      (req) => (bodyEmail(req.body) ? [RULES.forgotEmail, bodyEmail(req.body)!] : null),
    ],
    handler: async (req, _res, deps) =>
      requestPasswordReset(deps.identity, parse(forgotPasswordSchema, req.body).email),
  }),
  route({
    method: 'post',
    path: '/auth/reset-password',
    scope: 'public',
    summary: 'Set a new password with the emailed token; signs out every session',
    limits: [(req) => [RULES.tokenIp, req.ip ?? '']],
    handler: async (req, res, deps) => {
      await resetPassword(deps.identity, parse(resetPasswordSchema, req.body), requestMeta(req));
      clearSessionCookie(res, deps.config);
      return { reset: true };
    },
  }),
  route({
    method: 'post',
    path: '/auth/change-password',
    scope: 'user',
    summary: 'Change password; signs out every other session',
    limits: [(req) => (req.auth ? [RULES.sensitiveUser, req.auth.user.id] : null)],
    handler: async (req, _res, deps) => {
      const { actor, session } = requireAuth(req);
      const input = parse(changePasswordSchema, req.body);
      await changePassword(deps.identity, actor, { ...input, currentSessionId: session.id });
      return { changed: true };
    },
  }),
  route({
    method: 'get',
    path: '/auth/sessions',
    scope: 'user',
    summary: 'Active sessions of the signed-in user',
    handler: async (req, _res, deps) => {
      const { user, session } = requireAuth(req);
      const rows = await listActiveSessions(deps.db, user.id);
      return rows.map((s) => ({ ...s, current: s.id === session.id }));
    },
  }),
  route({
    method: 'delete',
    path: '/auth/sessions/:sessionId',
    scope: 'user',
    summary: 'Sign out one session',
    handler: async (req, res, deps) => {
      const { user, session, actor } = requireAuth(req);
      const id = String(req.params.sessionId);
      if (!(await revokeSession(deps.db, user.id, id))) throw new NotFoundError('Session');
      await writeAudit(deps.db, actor, { action: 'session.revoked', targetType: 'session', targetId: id });
      if (id === session.id) clearSessionCookie(res, deps.config);
      return { revoked: true };
    },
  }),
  route({
    method: 'post',
    path: '/auth/sessions/revoke-others',
    scope: 'user',
    summary: 'Sign out every other session',
    handler: async (req, _res, deps) => {
      const { user, session, actor } = requireAuth(req);
      const revoked = await revokeOtherSessions(deps.db, user.id, session.id);
      await writeAudit(deps.db, actor, { action: 'session.revoked_others', metadata: { revoked } });
      return { revoked };
    },
  }),
  route({
    method: 'get',
    path: '/auth/me/export',
    scope: 'user',
    summary: 'Download everything stored about the signed-in user',
    limits: [(req) => (req.auth ? [RULES.sensitiveUser, req.auth.user.id] : null)],
    handler: async (req, res, deps) => {
      const data = await exportAccount(deps.identity, requireAuth(req).user.id);
      res.setHeader('content-disposition', 'attachment; filename="deadletter-account-export.json"');
      return data;
    },
  }),
  route({
    method: 'delete',
    path: '/auth/me',
    scope: 'user',
    summary: 'Delete the account (password required)',
    limits: [(req) => (req.auth ? [RULES.sensitiveUser, req.auth.user.id] : null)],
    handler: async (req, res, deps) => {
      const { actor } = requireAuth(req);
      await deleteAccount(deps.identity, actor, parse(deleteAccountSchema, req.body).password);
      clearSessionCookie(res, deps.config);
      return { deleted: true };
    },
  }),
];
