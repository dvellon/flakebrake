# FlakeBrake Product Specification v0.1

**Status:** DRAFT — baseline for owner review
**Date:** 2026-08-25
**Project:** FlakeBrake
**Subtitle:** Obligation admission control for autonomous agents

## 1. Product thesis

AI agents are eager to accept missions and standing obligations without first establishing that the complete operating system can keep those promises.

FlakeBrake evaluates a proposed obligation against declared capacity constraints before consequential execution begins.

It returns one of three decisions:

- **ADMIT** — the proposed plan fits the declared constraints.
- **REPLAN** — the mission may be feasible, but the current plan is not.
- **REJECT** — no currently available plan satisfies the obligation.

Public positioning:

> Stop agents from accepting promises the system cannot keep.

Hero demonstration:

> Your human is not an infinite API.

## 2. v0.1 user job

Coordinate remediation of a synthetic live-service game incident under a finite human-review budget.

The mission presented to the TrueForge root agent is:

> Ranked-player abandonment jumped after patch 17.3. Find the cause, test safe remediation options, and get the best fix underway within ten minutes. I can make at most two meaningful approval decisions during this incident.

This is the only required v0.1 mission.

## 3. Declared capacity model

v0.1 models exactly one constrained resource:

```text
human_review_budget = 2 meaningful decisions
```

The operator supplies this value explicitly.

FlakeBrake does not claim to infer a person's true cognitive capacity, competence, fatigue, or available attention.

Future versions may model model calls, token spend, tool calls, subagent capacity, deadlines, money, and persistent obligation load. Those are not part of the v0.1 implementation requirement.

## 4. Synthetic MCP environment

### 4.1 game-telemetry

Read-only capabilities for:

- abandonment by cohort;
- encounter failure rates;
- input-device segmentation;
- latency and crash statistics.

### 4.2 game-deployments

Read-only capabilities for:

- patch and deployment history;
- configuration changes;
- deployment timing;
- dependency versions.

### 4.3 game-simulator

Capabilities for:

- replaying the affected encounter;
- testing a configuration hotfix;
- testing rollback behavior;
- producing deterministic simulation receipts.

### 4.4 game-change-control

Consequential capabilities for:

- applying a reversible change in the owned synthetic environment;
- creating a tested change request;
- publishing a controlled incident update.

The final approved action must change real state inside the synthetic environment and return a verifiable receipt.

## 5. TrueForge agent topology

The mission runs through TrueForge.

The root incident commander delegates to at least three visible subagents:

```text
ROOT INCIDENT COMMANDER
        |
        +-- telemetry investigator
        +-- deployment/configuration investigator
        +-- remediation/simulation engineer
```

Each subagent returns:

- findings;
- evidence references;
- proposed actions;
- dependencies;
- effect classification;
- available alternatives.

TrueForge must visibly provide:

- the root agent loop;
- subagent execution;
- MCP access;
- sandboxed Code Mode or generated-code execution;
- human approval pauses;
- persisted session state and reconnect/resume behavior.

FlakeBrake must not recreate those harness functions.

## 6. Action graph

The root agent assembles proposed work into a small typed directed acyclic graph.

Each action contains:

```yaml
id:
description:
depends_on:
effect: read | reversible | irreversible
criticality: protected | important | best_effort
authority_required:
approval_scope:
alternative_actions:
evidence_refs:
```

The schema is intentionally narrow. v0.1 is not a general workflow language.

## 7. Deterministic FlakeBrake kernel

The admission kernel is deterministic software rather than an LLM judgment.

Inputs:

- proposed action graph;
- consequential effects;
- approval scopes;
- dependencies and mutually exclusive branches;
- declared human-review budget.

Outputs:

- plan version;
- consequential effect count;
- required approval frontier;
- meaningful decisions required;
- declared review budget;
- covered consequential paths;
- uncovered consequential paths;
- `ADMIT`, `REPLAN`, or `REJECT`.

### 7.1 Core safety invariant

> No path to a consequential external effect may execute without crossing an approval grant whose declared scope covers that effect.

A broad approval does not automatically authorize unrelated effects.

For the bounded v0.1 graph, the implementation may use exhaustive search to find the smallest safe approval frontier. It must not claim a general optimal solution for arbitrary workflow graphs.

## 8. Required initial overload

The first proposed safe plan must require more meaningful human decisions than the declared budget permits.

Illustrative result:

```text
FLAKEBRAKE ENGAGED

Plan: v1
Meaningful decisions required: 4
Declared human review budget: 2
Uncovered consequential paths: 0

Result: REPLAN
```

No consequential action is authorized while the plan is in `REPLAN` state.

## 9. Required backpressure behavior

FlakeBrake must not merely combine several approval prompts into one summary.

The capacity constraint must cause a materially different execution plan.

Valid changes include:

- eliminating redundant or mutually exclusive branches;
- selecting a reversible intervention over an irreversible one;
- deferring best-effort work;
- replacing direct mutation with a tested change request;
- collecting additional evidence that honestly permits one decision to govern several downstream effects;
- narrowing an approval scope.

A revised graph that preserves the same actions and merely changes presentation does not satisfy v0.1.

Illustrative accepted result:

```text
Plan: v2
Meaningful decisions required: 2
Declared human review budget: 2
Uncovered consequential paths: 0

Result: ADMIT
```

## 10. Human denial and replanning

The demonstration must include one denied approval.

After denial, TrueForge must preserve:

- the mission;
- completed investigation evidence;
- the current action graph;
- the previous admission decision;
- the denied approval.

The agent must replan without repeating the entire investigation.

The revised plan must still pass the deterministic consequential-path coverage check before any write can occur.

## 11. Final controlled action

The final approved path should create a tested configuration-change request in the synthetic environment.

Illustrative receipt:

```json
{
  "change_request_id": "CR-173",
  "configuration": "dodge_window_ms",
  "old_value": 140,
  "proposed_value": 210,
  "simulation_receipt": "SIM-8841",
  "status": "OPEN_FOR_AUTHORIZED_OPERATOR"
}
```

The resulting state must be read back and verified before the root agent reports completion.

## 12. Required demonstration scoreboard

The final demo should expose at least:

```text
Subagents used
Candidate actions
Initial meaningful decisions
Declared review budget
Replanned meaningful decisions
Consequential paths uncovered
Denied decisions survived
Controlled external writes
Silent dropped obligations
```

The intended judge recollection is:

> The agents generated more decisions than the human could meaningfully review, so FlakeBrake forced them to redesign the plan instead of overwhelming the reviewer.

## 13. v0.1 acceptance criteria

FlakeBrake is not complete unless all of the following pass:

- [ ] The mission runs through a TrueForge root agent.
- [ ] At least three subagent threads are visible.
- [ ] At least three distinct MCP servers are genuinely used.
- [ ] Sandboxed Code Mode or generated code performs meaningful analysis.
- [ ] The initial safe plan exceeds the declared review budget.
- [ ] Approval-frontier coverage is calculated by deterministic code.
- [ ] Uncovered consequential paths equal zero before execution.
- [ ] Backpressure produces a structurally different action graph.
- [ ] One human decision is denied and the mission continues safely.
- [ ] The final consequential action waits for explicit TrueForge approval.
- [ ] Refresh/reconnect preserves the mission, graph, evidence, and denial.
- [ ] The final MCP action creates real synthetic state.
- [ ] Resulting state is read back before completion is reported.
- [ ] Substantive code is merged only after Qodo review and follow-up.
- [ ] The complete causal story fits comfortably within three minutes.

## 14. Explicit non-goals

The following are excluded from v0.1 unless the complete required vertical slice is already reliable:

- longitudinal human-competence scoring;
- earned-autonomy scoring;
- inference of reviewer cognitive capacity;
- recurring obligation scheduling across days or weeks;
- generalized mixed-criticality scheduling;
- stochastic deadline guarantees;
- generated MCP servers;
- arbitrary workflow compilation;
- custom memory or continuity systems;
- model-family benchmarking;
- production authentication;
- real game infrastructure;
- cloud or GPU infrastructure;
- more than one demonstration scenario.

## 15. Final pre-build kill questions

The specification must not be frozen until these questions are answered:

1. Is the schedulability claim limited to the declared deterministic resource model?
2. Does review-capacity exhaustion materially change the action graph?
3. Is consequential-path coverage mechanically verified?
4. Is TrueForge indispensable to the demonstrated execution?
5. Can a judge repeat the complete idea in one sentence after a three-minute demonstration?

## 16. Open owner-review items

This baseline remains open for owner comments on:

- whether the game-incident scenario is the strongest demonstration domain;
- whether two meaningful decisions is the right review budget;
- whether the final write should create a change request or apply a reversible synthetic hotfix;
- whether player communication belongs in the required action graph;
- terminology for consequential, reversible, and irreversible effects;
- any scope that should be cut before implementation.
