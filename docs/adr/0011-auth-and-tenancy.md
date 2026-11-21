# 0011: Authentication, sessions and tenant isolation

**Decisions.**

- **Server-side sessions, not JWTs.** The cookie holds a random 256-bit token; the database stores only its SHA-256.
  Sessions can be listed and revoked individually; logout, password change and password reset revoke server-side.
  Idle expiry 30 days (sliding, written at most every 10 minutes), absolute lifetime 90 days.
- **Cookie:** `HttpOnly`, `SameSite=Lax`, `Path=/`; over HTTPS it is `Secure` and named `__Host-dl_session`, so browsers
  refuse to let any other (sub)domain set or shadow it.
- **CSRF:** every state-changing request must carry an `Origin` (or, failing that, `Referer`) equal to `APP_ORIGIN`.
  Together with `SameSite=Lax` this blocks cross-site form posts and fetches. Login and sign-up are covered too
  (login CSRF). No token round-trip is needed because the web app and API share one origin.
- **Passwords:** Argon2id (`@node-rs/argon2`, 19 MiB, t=2, p=1, OWASP minimum). Policy is length-first (≥ 12, ≤ 128
  characters, small common-password list, must not contain the email's local part), with no composition rules (NIST
  SP 800-63B). Login performs one Argon2 verification whether or not the account exists, so timing does not reveal
  registered emails.
- **Account enumeration:** login and forgot-password give identical answers for unknown accounts. Sign-up does reveal
  "email already registered" for usability; this is rate limited (5 sign-ups per IP per hour).
- **Email tokens** (verification 24 h, reset 1 h, invites 7 d) are random, stored hashed, single-use, and issuing a new
  one retires older unused ones. A password reset revokes every session and marks the email verified.
- **Email may be unavailable.** Without `RESEND_API_KEY`, production uses a disabled mailer and every response says so
  (`emailConfigured: false`). Email verification is then not enforced (it could never be completed), and invitations
  return a shareable link to the inviting admin instead. With a key, verification is required for creating API keys and
  invitations and for accepting invitations.
- **Tenancy and roles:** Organization → Project. Roles OWNER > ADMIN > MEMBER > VIEWER. Non-members of an org or project
  always get **404** (never 403), so ids cannot be probed; members below the required role get 403. Invitations and role
  changes can never grant OWNER; ownership only moves by explicit transfer, and the last owner cannot leave or be removed.
  Only the owner manages admins.
- **Route registry** (`apps/api/src/http/registry.ts`): every console route declares `scope` (public, user, org,
  project) and minimum `role`. Malformed ids are 404, access is checked before the body is parsed, then the handler
  validates with the shared Zod schemas. `apps/api/test/isolation.int.test.ts` iterates the registry and proves, for
  every org/project route: outsiders get 404 and nothing changes; the victim's member/invite/key ids cannot be reached
  through the attacker's own org; viewers get 403 on anything above their role; anonymous callers get 401. A deliberate
  break of the access check makes 35 of these tests fail.
- **Rate limits** are fixed windows in Redis shared by all instances, with a per-process fallback if Redis is
  unavailable: per IP globally, and tighter per IP and per account for sign-up, login, password reset and token use.
- **API keys:** `dl_live_<12 hex>_<256-bit secret>`, shown once, stored as SHA-256 (fast hashing is appropriate for a
  random secret), compared in constant time, scoped, optionally expiring, revocable and rotatable.
- **Data rights:** users can export their data and delete their account; deletion removes organizations where they are
  the only member and is refused while they are the sole owner of a shared organization.

**Consequences.** Every new route must be added through `route()`; one without an org/project scope that uses
`:orgId`/`:projectId` fails the test suite.
