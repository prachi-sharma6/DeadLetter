import { randomBytes } from 'node:crypto';

/** URL-safe slug from a display name plus a short random suffix, so two orgs with the same name never collide. */
export function makeSlug(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';
  return `${base}-${randomBytes(4).toString('hex').slice(0, 6)}`;
}
