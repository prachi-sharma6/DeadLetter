import { describe, expect, it } from 'vitest';
import { createApiKeySchema, emailSchema, hasRole, inviteSchema, passwordSchema, signupSchema } from '../index';

describe('auth schemas', () => {
  it('normalizes email to trimmed lower case and rejects invalid ones', () => {
    expect(emailSchema.parse('  Bob@Example.COM ')).toBe('bob@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
  });

  it('applies a length-first password policy', () => {
    expect(passwordSchema.safeParse('short1!').success).toBe(false);
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaaa').success).toBe(false);
    expect(passwordSchema.safeParse('Password1234').success).toBe(false); // common
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
    expect(passwordSchema.safeParse('alllowercaseislong').success).toBe(true); // no composition rules
  });

  it('validates sign-up and reports the failing field', () => {
    const r = signupSchema.safeParse({ name: '', email: 'x', password: 'short' });
    expect(r.success).toBe(false);
    const fields = r.success ? [] : r.error.issues.map((i) => i.path[0]);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});

describe('roles and invites', () => {
  it('ranks roles', () => {
    expect(hasRole('OWNER', 'ADMIN')).toBe(true);
    expect(hasRole('MEMBER', 'ADMIN')).toBe(false);
    expect(hasRole('VIEWER', 'VIEWER')).toBe(true);
  });

  it('never lets an invite grant ownership', () => {
    expect(inviteSchema.safeParse({ email: 'a@b.co', role: 'OWNER' }).success).toBe(false);
    expect(inviteSchema.parse({ email: 'a@b.co' }).role).toBe('MEMBER');
  });

  it('defaults API keys to all scopes and rejects unknown ones', () => {
    expect(createApiKeySchema.parse({ name: 'ci' }).scopes).toHaveLength(4);
    expect(createApiKeySchema.safeParse({ name: 'ci', scopes: ['admin'] }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'ci', scopes: [] }).success).toBe(false);
  });
});
