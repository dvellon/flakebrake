# FlakeBrake Decision Log

## 2026-08-26 — Owner review 0002 closes execution and replan ambiguities

**Status:** Accepted into specification clarification; no v0.1 scope expansion.

Implementation-oriented review identified ambiguous concurrency, replay/idempotency, denial matching, scope containment, branch accounting, and accepted-obligation modification mechanics. The specification now requires portfolio-version compare-and-swap on acceptance, atomic versioned grant-slot claims, stable idempotent execution-attempt IDs, one canonical fingerprint-plus-scope denial rule, mechanical strict scope containment, explicit branch guards and linkage, and policy-bounded owner-approved portfolio modifications above declared service floors. These rules refine the existing admission and five-part assurance contract; portfolio-wide `REPLAN` remains required.

## 2026-08-26 — Owner review 0001 incorporated into the v0.1 draft

**Status:** Accepted into specification; owner lock still pending.

The v0.1 product contract now evaluates a new promise against the complete accepted-obligation portfolio and simultaneous human and agent capacity constraints. Feasible proposals return `ADMITTABLE` for an explicit owner choice; infeasible proposals receive portfolio-wide `REPLAN` analysis before `REJECT`, with targeted minimal expansion suggestions where calculable.

The revision mechanically defines typed effect fingerprints, bounded approval scopes and coverage, meaningful decisions and exclusive branches, denial lifetime and equivalence, the five-part action-assurance floor, immutable AdmissionRecords with append-only later facts, and transparent conservative estimate calibration.

After comparing four candidate domains, v0.1 selects an autonomous microfactory rush-order scenario. The prior live-service-game scenario remains recorded in the comparison as design history but is no longer the required hero demo. Internal delivery uses milestones M0–M5; FlakeBrake v0.1 remains the actual hackathon submission, with broader forecasting, cross-domain, production-integration, autonomy, cloud, and multi-demo work explicitly deferred.
