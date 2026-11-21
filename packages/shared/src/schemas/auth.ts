import { z } from 'zod';

/** Trimmed and lower-cased so uniqueness is case-insensitive. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  'qwertyuiopas',
  '123456789012',
  '1234567890123',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'deadletter123',
]);

/**
 * Length-first policy (NIST SP 800-63B): at least 12 characters, no composition rules, reject obvious choices.
 * The comparison with the user's email happens in the service, where both values are known.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters')
  .refine((p) => new Set(p).size > 3, 'Use more than 3 different characters')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'This password is too common');

export const nameSchema = z.string().trim().min(1, 'Name is required').max(80, 'Name is too long');

export const signupSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});
export const tokenSchema = z.object({ token: z.string().min(20).max(200) });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
});
export const updateProfileSchema = z.object({ name: nameSchema });
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
