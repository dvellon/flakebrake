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

export const HERO_ENVIRONMENT_ID = "microfactory-hero/v1";
export const HERO_PRODUCTION_CELL_ID = "cell-alpha";
export const HERO_HORIZON_START = "2026-08-26T08:00:00.000Z";
export const HERO_HORIZON_END = "2026-08-26T12:00:00.000Z";
export const HERO_OWNER_ID = "owner/microfactory-operations";

export const HERO_RESOURCE_KEYS = deepFreeze({
  agent: "agent_work_units",
  human: "human_review_decisions",
  production: "production_cell_minutes",
});

export interface HeroScheduleCommitment {
  readonly reservationId: string;
  readonly orderId: string;
  readonly productionCellId: string;
  readonly start: string;
  readonly end: string;
  readonly quantity: number;
  readonly status: "committed";
}

interface DemandValues {
  readonly agent: number;
  readonly human: number;
  readonly production: number;
}

function demand(values: DemandValues): ResourceDemand {
  return {
    [HERO_RESOURCE_KEYS.agent]: values.agent,
    [HERO_RESOURCE_KEYS.human]: values.human,
    [HERO_RESOURCE_KEYS.production]: values.production,
  };
}

function decisionSemantics(id: string): DecisionSemantics {
  return {
    objectiveId: `objective/${id}`,
    evidencePacketId: `evidence-packet/${id}`,
    approverId: HERO_OWNER_ID,
    executionBoundaryId: `execution-boundary/${id}`,
  };
}

function schedule(end: string): SchedulingConstraint {
  return {
    kind: "deadline",
    start: HERO_HORIZON_START,
    end,
    resourceKey: HERO_RESOURCE_KEYS.production,
    timeUnit: "minutes",
  };
}

function modificationOption(
  optionId: string,
  quantity: number,
  values: DemandValues,
): ModificationOption {
  return {
    optionId,
    changes: { quantity },
    resourceDemand: demand(values),
    addedCapacityCost: null,
    decisionSemantics: decisionSemantics(`modify/${optionId}`),
    reservationCompatibilityProofs: [],
    assumptions: [
      {
        key: "fixture-option",
        source: "microfactory-hero/v1",
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
      [HERO_RESOURCE_KEYS.agent]: `${config.id}/agent-planning`,
      [HERO_RESOURCE_KEYS.human]: `${config.id}/owner-review`,
      [HERO_RESOURCE_KEYS.production]: `${config.id}/cell-run`,
    },
    schedulingConstraint: schedule(config.deadline),
    pendingOwnerDecisions: [],
    assumptions: [
      {
        key: "deterministic-portfolio",
        source: "microfactory-hero/v1",
        value: true,
      },
    ],
    evidenceRefs: [`evidence/${config.id}/accepted-v1`],
    requiredEffects: [`effect/${config.id}/schedule-commitment-v1`],
    status: "accepted",
  };
}

const BEST_EFFORT_REDUCTION = modificationOption(
  "best-effort-order/reduce-to-8",
  8,
  { agent: 1, human: 0, production: 20 },
);

const RUSH_REDUCTION = modificationOption("rush-order/reduce-to-8", 8, {
  agent: 3,
  human: 0,
  production: 40,
});

const ACCEPTED_ORDERS = deepFreeze([
  acceptedOrder({
    id: "order/protected-medical",
    beneficiary: "beneficiary/community-clinic",
    objective: "Deliver protected medical housings without any term change",
    criticality: "protected",
    quantity: 10,
    minimumQuantity: 9,
    deadline: "2026-08-26T09:00:00.000Z",
    demand: { agent: 2, human: 0, production: 20 },
  }),
  acceptedOrder({
    id: "order/important-drive",
    beneficiary: "beneficiary/robotics-line",
    objective: "Deliver important drive brackets",
    criticality: "important",
    quantity: 10,
    minimumQuantity: 8,
    deadline: "2026-08-26T10:00:00.000Z",
    demand: { agent: 2, human: 0, production: 20 },
  }),
  acceptedOrder({
    id: "order/best-effort-display",
    beneficiary: "beneficiary/showroom",
    objective: "Deliver best-effort display stands",
    criticality: "best_effort",
    quantity: 10,
    minimumQuantity: 5,
    deadline: "2026-08-26T11:00:00.000Z",
    demand: { agent: 4, human: 2, production: 30 },
    options: [BEST_EFFORT_REDUCTION],
  }),
]);

const RUSH_PROPOSAL = deepFreeze<ProposedObligation>({
  obligationId: "proposal/rush-aerospace",
  beneficiary: "beneficiary/aerospace-repair",
  objective: "Accept and schedule the incoming rush aerospace bracket order",
  serviceLevel: { quantity: 10 },
  protected: false,
  criticality: "important",
  minimumService: { quantity: 6 },
  modificationPolicy: {
    modifiableFields: {
      quantity: {
        allowedBounds: { minimum: 6, maximum: 10 },
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
  modificationOptions: [RUSH_REDUCTION],
  resourceDemand: demand({ agent: 6, human: 2, production: 30 }),
  workClassByResource: {
    [HERO_RESOURCE_KEYS.agent]: "rush-order/agent-planning",
    [HERO_RESOURCE_KEYS.human]: "rush-order/owner-review",
    [HERO_RESOURCE_KEYS.production]: "rush-order/cell-run",
  },
  schedulingConstraint: schedule("2026-08-26T12:00:00.000Z"),
  pendingOwnerDecisions: [],
  assumptions: [
    {
      key: "rush-fixture",
      source: "microfactory-hero/v1",
      value: "deterministic",
    },
  ],
  evidenceRefs: ["evidence/proposal/rush-aerospace/v1"],
  requiredEffects: ["effect/proposal/rush-aerospace/schedule-reservation-v1"],
  status: "proposed",
  acceptanceDecision: decisionSemantics("accept/rush-aerospace"),
});

const RESOURCES = deepFreeze<readonly CapacityResource[]>([
  {
    resourceKey: HERO_RESOURCE_KEYS.agent,
    side: "agent",
    capacityKind: "generic",
    unit: "work_units",
    timeUnit: null,
    horizonStart: HERO_HORIZON_START,
    horizonEnd: HERO_HORIZON_END,
    capacity: 12,
    safetyReserve: 0,
    estimatorRule: "declared-and-calibrated-demand/v1",
    assumptions: [
      { key: "source", source: "owner/microfactory", value: "hero-v1" },
    ],
  },
  {
    resourceKey: HERO_RESOURCE_KEYS.human,
    side: "human",
    capacityKind: "meaningful_decisions",
    unit: "meaningful_decisions",
    timeUnit: null,
    horizonStart: HERO_HORIZON_START,
    horizonEnd: HERO_HORIZON_END,
    capacity: 4,
    safetyReserve: 0,
    estimatorRule: "declared-and-calibrated-demand/v1",
    assumptions: [
      { key: "source", source: "owner/microfactory", value: "hero-v1" },
    ],
  },
  {
    resourceKey: HERO_RESOURCE_KEYS.production,
    side: "operational",
    capacityKind: "generic",
    unit: "production_minutes",
    timeUnit: "minutes",
    horizonStart: HERO_HORIZON_START,
    horizonEnd: HERO_HORIZON_END,
    capacity: 110,
    safetyReserve: 0,
    estimatorRule: "declared-and-calibrated-demand/v1",
    assumptions: [
      { key: "production-cell", source: "microfactory-hero/v1", value: HERO_PRODUCTION_CELL_ID },
    ],
  },
]);

export const HERO_SCHEDULE_COMMITMENTS = deepFreeze<
  readonly HeroScheduleCommitment[]
>([
  {
    reservationId: "schedule/protected-medical/v1",
    orderId: "order/protected-medical",
    productionCellId: HERO_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:00:00.000Z",
    end: "2026-08-26T08:20:00.000Z",
    quantity: 10,
    status: "committed",
  },
  {
    reservationId: "schedule/important-drive/v1",
    orderId: "order/important-drive",
    productionCellId: HERO_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:20:00.000Z",
    end: "2026-08-26T08:40:00.000Z",
    quantity: 10,
    status: "committed",
  },
  {
    reservationId: "schedule/best-effort-display/v1",
    orderId: "order/best-effort-display",
    productionCellId: HERO_PRODUCTION_CELL_ID,
    start: "2026-08-26T08:40:00.000Z",
    end: "2026-08-26T09:10:00.000Z",
    quantity: 10,
    status: "committed",
  },
]);

export function createHeroInitialState(): StatefulInitialState {
  return canonicalClone({
    acceptedObligations: ACCEPTED_ORDERS,
    resources: RESOURCES,
    assumptions: [
      {
        key: "environment",
        source: "microfactory-hero/v1",
        value: HERO_ENVIRONMENT_ID,
      },
    ],
    combinedDecisionProofs: [],
  });
}

export function createHeroProposal(): ProposedObligation {
  return canonicalClone(RUSH_PROPOSAL);
}

export function createHeroEvaluationInput(): AdmissionEvaluationInput {
  const initial = createHeroInitialState();
  return {
    versions: {
      portfolioVersion: "portfolio/v1",
      capacityModelVersion: "capacity-model/v1",
      capacityPlanVersion: "capacity-plan/v1",
      authorizationStateVersion: "authorization/v1",
    },
    calibration: {
      ruleId: "conservative-max/v1",
      historyRecords: [],
      expectedFrontierDigest: null,
    },
    resources: initial.resources,
    acceptedObligations: initial.acceptedObligations,
    proposal: createHeroProposal(),
    fixedCapacityReservations: [],
    combinedDecisionProofs: [],
    authorizationFacts: [
      {
        key: "authorization-snapshot",
        source: "microfactory-hero/v1",
        value: "no-live-grants",
      },
    ],
    assumptions: initial.assumptions,
  };
}
