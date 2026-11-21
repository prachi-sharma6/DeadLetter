/**
 * Per-plan limits. They keep one organization from exhausting the free-tier database, Redis and email budgets
 * (see PLAN.md section 6). Enforced server-side at ingestion and on create endpoints.
 */
export const PLANS = ['FREE'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  projectsPerOrg: number;
  membersPerOrg: number;
  /** Jobs that may be registered per project per UTC day. */
  jobsPerProjectPerDay: number;
  /** Finished jobs and their history are deleted after this many days. */
  retentionDays: number;
  /** Larger payloads are rejected at ingestion. */
  maxPayloadBytes: number;
  apiKeysPerProject: number;
  alertEmailsPerOrgPerDay: number;
}

export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  FREE: {
    projectsPerOrg: 3,
    membersPerOrg: 5,
    jobsPerProjectPerDay: 5_000,
    retentionDays: 7,
    maxPayloadBytes: 32 * 1024,
    apiKeysPerProject: 10,
    alertEmailsPerOrgPerDay: 20,
  },
};
