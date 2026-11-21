# 0006: Push and pull recovery modes

**Context.** Retrying or replaying a job means running it again in the customer's environment. Many apps run jobs
behind firewalls and cannot expose a webhook.

**Decision.** Support both: **push** (DeadLetter POSTs to a signed customer webhook) and **pull** (the SDK long-polls
for recovery commands and runs them in-process). Pull is the default for the BullMQ adapter.

**Consequences.** More SDK surface, but recovery works for every deployment shape.
