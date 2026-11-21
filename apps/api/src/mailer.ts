import { DisabledMailer, MemoryMailer, ResendMailer, type Mailer } from '@deadletter/core';
import type { Logger } from '@deadletter/runtime';
import type { ApiConfig } from './config';

/**
 * Resend when configured. In development without a key, emails are logged (with their links) instead of sent.
 * In production without a key, email is reported as not configured: features that depend on it say so honestly.
 */
export function createMailer(config: ApiConfig, logger: Logger): Mailer {
  if (config.RESEND_API_KEY) return new ResendMailer(config.RESEND_API_KEY, config.EMAIL_FROM);
  if (config.NODE_ENV !== 'production') {
    return new MemoryMailer((m) =>
      logger.info({ to: m.to, subject: m.subject, body: m.text }, 'email (development: logged, not sent)'),
    );
  }
  logger.warn('RESEND_API_KEY is not set: email verification, password reset and invitation emails are disabled');
  return new DisabledMailer();
}
