# 0007: Organizations and teams in v1

**Decision.** Model `Organization` → `Project` with memberships, roles (owner/admin/member/viewer) and email
invites from the first schema version.

**Consequences.** Every query is scoped by organization from day one; a cross-tenant isolation test suite is a Phase 2
exit criterion.
