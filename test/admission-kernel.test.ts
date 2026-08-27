import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { canonicalSerialize } from "../src/canonical.js";
import { stableTupleId } from "../src/identity.js";
import {
  AdmissionInputError,
  compareReplanCandidates,
  evaluateAdmission,
  rational,
  serializeAdmissionResult,
} from "../src/index.js";
import { nondominatedFrontierLayers } from "../src/ordering.js";
import type {
  AcceptedObligation,
  AdmissionEvaluationInput,
  CandidateScore,
  CapacityResource,
  CombinedDecisionProof,
  Criticality,
  DecisionSemantics,
  FixedCapacityReservation,
  ModificationOption,
  ProposedObligation,
  RankableReplanCandidate,
  ResourceDemand,
  SchedulingConstraint,
  TypedCost,
} from "../src/index.js";

const AGENT = "agent_work_units";
const HUMAN = "human_review_decisions";
const PRODUCTION = "production_cell_minutes";

interface DemandValues {
  readonly agent: number;
  readonly human: number;
  readonly production: number;
}

interface ObligationConfig {
  readonly id: string;
  readonly criticality?: Criticality;
  readonly demand: DemandValues;
  readonly serviceLevel?: Readonly<Record<string, number>>;
  readonly minimumService?: Readonly<Record<string, number>>;
  readonly policyMinimum?: number;
  readonly options?: readonly ModificationOption[];
  readonly schedulingConstraint?: SchedulingConstraint;
  readonly workClassByResource?: Readonly<Record<string, string>>;
}

interface InputConfig {
  readonly capacity?: DemandValues;
  readonly resources?: readonly CapacityResource[];
  readonly accepted?: readonly AcceptedObligation[];
  readonly proposal?: ProposedObligation;
  readonly reservations?: readonly FixedCapacityReservation[];
  readonly combinedDecisionProofs?: readonly CombinedDecisionProof[];
  readonly calibration?: AdmissionEvaluationInput["calibration"];
}

interface MutableAdmissionResultFixture {
  decision: string;
  expectedBasis: {
    expectedPortfolioVersion: string;
    expectedCalibrationFrontierDigest: string;
  };
  directPlan: {
    capacityAfter: { resourceKey: string; value: number }[];
  };
  promiseBasis: {
    decision: string;
    expectedAcceptanceBasis: {
      expectedPortfolioVersion: string;
      expectedCalibrationFrontierDigest: string;
    } | string;
    selectedPlanIds: string[];
  };
}

function demand(values: DemandValues): ResourceDemand {
  return {
    [AGENT]: values.agent,
    [HUMAN]: values.human,
    [PRODUCTION]: values.production,
  };
}

function semantics(id: string): DecisionSemantics {
  return {
    objectiveId: `objective:${id}`,
    evidencePacketId: `evidence-packet:${id}`,
    approverId: `approver:${id}`,
    executionBoundaryId: `execution-boundary:${id}`,
  };
}

function option(
  optionId: string,
  changes: Readonly<Record<string, number>>,
  values: DemandValues,
  addedCapacityCost: TypedCost | null = null,
  decisionSemantics: DecisionSemantics = semantics(`modify:${optionId}`),
): ModificationOption {
  return {
    optionId,
    changes,
    resourceDemand: demand(values),
    addedCapacityCost,
    decisionSemantics,
    reservationCompatibilityProofs: [],
    assumptions: [
      { key: "option", source: "mechanical-test", value: optionId },
    ],
  };
}

function defaultSchedule(
  end = "2026-08-26T01:00:00Z",
): SchedulingConstraint {
  return {
    kind: "deadline",
    start: "2026-08-26T00:00:00Z",
    end,
    resourceKey: PRODUCTION,
    timeUnit: "minutes",
  };
}

function obligationCore(config: ObligationConfig) {
  const criticality = config.criticality ?? "important";
  const serviceLevel = config.serviceLevel ?? { quantity: 10 };
  const minimumService =
    config.minimumService ?? { quantity: 5 };
  const modifiableFields = Object.fromEntries(
    Object.keys(serviceLevel).map((field) => [
      field,
      {
        allowedBounds: {
          minimum:
            field === "quantity" && config.policyMinimum !== undefined
              ? config.policyMinimum
              : (minimumService[field] ?? 0),
          maximum: serviceLevel[field] ?? 0,
        },
        utilityRule: {
          ruleId: `linear-${field}/v1`,
          kind: "linear" as const,
          slope: rational(1),
          intercept: rational(0),
        },
        dimensionWeight: rational(1),
      },
    ]),
  );
  return {
    obligationId: config.id,
    beneficiary: `${config.id}-beneficiary`,
    objective: `${config.id}-objective`,
    serviceLevel,
    protected: criticality === "protected",
    criticality,
    minimumService,
    modificationPolicy: { modifiableFields },
    modificationOptions: config.options ?? [],
    resourceDemand: demand(config.demand),
    workClassByResource:
      config.workClassByResource ??
      {
        [AGENT]: `${config.id}:agent-class`,
        [HUMAN]: `${config.id}:human-class`,
        [PRODUCTION]: `${config.id}:production-class`,
      },
    schedulingConstraint: config.schedulingConstraint ?? defaultSchedule(),
    pendingOwnerDecisions: [],
    assumptions: [
      { key: "fixture", source: "mechanical-test", value: true },
    ],
    evidenceRefs: [`evidence:${config.id}`],
    requiredEffects: [`effect:${config.id}`],
  };
}

function accepted(config: ObligationConfig): AcceptedObligation {
  return { ...obligationCore(config), status: "accepted" };
}

function proposed(config: ObligationConfig): ProposedObligation {
  return {
    ...obligationCore(config),
    status: "proposed",
    acceptanceDecision: semantics(`accept:${config.id}`),
  };
}

function resource(
  resourceKey: string,
  side: CapacityResource["side"],
  unit: string,
  capacity: number,
  capacityKind: CapacityResource["capacityKind"] = "generic",
  timeUnit: CapacityResource["timeUnit"] = null,
): CapacityResource {
  return {
    resourceKey,
    side,
    capacityKind,
    unit,
    timeUnit,
    horizonStart: "2026-08-26T00:00:00Z",
    horizonEnd: "2026-08-27T00:00:00Z",
    capacity,
    safetyReserve: 0,
    estimatorRule: "declared-and-calibrated-demand/v1",
    assumptions: [
      { key: "capacity-source", source: "operator", value: "test-fixture" },
    ],
  };
}

function resourcesFor(capacity: DemandValues): readonly CapacityResource[] {
  return [
    resource(AGENT, "agent", "work_units", capacity.agent),
    resource(
      HUMAN,
      "human",
      "meaningful_decisions",
      capacity.human,
      "meaningful_decisions",
    ),
    resource(
      PRODUCTION,
      "operational",
      "production_minutes",
      capacity.production,
      "generic",
      "minutes",
    ),
  ];
}

function evaluationInput(config: InputConfig = {}): AdmissionEvaluationInput {
  const capacity = config.capacity ?? {
    agent: 10,
    human: 8,
    production: 20,
  };
  return {
    versions: {
      portfolioVersion: "portfolio/v7",
      capacityModelVersion: "capacity-model/v3",
      capacityPlanVersion: "capacity-plan/v11",
      authorizationStateVersion: "authorization/v5",
    },
    calibration:
      config.calibration ??
      {
        ruleId: "conservative-max/v1",
        historyRecords: [],
        expectedFrontierDigest: null,
      },
    resources: config.resources ?? resourcesFor(capacity),
    acceptedObligations:
      config.accepted ??
      [
        accepted({
          id: "protected-order",
          criticality: "protected",
          demand: { agent: 2, human: 1, production: 2 },
        }),
      ],
    proposal:
      config.proposal ??
      proposed({
        id: "rush-order",
        demand: { agent: 3, human: 2, production: 4 },
      }),
    fixedCapacityReservations: config.reservations ?? [],
    combinedDecisionProofs: config.combinedDecisionProofs ?? [],
    authorizationFacts: [
      { key: "authority", source: "authorization-snapshot", value: "valid" },
    ],
    assumptions: [
      { key: "schedule", source: "deterministic-fixture", value: "bounded" },
    ],
  };
}

function amount(
  entries: readonly { readonly resourceKey: string; readonly value: number }[],
  resourceKey: string,
): number {
  const entry = entries.find((candidate) => candidate.resourceKey === resourceKey);
  assert.ok(entry, `missing resource ${resourceKey}`);
  return entry.value;
}

function violationDeficit(
  violations: readonly { readonly kind: string; readonly resourceKey?: string; readonly deficit?: number }[],
  resourceKey: string,
): number | undefined {
  return violations.find(
    (violation) =>
      violation.kind === "resource_capacity" &&
      violation.resourceKey === resourceKey,
  )?.deficit;
}

function reservation(
  claimAccounting: FixedCapacityReservation["claimAccounting"],
  claims: DemandValues,
  affectedObligationIds: readonly string[] = ["existing-order"],
): FixedCapacityReservation {
  const start = "2026-08-26T00:00:00Z";
  return {
    reservationId: "reservation-1",
    executionAttemptId: "attempt-1",
    authorizationIdentity: "authorization-1",
    lockedOperationId: "operation-1",
    affectedObligationIds,
    resourceClaims: demand(claims),
    temporalClaim:
      claims.production === 0
        ? null
        : {
            resourceKey: PRODUCTION,
            start,
            end: new Date(
              Date.parse(start) + claims.production * 60_000,
            ).toISOString(),
            requiredDuration: claims.production,
            timeUnit: "minutes",
          },
    expectedPostcondition: { state: "finished" },
    claimAccounting,
  };
}

function fixedReservationDigest(value: FixedCapacityReservation): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value), "utf8")
    .digest("hex")}`;
}

function acceptanceRequirementId(obligationId: string): string {
  return stableTupleId("requirement", ["accept", obligationId]);
}

function modificationRequirementId(
  obligationId: string,
  optionId: string,
): string {
  return stableTupleId("requirement", ["modify", obligationId, optionId]);
}

function pendingRequirementId(obligationId: string, decisionId: string): string {
  return stableTupleId("requirement", [
    "consequential_effect",
    obligationId,
    decisionId,
  ]);
}

function singleRequirementProof(
  proofId: string,
  decisionId: string,
  requirementId: string,
  decisionSemantics: DecisionSemantics,
): CombinedDecisionProof {
  return {
    proofId,
    decisionId,
    selectorId: `selector:${proofId}`,
    selectedBundleId: `selected:${proofId}`,
    coveredRequirementIds: [requirementId],
    alternatives: [
      {
        bundleId: `selected:${proofId}`,
        selectorValue: "selected",
        requirementIds: [requirementId],
        fullySpecified: true,
      },
      {
        bundleId: `declined:${proofId}`,
        selectorValue: "declined",
        requirementIds: [],
        fullySpecified: true,
      },
    ],
    allOrNoneEnforced: true,
    ...decisionSemantics,
  };
}

function score(overrides: Partial<CandidateScore> = {}): CandidateScore {
  return {
    protectedObligationViolations: 0,
    criticalityWeightedServiceDegradation: rational(0),
    previouslyAcceptedObligationsChanged: 0,
    addedCapacityCost: { components: [] },
    bottleneckSlack: rational(1),
    ...overrides,
  };
}

function rankable(
  candidatePlanId: string,
  overrides: Partial<CandidateScore> = {},
): RankableReplanCandidate {
  return { candidatePlanId, score: score(overrides) };
}

describe("original M1 acceptance cases A-L", () => {
  test("A. feasible direct admission returns ADMITTABLE", () => {
    const result = evaluateAdmission(evaluationInput());

    assert.equal(result.decision, "ADMITTABLE");
    assert.deepEqual(result.permissibleOwnerChoices, [
      "ACCEPT_PROMISE",
      "MODIFY",
      "DECLINE",
    ]);
    assert.equal(amount(result.directPlan.capacityBefore, AGENT), 8);
    assert.equal(amount(result.directPlan.predictedConsumption, HUMAN), 3);
    assert.equal(amount(result.directPlan.capacityAfter, HUMAN), 4);
    assert.match(result.basis.calibrationFrontierDigest, /^sha256:[0-9a-f]{64}$/u);
  });

  test("B. proposal exceeding agent capacity is not admitted", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 5, human: 10, production: 20 },
        proposal: proposed({
          id: "agent-heavy",
          demand: { agent: 4, human: 0, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    assert.equal(violationDeficit(result.directPlan.violations, AGENT), 1);
  });

  test("C. proposal exceeding human-review capacity is not admitted", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 3, production: 20 },
      }),
    );

    assert.equal(result.decision, "REJECT");
    assert.equal(violationDeficit(result.directPlan.violations, HUMAN), 1);
  });

  test("D. a protected obligation cannot be degraded", () => {
    const locked = accepted({
      id: "locked",
      criticality: "protected",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("trim-locked", { quantity: 8 }, { agent: 2, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [locked],
        proposal: proposed({
          id: "new",
          demand: { agent: 3, human: 0, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    const family = result.strategyFamilies.find(
      (candidate) => candidate.strategy === "modify_existing",
    );
    assert.equal(family?.rejectedOptions[0]?.code, "protected_obligation");
  });

  test("E. a minimum service floor cannot be crossed", () => {
    const floorBound = accepted({
      id: "floor-bound",
      criticality: "best_effort",
      policyMinimum: 0,
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("below-floor", { quantity: 4 }, { agent: 2, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [floorBound],
        proposal: proposed({
          id: "new",
          demand: { agent: 3, human: 0, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    const family = result.strategyFamilies.find(
      (candidate) => candidate.strategy === "modify_existing",
    );
    assert.equal(family?.rejectedOptions[0]?.code, "minimum_service_floor");
  });

  test("F. modifying a lower-criticality accepted obligation can restore feasibility", () => {
    const lower = accepted({
      id: "lower",
      criticality: "best_effort",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("trim-lower", { quantity: 8 }, { agent: 4, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [lower],
        proposal: proposed({
          id: "new",
          demand: { agent: 3, human: 0, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REPLAN");
    assert.equal(result.recommendedCandidate?.strategy, "modify_existing");
    assert.equal(
      result.recommendedCandidate?.affectedObligations[0]?.obligationId,
      "lower",
    );
  });

  test("G. comparator follows every semantic lexicographic objective", () => {
    assert.equal(
      compareReplanCandidates(rankable("a"), rankable("b", { protectedObligationViolations: 1 })),
      "left_preferred",
    );
    assert.equal(
      compareReplanCandidates(
        rankable("a", { criticalityWeightedServiceDegradation: rational(1, 4) }),
        rankable("b", { criticalityWeightedServiceDegradation: rational(1, 2) }),
      ),
      "left_preferred",
    );
    assert.equal(
      compareReplanCandidates(
        rankable("a", { previouslyAcceptedObligationsChanged: 1 }),
        rankable("b", { previouslyAcceptedObligationsChanged: 2 }),
      ),
      "left_preferred",
    );
    assert.equal(
      compareReplanCandidates(
        rankable("a", { addedCapacityCost: { components: [{ basisKey: "USD", amount: rational(2) }] } }),
        rankable("b", { addedCapacityCost: { components: [{ basisKey: "USD", amount: rational(3) }] } }),
      ),
      "left_preferred",
    );
    assert.equal(
      compareReplanCandidates(
        rankable("a", { bottleneckSlack: rational(2) }),
        rankable("b", { bottleneckSlack: rational(1) }),
      ),
      "left_preferred",
    );
    assert.equal(compareReplanCandidates(rankable("a"), rankable("b")), "equivalent");
  });

  test("H. changing the newest proposal is not automatically preferred", () => {
    const existing = accepted({
      id: "existing-low",
      criticality: "best_effort",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("trim-existing", { quantity: 8 }, { agent: 4, human: 0, production: 1 }),
      ],
    });
    const proposal = proposed({
      id: "new-important",
      criticality: "important",
      demand: { agent: 3, human: 0, production: 1 },
      options: [
        option("trim-new", { quantity: 9 }, { agent: 2, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [existing],
        proposal,
      }),
    );

    assert.equal(result.decision, "REPLAN");
    assert.equal(result.recommendedCandidate?.strategy, "modify_existing");
  });

  test("I. REJECT occurs only after direct admission and all bounded replans fail", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 4, human: 10, production: 20 },
        accepted: [],
        proposal: proposed({
          id: "impossible",
          demand: { agent: 5, human: 0, production: 1 },
          options: [
            option("still-impossible", { quantity: 9 }, { agent: 5, human: 0, production: 1 }),
          ],
        }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    assert.equal(result.consideredCandidates.length, 1);
    assert.equal(result.consideredCandidates[0]?.feasible, false);
  });

  test("J. REJECT returns exact minimal resource expansions", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 4, human: 3, production: 20 },
        proposal: proposed({
          id: "over-all",
          demand: { agent: 4, human: 3, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    const direct = result.feasibilityRestoringSuggestions.find((candidate) =>
      candidate.candidatePlanId.includes("direct"),
    );
    assert.ok(direct);
    assert.equal(amount(direct.capacityExpansion, AGENT), 2);
    assert.equal(amount(direct.capacityExpansion, HUMAN), 2);
  });

  test("K. stable ordering makes normalized output byte-identical", () => {
    const first = evaluationInput({
      capacity: { agent: 2, human: 10, production: 20 },
      accepted: [],
      proposal: proposed({
        id: "tie",
        demand: { agent: 3, human: 0, production: 1 },
        options: [
          option("z-option", { quantity: 9 }, { agent: 2, human: 0, production: 1 }),
          option("a-option", { quantity: 9 }, { agent: 2, human: 0, production: 1 }),
        ],
      }),
    });
    const second = {
      ...first,
      resources: [...first.resources].reverse(),
      proposal: {
        ...first.proposal,
        modificationOptions: [...first.proposal.modificationOptions].reverse(),
      },
    };

    assert.equal(
      serializeAdmissionResult(evaluateAdmission(first)),
      serializeAdmissionResult(evaluateAdmission(second)),
    );
  });

  test("L. all simultaneous resource dimensions are enforced", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 10, production: 8 },
        accepted: [
          accepted({ id: "existing", demand: { agent: 1, human: 0, production: 3 } }),
        ],
        proposal: proposed({ id: "new", demand: { agent: 1, human: 0, production: 6 } }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    assert.equal(violationDeficit(result.directPlan.violations, PRODUCTION), 1);
    assert.equal(violationDeficit(result.directPlan.violations, AGENT), undefined);
  });
});

describe("nine audit blocker regressions", () => {
  test("1. 61 production-minutes cannot fit a declared 60-minute window", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 100, human: 100, production: 1_000 },
        accepted: [],
        proposal: proposed({
          id: "sixty-one-minutes",
          demand: { agent: 1, human: 0, production: 61 },
        }),
      }),
    );

    assert.notEqual(result.decision, "ADMITTABLE");
    assert.deepEqual(result.directPlan.temporalSlack, [
      {
        obligationId: "sixty-one-minutes",
        resourceKey: PRODUCTION,
        constraintStart: "2026-08-26T00:00:00Z",
        constraintEnd: "2026-08-26T01:00:00Z",
        windowDuration: 60,
        requiredDuration: 61,
        slack: -1,
        timeUnit: "minutes",
        protected: false,
        status: "violated",
      },
    ]);
  });

  test("2. separate acceptance and accepted-obligation modification decisions consume two human decisions", () => {
    const existing = accepted({
      id: "decision-locked",
      criticality: "best_effort",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("free-agent", { quantity: 8 }, { agent: 4, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 1, production: 20 },
        accepted: [existing],
        proposal: proposed({ id: "new", demand: { agent: 3, human: 0, production: 1 } }),
      }),
    );

    assert.equal(result.decision, "REJECT");
    const replan = result.consideredCandidates[0];
    assert.equal(replan?.capacity.meaningfulDecisionFrontier.requiredDecisionCount, 2);
    assert.equal(violationDeficit(replan?.capacity.violations ?? [], HUMAN), 1);
  });

  test("2b. a mechanically valid combined decision proof charges one decision", () => {
    const shared = semantics("shared-decision");
    const existing = accepted({
      id: "bundle-existing",
      criticality: "best_effort",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option(
          "bundle-trim",
          { quantity: 8 },
          { agent: 4, human: 0, production: 1 },
          null,
          shared,
        ),
      ],
    });
    const proposal = {
      ...proposed({ id: "bundle-new", demand: { agent: 3, human: 0, production: 1 } }),
      acceptanceDecision: shared,
    };
    const covered = [
      acceptanceRequirementId("bundle-new"),
      modificationRequirementId("bundle-existing", "bundle-trim"),
    ];
    const proof: CombinedDecisionProof = {
      proofId: "combined-proof-1",
      decisionId: "combined-decision-1",
      selectorId: "plan-selector",
      selectedBundleId: "accept-and-trim",
      coveredRequirementIds: covered,
      alternatives: [
        {
          bundleId: "accept-and-trim",
          selectorValue: "accept",
          requirementIds: covered,
          fullySpecified: true,
        },
        {
          bundleId: "decline",
          selectorValue: "decline",
          requirementIds: [],
          fullySpecified: true,
        },
      ],
      allOrNoneEnforced: true,
      ...shared,
    };
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 1, production: 20 },
        accepted: [existing],
        proposal,
        combinedDecisionProofs: [proof],
      }),
    );

    assert.equal(result.decision, "REPLAN");
    assert.equal(
      result.recommendedCandidate?.capacity.meaningfulDecisionFrontier.requiredDecisionCount,
      1,
    );
  });

  test("3A. a locked reservation blocks modification without compatibility proof", () => {
    const existing = accepted({
      id: "existing-order",
      criticality: "best_effort",
      demand: { agent: 6, human: 0, production: 1 },
      options: [
        option("trim-locked-work", { quantity: 8 }, { agent: 4, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [existing],
        proposal: proposed({ id: "new", demand: { agent: 3, human: 0, production: 1 } }),
        reservations: [
          reservation("already_in_portfolio", { agent: 2, human: 0, production: 1 }),
        ],
      }),
    );

    assert.equal(result.decision, "REJECT");
    const family = result.strategyFamilies.find(
      (candidate) => candidate.strategy === "modify_existing",
    );
    assert.equal(family?.rejectedOptions[0]?.code, "fixed_reservation_conflict");
  });

  test("3B. a reservation claim already represented in portfolio demand is counted once", () => {
    const existing = accepted({
      id: "existing-order",
      demand: { agent: 2, human: 0, production: 2 },
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 10, production: 20 },
        accepted: [existing],
        proposal: proposed({ id: "new", demand: { agent: 5, human: 0, production: 1 } }),
        reservations: [
          reservation("already_in_portfolio", { agent: 2, human: 0, production: 2 }),
        ],
      }),
    );

    assert.equal(result.decision, "ADMITTABLE");
    assert.equal(amount(result.directPlan.capacityBefore, AGENT), 8);
    assert.equal(amount(result.directPlan.capacityAfter, AGENT), 3);
  });

  test("4. protected slack has typed resource and temporal vectors, never a cross-unit scalar minimum", () => {
    const hourResources = [
      resource(AGENT, "agent", "work_units", 2),
      resource(HUMAN, "human", "meaningful_decisions", 3, "meaningful_decisions"),
      resource(PRODUCTION, "operational", "production_hours", 4, "generic", "hours"),
    ];
    const result = evaluateAdmission(
      evaluationInput({
        resources: hourResources,
        accepted: [],
        proposal: proposed({
          id: "typed-slack",
          criticality: "protected",
          demand: { agent: 1, human: 0, production: 4 },
          schedulingConstraint: {
            kind: "deadline",
            start: "2026-08-26T00:00:00Z",
            end: "2026-08-26T05:00:00Z",
            resourceKey: PRODUCTION,
            timeUnit: "hours",
          },
        }),
      }),
    );

    assert.equal(result.decision, "ADMITTABLE");
    const slack = result.directPlan.protectedObligationSlack;
    assert.deepEqual(slack.byResource, [
      { resourceKey: AGENT, value: 1 },
      { resourceKey: HUMAN, value: 2 },
      { resourceKey: PRODUCTION, value: 0 },
    ]);
    assert.equal(slack.bySchedulingConstraint[0]?.slack, 1);
    assert.equal(slack.bySchedulingConstraint[0]?.timeUnit, "hours");
    assert.equal(Object.hasOwn(slack, "minimum"), false);
  });

  test("5. incomparable USD and hour costs remain deterministic nondominated alternatives", () => {
    const proposal = proposed({
      id: "cost-bases",
      demand: { agent: 4, human: 0, production: 1 },
      options: [
        option(
          "usd-three",
          { quantity: 9 },
          { agent: 2, human: 0, production: 1 },
          { basisKey: "USD", amount: rational(3) },
        ),
        option(
          "hours-two",
          { quantity: 9 },
          { agent: 2, human: 0, production: 1 },
          { basisKey: "hours", amount: rational(2) },
        ),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 3, human: 10, production: 20 },
        accepted: [],
        proposal,
      }),
    );

    assert.equal(result.decision, "REPLAN");
    assert.equal(result.recommendedCandidate, null);
    assert.equal(result.recommendedCandidates.length, 2);
    assert.deepEqual(
      result.recommendedCandidates
        .map((candidate) => candidate.affectedObligations[0]?.optionId)
        .sort(),
      ["hours-two", "usd-three"],
    );
    assert.equal(
      compareReplanCandidates(
        rankable("usd", { addedCapacityCost: { components: [{ basisKey: "USD", amount: rational(3) }] } }),
        rankable("hours", { addedCapacityCost: { components: [{ basisKey: "hours", amount: rational(2) }] } }),
      ),
      "incomparable",
    );
  });

  test("6. distinct quantity and quality tradeoffs remain Pareto nondominated", () => {
    const proposal = proposed({
      id: "two-dimensional-service",
      demand: { agent: 5, human: 0, production: 1 },
      serviceLevel: { quantity: 10, quality: 10 },
      minimumService: { quantity: 5, quality: 5 },
      options: [
        option("lose-quantity", { quantity: 9 }, { agent: 4, human: 0, production: 1 }),
        option("lose-quality", { quality: 9 }, { agent: 4, human: 0, production: 1 }),
      ],
    });
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 3, human: 10, production: 20 },
        accepted: [],
        proposal,
      }),
    );

    assert.equal(result.decision, "REJECT");
    const suggestionOptions = result.feasibilityRestoringSuggestions.flatMap(
      (suggestion) => suggestion.boundedModifications.map((change) => change.optionId),
    );
    assert.ok(suggestionOptions.includes("lose-quality"));
    assert.ok(suggestionOptions.includes("lose-quantity"));
  });

  test("7A. missing authorization-state version fails closed", () => {
    const input = evaluationInput() as unknown as Record<string, unknown>;
    const versions = { ...(input["versions"] as Record<string, unknown>) };
    delete versions["authorizationStateVersion"];
    input["versions"] = versions;

    assert.throws(
      () => evaluateAdmission(input),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "versions.authorizationStateVersion",
    );
  });

  test("7B. an unused option missing a mandatory resource dimension fails eagerly", () => {
    const malformed = option(
      "unused-malformed",
      { quantity: 9 },
      { agent: 1, human: 0, production: 1 },
    ) as unknown as { resourceDemand: Record<string, number> };
    delete malformed.resourceDemand[PRODUCTION];
    const input = evaluationInput({
      proposal: proposed({
        id: "otherwise-feasible",
        demand: { agent: 1, human: 0, production: 1 },
        options: [malformed as unknown as ModificationOption],
      }),
    });

    assert.throws(
      () => evaluateAdmission(input),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.message.includes("must contain every and only declared resource key"),
    );
  });

  test("7C. malformed rationals fail at exported construction and comparator boundaries", () => {
    assert.throws(() => rational(1, -2), /denominator must be positive/u);
    const malformed = rankable("malformed") as unknown as {
      score: { criticalityWeightedServiceDegradation: { numerator: number; denominator: number } };
    };
    malformed.score.criticalityWeightedServiceDegradation = {
      numerator: 1,
      denominator: -2,
    };
    assert.throws(
      () => compareReplanCandidates(malformed, rankable("valid")),
      /denominator must be a positive safe integer|denominator must be positive/u,
    );
  });

  test("7D. canonical result serialization rejects undefined instead of omitting it", () => {
    const result = evaluateAdmission(evaluationInput());
    const malformed = {
      ...result,
      promiseBasis: {
        ...result.promiseBasis,
        authorizationFacts: undefined,
      },
    };

    assert.throws(
      () => serializeAdmissionResult(malformed),
      /required field is undefined|undefined is not canonical JSON/u,
    );
  });

  test("8A. conservative comparable-history calibration changes admission", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 5, human: 10, production: 20 },
        accepted: [
          accepted({ id: "existing", demand: { agent: 2, human: 0, production: 1 } }),
        ],
        proposal: proposed({ id: "calibrated", demand: { agent: 3, human: 0, production: 1 } }),
        calibration: {
          ruleId: "conservative-max/v1",
          expectedFrontierDigest: null,
          historyRecords: [
            {
              recordId: "actual-6",
              completedAt: "2026-08-25T12:00:00Z",
              resourceKey: AGENT,
              workClassKey: "calibrated:agent-class",
              actualConsumption: 6,
              actualConsumptionAddendumId: "actual-addendum-6",
              outcome: "completed",
              outcomeAddendumId: "outcome-addendum-6",
            },
          ],
        },
      }),
    );

    assert.notEqual(result.decision, "ADMITTABLE");
    assert.equal(violationDeficit(result.directPlan.violations, AGENT), 3);
    const snapshot = result.promiseBasis.calibratedDemands.find(
      (candidate) =>
        candidate.obligationId === "calibrated" && candidate.variantId === "current",
    );
    assert.equal(amount(snapshot?.calibratedDemand ?? [], AGENT), 6);
  });

  test("8B. a forged calibration digest fails its precondition", () => {
    const input = evaluationInput({
      calibration: {
        ruleId: "conservative-max/v1",
        historyRecords: [],
        expectedFrontierDigest: `sha256:${"0".repeat(64)}`,
      },
    });

    assert.throws(
      () => evaluateAdmission(input),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "calibration.expectedFrontierDigest",
    );
  });

  test("9A. Promise Basis captures complete evaluated state", () => {
    const fixed = reservation(
      "additional",
      { agent: 1, human: 0, production: 1 },
      ["protected-order"],
    );
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 20, human: 20, production: 30 },
        reservations: [fixed],
      }),
    );
    const basis = result.promiseBasis;

    assert.equal(basis.schemaVersion, "flakebrake-promise-basis/v0.1-m1");
    assert.deepEqual(basis.versions, {
      portfolioVersion: "portfolio/v7",
      capacityModelVersion: "capacity-model/v3",
      capacityPlanVersion: "capacity-plan/v11",
      authorizationStateVersion: "authorization/v5",
    });
    assert.equal(basis.proposal.obligationId, "rush-order");
    assert.equal(basis.acceptedPortfolio[0]?.obligationId, "protected-order");
    assert.equal(basis.resources.length, 3);
    assert.equal(basis.fixedCapacityReservations[0]?.lockedOperationId, "operation-1");
    assert.equal(basis.fixedCapacityReservations[0]?.claimAccounting, "additional");
    assert.equal(basis.calibrationFrontierDigest, result.basis.calibrationFrontierDigest);
    assert.equal(basis.directPlan.capacityAfter.length, 3);
    assert.equal(basis.directPlan.temporalSlack.length, 2);
    assert.equal(basis.directPlan.meaningfulDecisionFrontier.requiredDecisionCount, 1);
    assert.deepEqual(basis.selectedPlanIds, [
      stableTupleId("direct-plan", ["rush-order"]),
    ]);
  });

  test("9B. returned result and Promise Basis are detached from caller mutation", () => {
    const input = evaluationInput();
    const result = evaluateAdmission(input);
    const before = serializeAdmissionResult(result);
    const mutableInput = input as unknown as {
      versions: { portfolioVersion: string };
      resources: { capacity: number }[];
      acceptedObligations: { serviceLevel: { quantity: number } }[];
      assumptions: { value: string }[];
    };
    mutableInput.versions.portfolioVersion = "mutated";
    mutableInput.resources[0]!.capacity = 999;
    mutableInput.acceptedObligations[0]!.serviceLevel.quantity = 0;
    mutableInput.assumptions[0]!.value = "mutated";

    assert.equal(serializeAdmissionResult(result), before);
    assert.equal(result.promiseBasis.versions.portfolioVersion, "portfolio/v7");
    assert.notEqual(result.promiseBasis.resources[0]?.capacity, 999);
    assert.equal(result.promiseBasis.acceptedPortfolio[0]?.serviceLevel["quantity"], 10);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.promiseBasis), true);
  });
});

describe("final bounded M1 closure regressions", () => {
  test("1. fixed temporal reservations consume availability in the joint schedule", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 10, production: 100 },
        accepted: [
          accepted({
            id: "schedule-anchor",
            demand: { agent: 0, human: 0, production: 0 },
          }),
        ],
        proposal: proposed({
          id: "forty-minute-proposal",
          demand: { agent: 0, human: 0, production: 40 },
        }),
        reservations: [
          reservation(
            "additional",
            { agent: 0, human: 0, production: 30 },
            ["schedule-anchor"],
          ),
        ],
      }),
    );

    assert.notEqual(result.decision, "ADMITTABLE");
    const schedulingViolation = result.directPlan.violations.find(
      (violation) =>
        violation.kind === "scheduling_constraint" &&
        violation.obligationId === "forty-minute-proposal",
    );
    assert.deepEqual(schedulingViolation, {
      kind: "scheduling_constraint",
      obligationId: "forty-minute-proposal",
      resourceKey: PRODUCTION,
      deficit: 10,
      timeUnit: "minutes",
      protected: false,
    });
  });

  test("1b. flexible requirements cannot independently reuse one free interval", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 10, production: 100 },
        accepted: [
          accepted({
            id: "accepted-forty",
            demand: { agent: 0, human: 0, production: 40 },
          }),
        ],
        proposal: proposed({
          id: "proposal-forty",
          demand: { agent: 0, human: 0, production: 40 },
        }),
      }),
    );

    assert.notEqual(result.decision, "ADMITTABLE");
    const totalSchedulingDeficit = result.directPlan.violations.reduce(
      (total, violation) =>
        violation.kind === "scheduling_constraint"
          ? total + violation.deficit
          : total,
      0,
    );
    assert.equal(totalSchedulingDeficit, 20);
  });

  test("1c. candidate modifications recompute the complete fixed-interval schedule", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 10, production: 100 },
        accepted: [
          accepted({
            id: "schedule-anchor",
            demand: { agent: 0, human: 0, production: 0 },
          }),
        ],
        proposal: proposed({
          id: "modifiable-forty",
          demand: { agent: 0, human: 0, production: 40 },
          options: [
            option(
              "fit-remaining-thirty",
              { quantity: 9 },
              { agent: 0, human: 0, production: 30 },
            ),
          ],
        }),
        reservations: [
          reservation(
            "additional",
            { agent: 0, human: 0, production: 30 },
            ["schedule-anchor"],
          ),
        ],
      }),
    );

    assert.equal(result.decision, "REPLAN");
    assert.equal(
      result.directPlan.temporalSlack.find(
        (entry) => entry.obligationId === "modifiable-forty",
      )?.slack,
      -10,
    );
    const modifiedSlack = result.recommendedCandidates[0]?.capacity.temporalSlack
      .find((entry) => entry.obligationId === "modifiable-forty");
    assert.equal(modifiedSlack?.slack, 0);
    assert.equal(modifiedSlack?.status, "binding");
  });

  test("2. aggregate already-in-portfolio claims cannot exceed authoritative demand", () => {
    const first = reservation(
      "already_in_portfolio",
      { agent: 2, human: 0, production: 0 },
    );
    const second: FixedCapacityReservation = {
      ...first,
      reservationId: "reservation-2",
      executionAttemptId: "attempt-2",
    };

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            accepted: [
              accepted({
                id: "existing-order",
                demand: { agent: 2, human: 0, production: 0 },
              }),
            ],
            reservations: [first, second],
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path.includes(`existing-order.${AGENT}`),
    );
  });

  test("3. a correct reservation digest cannot authorize an incompatible demand reduction", () => {
    const locked = reservation(
      "already_in_portfolio",
      { agent: 4, human: 0, production: 1 },
    );
    const incompatibleOption: ModificationOption = {
      ...option(
        "reduce-below-lock",
        { quantity: 8 },
        { agent: 2, human: 0, production: 1 },
      ),
      reservationCompatibilityProofs: [
        {
          reservationId: locked.reservationId,
          reservationDigest: fixedReservationDigest(locked),
        },
      ],
    };
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 8, human: 10, production: 20 },
        accepted: [
          accepted({
            id: "existing-order",
            criticality: "best_effort",
            demand: { agent: 6, human: 0, production: 1 },
            options: [incompatibleOption],
          }),
        ],
        proposal: proposed({
          id: "new-demand",
          demand: { agent: 3, human: 0, production: 1 },
        }),
        reservations: [locked],
      }),
    );

    assert.equal(result.decision, "REJECT");
    const family = result.strategyFamilies.find(
      (candidate) => candidate.strategy === "modify_existing",
    );
    assert.equal(family?.rejectedOptions[0]?.code, "fixed_reservation_conflict");
  });

  test("4. agent_work_units is a mandatory canonical resource", () => {
    const withoutAgent = resourcesFor({ agent: 10, human: 10, production: 20 })
      .filter((candidate) => candidate.resourceKey !== AGENT);

    assert.throws(
      () => evaluateAdmission(evaluationInput({ resources: withoutAgent })),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "resources" &&
        error.message.includes(AGENT),
    );
  });

  test("5. derived modification identities are collision-free for delimiter-bearing IDs", () => {
    const firstRequirement = modificationRequirementId("a", "b:c");
    const secondRequirement = modificationRequirementId("a:b", "c");
    assert.notEqual(firstRequirement, secondRequirement);

    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 5, human: 10, production: 20 },
        accepted: [
          accepted({
            id: "a",
            criticality: "best_effort",
            demand: { agent: 3, human: 0, production: 1 },
            options: [
              option(
                "b:c",
                { quantity: 8 },
                { agent: 1, human: 0, production: 1 },
              ),
            ],
          }),
          accepted({
            id: "a:b",
            criticality: "best_effort",
            demand: { agent: 3, human: 0, production: 1 },
            options: [
              option(
                "c",
                { quantity: 8 },
                { agent: 1, human: 0, production: 1 },
              ),
            ],
          }),
        ],
        proposal: proposed({
          id: "tuple-proposal",
          demand: { agent: 3, human: 0, production: 1 },
        }),
      }),
    );

    assert.equal(result.decision, "REPLAN");
    const both = result.candidates.find(
      (candidate) => candidate.affectedObligations.length === 2,
    );
    assert.ok(both);
    assert.equal(
      both.capacity.meaningfulDecisionFrontier.requiredDecisionCount,
      3,
    );
    const requirementIds = both.capacity.meaningfulDecisionFrontier.requirements
      .map((requirement) => requirement.requirementId);
    assert.ok(requirementIds.includes(firstRequirement));
    assert.ok(requirementIds.includes(secondRequirement));
  });

  test("6. typed coordinate sets preserve embedded NUL boundaries", () => {
    assert.equal(
      compareReplanCandidates(
        rankable("left-cost", {
          addedCapacityCost: {
            components: [
              { basisKey: "a", amount: rational(1) },
              { basisKey: "b\u0000c", amount: rational(1) },
            ],
          },
        }),
        rankable("right-cost", {
          addedCapacityCost: {
            components: [
              { basisKey: "a\u0000b", amount: rational(1) },
              { basisKey: "c", amount: rational(1) },
            ],
          },
        }),
      ),
      "incomparable",
    );

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            proposal: proposed({
              id: "nul-service-sets",
              demand: { agent: 1, human: 0, production: 1 },
              serviceLevel: { a: 10, "b\u0000c": 10 },
              minimumService: { "a\u0000b": 5, c: 5 },
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "proposal.minimumService",
    );
  });

  test("7. frontier layers preserve USD dominance without ordering incomparable hours", () => {
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 3, human: 10, production: 20 },
        accepted: [],
        proposal: proposed({
          id: "layered-costs",
          demand: { agent: 4, human: 0, production: 1 },
          options: [
            option(
              "b-usd-two",
              { quantity: 9 },
              { agent: 2, human: 0, production: 1 },
              { basisKey: "USD", amount: rational(2) },
            ),
            option(
              "c-hours-one",
              { quantity: 9 },
              { agent: 2, human: 0, production: 1 },
              { basisKey: "hours", amount: rational(1) },
            ),
            option(
              "d-usd-one",
              { quantity: 9 },
              { agent: 2, human: 0, production: 1 },
              { basisKey: "USD", amount: rational(1) },
            ),
          ],
        }),
      }),
    );

    assert.equal(result.decision, "REPLAN");
    const orderedOptions = result.candidates.map(
      (candidate) => candidate.affectedObligations[0]?.optionId,
    );
    assert.ok(
      orderedOptions.indexOf("d-usd-one") < orderedOptions.indexOf("b-usd-two"),
    );
    assert.deepEqual(
      result.recommendedCandidates
        .map((candidate) => candidate.affectedObligations[0]?.optionId)
        .sort(),
      ["c-hours-one", "d-usd-one"],
    );
    assert.equal(result.recommendedCandidate, null);
  });

  test("8. Promise Basis contains combined-decision proof and acceptance preconditions", () => {
    const shared = semantics("accept-with-effect");
    const effectDecisionId = "effect-decision";
    const proposal: ProposedObligation = {
      ...proposed({
        id: "proof-bearing-proposal",
        demand: { agent: 1, human: 0, production: 1 },
      }),
      acceptanceDecision: shared,
      pendingOwnerDecisions: [
        {
          decisionId: effectDecisionId,
          kind: "consequential_effect",
          ...shared,
        },
      ],
    };
    const covered = [
      acceptanceRequirementId(proposal.obligationId),
      pendingRequirementId(proposal.obligationId, effectDecisionId),
    ];
    const proof: CombinedDecisionProof = {
      proofId: "accept-with-effect-proof",
      decisionId: "accept-with-effect-decision",
      selectorId: "acceptance-selector",
      selectedBundleId: "accept-and-run-effect",
      coveredRequirementIds: covered,
      alternatives: [
        {
          bundleId: "accept-and-run-effect",
          selectorValue: "accept",
          requirementIds: covered,
          fullySpecified: true,
        },
        {
          bundleId: "decline",
          selectorValue: "decline",
          requirementIds: [],
          fullySpecified: true,
        },
      ],
      allOrNoneEnforced: true,
      ...shared,
    };
    const result = evaluateAdmission(
      evaluationInput({
        capacity: { agent: 10, human: 1, production: 20 },
        accepted: [],
        proposal,
        combinedDecisionProofs: [proof],
      }),
    );

    assert.equal(result.decision, "ADMITTABLE");
    assert.equal(
      result.directPlan.meaningfulDecisionFrontier.requiredDecisionCount,
      1,
    );
    assert.equal(result.promiseBasis.combinedDecisionProofs.length, 1);
    assert.equal(
      result.promiseBasis.combinedDecisionProofs[0]?.proofId,
      proof.proofId,
    );
    assert.deepEqual(
      [...(result.promiseBasis.combinedDecisionProofs[0]?.coveredRequirementIds ?? [])]
        .sort(),
      [...covered].sort(),
    );
    assert.deepEqual(
      result.promiseBasis.expectedAcceptanceBasis,
      result.expectedBasis,
    );
  });

  test("9. canonical JSON preserves __proto__ and awkward own keys", () => {
    assert.notEqual(
      canonicalSerialize({}),
      canonicalSerialize(JSON.parse('{"__proto__":{"x":1}}')),
    );

    const awkwardKeys = [
      "__proto__",
      "constructor",
      "prototype",
      "embedded\u0000nul",
      'quote"key',
      "backslash\\key",
      "Unicode-雪-😀",
    ];
    const encodings = new Set<string>();
    for (const key of awkwardKeys) {
      const first = Object.fromEntries([["anchor", true], [key, "first"]]);
      const reordered = Object.fromEntries([[key, "first"], ["anchor", true]]);
      const changed = Object.fromEntries([["anchor", true], [key, "second"]]);
      const firstBytes = canonicalSerialize(first);
      assert.equal(firstBytes, canonicalSerialize(reordered));
      assert.notEqual(firstBytes, canonicalSerialize(changed));
      encodings.add(firstBytes);
    }
    assert.equal(encodings.size, awkwardKeys.length);
  });

  test("10. serialization rejects duplicated or cross-linked result mutations", () => {
    const validBytes = serializeAdmissionResult(
      evaluateAdmission(evaluationInput()),
    );
    const mutations: readonly ((value: MutableAdmissionResultFixture) => void)[] = [
      (value) => {
        value.promiseBasis.decision = "REJECT";
      },
      (value) => {
        const expected = value.promiseBasis.expectedAcceptanceBasis;
        assert.notEqual(typeof expected, "string");
        if (typeof expected !== "string") {
          expected.expectedCalibrationFrontierDigest = `sha256:${"0".repeat(64)}`;
        }
      },
      (value) => {
        value.promiseBasis.selectedPlanIds[0] = "forged-plan";
      },
      (value) => {
        const coordinate = value.directPlan.capacityAfter[0];
        assert.ok(coordinate);
        coordinate.resourceKey = "forged-resource";
      },
      (value) => {
        value.expectedBasis.expectedPortfolioVersion = "forged-portfolio";
      },
    ];

    for (const mutate of mutations) {
      const malformed = JSON.parse(validBytes) as MutableAdmissionResultFixture;
      mutate(malformed);
      assert.throws(
        () => serializeAdmissionResult(malformed),
        /does not exactly match deterministic recomputation|AdmissionResult/u,
      );
    }
  });

  test("11. executionAttemptId is globally unique across reservations", () => {
    const first = reservation(
      "additional",
      { agent: 1, human: 0, production: 1 },
    );
    const second: FixedCapacityReservation = {
      ...reservation("additional", { agent: 2, human: 0, production: 1 }),
      reservationId: "reservation-2",
      executionAttemptId: first.executionAttemptId,
      lockedOperationId: "operation-2",
    };

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            accepted: [
              accepted({
                id: "existing-order",
                demand: { agent: 2, human: 0, production: 2 },
              }),
            ],
            reservations: [first, second],
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "fixedCapacityReservations.executionAttemptId",
    );
  });
});

describe("Qodo PR #2 correctness regressions", () => {
  test("replan search rejects oversized portfolios, option lists, and candidate products", () => {
    const oversizedPortfolio = Array.from({ length: 17 }, (_, index) =>
      accepted({
        id: `bounded-portfolio-${String(index)}`,
        demand: { agent: 0, human: 0, production: 0 },
      }),
    );
    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 0, human: 100, production: 100 },
            accepted: oversizedPortfolio,
            proposal: proposed({
              id: "bounded-portfolio-proposal",
              demand: { agent: 1, human: 0, production: 0 },
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "acceptedObligations",
    );

    const oversizedOptions = Array.from({ length: 17 }, (_, index) =>
      option(
        `bounded-option-${String(index)}`,
        { quantity: 9 },
        { agent: 1, human: 0, production: 0 },
      ),
    );
    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 0, human: 100, production: 100 },
            accepted: [],
            proposal: proposed({
              id: "bounded-option-proposal",
              demand: { agent: 1, human: 0, production: 0 },
              options: oversizedOptions,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "proposal.modificationOptions",
    );

    const threeOptions = (prefix: string) =>
      Array.from({ length: 3 }, (_, index) =>
        option(
          `${prefix}-${String(index)}`,
          { quantity: 9 },
          { agent: 0, human: 0, production: 0 },
        ),
      );
    const productPortfolio = Array.from({ length: 4 }, (_, index) =>
      accepted({
        id: `candidate-product-${String(index)}`,
        demand: { agent: 0, human: 0, production: 0 },
        options: threeOptions(`candidate-product-option-${String(index)}`),
      }),
    );
    const productProposalOptions = Array.from({ length: 4 }, (_, index) =>
      option(
        `candidate-product-proposal-option-${String(index)}`,
        { quantity: 9 },
        { agent: 1, human: 0, production: 0 },
      ),
    );
    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 0, human: 100, production: 100 },
            accepted: productPortfolio,
            proposal: proposed({
              id: "candidate-product-proposal",
              demand: { agent: 1, human: 0, production: 0 },
              options: productProposalOptions,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "replanSearch.candidateCount",
    );
  });

  test("fixed temporal reservation duration must equal its occupied interval", () => {
    const partialInterval: FixedCapacityReservation = {
      ...reservation(
        "additional",
        { agent: 0, human: 0, production: 10 },
        ["reservation-anchor"],
      ),
      temporalClaim: {
        resourceKey: PRODUCTION,
        start: "2026-08-26T00:00:00Z",
        end: "2026-08-26T00:30:00Z",
        requiredDuration: 10,
        timeUnit: "minutes",
      },
    };

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 10, human: 10, production: 100 },
            accepted: [
              accepted({
                id: "reservation-anchor",
                demand: { agent: 0, human: 0, production: 0 },
              }),
            ],
            proposal: proposed({
              id: "reservation-proposal",
              demand: { agent: 0, human: 0, production: 0 },
            }),
            reservations: [partialInterval],
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path ===
          "fixedCapacityReservations.0.temporalClaim.requiredDuration",
    );
  });

  test("combined proofs cannot emit duplicate decision IDs", () => {
    const firstSemantics = semantics("decision-collision-first");
    const secondSemantics = semantics("decision-collision-second");
    const proposal: ProposedObligation = {
      ...proposed({
        id: "decision-collision-proposal",
        demand: { agent: 0, human: 0, production: 0 },
      }),
      pendingOwnerDecisions: [
        {
          decisionId: "pending-first",
          kind: "consequential_effect",
          ...firstSemantics,
        },
        {
          decisionId: "pending-second",
          kind: "consequential_effect",
          ...secondSemantics,
        },
      ],
    };

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 10, human: 10, production: 100 },
            accepted: [],
            proposal,
            combinedDecisionProofs: [
              singleRequirementProof(
                "proof-first",
                "colliding-decision",
                pendingRequirementId(proposal.obligationId, "pending-first"),
                firstSemantics,
              ),
              singleRequirementProof(
                "proof-second",
                "colliding-decision",
                pendingRequirementId(proposal.obligationId, "pending-second"),
                secondSemantics,
              ),
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "combinedDecisionProofs.decisionId",
    );
  });

  test("combined proof decision IDs cannot collide with generated decisions", () => {
    const effectSemantics = semantics("generated-decision-collision");
    const proposal: ProposedObligation = {
      ...proposed({
        id: "generated-decision-collision-proposal",
        demand: { agent: 0, human: 0, production: 0 },
      }),
      pendingOwnerDecisions: [
        {
          decisionId: "pending-effect",
          kind: "consequential_effect",
          ...effectSemantics,
        },
      ],
    };

    assert.throws(
      () =>
        evaluateAdmission(
          evaluationInput({
            capacity: { agent: 10, human: 10, production: 100 },
            accepted: [],
            proposal,
            combinedDecisionProofs: [
              singleRequirementProof(
                "proof-generated-collision",
                acceptanceRequirementId(proposal.obligationId),
                pendingRequirementId(proposal.obligationId, "pending-effect"),
                effectSemantics,
              ),
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof AdmissionInputError &&
        error.path === "meaningfulDecisionFrontier.decisionId",
    );
  });
});

describe("bounded deterministic metamorphic coverage", () => {
  test("partial-order layers place every semantic preference edge earlier", () => {
    const pool = [
      rankable("zero"),
      rankable("usd-1", {
        addedCapacityCost: {
          components: [{ basisKey: "USD", amount: rational(1) }],
        },
      }),
      rankable("usd-2", {
        addedCapacityCost: {
          components: [{ basisKey: "USD", amount: rational(2) }],
        },
      }),
      rankable("hours-1", {
        addedCapacityCost: {
          components: [{ basisKey: "hours", amount: rational(1) }],
        },
      }),
      rankable("hours-2", {
        addedCapacityCost: {
          components: [{ basisKey: "hours", amount: rational(2) }],
        },
      }),
      rankable("eur-1", {
        addedCapacityCost: {
          components: [{ basisKey: "EUR", amount: rational(1) }],
        },
      }),
    ];

    for (let start = 0; start < pool.length; start += 1) {
      for (let size = 3; size <= pool.length; size += 1) {
        const candidates = Array.from(
          { length: size },
          (_, offset) => pool[(start + offset) % pool.length],
        ).filter((candidate): candidate is RankableReplanCandidate =>
          candidate !== undefined,
        );
        const layers = nondominatedFrontierLayers(
          candidates,
          compareReplanCandidates,
          (candidate) => candidate.candidatePlanId,
        );
        const layerById = new Map<string, number>();
        layers.forEach((layer, layerIndex) => {
          layer.forEach((candidate) =>
            layerById.set(candidate.candidatePlanId, layerIndex),
          );
        });
        for (const left of candidates) {
          for (const right of candidates) {
            if (left === right) continue;
            if (compareReplanCandidates(left, right) === "left_preferred") {
              assert.ok(
                (layerById.get(left.candidatePlanId) ?? -1) <
                  (layerById.get(right.candidatePlanId) ?? -1),
              );
            }
          }
        }
      }
    }
  });

  test("a genuine semantic preference cycle fails closed", () => {
    const candidates = ["a", "b", "c"];
    assert.throws(
      () =>
        nondominatedFrontierLayers(
          candidates,
          (left, right) => {
            const edge = `${left}->${right}`;
            if (["a->b", "b->c", "c->a"].includes(edge)) {
              return "left_preferred";
            }
            if (["b->a", "c->b", "a->c"].includes(edge)) {
              return "right_preferred";
            }
            return "equivalent";
          },
          (candidate) => candidate,
        ),
      /preference relation contains a cycle/u,
    );
  });

  test("typed tuple identities remain distinct across delimiters and controls", () => {
    const tuples = [
      ["a", "b:c"],
      ["a:b", "c"],
      ["a", "b\u0000c"],
      ["a\u0000b", "c"],
      ["a\\b", 'c"d'],
      ["雪", "😀"],
    ] as const;
    const ids = tuples.map(([obligationId, optionId]) =>
      modificationRequirementId(obligationId, optionId),
    );
    assert.equal(new Set(ids).size, tuples.length);
  });

  test("awkward-key canonical objects differ iff their mappings differ", () => {
    const keys = [
      "__proto__",
      "constructor",
      "prototype",
      "\u0000",
      '"',
      "\\",
      "é",
    ];
    for (const key of keys) {
      const mapping = Object.fromEntries([[key, "value"], ["peer", 1]]);
      const sameMapping = Object.fromEntries([["peer", 1], [key, "value"]]);
      const differentMapping = Object.fromEntries([[key, "value"], ["peer", 2]]);
      assert.equal(canonicalSerialize(mapping), canonicalSerialize(sameMapping));
      assert.notEqual(
        canonicalSerialize(mapping),
        canonicalSerialize(differentMapping),
      );
    }
  });

  test("generated represented claims fail exactly when aggregate demand is exceeded", () => {
    for (let authoritative = 0; authoritative <= 4; authoritative += 1) {
      for (let firstClaim = 0; firstClaim <= 2; firstClaim += 1) {
        for (let secondClaim = 0; secondClaim <= 2; secondClaim += 1) {
          const reservations: FixedCapacityReservation[] = [
            {
              ...reservation(
                "already_in_portfolio",
                { agent: firstClaim, human: 0, production: 0 },
              ),
              temporalClaim: null,
            },
            {
              ...reservation(
                "already_in_portfolio",
                { agent: secondClaim, human: 0, production: 0 },
              ),
              reservationId: "reservation-2",
              executionAttemptId: "attempt-2",
              temporalClaim: null,
            },
          ];
          const input = evaluationInput({
            capacity: { agent: 20, human: 10, production: 20 },
            accepted: [
              accepted({
                id: "existing-order",
                demand: { agent: authoritative, human: 0, production: 0 },
              }),
            ],
            proposal: proposed({
              id: "generated-proposal",
              demand: { agent: 0, human: 0, production: 0 },
            }),
            reservations,
          });

          if (firstClaim + secondClaim <= authoritative) {
            assert.doesNotThrow(() => evaluateAdmission(input));
          } else {
            assert.throws(() => evaluateAdmission(input), AdmissionInputError);
          }
        }
      }
    }
  });

  test("generated cross-field result mutations all fail serialization", () => {
    const validBytes = serializeAdmissionResult(
      evaluateAdmission(evaluationInput()),
    );
    const replacementValues = ["mutated-a", "mutated:b", "mutated\u0000c"];
    for (const replacement of replacementValues) {
      const malformed = JSON.parse(validBytes) as MutableAdmissionResultFixture;
      malformed.promiseBasis.selectedPlanIds[0] = replacement;
      assert.throws(() => serializeAdmissionResult(malformed));
    }
  });
});

describe("runtime boundary completeness", () => {
  test("resource vectors may not omit a declared generic dimension", () => {
    const input = evaluationInput() as unknown as {
      proposal: { resourceDemand: Record<string, number> };
    };
    delete input.proposal.resourceDemand[PRODUCTION];
    assert.throws(() => evaluateAdmission(input), AdmissionInputError);
  });

  test("repeated identical input produces byte-identical normalized output", () => {
    const input = evaluationInput();
    assert.equal(
      serializeAdmissionResult(evaluateAdmission(input)),
      serializeAdmissionResult(evaluateAdmission(input)),
    );
  });
});
