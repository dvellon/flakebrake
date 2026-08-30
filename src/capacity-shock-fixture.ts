import { canonicalClone, deepFreeze } from "./canonical.js";
import type {
  AcceptedObligation,
  AdmissionEvaluationInput,
  CapacityResource,
  DecisionSemantics,
  ModificationOption,
  ProposedObligation,
  ResourceDemand,
  SchedulingConstraint,
} from "./domain.js";
import { rational } from "./rational.js";
import type { StatefulInitialState } from "./stateful-domain.js";

export const CAPACITY_SHOCK_SCENARIO_ID = "capacity-shock";
export const CAPACITY_SHOCK_ENVIRONMENT_ID = "microfactory-capacity-shock/v1";
export const CAPACITY_SHOCK_MISSION_ID = "mission/flakebrake-capacity-shock";
export const CAPACITY_SHOCK_PRODUCTION_CELL_ID = "cell-beta";
export const CAPACITY_SHOCK_HORIZON_START = "2026-08-26T08:00:00.000Z";
export const CAPACITY_SHOCK_HORIZON_END = "2026-08-26T12:00:00.000Z";
export const CAPACITY_SHOCK_OWNER_ID = "owner/microfactory-operations";
export const CAPACITY_SHOCK_ATTEMPT_ID = "attempt/capacity-shock/safe-alternative";
export const CAPACITY_SHOCK_PRIMARY_START = "2026-08-26T09:12:00.000Z";
export const CAPACITY_SHOCK_PRIMARY_END = "2026-08-26T09:36:00.000Z";
export const CAPACITY_SHOCK_ALTERNATIVE_START = "2026-08-26T09:36:00.000Z";
export const CAPACITY_SHOCK_ALTERNATIVE_END = "2026-08-26T10:00:00.000Z";

export const CAPACITY_SHOCK_RESOURCE_KEYS = deepFreeze({
  agent: "agent_work_units",
  human: "human_review_decisions",
  production: "production_cell_minutes",
});

interface DemandValues {
  readonly agent: number;
  readonly human: number;
  readonly production: number;
}

function demand(values: DemandValues): ResourceDemand {
  return {
    [CAPACITY_SHOCK_RESOURCE_KEYS.agent]: values.agent,
    [CAPACITY_SHOCK_RESOURCE_KEYS.human]: values.human,
    [CAPACITY_SHOCK_RESOURCE_KEYS.production]: values.production,
  };
}

function semantics(id: string): DecisionSemantics {
  return {
    objectiveId: `objective/capacity-shock/${id}`,
    evidencePacketId: `evidence-packet/capacity-shock/${id}`,
    approverId: CAPACITY_SHOCK_OWNER_ID,
    executionBoundaryId: `execution-boundary/capacity-shock/${id}`,
  };
}

function schedule(end: string): SchedulingConstraint {
  return {
    kind: "deadline",
    start: CAPACITY_SHOCK_HORIZON_START,
    end,
    resourceKey: CAPACITY_SHOCK_RESOURCE_KEYS.production,
    timeUnit: "minutes",
  };
}

function option(
  optionId: string,
  quantity: number,
  values: DemandValues,
): ModificationOption {
  return {
    optionId,
    changes: { quantity },
    resourceDemand: demand(values),
    addedCapacityCost: null,
    decisionSemantics: semantics(`modify/${optionId}`),
    reservationCompatibilityProofs: [],
    assumptions: [
      {
        key: "fixture-option",
        source: CAPACITY_SHOCK_ENVIRONMENT_ID,
        value: optionId,
      },
    ],
  };
}

function acceptedOrder(config: {
  readonly id: string;
  readonly beneficiary: string;
  readonly objective: string;
  readonly criticality: AcceptedObligation["criticality"];
  readonly quantity: number;
  readonly minimumQuantity: number;
  readonly deadline: string;
  readonly demand: DemandValues;
  readonly options?: readonly ModificationOption[];
}): AcceptedObligation {
  return {
    obligationId: config.id,
    beneficiary: config.beneficiary,
    objective: config.objective,
    serviceLevel: { quantity: config.quantity },
    protected: config.criticality === "protected",
    criticality: config.criticality,
    minimumService: { quantity: config.minimumQuantity },
    modificationPolicy: {
      modifiableFields: {
        quantity: {
          allowedBounds: {
            minimum: config.minimumQuantity,
            maximum: config.quantity,
          },
          utilityRule: {
            ruleId: "microfactory-linear-quantity/v1",
            kind: "linear",
            slope: rational(1),
            intercept: rational(0),
          },
          dimensionWeight: rational(1),
        },
      },
    },
    modificationOptions: config.options ?? [],
    resourceDemand: demand(config.demand),
    workClassByResource: {
      [CAPACITY_SHOCK_RESOURCE_KEYS.agent]: `${config.id}/agent-planning`,
      [CAPACITY_SHOCK_RESOURCE_KEYS.human]: `${config.id}/owner-review`,
      [CAPACITY_SHOCK_RESOURCE_KEYS.production]: `${config.id}/cell-run`,
    },
    schedulingConstraint: schedule(config.deadline),
    pendingOwnerDecisions: [],
    assumptions: [
      {
        key: "deterministic-portfolio",
        source: CAPACITY_SHOCK_ENVIRONMENT_ID,
        value: true,
      },
    ],
    evidenceRefs: [`evidence/${config.id}/accepted-v1`],
    requiredEffects: [`effect/${config.id}/schedule-commitment-v1`],
    status: "accepted",
  };
}

const TRAINING_TRAY_REDUCTION = option(
  "training-trays/reduce-to-8",
  8,
  { agent: 2, human: 0, production: 24 },
);

const QUALITY_FIXTURE_REDUCTION = option(
  "quality-fixtures/reduce-to-6",
  6,
  { agent: 2, human: 0, production: 18 },
);

const ACCEPTED_ORDERS = deepFreeze([
  acceptedOrder({
    id: "order/protected-cold-chain",
    beneficiary: "beneficiary/vaccine-line",
    objective: "Deliver protected cold-chain cartridge carriers unchanged",
    criticality: "protected",
    quantity: 8,
    minimumQuantity: 7,
    deadline: "2026-08-26T09:00:00.000Z",
    demand: { agent: 2, human: 0, production: 24 },
  }),
  acceptedOrder({
    id: "order/important-calibration-jigs",
    beneficiary: "beneficiary/metrology-team",
    objective: "Deliver metrology calibration jigs",
    criticality: "important",
    quantity: 6,
    minimumQuantity: 5,
    deadline: "2026-08-26T10:00:00.000Z",
    demand: { agent: 2, human: 0, production: 18 },
  }),
  acceptedOrder({
    id: "order/best-effort-training-trays",
    beneficiary: "beneficiary/operator-training",
    objective: "Deliver best-effort operator training trays",
    criticality: "best_effort",
    quantity: 10,
    minimumQuantity: 6,
    deadline: "2026-08-26T11:00:00.000Z",
    demand: { agent: 3, human: 1, production: 30 },
    options: [TRAINING_TRAY_REDUCTION],
  }),
]);

const QUALITY_FIXTURE_PROPOSAL = deepFreeze<ProposedObligation>({
  obligationId: "proposal/planned-quality-fixtures",
  beneficiary: "beneficiary/quality-lab",
  objective: "Schedule the planned quality-inspection fixture batch",
  serviceLevel: { quantity: 8 },
  protected: false,
  criticality: "important",
  minimumService: { quantity: 6 },
  modificationPolicy: {
    modifiableFields: {
      quantity: {
        allowedBounds: { minimum: 6, maximum: 8 },
        utilityRule: {
          ruleId: "microfactory-linear-quantity/v1",
          kind: "linear",
          slope: rational(1),
          intercept: rational(0),
        },
        dimensionWeight: rational(1),
      },
    },
  },
  modificationOptions: [QUALITY_FIXTURE_REDUCTION],
  resourceDemand: demand({ agent: 3, human: 1, production: 24 }),
  workClassByResource: {
    [CAPACITY_SHOCK_RESOURCE_KEYS.agent]: "quality-fixtures/agent-planning",
    [CAPACITY_SHOCK_RESOURCE_KEYS.human]: "quality-fixtures/owner-review",
    [CAPACITY_SHOCK_RESOURCE_KEYS.production]: "quality-fixtures/cell-run",
  },
  schedulingConstraint: schedule(CAPACITY_SHOCK_HORIZON_END),
  pendingOwnerDecisions: [],
  assumptions: [
    {
      key: "planned-batch",
      source: CAPACITY_SHOCK_ENVIRONMENT_ID,
      value: "deterministic",
    },
  ],
  evidenceRefs: ["evidence/proposal/planned-quality-fixtures/v1"],
  requiredEffects: ["effect/proposal/planned-quality-fixtures/schedule-reservation-v1"],
  status: "proposed",
  acceptanceDecision: semantics("accept/planned-quality-fixtures"),
});

function resources(productionCapacity: number): readonly CapacityResource[] {
  return [
    {
      resourceKey: CAPACITY_SHOCK_RESOURCE_KEYS.agent,
      side: "agent",
      capacityKind: "generic",
      unit: "work_units",
      timeUnit: null,
      horizonStart: CAPACITY_SHOCK_HORIZON_START,
      horizonEnd: CAPACITY_SHOCK_HORIZON_END,
      capacity: 10,
      safetyReserve: 0,
      estimatorRule: "declared-and-calibrated-demand/v1",
      assumptions: [
        { key: "source", source: "owner/microfactory", value: "capacity-shock-v1" },
      ],
    },
    {
      resourceKey: CAPACITY_SHOCK_RESOURCE_KEYS.human,
      side: "human",
      capacityKind: "meaningful_decisions",
      unit: "meaningful_decisions",
      timeUnit: null,
      horizonStart: CAPACITY_SHOCK_HORIZON_START,
      horizonEnd: CAPACITY_SHOCK_HORIZON_END,
      capacity: 4,
      safetyReserve: 0,
      estimatorRule: "declared-and-calibrated-demand/v1",
      assumptions: [
        { key: "source", source: "owner/microfactory", value: "capacity-shock-v1" },
      ],
    },
    {
      resourceKey: CAPACITY_SHOCK_RESOURCE_KEYS.production,
      side: "operational",
      capacityKind: "generic",
      unit: "production_minutes",
      timeUnit: "minutes",
      horizonStart: CAPACITY_SHOCK_HORIZON_START,
      horizonEnd: CAPACITY_SHOCK_HORIZON_END,
      capacity: productionCapacity,
      safetyReserve: 0,
      estimatorRule: "declared-and-calibrated-demand/v1",
      assumptions: [
        {
          key: "production-cell",
          source: CAPACITY_SHOCK_ENVIRONMENT_ID,
          value: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
        },
      ],
    },
  ];
}

const INITIAL_RESOURCES = deepFreeze(resources(100));
const SHOCKED_RESOURCES = deepFreeze(resources(90));

export const CAPACITY_SHOCK_SCHEDULE_COMMITMENTS = deepFreeze([
  {
    reservationId: "schedule/capacity-shock/protected-cold-chain/v1",
    orderId: "order/protected-cold-chain",
    productionCellId: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:00:00.000Z",
    end: "2026-08-26T08:24:00.000Z",
    quantity: 8,
    status: "committed" as const,
  },
  {
    reservationId: "schedule/capacity-shock/important-calibration-jigs/v1",
    orderId: "order/important-calibration-jigs",
    productionCellId: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:24:00.000Z",
    end: "2026-08-26T08:42:00.000Z",
    quantity: 6,
    status: "committed" as const,
  },
  {
    reservationId: "schedule/capacity-shock/best-effort-training-trays/v1",
    orderId: "order/best-effort-training-trays",
    productionCellId: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:42:00.000Z",
    end: "2026-08-26T09:12:00.000Z",
    quantity: 10,
    status: "committed" as const,
  },
]);

export function createCapacityShockInitialState(): StatefulInitialState {
  return canonicalClone({
    acceptedObligations: ACCEPTED_ORDERS,
    resources: INITIAL_RESOURCES,
    assumptions: [
      {
        key: "environment",
        source: CAPACITY_SHOCK_ENVIRONMENT_ID,
        value: CAPACITY_SHOCK_ENVIRONMENT_ID,
      },
    ],
    combinedDecisionProofs: [],
  });
}

export function createCapacityShockProposal(): ProposedObligation {
  return canonicalClone(QUALITY_FIXTURE_PROPOSAL);
}

export function createCapacityShockPlanResources(): readonly CapacityResource[] {
  return canonicalClone(SHOCKED_RESOURCES);
}

export function createCapacityShockEvaluationInput(
  shocked = true,
): AdmissionEvaluationInput {
  const initial = createCapacityShockInitialState();
  return {
    versions: {
      portfolioVersion: "portfolio/v1",
      capacityModelVersion: "capacity-model/v1",
      capacityPlanVersion: shocked ? "capacity-plan/v2" : "capacity-plan/v1",
      authorizationStateVersion: "authorization/v1",
    },
    calibration: {
      ruleId: "conservative-max/v1",
      historyRecords: [],
      expectedFrontierDigest: null,
    },
    resources: shocked ? createCapacityShockPlanResources() : initial.resources,
    acceptedObligations: initial.acceptedObligations,
    proposal: createCapacityShockProposal(),
    fixedCapacityReservations: [],
    combinedDecisionProofs: [],
    authorizationFacts: [
      {
        key: "authorization-snapshot",
        source: CAPACITY_SHOCK_ENVIRONMENT_ID,
        value: "no-live-grants",
      },
    ],
    assumptions: initial.assumptions,
  };
}
