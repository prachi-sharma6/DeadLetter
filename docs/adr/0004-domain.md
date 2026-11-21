# 0004: Buy a domain

**Context.** Email providers only deliver to arbitrary recipients from a verified domain. Email verification, password
reset, invites and alert emails all depend on it.

**Decision.** Buy a domain (about $10/year) before Phase 2's email features ship; configure SPF/DKIM for Resend.

**Consequences.** The only planned recurring cost. Until then, emails can only reach the owner's own address.
