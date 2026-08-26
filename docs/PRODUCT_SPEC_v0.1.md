# FlakeBrake Product Specification v0.1

**Status:** DRAFT — owner reviews 0001–0004 incorporated; pending owner lock

**Date:** 2026-08-26

**Project:** FlakeBrake

**Subtitle:** Obligation admission control for autonomous agents and humans

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. Product thesis and claims boundary

Autonomous agents and humans can both accept more obligations than the combined system can safely service. FlakeBrake evaluates a proposed promise against the complete accepted-obligation portfolio, a declared multi-resource capacity model, active authorization constraints, and explicit assumptions before consequential execution begins.

FlakeBrake is admission control for the human-agent system as a whole. It is not merely an approval-prompt reducer.

Public positioning:

> Stop agents from accepting promises the system cannot keep.

Demo hook:

> Your human is not an infinite API—and neither is your agent.

FlakeBrake v0.1 proves only that a proposal is feasible under the declared capacity model, capacity plan, authorization state, estimator, evidence, and assumptions evaluated at a specific portfolio, capacity-model, capacity-plan, and authorization-state version tuple. `ADMITTABLE` is not a guarantee that every accepted promise will be fulfilled. Unmodeled failures, invalid assumptions, and post-admission changes can still prevent fulfillment and MUST be reported rather than hidden.

## 2. v0.1 user job and demonstration domain

### 2.1 Domain comparison

The v0.1 hero domain is selected against the following requirements: accepting a new promise is central; human and agent capacity constraints are simultaneous and natural; existing accepted obligations cannot disappear; portfolio-wide replanning is meaningful; the final action is consequential but controlled; and the causal story is immediately understandable in a deterministic three-minute demo.

| Candidate | New-promise user job | Capacity and existing portfolio | Replanning and final action | Three-minute fit |
|---|---|---|---|---|
| Autonomous microfactory / rush order | Decide whether to promise a rush-order quantity and deadline. | Human change-control decisions, autonomous planning/simulation work, and production-cell time are visibly finite; previously accepted orders remain due. | Change the rush order or reschedule a lower-criticality order, then create a bounded synthetic schedule reservation. | Strong: orders, deadlines, and a full schedule are familiar without specialist context. |
| AI/GPU research lab | Decide whether to accept a new experiment run. | Human review, agent orchestration, and GPU time are finite; accepted experiments remain queued. | Change run size/deadline or move a lower-criticality experiment, then reserve a synthetic GPU slot. | Good, but GPU scheduling and experiment service levels require more explanation. |
| Scientific-instrument facility | Decide whether to accept an urgent sample. | Operator review, autonomous analysis, and instrument time are finite; existing bookings remain. | Change sample service or move a lower-criticality booking, then create a synthetic instrument reservation. | Good, but calibration, custody, and instrument constraints add domain-specific setup. |
| Live-service game | Decide how to respond to an incident rather than whether to accept a new customer promise. | Human review and agent investigation are finite, but the accepted-obligation portfolio is less visible. | Change incident scope or defer lower-criticality work, then create a synthetic configuration change request. | Visually clear, but obligation admission is indirect and can look like incident-response orchestration. |

The selected v0.1 hero domain is the **autonomous microfactory rush-order scenario**. It makes the admission decision itself the center of the story and satisfies the required portfolio, capacity, replan, and controlled-action criteria with the least explanatory overhead. The live-service-game draft is preserved as design history, not as a second required demo.

### 2.2 Required mission

The only required polished v0.1 mission is:

> A rush order arrives at an autonomous microfactory with a requested quantity and delivery deadline. Decide whether the factory can accept that promise without breaking its existing accepted orders. If the direct plan does not fit, compare changing the rush order with changing lower-criticality existing obligations, obtain every required owner decision, and put only the approved schedule change into the controlled synthetic factory.

The starting portfolio MUST contain at least:

- one **protected** accepted order that no recommended replan may degrade;
- one **important** accepted order; and
- one **best-effort** accepted order that can be proposed for modification but cannot be changed without owner approval.

The deterministic demo fixture MUST make the direct rush-order plan exceed both a human-side constraint and an agent-side constraint. A later feasible plan MUST satisfy both constraints; the implementation MAY also make production-cell time binding.

## 3. Bounded v0.1 model

### 3.1 Core terms and versions

- An **obligation** is a promise with a stable ID, beneficiary, objective, service level, deadline or horizon, criticality, required resources, and expected consequential effects.
- The **accepted portfolio** is the immutable snapshot of all currently accepted obligations and their predicted resource reservations. A `portfolio_version` changes only after an explicit owner decision atomically accepts a new promise or approves a bounded modification to an existing promise.
- A **proposal** is a not-yet-accepted obligation or portfolio change evaluated against one complete portfolio, capacity-model, capacity-plan, and authorization-state version tuple.
- A **candidate plan** is a complete proposed portfolio state plus its action graph, resource allocations, decision frontier, assumptions, and predicted results.
- A **capacity model version** identifies resource types, units, horizons, feasibility rules, estimator rules, and assumption schema.
- A **capacity plan version** assigns concrete capacity values and permitted bounds to one capacity-model version. Owner-approved expansion creates a new capacity-plan version; it does not rewrite the old version.
- An **authorization state version** is the single monotonically advancing version of the admission-relevant grant and denial state. Any grant or denial transition that could change admission feasibility or authorization MUST advance `authorization_state_version`, including grant issuance, activation, revocation, expiry, execution-slot consumption or exhaustion, and denial creation, supersession, or mission closure when admission-relevant. Immutable evidence artifacts and unchanged static action bundles do not advance it unless their admission-relevant authorization semantics change.
- **Criticality** is one of `protected`, `important`, or `best_effort`. Protected service is a hard constraint in the permitted v0.1 replan search.

Evaluation is side-effect free. Merely evaluating, ranking, or displaying a candidate MUST NOT mutate a portfolio, capacity plan, grant, denial, or external system. An `ADMITTABLE` result is valid only for its complete evaluated state tuple and carries `expected_portfolio_version`, `expected_capacity_model_version`, `expected_capacity_plan_version`, and `expected_authorization_state_version` for acceptance.

### 3.2 Declared capacity resources

v0.1 MUST model at least these simultaneous resources over one explicit scheduling horizon:

1. `human_review_decisions` — human-side capacity measured in meaningful decisions as defined in Section 5.3;
2. `agent_work_units` — agent-side capacity measured from a versioned table of deterministic work-unit costs for TrueForge subagent, sandbox, simulation, and MCP operation classes.

The microfactory demo SHOULD also model `production_cell_minutes` so the accepted-order portfolio has a visible operational constraint. v0.1 is multi-resource but remains a bounded, domain-specific scheduler; it is not an arbitrary resource-planning language.

Each resource declaration MUST contain:

```yaml
resource_key:
side: human | agent | operational
unit:
horizon_start:
horizon_end:
capacity:
safety_reserve:
estimator_rule:
assumptions:
```

The operator supplies resource capacity and assumptions explicitly. FlakeBrake MUST NOT infer a person's competence, fatigue, cognitive capacity, or long-term availability.

For resource `r` and candidate plan `p`:

```text
capacity_before[r]
  = declared_capacity[r]
  - predicted_existing_portfolio_use[r]
  - safety_reserve[r]

predicted_consumption[r, p]
  = predicted_candidate_portfolio_use[r]
  - predicted_existing_portfolio_use[r]

predicted_capacity_after[r, p]
  = capacity_before[r] - predicted_consumption[r, p]
```

`predicted_consumption` can be negative only when a candidate explicitly proposes reducing or moving existing work. The corresponding accepted obligation remains unchanged until the owner approves that modification.

A plan is capacity-feasible only if every relevant `predicted_capacity_after` is nonnegative and every accepted service-level and deadline constraint remains satisfied. Every resource omitted from a proposal but required by the capacity model is a validation failure, not zero consumption.

**Protected-obligation slack** is the remaining resource and deadline margin before any protected obligation would become infeasible under the candidate plan. It MUST be reported per relevant resource and protected deadline, together with the minimum value. A candidate with negative protected slack is not permitted.

The **binding resource** is any resource with zero post-plan capacity. If none is zero, the **limiting resource** is the resource with the smallest normalized post-plan slack, `predicted_capacity_after / max(declared_capacity, 1)`. Ties are reported together in stable `resource_key` order; no arbitrary single winner is invented.

### 3.3 Transparent conservative estimation

The kernel MUST derive predicted demand from the domain action type, declared proposal data, the versioned work-cost table, and observed immutable history. Agent-supplied labels or conclusions such as `safe`, `covered`, `equivalent`, `simulation_passed`, or a self-reported resource estimate are evidence inputs only and are never authoritative.

For v0.1, each resource and comparable work class has a declared base estimate. Using at most the ten most recent completed comparable items:

```text
calibrated_estimate = max(declared_base_estimate, maximum_observed_actual)
additive_correction = calibrated_estimate - declared_base_estimate
```

If no comparable actual exists, the declared base estimate is used. Work-class keys and the selected history records MUST be shown in the Promise Basis. v0.1 does not automatically reduce an estimate below its declared base. A changed estimator, work-class definition, or assumption requires a new capacity-model version.

Predicted and actual consumption MUST remain separate values. Later observations append calibration facts; they never overwrite the prediction that supported an earlier decision. Counts of recent binding or limiting resources MAY drive targeted suggestions such as, "Human review was the binding resource in 7 of the last 10 constrained admissions."

## 4. Portfolio and action representation

### 4.1 Obligation schema

Each accepted obligation and proposal MUST contain at least:

```yaml
obligation_id:
beneficiary:
objective:
service_level:
protected: true | false
deadline_or_horizon:
criticality: protected | important | best_effort
minimum_service:
modification_policy:
  modifiable_fields:
    <field>:
      allowed_bounds:
      utility_rule:
      dimension_weight:
resource_demand:
assumptions:
evidence_refs:
required_effects:
status: proposed | accepted | completed | failed | declined
```

`minimum_service` is the explicit typed service floor for each service dimension. Each `modifiable_fields` entry names one field that may change, its closed allowed bounds, a versioned monotonic rational `utility_rule`, and a nonnegative rational `dimension_weight`. A field absent from `modifiable_fields`, a value outside its bounds, or an obligation missing any required policy field is not modifiable. `protected: true` and `criticality: protected` MUST agree; inconsistency fails closed.

For a permitted field change from accepted value `old` to candidate value `new`, with declared floor `floor`:

```text
dimension_loss
  = (utility(old) - utility(new))
  / (utility(old) - utility(floor))

obligation_service_loss
  = sum(dimension_weight * dimension_loss)
    / sum(dimension_weight)
```

The policy MUST define utility so more service has no lower utility, each utility denominator and the sum of dimension weights are positive, and the result is an exact rational in `[0, 1]`; otherwise the modification fails closed. Unchanged dimensions contribute zero. A candidate below a minimum-service floor is a decline or replacement, not a modification, and is outside the permitted v0.1 replan search.

### 4.2 Typed action graph

The root agent assembles proposed work into a small typed directed acyclic graph. Each action contains:

```yaml
action_id:
display_name:
objective_id:
depends_on:
incoming_branch_ids:
execution_boundary_id:
effect_fingerprints:
consequence: read_only | consequential_reversible | consequential_irreversible
criticality: protected | important | best_effort
authority_required:
proposed_approval_scope:
alternative_actions:
evidence_refs:
resource_work_class:
```

Action IDs, display names, MCP names, and tool names are routing metadata. They are not effect identity and MUST NOT determine approval coverage or denial matching. The schema is intentionally microfactory-specific and narrow; v0.1 is not a generalized workflow or change-taxonomy framework.

Conditional edges MUST be represented separately as typed branch records:

```yaml
branch_id:
source_action_id:
target_action_ids:
downstream_decision_ids:
guard_predicate:
  selector_id:
  operator: equals | in
  typed_values: []
exclusivity_group:
selected_by_decision_id:
selected_bundle_id:
```

Every branch ID and linkage ID is stable. All referenced actions, decisions, and bundles MUST exist. `equals` requires exactly one typed value; `in` requires a finite nonempty typed set. The v0.1 kernel may prove branches mutually exclusive only when they share one `exclusivity_group` and one single-valued `selector_id`, their typed guard-value sets are pairwise disjoint, and the selecting decision and bundle links are complete. Missing guards, overlapping values, dangling links, or unverifiable selector semantics fail closed; the branches are treated as co-reachable.

## 5. Normative authorization semantics

### 5.1 Typed stable effect fingerprints

Every consequential effect MUST have a typed identity with all of these fields:

```yaml
effect_schema_version:
environment_id:
effect_type:
target_type:
target_id:
operation:
material_parameters:
```

`effect_type`, `target_type`, `operation`, and the required typed keys in `material_parameters` come from the bounded domain schema identified by `effect_schema_version`. For example, a schedule reservation fingerprint identifies the synthetic factory, order, production cell, operation, start and end times, and quantity.

The stable full fingerprint is the canonical, type-preserving serialization of those submitted fields in declared-schema order after target-alias resolution. It includes the raw `effect_schema_version`, which remains audit and provenance metadata. A digest MAY be stored as an index, but the typed fields are authoritative. Display name, action ID, graph position, agent, MCP server, and tool name are deliberately excluded. Target aliases MUST be resolved through a versioned authoritative alias table; an unknown alias fails closed.

Every supported effect-schema version MUST declare a deterministic normalizer to a common canonical typed semantic form containing a `canonical_effect_class`, environment, target type, canonical target ID, operation, and normalized material parameters. The normalizer MUST preserve every material distinction. Two effects are **equivalent** exactly when their supported representations normalize to the same canonical semantic form; their raw schema versions and full fingerprints may differ. Renaming an action, moving it in the graph, using a different agent, MCP, or tool, or using an alternate supported serialization does not change equivalence. Changing a material parameter creates a different full fingerprint and canonical effect identity, while the canonical effect class remains the typed basis for scoped matching. Full fingerprints remain immutable representation-identity and audit anchors, but Section 5.4 deliberately does not require full-fingerprint equality when matching future effects to a scoped denial.

Missing required fingerprint fields, unknown field types, unsupported schema versions, unresolved aliases, and unrecognized material parameters fail closed.

### 5.2 Typed bounded approval scopes and coverage

Every proposed scope and issued grant MUST contain:

```yaml
scope_schema_version:
environment_id:
allowed_effect_schema_versions: []
allowed_effect_types: []
allowed_target_types: []
allowed_target_ids: []
allowed_operations: []
material_parameter_constraints: {}
resource_constraints: {}
objective_id:
promise_basis_id:
approver_id:
valid_from:
valid_until:
max_executions:
```

All lists are explicit, finite, nonempty sets. v0.1 supports no wildcard. Each material parameter and relevant resource required by an allowed effect type MUST have an equality, finite-set, or closed-range constraint of the correct type. `valid_until` and `max_executions` make the scope time- and count-bounded. Missing fields or constraints fail closed.

An issued `ApprovalGrant` wraps exactly one scope and MUST also contain `grant_id`, `grant_version`, `authorization_state_version`, `decision_id`, `selected_bundle_id`, `portfolio_version`, `capacity_model_version`, `capacity_plan_version`, `issued_at`, `status`, and the durable set of claimed execution slots. It cannot authorize a bundle other than the one selected by its referenced decision.

An effect occurrence is the typed fingerprint plus its `objective_id`, `promise_basis_id`, typed resource claims, attempted execution time, and atomically assigned grant execution ordinal. For an effect occurrence `e` and scope `s`, `covers(s, e)` is true if and only if all of the following are true:

1. both schemas are supported and every required typed field is present;
2. `environment_id`, `objective_id`, and `promise_basis_id` exactly match;
3. the effect schema version, effect type, target type, canonical target ID, and operation are members of their corresponding finite allowed sets;
4. every material effect parameter and relevant resource claim satisfies its named typed constraint, with no unconstrained material parameter or resource;
5. the attempted execution time is within the closed validity interval; and
6. the atomically assigned grant execution ordinal is positive and does not exceed `max_executions`.

For two scopes `A` and `B`, `scope_contained(A, B)` is true only when every typed permission represented by `A` is contained by `B`:

1. both schemas are supported and compatible, and every required dimension is present;
2. `environment_id`, `objective_id`, `promise_basis_id`, and `approver_id` exactly match;
3. each allowed effect-schema-version, effect-type, target-type, target-ID, and operation set in `A` is a subset of the corresponding set in `B`;
4. for every material-parameter and resource dimension, the permitted domain in `A` is a subset of the same typed domain in `B`: equality is a singleton, a finite set uses set inclusion, and a closed range's lower and upper bounds MUST lie within `B`'s closed range;
5. `A`'s validity interval is contained within `B`'s validity interval; and
6. `A.max_executions <= B.max_executions`.

Unknown types, incomparable constraint forms, extra unconstrained dimensions, or a missing required dimension fail closed. `A` is a **strict subset** of `B` only when `scope_contained(A, B)` is true and at least one set, value domain, range, resource bound, time bound, or execution bound is properly narrower. Different labels do not affect containment.

An effect is **authorized** only when a live grant references the selected decision bundle and approver, its scope covers the effect occurrence, the grant has not been revoked or exhausted, and no active denial matches. A broad textual approval, agent claim, or similar prior action is not coverage.

Core safety invariant:

> No path to a consequential external effect may execute without crossing a live approval grant whose typed bounded scope covers that exact effect occurrence and whose selected action bundle remains admission-feasible.

Before any consequential effect, the authoritative authorization ledger MUST atomically claim one grant execution slot. The indivisible claim operation receives a stable `execution_attempt_id`, the exact effect occurrence, and expected grant, authorization-state, portfolio, capacity-model, and capacity-plan versions. In the same fail-closed operation it MUST:

1. compare every expected version with current authoritative state;
2. validate that the grant is live, unrevoked, unexpired, and bound to the selected decision bundle;
3. recompute scope coverage and active-denial matching;
4. recompute that the selected bundle remains admission-feasible; and
5. allocate one previously unclaimed execution ordinal not greater than `max_executions` and bind it permanently to `execution_attempt_id`.

The claim is the authorization linearization point: claim and revocation serialize, only a successful claimant may invoke the controlled effect, and concurrent or repeated attempts cannot consume the same slot. Failure of any validation creates no claim and permits no effect. The controlled executor MUST validate the resulting claim before mutation.

Every consequential attempt MUST use its `execution_attempt_id` as the idempotency key across the slot claim, controlled MCP call, read-back, and receipt. Replaying the same ID with the same canonical effect and grant returns the already recorded claim and result; it MUST NOT claim another slot or repeat the consequential effect. Reuse of that ID with a different grant, effect, or material payload fails closed. A different ID cannot take a slot already bound to another attempt.

### 5.3 Meaningful decisions and mutually exclusive branches

A **meaningful decision** is one owner selection among fully specified, mutually exclusive action bundles. It consumes one unit of `human_review_decisions` only when all alternatives share:

- one objective;
- one immutable evidence packet;
- one responsible approver; and
- one mechanically enforced all-or-none execution boundary.

The typed decision record MUST contain `decision_id`, `objective_id`, `evidence_packet_id`, `approver_id`, `execution_boundary_id`, the complete finite list of alternative bundles, the stable branch IDs selected by each bundle, `selected_bundle_id` or `PENDING`, and `status`. Each bundle has its own stable ID and the complete fields required below.

Every alternative MUST enumerate its obligations changed, effects, scopes, resource consequences, expected state, and no-op or decline result before the decision is presented. Several effects may share one decision only if they are inseparable parts of the selected fully specified bundle and the boundary prevents partial execution. If the environment cannot enforce all-or-none behavior, the effects require separate decisions.

Unrelated effects, different objectives, different evidence packets, different approvers, or independently executable effects MUST NOT be grouped merely to reduce the decision count. Formatting several prompts as one summary does not create one meaningful decision.

Mutually exclusive branches count as follows:

- Alternatives selected by one conforming meaningful decision count as one decision only when their branch records satisfy the proof rule in Section 4.2; only the selected bundle and its linked branch can receive grants.
- For a proven exclusive branch followed by later decisions, reserve the selector decision plus the maximum capacity and downstream decision demand of any reachable branch, not the sum of branches that cannot co-occur.
- Branches without a proven shared selector, disjoint guards, exclusivity-group linkage, and complete downstream action/decision links are treated as co-reachable.
- If exclusivity or downstream reachability cannot be proven from the declared structure, the kernel fails closed by conservatively counting all relevant branches against resource and human-review capacity.

The human-capacity prediction includes promise admission, modifications to accepted promises, and later effect approvals expected within the horizon. One decision MAY perform more than one of those roles only when the fully specified bundle satisfies every rule above and the resulting grant is explicit.

### 5.4 Denials as active authorization constraints

A denial is not merely history. It creates an active `DenialConstraint` containing:

```yaml
denial_id:
denied_effect_fingerprint:
denied_scope:
denied_scope_predicate:
  scope_schema_version:
  environment_id:
  allowed_canonical_effect_classes: []
  allowed_canonical_target_types: []
  allowed_target_ids: []
  allowed_canonical_operations: []
  material_parameter_constraints: {}
  resource_constraints: {}
  objective_id:
objective_id:
approver_id:
evidence_packet_id:
created_at:
mission_id:
reason:
status: active | superseded | mission_closed
```

The originally denied full fingerprint and scope are both required and remain immutable audit and representation-identity anchors. `denied_scope` is the complete rejected typed scope used for owner display and strict-subset checks. `denied_scope_predicate` is its canonical effect-relevant projection with exactly the fields shown above, and its `objective_id` MUST equal the outer denial `objective_id`. Construction of the predicate MUST deterministically normalize every supported effect-schema representation admitted by the denied scope into its canonical effect class; raw effect-schema versions are retained in the original scope and fingerprint for audit, not copied into the matching predicate. Denial record identity is the tuple of the original stable full fingerprint and canonical denied-scope predicate; future denial matching is determined by the predicate, not equality with the anchor fingerprint. A malformed or non-normalizable denial cannot be created; if malformed active denial data is encountered, authorization for its objective fails closed until authoritative state is repaired.

Before denial matching, FlakeBrake MUST normalize the attempted supported representation through the declared deterministic canonicalization rules. For any active denial in the same environment and objective, if FlakeBrake cannot establish whether the attempted representation has the denied canonical effect identity, consequential authorization fails closed; it MUST NOT classify the uncertain representation as non-matching.

There is one denial-match rule. An active denial matches a canonically normalized attempted effect if and only if:

1. environment and objective exactly match the denied-scope predicate;
2. canonical effect class, normalized target type, canonical target ID, and normalized operation belong to the predicate's finite allowed sets; and
3. every material parameter and relevant resource claim satisfies its corresponding typed denied constraint.

Full-fingerprint equality and raw effect-schema-version equality are not match conditions. Material parameters are tested through the typed denied-scope predicate. Therefore, if supported schema versions V1 and V2 normalize to the same canonical effect class, target, and operation, an in-scope effect represented by either version matches even when its full fingerprint differs. A genuinely different canonical effect class does not match merely because a parameter value overlaps.

This matcher does not call `covers` and does not compare `promise_basis_id`, approver, approval-validity interval, or grant execution count; denial lifetime is governed only by the rule below. Action names, tool or MCP names, labels, plan-node names, raw schema versions, and serialization choices are non-authoritative for denial matching. Renaming an action, selecting an alternate tool, or submitting an equivalent supported schema representation cannot evade a matching denial.

In v0.1 a denial remains active through graph rewrites, renamed actions, alternate agents, alternate MCPs or tools, session reconnects, and portfolio replans. Time passage alone does not expire it. It ends only when the mission is closed or the owner explicitly supersedes it through a valid re-request decision. The old denial record remains immutable.

A re-request MUST reference the prior `denial_id`, declare its change class, and pass one of these deterministic conditions:

- **narrower scope:** `scope_contained(requested_scope, denied_scope)` is true under Section 5.2 and at least one typed permission dimension is properly narrower; or
- **materially new basis:** new post-denial evidence or a changed precondition alters at least one domain field predeclared as material in the Promise Basis schema, and the domain verifier validates the new evidence receipt.

A renamed action, alternate tool, changed plan node, different full fingerprint, equivalent raw schema version or serialization, or material-parameter change that remains inside the denied scope is neither a bypass nor a material change for re-request. New prose rationale or repeated identical evidence is also insufficient. Until the owner explicitly approves a valid re-request, the denial continues to block matching approval requests and execution. Supersession is recorded by an append-only event linked to both the denial and the new decision.

## 6. Deterministic admission kernel

### 6.1 Inputs, independent recomputation, and feasibility

The deterministic kernel receives:

- the proposal and selected `portfolio_version`;
- the `capacity_model_version` and `capacity_plan_version`;
- the `authorization_state_version` and the active grants and denials at that version;
- the complete accepted portfolio and reservations;
- typed action graphs, effects, dependencies, and complete branch records with selectors and exclusivity linkage;
- proposed decisions and approval scopes;
- evidence receipts and comparable immutable admission history.

It independently validates schemas and recomputes the portfolio schedule, resource demand, protected slack, meaningful-decision frontier, effect equivalence, scope coverage, and denial matches. LLM judgment can propose inputs but cannot declare feasibility, safety, coverage, equivalence, or authorization.

During admission, coverage analysis proves that the proposed decision frontier and scopes can cover every consequential path and includes those decisions in predicted human demand; a proposed scope is not a grant. During execution, only issued live grants count as authorization.

Within the bounded v0.1 domain, candidate alternatives are finite and the kernel MAY exhaustively enumerate them. It MUST NOT claim optimal scheduling for arbitrary graphs or domains.

### 6.2 Outcome sequence

The kernel uses this mandatory sequence:

1. Validate and evaluate the **direct plan**: add the proposal without changing any accepted obligation or capacity plan.
2. If the direct plan is feasible, emit `ADMITTABLE`.
3. If direct admission fails, run the permitted portfolio-wide replan search in Section 6.4.
4. If that search finds at least one feasible structurally different plan, emit `REPLAN` with ranked candidates and a recommendation.
5. Emit `REJECT` only when both direct admission and permitted replanning fail.

Every evaluation emits exactly one immutable AdmissionRecord as specified in Section 8. Owner choices and execution happen after evaluation and cannot retroactively change its decision.

### 6.3 `ADMITTABLE`

`ADMITTABLE` means the proposal can fit under the exact declared versions and assumptions. It is valid only for the complete immutable evaluated state tuple `(portfolio_version, capacity_model_version, capacity_plan_version, authorization_state_version)`. It does not accept the promise and does not authorize execution.

Every `ADMITTABLE` result MUST declare:

- portfolio version, also emitted as `expected_portfolio_version` for acceptance;
- capacity-model version, also emitted as `expected_capacity_model_version` for acceptance;
- capacity-plan version, also emitted as `expected_capacity_plan_version` for acceptance;
- authorization-state version, also emitted as `expected_authorization_state_version` for acceptance;
- every relevant capacity constraint;
- all feasibility and estimator assumptions;
- capacity before admission, by resource;
- predicted consumption, by resource;
- predicted capacity remaining after admission, by resource;
- protected-obligation slack after admission;
- every binding resource, or the limiting resource when none binds;
- the complete domain-specific Promise Basis; and
- the explicit owner choices **ACCEPT PROMISE**, **MODIFY**, and **DECLINE**.

An `ACCEPT PROMISE` request MUST carry `expected_portfolio_version`, `expected_capacity_model_version`, `expected_capacity_plan_version`, and `expected_authorization_state_version` from the selected `ADMITTABLE` AdmissionRecord. Portfolio activation uses one atomic compare-and-swap/precondition operation. Acceptance succeeds only if all four equal current authoritative state:

```text
expected_portfolio_version      == current_portfolio_version
expected_capacity_model_version == current_capacity_model_version
expected_capacity_plan_version  == current_capacity_plan_version
expected_authorization_state_version == current_authorization_state_version
```

The same operation validates that every specifically approved bounded modification remains applicable and writes the resulting portfolio as one new version. If any version comparison or validation fails, FlakeBrake fails closed, performs no portfolio mutation, preserves the prior AdmissionRecord without rewriting it, appends a stale/superseded acceptance result, and reruns admission against the current portfolio, capacity model, capacity plan, and authorization state. Any concurrent change to one component of the evaluated state tuple therefore prevents the stale admission from committing.

This acceptance precondition prevents a promise from committing against already-stale authorization assumptions. It does not issue a grant and does not replace the execution-time authorization recomputation, version validation, denial matching, or atomic grant-slot claim required by Sections 5.2 and 7.2.

On a successful compare-and-swap, `ACCEPT PROMISE` creates one new portfolio version containing the promise and only those modifications to existing obligations that received explicit conforming owner decisions. `MODIFY` creates a new proposal and reruns evaluation. `DECLINE` records the owner's choice without adding the promise; it is not a kernel `REJECT`.

The predicted human consumption includes the pending owner choice and any separate effect approvals within the horizon. Promise acceptance is not automatically an execution grant.

### 6.4 `REPLAN`

`REPLAN` evaluates the entire accepted portfolio plus the proposal. It MUST always evaluate both strategy families, recording infeasibility reasons when a family has no constructible candidate:

1. modify the new proposal's quantity, deadline, service level, action structure, or resource demand within declared bounds; and
2. modify one or more existing non-protected `important` or `best_effort` obligations within their declared modification policies.

Portfolio-wide replanning is required and MUST NOT be simplified to changing only the newest proposal. An existing accepted obligation may appear in a modification candidate only when all of the following hold:

1. `protected` is false and `criticality` is not `protected`;
2. its declared `modification_policy` names every changed field and the proposed value is within that field's allowed bounds;
3. every resulting service dimension remains at or above `minimum_service`;
4. its exact rational `obligation_service_loss` from Section 4.1 is included in the criticality-weighted degradation objective; and
5. the owner explicitly approves the specific old-to-new field changes before the compare-and-swap activates the new portfolio version.

Protected obligations cannot be degraded by the permitted v0.1 search. Accepted promises are never rewritten by search or recommendation. A missing policy, unspecified bound, below-floor result, or unapproved field change makes that candidate infeasible.

A replan is structurally different only if it changes at least one obligation term, resource allocation, effect set, dependency, enforced branch, or all-or-none execution boundary. Renaming actions, changing tools, reformatting prompts, or summarizing the same approvals is not structural change.

Feasible candidates are ordered lexicographically, not by a blended opaque score:

1. preserve every protected obligation; candidates that fail this are excluded;
2. minimize the sum of criticality weight times the exact normalized `obligation_service_loss` defined in Section 4.1 (`important = 10`, `best_effort = 1` in the demo fixture);
3. minimize the number of previously accepted obligations changed;
4. minimize added capacity cost under the candidate assumptions and declared cost values; and
5. maximize the minimum normalized post-plan slack across relevant constraints.

Candidates tied on all five criteria use stable candidate-plan ID order. If added-capacity choices lack a declared comparable cost, the kernel reports the nondominated alternatives and does not invent a scalar cost. Any capacity increase remains hypothetical until owner approval creates a new capacity-plan version and admission is rerun.

The `REPLAN` result MUST show the direct-plan failure, candidates from both required strategy families, the selected recommendation, complete portfolio diffs, resource before/after values, protected slack, decision requirements, and all assumptions. Selecting a replan does not itself mutate the portfolio.

### 6.5 `REJECT` and capacity-expansion sensitivity

`REJECT` is emitted only after direct admission and the permitted replan search both fail under the current capacity plan. It MUST include the specific violated constraints and, where calculable, targeted minimal changes that would make at least one proposal variant feasible.

For numeric resources, the kernel computes the nonnegative deficit vector for each least-degrading candidate. For bounded deadline or service-level alternatives, it enumerates the declared allowed changes. It then removes any option dominated by another option that requires no greater change in every dimension and a smaller change in at least one. The result is the Pareto-minimal set of capacity or constraint changes, such as:

- one additional meaningful human-review decision;
- additional agent work units;
- a bounded deadline extension;
- a narrower quantity or service level; or
- a newly declared relevant resource with its required amount and assumptions.

When the capacity plan declares comparable cost or disruption values, the result recommends the least-cost or least-disruptive Pareto-minimal option. Without those values it reports the alternatives without pretending to know owner preference. If a change is not calculable under the model, the result states that fact and the missing variable.

Owner approval of an expansion creates a new immutable `capacity_plan_version`; it does not convert the old rejection into an admission. The kernel MUST rerun the full sequence against the new version and create a new AdmissionRecord.

## 7. Normative action-assurance floor

Admission feasibility is necessary but never sufficient for consequential execution. Before any consequential effect, FlakeBrake v0.1 MUST satisfy all five requirements below.

### 7.1 Typed effects and scoped grants

Every consequential effect has the stable typed fingerprint in Section 5.1. Every grant has the typed bounded scope in Section 5.2. The exact effect occurrence MUST be covered by a live grant, and its execution attempt MUST own the atomically claimed grant slot before controlled execution begins.

### 7.2 Deterministic portfolio and effect recomputation

Immediately before execution, deterministic code MUST recompute portfolio feasibility, capacity remaining, protected slack, the selected bundle, effect identity, scope coverage, and active-denial matches from authoritative state. This final recomputation and the execution-slot claim MUST occur in the same atomic fail-closed operation defined in Section 5.2; a separate check followed by a later claim is insufficient. Agent-supplied `safe`, `covered`, `equivalent`, or similar claims cannot substitute for recomputation.

If the portfolio, capacity model, capacity plan, authorization state (including grants and denials), Promise Basis, evidence, or expected effect has materially changed since admission, execution pauses and admission reruns against current versions. This execution-time rule remains required even when the acceptance precondition in Section 6.3 succeeded.

### 7.3 Domain-specific pre-approval Promise Basis

Every proposed promise and consequential portfolio change presented for approval MUST include a versioned microfactory Promise Basis containing:

- proposed order quantity, service level, beneficiary, and deadline;
- evaluated portfolio, capacity-model, capacity-plan, and authorization-state versions together with `expected_portfolio_version`, `expected_capacity_model_version`, `expected_capacity_plan_version`, and `expected_authorization_state_version` acceptance preconditions;
- resource capacity before, predicted consumption, capacity after, and calibration corrections;
- assumptions and evidence receipts, including deterministic schedule/simulation results;
- every affected accepted obligation, its modification policy and minimum-service floor, each exact proposed term change, and normalized degradation;
- protected obligations and their post-plan slack;
- consequential effect fingerprints, proposed scopes, decision bundles, branch guards and exclusivity proofs, and active denials;
- binding or limiting resources; and
- authorized expected post-execution state and verification method.

The Promise Basis is computed from authoritative portfolio, ledger, and synthetic-environment reads. It MUST be available to the owner before promise acceptance or approval.

### 7.4 Denial-resistant replanning

Every replan and pre-execution check MUST include active `DenialConstraint` records. Matching effects remain blocked across renamed actions, graph changes, alternate tools, and alternate agents unless the re-request and explicit supersession rules in Section 5.4 are satisfied.

### 7.5 Post-execution verification and durable receipt

After an approved consequential action, FlakeBrake MUST read state back through the authoritative synthetic environment, compare it field-by-field with the authorized expected state, and persist exactly one durable logical receipt for the stable `execution_attempt_id` before reporting completion.

The receipt MUST contain at least:

```yaml
receipt_id:
execution_attempt_id:
admission_record_id:
portfolio_version:
effect_fingerprint:
decision_id:
grant_id:
grant_execution_ordinal:
before_state_ref:
expected_after_state:
observed_after_state:
actual_consumption:
verification_status: verified | mismatch | unavailable
evidence_refs:
recorded_at:
```

The controlled mutation service MUST durably bind `execution_attempt_id` to the claimed grant ordinal and mutation result before acknowledging the write. A retry or duplicate delivery with the same ID returns that recorded result and receipt identity without repeating the effect; a different ID cannot reuse the ordinal. If a response is lost, FlakeBrake recovers the prior result by attempt ID and completes read-back rather than issuing a new mutation.

Only `verified` may be reported as completed. `mismatch` or `unavailable` records the observed result, keeps the promise outcome open or failed as appropriate, and triggers safe replanning or escalation; it MUST NOT be relabeled as success.

Broader certificate frameworks, generalized change taxonomies, hash chains, and similar assurance expansion are outside v0.1 unless every required core capability is already complete and reliable.

## 8. Measure, don't destroy: immutable admission history

**Measure, don't destroy** is a governing design rule. Every `ADMITTABLE`, `REPLAN`, and `REJECT` evaluation MUST create an immutable AdmissionRecord containing:

```yaml
record_id:
created_at:
portfolio_version:
expected_portfolio_version:
capacity_model_version:
expected_capacity_model_version:
capacity_plan_version:
expected_capacity_plan_version:
authorization_state_version:
expected_authorization_state_version:
proposal:
candidate_plans:
selected_plan:
decision: ADMITTABLE | REPLAN | REJECT
capacity_before:
predicted_consumption:
predicted_capacity_after:
protected_obligation_slack:
binding_or_limiting_resource:
assumptions:
owner_choice:
actual_consumption:
outcome:
additive_corrections:
```

`decision` is the kernel result; `owner_choice` is the later human response; and `outcome` is the eventual operational result. For `ADMITTABLE`, each `expected_*_version` equals its corresponding evaluated version; for other outcomes each is `NOT_APPLICABLE`. At evaluation time, unavailable later facts use explicit sentinel values such as `PENDING_OWNER_CHOICE` and `NOT_YET_KNOWN`; `selected_plan` uses `NO_FEASIBLE_PLAN` for a rejection. Fields are never omitted. Owner choices, compare-and-swap results, stale/superseded markers, execution-attempt IDs, actual consumption, verification outcomes, corrected evidence, and supersession facts are appended as immutable addenda with their own IDs, timestamps, source receipts, and reference to `record_id`. A materialized view MAY project the base record plus addenda, but it MUST preserve and expose every prior value. No record, prediction, candidate, decision, denial, or outcome may be silently rewritten or deleted.

Calibration reads only transparent prior records and their addenda under Section 3.3. It MUST preserve predicted versus actual demand and the exact additive correction used for each later estimate. Recurring binding-resource counts MAY inform the targeted expansion analysis in Section 6.5, but historical correlation is not a fulfillment guarantee.

## 9. Synthetic microfactory environment and TrueForge

### 9.1 Required MCP capabilities

The demo MUST genuinely use at least three MCP servers. The selected environment uses four bounded services:

- **factory-orders** — read accepted orders, service levels, deadlines, and immutable portfolio versions;
- **factory-capacity** — read human, agent, and production-cell capacity plans plus actual consumption;
- **factory-simulator** — deterministically evaluate candidate schedules and return evidence receipts without external mutation;
- **factory-change-control** — atomically validate the claimed grant slot, idempotently create the explicitly approved synthetic schedule reservation or change request by `execution_attempt_id`, return any previously recorded result for a replay, and read state back.

The final approved action changes real state in the owned synthetic environment only. No real factory or production integration is required or permitted for v0.1.

### 9.2 TrueForge topology

The mission runs through a TrueForge root agent with at least three visible subagents:

```text
ROOT OBLIGATION COMMANDER
        |
        +-- portfolio and order analyst
        +-- capacity and schedule analyst
        +-- assurance and simulation engineer
```

Each subagent returns findings, evidence references, proposed actions, dependencies, typed effects, resource work classes, and available alternatives. TrueForge MUST visibly provide:

- the root agent loop and genuine subagent execution;
- genuine MCP access;
- sandboxed Code Mode or generated-code execution for meaningful analysis;
- human approval pauses;
- persisted session state; and
- reconnect/resume behavior that preserves the mission, portfolio, graph, evidence, AdmissionRecords, grants, and denials.

FlakeBrake MUST use rather than recreate these harness functions.

### 9.3 Required overload, denial, and final action

The first direct safe plan MUST exceed both `human_review_decisions` and `agent_work_units`. No consequential action is authorized while the outcome is `REPLAN` or `REJECT`.

The demonstration MUST include one denied consequential effect or scope. The next replan MUST retain completed investigation evidence and the denial, avoid repeating the full investigation, and prove mechanically that a renamed action or alternate MCP/tool cannot reproduce the denied effect.

The final approved path creates a bounded schedule reservation or tested schedule-change request in the synthetic environment. It MUST be read back and verified against the authorized expected state before the root agent reports completion.

## 10. Required UI and three-minute demonstration

The focused v0.1 UI MUST show:

- the accepted-obligation portfolio and version;
- resource capacity before, predicted consumption, predicted capacity after, and protected slack;
- the direct-plan failure and binding constraints;
- side-by-side new-proposal and existing-obligation replan candidates;
- exact changes to previously accepted promises;
- the lexicographic recommendation rationale;
- **ACCEPT PROMISE / MODIFY / DECLINE** at `ADMITTABLE`;
- pending and completed meaningful decisions, grants, and denials;
- immutable AdmissionRecord history, predicted-versus-actual demand, and final verification receipt.

The required demo sequence is:

1. Show the existing portfolio and finite human, agent, and production capacity.
2. Submit the rush-order proposal; direct admission fails on simultaneous constraints and creates a `REPLAN` record.
3. Compare modifying the rush order with moving lower-criticality existing work; no protected order disappears.
4. Let the owner select any proposed portfolio modifications, rerun admission, display post-promise capacity in `ADMITTABLE`, and require **ACCEPT PROMISE / MODIFY / DECLINE**.
5. Deny one effect or scope; show the active denial surviving an alternate-tool replan.
6. Approve the bounded alternative, execute one controlled synthetic write, read it back, persist the receipt, and show actual versus predicted demand.

The scoreboard MUST expose at least:

```text
Portfolio version
Capacity-model and capacity-plan versions
Accepted obligations preserved/modified
Human decisions before/predicted/remaining
Agent work before/predicted/remaining
Protected-obligation slack
Direct-plan binding constraints
Candidate replan strategies compared
Consequential paths uncovered
Denied effects/scopes survived
Controlled external writes
Silent dropped obligations
Admission records created
Predicted versus actual demand
Post-execution verification status
```

`Consequential paths uncovered` and `Silent dropped obligations` MUST both be zero before successful completion.

## 11. Submission scope and milestones

FlakeBrake v0.1 is the actual hackathon submission, not a thin interim product version. Internal work uses these milestones:

- **M0 — spec + TrueForge smoke test**
- **M1 — deterministic admission kernel**
- **M2 — portfolio scheduler + immutable admission ledger**
- **M3 — synthetic operational environment + MCPs**
- **M4 — TrueForge end-to-end integration**
- **M5 — UI, hardening, clean-clone verification, demo**

The final v0.1 target includes:

- an existing accepted-obligation portfolio;
- at least one human-side and one agent-side constrained resource;
- typed effects, grants, decisions, and denials;
- `ADMITTABLE` with post-promise capacity and explicit owner choice;
- portfolio-wide `REPLAN`;
- `REJECT` with targeted minimal capacity-expansion or constraint-change suggestions;
- immutable admission records and simple evidence-based calibration;
- the domain-specific Promise Basis;
- denial-resistant replanning;
- post-execution verification and a durable receipt;
- genuine TrueForge subagents, MCPs, sandbox execution, approval, and persistence;
- a focused capacity/replan UI; and
- meaningful mechanical tests and clean-clone reproducibility.

## 12. v0.1 acceptance criteria

FlakeBrake v0.1 is not complete unless all of the following pass:

- [ ] The microfactory rush-order mission starts with a versioned portfolio containing protected, important, and best-effort accepted obligations.
- [ ] The deterministic direct plan exceeds both a declared human-review constraint and a declared agent-work constraint.
- [ ] `ADMITTABLE` contains every required version, constraint, assumption, before/consumed/after value, protected slack, limiting resource, Promise Basis, and owner choice; a mismatch in any expected portfolio, capacity-model, capacity-plan, or authorization-state version fails the atomic acceptance precondition without mutation, appends a stale/superseded result, and triggers readmission.
- [ ] `REPLAN` evaluates and displays both modification strategy families; every proposed accepted-obligation change is non-protected, policy-bounded, at or above its minimum-service floor, scored as degradation, and specifically owner-approved before activation.
- [ ] Mechanical tests verify the exact lexicographic recommendation order and structural-difference rule.
- [ ] `REJECT` occurs only after direct and replan failure and reports Pareto-minimal targeted changes where calculable.
- [ ] Owner-approved capacity expansion creates a new capacity-plan version and a fresh admission evaluation.
- [ ] Effect equivalence survives action renames, alternate tools, and equivalent supported schema representations under the declared deterministic normalizers.
- [ ] Scope coverage and scope-to-scope containment fail closed for every missing, unknown, expired, exhausted, incomparable, or out-of-bounds field; strict-subset tests exercise sets, values, ranges, resources, time, and execution count.
- [ ] Mechanical tests prevent unrelated effects from sharing a decision and grant exclusive accounting only to branch records with stable IDs, disjoint guards, shared exclusivity linkage, and complete downstream links.
- [ ] The canonical typed denied-scope predicate blocks in-scope material-parameter variants, renamed actions, alternate tools, changed plan nodes, and equivalent supported schema representations without requiring full-fingerprint or raw-schema-version equality, while genuinely different canonical effect classes remain distinct and uncertain equivalence fails closed.
- [ ] Portfolio feasibility, decision demand, effect coverage, and denial matches are recomputed by deterministic code.
- [ ] Concurrent or repeated execution attempts cannot claim the same grant ordinal; validation, version checks, and slot claim are one atomic fail-closed operation.
- [ ] Duplicate delivery of one `execution_attempt_id` returns the recorded result without repeating the consequential effect or creating a second logical receipt.
- [ ] Every outcome creates an immutable AdmissionRecord; later owner choices, actuals, outcomes, and corrections are append-only.
- [ ] Calibration is transparent, preserves predicted and actual demand, and uses only declared bases plus comparable observed history.
- [ ] Every approval displays a complete microfactory Promise Basis.
- [ ] No consequential path executes without an exact live scoped grant, and uncovered consequential paths equal zero.
- [ ] The final consequential action waits for explicit TrueForge approval, changes controlled synthetic state, is read back, and has a durable verified receipt before completion is reported.
- [ ] The mission uses a TrueForge root agent, at least three visible subagent threads, at least three genuine MCP servers, and meaningful sandbox execution.
- [ ] Refresh/reconnect preserves the mission, portfolio, graph, evidence, records, grants, and denial constraints.
- [ ] The focused UI makes capacity, portfolio diffs, recommendation rationale, owner choices, and history legible.
- [ ] Tests include no silent dropped obligations, denial-bypass, record immutability, predicted-versus-actual, and verification-mismatch cases.
- [ ] Substantive code is merged only after required review and follow-up.
- [ ] A clean clone reproduces mechanical tests and the complete causal story fits comfortably within three minutes.

## 13. Explicitly deferred beyond v0.1

Unless the complete required submission is already reliable, defer:

- learned or probabilistic capacity forecasting;
- arbitrary cross-domain or generalized mixed-criticality scheduling;
- generated MCP servers;
- long-term human-competence, cognition, fatigue, or earned-capacity estimation;
- generalized earned-autonomy systems;
- real production or factory integration;
- cloud bursting or real cloud/GPU infrastructure;
- exhaustive model-cost optimization or model-family benchmarking;
- multiple polished demonstration scenarios;
- stochastic deadline or universal fulfillment guarantees;
- arbitrary workflow compilation;
- custom memory or continuity systems that duplicate TrueForge;
- production authentication; and
- broader certificate frameworks, generalized change taxonomies, or hash-chain systems.

## 14. Design-history reconciliation

This revision preserves the compatible intent of the baseline draft: a deterministic kernel; a narrow typed action graph; required initial overload; structural rather than cosmetic backpressure; a denial that survives replanning; a controlled synthetic write followed by read-back; TrueForge root/subagent/MCP/sandbox/approval/persistence requirements; a visible scoreboard; mechanical acceptance tests; required review; and a three-minute causal story.

Owner review 0001 changes the center of gravity from a single human-review budget in a live-service-game incident to multi-resource admission of a new promise against an existing portfolio. The former game scenario is not erased; Section 2 records why the microfactory is the stronger v0.1 hero domain. The former `ADMIT` term is replaced by `ADMITTABLE` so feasibility cannot silently become owner acceptance.

## 15. Final pre-build lock questions

The specification MUST NOT be locked until the owner can answer yes to all of these:

1. Is every feasibility claim explicitly limited to the declared portfolio, capacity versions, authorization-state version, estimator, evidence, and assumptions?
2. Do simultaneous human and agent capacity constraints materially change the portfolio plan?
3. Are effects, scopes, meaningful decisions, mutually exclusive branches, and denials mechanically decidable and fail-closed?
4. Does every outcome preserve immutable predicted-versus-actual history, and does every consequential completion have a verified durable receipt?
5. Is TrueForge indispensable to a cleanly reproducible demonstration whose complete idea a judge can repeat after three minutes?
