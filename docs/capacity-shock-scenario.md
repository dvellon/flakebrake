# Capacity-shock deterministic scenario

Select **Capacity shock · second scenario** in the judge UI. The rush-order
hero remains selected by default and retains its original fixture, labels,
quantities, evidence, and four-decision flow.

## What changes

This story starts with a planned quality-inspection fixture batch rather than a
new rush order. Under `capacity-plan/v1`, the complete portfolio requests agent
10/10, human 3/4, and production 96/100, so the existing M1 kernel returns
`ADMITTABLE` with four production minutes remaining.

An owner-authorized spindle calibration hold then replaces the capacity plan.
Only production capacity changes: 100 → 90 minutes. The portfolio and capacity
model do not change. The transition advances the authoritative basis from
`capacity-plan/v1` to `capacity-plan/v2`.

The old admission therefore cannot authorize action. An attempted acceptance
using its exact v1 basis is durably rejected with the single mismatch
`capacity_plan_version`; the kernel immediately reads the current basis and
returns `REPLAN` because production is now 96/90, or six minutes over.

## Bounded alternatives and exact winner

The unchanged comparator evaluates three candidates using existing fixture and
ordering semantics:

| Candidate | Exact change | Current-basis remainder (agent, human, production) |
| --- | --- | --- |
| Modify existing | best-effort training trays 10 → 8 | 1, 1, 0 |
| Modify proposal | important quality fixtures 8 → 6 | 1, 1, 0 |
| Modify both | both reductions above | 2, 1, 6 |

The deterministic winner is the single existing-order modification
`training-trays/reduce-to-8`. It preserves the important proposed batch at 8,
changes only lower-criticality best-effort work, and leaves the protected
cold-chain order byte-for-byte unchanged. No new score, policy, resource, or
scientific rule is introduced.

## Durable outcome

The interactive route records four external decisions: approve the portfolio
modification, approve the fresh promise, deny the 09:12–09:36 reservation that
overlaps the calibration hold, and approve the distinct 09:36–10:00
alternative. The equivalent alternate adapter is denied mechanically by the
active M2 denial without a fifth owner call.

The terminal record contains exactly one acceptance, one execution attempt,
one fenced factory mutation, one receipt, and two actual-consumption facts:
agent 3 and production 24. Independent factory read-back precedes terminal
verification. Restarting and selecting the scenario again reuses the same
scenario-bound mission, session, projection, receipt, and terminal result with
zero owner calls and no duplicate effect.

All capacity-shock SQLite files, mission/session IDs, environment IDs,
idempotency scope, denial IDs, and attempt IDs carry capacity-shock identity.
They are separate from the original hero's durable files, so running or
resetting either scenario cannot replace the other scenario's state.
