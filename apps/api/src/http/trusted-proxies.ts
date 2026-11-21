/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-11-21).
 * Render fronts every service with Cloudflare, so the request chain is
 *   client → Cloudflare edge (public IP) → Render proxy (10.x) → app
 * and X-Forwarded-For arrives as "<client>, <cloudflare edge>, <render internal>". Trusting these ranges plus private
 * addresses makes the app pick the right-most address that is neither, i.e. the real client. A client cannot spoof
 * this: whatever it sends ends up to the left of the address Cloudflare appends.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

const PRIVATE = ['loopback', 'linklocal', 'uniquelocal'];

/** Value for Express's `trust proxy` setting. */
export function trustProxySetting(mode: 'private' | 'cloudflare' | number): string[] | number {
  if (mode === 'private') return PRIVATE;
  if (mode === 'cloudflare') return [...PRIVATE, ...CLOUDFLARE_RANGES];
  return mode;
}
