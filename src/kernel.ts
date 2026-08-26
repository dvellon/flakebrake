import { createHash } from "node:crypto";

import { computeCalibration } from "./calibration.js";
import type { CalibrationComputation } from "./calibration.js";
import {
  canonicalClone,
  canonicalSerialize,
  compareStableStrings,
  deepFreeze,
} from "./canonical.js";
import {
  exactStringSequencesEqual,
  sortedStrings,
  stableTupleId,
} from "./identity.js";
import { nondominatedFrontierLayers } from "./ordering.js";
import {
  evaluateTemporalSchedule,
  SchedulingError,
} from "./scheduling.js";
import type {
  FixedSchedulingClaim,
  FlexibleSchedulingClaim,
} from "./scheduling.js";
import type {
  AcceptedObligation,
  AdmissionBasis,
  AdmissionEvaluationInput,
  AdmissionResult,
  BindingOrLimitingResources,
  CandidateComparison,
  CandidateScore,
  CapacityEvaluation,
  CapacityResource,
  CombinedDecisionProof,
  ConstraintViolation,
  CostVector,
  DecisionRequirement,
  ExpectedAdmissionBasis,
  FeasibilityRestoringSuggestion,
  FixedCapacityReservation,
  JsonPrimitive,
  MeaningfulDecision,
  MeaningfulDecisionFrontier,
  ModificationFailureCode,
  ModificationOption,
  ObligationChange,
  PromiseBasis,
  ProposedObligation,
  ProvenanceEntry,
  RankableReplanCandidate,
  Rational,
  RejectedModificationOption,
  ReplanCandidate,
  RequiredOwnerApproval,
  ResourceAmount,
  ResourceDemand,
  ServiceDimensionLoss,
  ServiceLevel,
  StrategyFamilySummary,
  TemporalSlack,
  TimeUnit,
  TypedCost,
  UncalculableFeasibilityChange,
} from "./domain.js";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  normalizeRational,
  rational,
  subtractRational,
  validateCanonicalRational,
} from "./rational.js";

const HUMAN_REVIEW_RESOURCE_KEY = "human_review_decisions";
const AGENT_WORK_RESOURCE_KEY = "agent_work_units";
const TIME_UNIT_MILLISECONDS: Readonly<Record<TimeUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
};

type Obligation = AcceptedObligation | ProposedObligation;

interface EvaluatorContext {
  readonly input: AdmissionEvaluationInput;
  readonly resources: readonly CapacityResource[];
  readonly resourceKeys: readonly string[];
  readonly resourceByKey: ReadonlyMap<string, CapacityResource>;
  readonly acceptedObligations: readonly AcceptedObligation[];
  readonly reservations: readonly FixedCapacityReservation[];
  readonly calibration: CalibrationComputation;
  readonly baselineDecisionFrontier: MeaningfulDecisionFrontier;
  readonly capacityBefore: ReadonlyMap<string, number>;
}

interface ConstructibleModification {
  readonly obligation: Obligation;
  readonly option: ModificationOption;
  readonly proposedServiceLevel: ServiceLevel;
  readonly calibratedDemand: ResourceDemand;
  readonly serviceLoss: Rational;
  readonly dimensionLosses: readonly ServiceDimensionLoss[];
}

interface EvaluatedSearch {
  readonly candidates: readonly ReplanCandidate[];
  readonly strategyFamilies: readonly StrategyFamilySummary[];
}

interface PlanState {
  readonly proposalChoice: ConstructibleModification | null;
  readonly acceptedChoices: readonly (ConstructibleModification | null)[];
}

interface SensitivityPlan {
  readonly candidatePlanId: string;
  readonly capacity: CapacityEvaluation;
  readonly affectedObligations: readonly ObligationChange[];
}

export class AdmissionInputError extends TypeError {
  public constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "AdmissionInputError";
  }
}

export function compareReplanCandidates(
  left: unknown,
  right: unknown,
): CandidateComparison {
  validateRankableCandidate(left, "left");
  validateRankableCandidate(right, "right");

  const protectedComparison = compareNumber(
    left.score.protectedObligationViolations,
    right.score.protectedObligationViolations,
  );
  if (protectedComparison !== 0) return preference(protectedComparison);

  const degradationComparison = compareRational(
    left.score.criticalityWeightedServiceDegradation,
    right.score.criticalityWeightedServiceDegradation,
  );
  if (degradationComparison !== 0) return preference(degradationComparison);

  const changedComparison = compareNumber(
    left.score.previouslyAcceptedObligationsChanged,
    right.score.previouslyAcceptedObligationsChanged,
  );
  if (changedComparison !== 0) return preference(changedComparison);

  const costComparison = compareCostVectors(
    left.score.addedCapacityCost,
    right.score.addedCapacityCost,
  );
  if (costComparison === "incomparable") return "incomparable";
  if (costComparison !== "equivalent") return costComparison;

  const slackComparison = compareRational(
    right.score.bottleneckSlack,
    left.score.bottleneckSlack,
  );
  if (slackComparison !== 0) return preference(slackComparison);

  return "equivalent";
}

export function evaluateAdmission(input: unknown): AdmissionResult {
  const validatedInput = validateAdmissionInput(input);
  const context = createContext(normalizeInput(validatedInput));
  const basis = createAdmissionBasis(context);
  const directState: PlanState = {
    proposalChoice: null,
    acceptedChoices: context.acceptedObligations.map(() => null),
  };
  const directPlan = evaluatePlan(context, directState);

  if (directPlan.violations.length === 0) {
    const selectedPlanIds = [
      directCandidatePlanId(context.input.proposal.obligationId),
    ];
    const promiseBasis = createPromiseBasis(
      context,
      "ADMITTABLE",
      directPlan,
      [],
      selectedPlanIds,
      [],
      [],
    );
    return finalizeResult({
      decision: "ADMITTABLE",
      basis,
      expectedBasis: expectedAcceptanceBasis(context),
      directPlan,
      permissibleOwnerChoices: ["ACCEPT_PROMISE", "MODIFY", "DECLINE"],
      promiseBasis,
    });
  }

  const search = enumerateReplans(context);
  const feasibleLayers = rankCandidateLayers(
    search.candidates.filter((candidate) => candidate.feasible),
  );
  const feasibleCandidates = feasibleLayers.flat();

  if (feasibleCandidates.length > 0) {
    const recommendedCandidates = feasibleLayers[0] ?? [];
    const recommendedCandidate =
      recommendedCandidates.length === 1
        ? (recommendedCandidates[0] ?? null)
        : null;
    const selectedPlanIds = recommendedCandidates.map(
      (candidate) => candidate.candidatePlanId,
    );
    const promiseBasis = createPromiseBasis(
      context,
      "REPLAN",
      directPlan,
      search.candidates,
      selectedPlanIds,
      [],
      [],
    );
    return finalizeResult({
      decision: "REPLAN",
      basis,
      expectedBasis: "NOT_APPLICABLE",
      directPlan,
      strategyFamilies: search.strategyFamilies,
      consideredCandidates: search.candidates,
      candidates: feasibleCandidates,
      recommendedCandidates,
      recommendedCandidate,
      promiseBasis,
    });
  }

  const consideredCandidates = search.candidates;
  const sensitivityPlans: SensitivityPlan[] = [
    {
      candidatePlanId: directCandidatePlanId(
        context.input.proposal.obligationId,
      ),
      capacity: directPlan,
      affectedObligations: [],
    },
    ...consideredCandidates.map((candidate) => ({
      candidatePlanId: candidate.candidatePlanId,
      capacity: candidate.capacity,
      affectedObligations: candidate.affectedObligations,
    })),
  ];
  const suggestions = paretoMinimalSuggestions(context, sensitivityPlans);
  const uncalculable = uncalculableChanges(directPlan);
  const promiseBasis = createPromiseBasis(
    context,
    "REJECT",
    directPlan,
    consideredCandidates,
    ["NO_FEASIBLE_PLAN"],
    suggestions,
    uncalculable,
  );
  return finalizeResult({
    decision: "REJECT",
    basis,
    expectedBasis: "NOT_APPLICABLE",
    directPlan,
    strategyFamilies: search.strategyFamilies,
    consideredCandidates,
    feasibilityRestoringSuggestions: suggestions,
    uncalculableFeasibilityChanges: uncalculable,
    promiseBasis,
  });
}

function createContext(input: AdmissionEvaluationInput): EvaluatorContext {
  const resources = input.resources;
  const resourceKeys = resources.map((resource) => resource.resourceKey);
  const resourceByKey = new Map(
    resources.map((resource) => [resource.resourceKey, resource]),
  );
  const acceptedObligations = input.acceptedObligations;
  const reservations = input.fixedCapacityReservations;
  const obligations: Obligation[] = [...acceptedObligations, input.proposal];
  const calibration = computeCalibration(
    input.versions.capacityModelVersion,
    resources,
    obligations,
    input.calibration.historyRecords,
  );
  if (
    input.calibration.expectedFrontierDigest !== null &&
    input.calibration.expectedFrontierDigest !== calibration.digest
  ) {
    throw new AdmissionInputError(
      "calibration.expectedFrontierDigest",
      `does not match recomputed digest ${calibration.digest}`,
    );
  }

  const baselineRequirements = acceptedObligations.flatMap((obligation) =>
    pendingRequirements(obligation),
  );
  const baselineDecisionFrontier = buildDecisionFrontier(
    baselineRequirements,
    input.combinedDecisionProofs,
  );

  const capacityBefore = new Map<string, number>();
  for (const resource of resources) {
    let existingUse = 0;
    for (const obligation of acceptedObligations) {
      const demand = calibration.calibratedDemand(
        obligation,
        obligation.resourceDemand,
      );
      existingUse = safeAdd(
        existingUse,
        demandValue(demand, resource.resourceKey),
        `existing use for ${resource.resourceKey}`,
      );
    }
    if (resource.resourceKey === HUMAN_REVIEW_RESOURCE_KEY) {
      existingUse = safeAdd(
        existingUse,
        baselineDecisionFrontier.requiredDecisionCount,
        "existing meaningful decisions",
      );
    }
    for (const reservation of reservations) {
      if (reservation.claimAccounting === "additional") {
        existingUse = safeAdd(
          existingUse,
          demandValue(reservation.resourceClaims, resource.resourceKey),
          `fixed reservation use for ${resource.resourceKey}`,
        );
      }
    }
    capacityBefore.set(
      resource.resourceKey,
      safeSubtract(
        safeSubtract(
          resource.capacity,
          resource.safetyReserve,
          `capacity reserve for ${resource.resourceKey}`,
        ),
        existingUse,
        `capacity before for ${resource.resourceKey}`,
      ),
    );
  }

  return {
    input,
    resources,
    resourceKeys,
    resourceByKey,
    acceptedObligations,
    reservations,
    calibration,
    baselineDecisionFrontier,
    capacityBefore,
  };
}

function evaluatePlan(
  context: EvaluatorContext,
  state: PlanState,
): CapacityEvaluation {
  const changes = selectedChanges(state);
  const requirements = [
    ...context.acceptedObligations.flatMap((obligation) =>
      pendingRequirements(obligation),
    ),
    ...pendingRequirements(context.input.proposal),
    acceptanceRequirement(context.input.proposal),
    ...changes.map((change) => modificationRequirement(change)),
  ].sort(compareDecisionRequirements);
  const decisionFrontier = buildDecisionFrontier(
    requirements,
    context.input.combinedDecisionProofs,
  );

  const operational = new Map<string, number>();
  const controlPlane = new Map<string, number>();
  for (const resourceKey of context.resourceKeys) {
    const proposalDemand = finalCalibratedDemand(
      context,
      context.input.proposal,
      state.proposalChoice,
    );
    let operationalValue = demandValue(proposalDemand, resourceKey);
    for (const [index, obligation] of context.acceptedObligations.entries()) {
      const choice = state.acceptedChoices[index] ?? null;
      if (choice !== null) {
        const previous = context.calibration.calibratedDemand(
          obligation,
          obligation.resourceDemand,
        );
        operationalValue = safeAdd(
          operationalValue,
          safeSubtract(
            demandValue(choice.calibratedDemand, resourceKey),
            demandValue(previous, resourceKey),
            `resource delta for ${obligation.obligationId}`,
          ),
          `candidate operational consumption for ${resourceKey}`,
        );
      }
    }
    operational.set(resourceKey, operationalValue);
    controlPlane.set(
      resourceKey,
      resourceKey === HUMAN_REVIEW_RESOURCE_KEY
        ? safeSubtract(
            decisionFrontier.requiredDecisionCount,
            context.baselineDecisionFrontier.requiredDecisionCount,
            "meaningful decision delta",
          )
        : 0,
    );
  }

  const capacityBefore = context.resourceKeys.map((resourceKey) => ({
    resourceKey,
    value: requiredMapValue(context.capacityBefore, resourceKey),
  }));
  const predictedOperationalConsumption = mapAmounts(
    operational,
    context.resourceKeys,
  );
  const predictedControlPlaneConsumption = mapAmounts(
    controlPlane,
    context.resourceKeys,
  );
  const predictedConsumption = context.resourceKeys.map((resourceKey) => ({
    resourceKey,
    value: safeAdd(
      requiredMapValue(operational, resourceKey),
      requiredMapValue(controlPlane, resourceKey),
      `total predicted consumption for ${resourceKey}`,
    ),
  }));
  const capacityAfter = predictedConsumption.map((entry) => ({
    resourceKey: entry.resourceKey,
    value: safeSubtract(
      requiredMapValue(context.capacityBefore, entry.resourceKey),
      entry.value,
      `capacity after for ${entry.resourceKey}`,
    ),
  }));

  const violations: ConstraintViolation[] = capacityAfter
    .filter((entry) => entry.value < 0)
    .map((entry) => ({
      kind: "resource_capacity" as const,
      resourceKey: entry.resourceKey,
      deficit: -entry.value,
    }));
  const temporalSlack = evaluateTemporalSlack(context, state);
  for (const temporal of temporalSlack) {
    if (temporal.slack < 0) {
      violations.push({
        kind: "scheduling_constraint",
        obligationId: temporal.obligationId,
        resourceKey: temporal.resourceKey,
        deficit: -temporal.slack,
        timeUnit: temporal.timeUnit,
        protected: temporal.protected,
      });
    }
  }

  return {
    capacityBefore,
    predictedOperationalConsumption,
    predictedControlPlaneConsumption,
    predictedConsumption,
    capacityAfter,
    temporalSlack,
    protectedObligationSlack: {
      byResource: capacityAfter.map((entry) => ({ ...entry })),
      bySchedulingConstraint: temporalSlack.filter(
        (entry) => entry.protected,
      ),
    },
    meaningfulDecisionFrontier: decisionFrontier,
    bindingOrLimitingResources: bindingOrLimiting(context, capacityAfter),
    violations,
  };
}

function evaluateTemporalSlack(
  context: EvaluatorContext,
  state: PlanState,
): readonly TemporalSlack[] {
  const flexible: FlexibleSchedulingClaim[] = [];
  for (const [index, obligation] of context.acceptedObligations.entries()) {
    const calibratedDemand = finalCalibratedDemand(
      context,
      obligation,
      state.acceptedChoices[index] ?? null,
    );
    const constraint = obligation.schedulingConstraint;
    const requiredDuration = demandValue(
      calibratedDemand,
      constraint.resourceKey,
    );
    flexible.push({
      obligationId: obligation.obligationId,
      resourceKey: constraint.resourceKey,
      start: constraint.start,
      end: constraint.end,
      timeUnit: constraint.timeUnit,
      flexibleDuration: safeSubtract(
        requiredDuration,
        representedReservationClaim(
          context.reservations,
          obligation.obligationId,
          constraint.resourceKey,
        ),
        `unreserved temporal demand for ${obligation.obligationId}`,
      ),
      reportedRequiredDuration: requiredDuration,
      protected: obligation.protected,
    });
  }
  const proposalDemand = finalCalibratedDemand(
    context,
    context.input.proposal,
    state.proposalChoice,
  );
  const proposalConstraint = context.input.proposal.schedulingConstraint;
  const proposalRequiredDuration = demandValue(
    proposalDemand,
    proposalConstraint.resourceKey,
  );
  flexible.push({
    obligationId: context.input.proposal.obligationId,
    resourceKey: proposalConstraint.resourceKey,
    start: proposalConstraint.start,
    end: proposalConstraint.end,
    timeUnit: proposalConstraint.timeUnit,
    flexibleDuration: proposalRequiredDuration,
    reportedRequiredDuration: proposalRequiredDuration,
    protected: context.input.proposal.protected,
  });

  const fixed: FixedSchedulingClaim[] = context.reservations.flatMap(
    (reservation) =>
      reservation.temporalClaim === null
        ? []
        : [
            {
              reservationId: reservation.reservationId,
              resourceKey: reservation.temporalClaim.resourceKey,
              start: reservation.temporalClaim.start,
              end: reservation.temporalClaim.end,
              timeUnit: reservation.temporalClaim.timeUnit,
            },
          ],
  );
  try {
    return evaluateTemporalSchedule(flexible, fixed);
  } catch (error: unknown) {
    if (error instanceof SchedulingError) {
      throw new AdmissionInputError("scheduling", error.message);
    }
    throw error;
  }
}

function representedReservationClaim(
  reservations: readonly FixedCapacityReservation[],
  obligationId: string,
  resourceKey: string,
): number {
  return reservations
    .filter(
      (reservation) =>
        reservation.claimAccounting === "already_in_portfolio" &&
        reservation.affectedObligationIds.length === 1 &&
        reservation.affectedObligationIds[0] === obligationId,
    )
    .reduce(
      (total, reservation) =>
        safeAdd(
          total,
          demandValue(reservation.resourceClaims, resourceKey),
          `represented fixed reservation use for ${resourceKey}`,
        ),
      0,
    );
}

function reservationTemporalClaimIsInsideObligation(
  reservation: FixedCapacityReservation,
  obligation: AcceptedObligation,
): boolean {
  const temporal = reservation.temporalClaim;
  if (temporal === null) return true;
  const constraint = obligation.schedulingConstraint;
  return (
    temporal.resourceKey === constraint.resourceKey &&
    temporal.timeUnit === constraint.timeUnit &&
    Date.parse(temporal.start) >= Date.parse(constraint.start) &&
    Date.parse(temporal.end) <= Date.parse(constraint.end)
  );
}

function representedDemandFor(
  obligation: AcceptedObligation,
  resourceKey: string,
): number {
  return demandValue(obligation.resourceDemand, resourceKey);
}

function validateAggregateReservationAccounting(
  accepted: readonly AcceptedObligation[],
  reservations: readonly FixedCapacityReservation[],
  resourceKeys: readonly string[],
): void {
  const acceptedById = new Map(
    accepted.map((obligation) => [obligation.obligationId, obligation]),
  );
  const representedTotals = new Map<string, Map<string, number>>();

  for (const reservation of reservations) {
    if (reservation.claimAccounting !== "already_in_portfolio") continue;
    const hasRepresentedClaim =
      reservation.temporalClaim !== null ||
      resourceKeys.some(
        (resourceKey) =>
          demandValue(reservation.resourceClaims, resourceKey) > 0,
      );
    if (!hasRepresentedClaim) continue;
    if (reservation.affectedObligationIds.length !== 1) {
      throw new AdmissionInputError(
        `fixedCapacityReservations.${reservation.reservationId}.affectedObligationIds`,
        "already-in-portfolio claims require one unambiguous affected obligation",
      );
    }
    const obligationId = reservation.affectedObligationIds[0];
    if (obligationId === undefined) {
      throw new AdmissionInputError(
        `fixedCapacityReservations.${reservation.reservationId}.affectedObligationIds`,
        "must reference one accepted obligation",
      );
    }
    const obligation = acceptedById.get(obligationId);
    if (obligation === undefined) {
      throw new AdmissionInputError(
        `fixedCapacityReservations.${reservation.reservationId}.affectedObligationIds`,
        "must reference one accepted obligation",
      );
    }
    if (!reservationTemporalClaimIsInsideObligation(reservation, obligation)) {
      throw new AdmissionInputError(
        `fixedCapacityReservations.${reservation.reservationId}.temporalClaim`,
        "must preserve the affected obligation's temporal resource and window",
      );
    }

    const byResource =
      representedTotals.get(obligationId) ?? new Map<string, number>();
    representedTotals.set(obligationId, byResource);
    for (const resourceKey of resourceKeys) {
      byResource.set(
        resourceKey,
        safeAdd(
          byResource.get(resourceKey) ?? 0,
          demandValue(reservation.resourceClaims, resourceKey),
          `aggregate represented reservation demand for ${resourceKey}`,
        ),
      );
    }
  }

  for (const [obligationId, byResource] of representedTotals) {
    const obligation = acceptedById.get(obligationId);
    if (obligation === undefined) throw new Error(`Missing obligation ${obligationId}`);
    for (const resourceKey of resourceKeys) {
      if (
        (byResource.get(resourceKey) ?? 0) >
        representedDemandFor(obligation, resourceKey)
      ) {
        throw new AdmissionInputError(
          `fixedCapacityReservations.claimAccounting.${obligationId}.${resourceKey}`,
          "aggregate already-in-portfolio claims exceed authoritative obligation demand",
        );
      }
    }
  }
}

function enumerateReplans(context: EvaluatorContext): EvaluatedSearch {
  const proposalOptions = constructibleOptions(context, context.input.proposal);
  const acceptedOptions = context.acceptedObligations.map((obligation) => ({
    obligation,
    options: constructibleOptions(context, obligation),
  }));
  const rejectedOptions = [
    ...proposalOptions.rejected,
    ...acceptedOptions.flatMap((entry) => entry.options.rejected),
  ].sort(compareRejectedOptions);

  const candidates: ReplanCandidate[] = [];
  const proposalChoices: readonly (ConstructibleModification | null)[] = [
    null,
    ...proposalOptions.valid,
  ];
  for (const proposalChoice of proposalChoices) {
    enumerateAcceptedChoices(acceptedOptions, 0, [], (acceptedChoices) => {
      if (
        proposalChoice === null &&
        acceptedChoices.every((choice) => choice === null)
      ) {
        return;
      }
      candidates.push(
        evaluateCandidate(context, { proposalChoice, acceptedChoices }),
      );
    });
  }
  const rankedCandidates = rankCandidateLayers(candidates).flat();

  const proposalFamily = rankedCandidates.filter(
    (candidate) => candidate.strategy !== "modify_existing",
  );
  const existingFamily = rankedCandidates.filter(
    (candidate) => candidate.strategy !== "modify_proposal",
  );
  const existingDeclared = context.acceptedObligations.reduce(
    (count, obligation) => count + obligation.modificationOptions.length,
    0,
  );
  const summaries: StrategyFamilySummary[] = [
    {
      strategy: "modify_proposal",
      status: strategyStatus(
        context.input.proposal.modificationOptions.length,
        proposalFamily,
      ),
      declaredOptionCount: context.input.proposal.modificationOptions.length,
      constructibleCandidateCount: proposalFamily.length,
      feasibleCandidateCount: proposalFamily.filter(
        (candidate) => candidate.feasible,
      ).length,
      rejectedOptions: rejectedOptions.filter(
        (option) =>
          option.obligationId === context.input.proposal.obligationId,
      ),
    },
    {
      strategy: "modify_existing",
      status: strategyStatus(existingDeclared, existingFamily),
      declaredOptionCount: existingDeclared,
      constructibleCandidateCount: existingFamily.length,
      feasibleCandidateCount: existingFamily.filter(
        (candidate) => candidate.feasible,
      ).length,
      rejectedOptions: rejectedOptions.filter(
        (option) =>
          option.obligationId !== context.input.proposal.obligationId,
      ),
    },
  ];
  return { candidates: rankedCandidates, strategyFamilies: summaries };
}

function constructibleOptions(
  context: EvaluatorContext,
  obligation: Obligation,
): {
  readonly valid: readonly ConstructibleModification[];
  readonly rejected: readonly RejectedModificationOption[];
} {
  const valid: ConstructibleModification[] = [];
  const rejected: RejectedModificationOption[] = [];
  for (const option of obligation.modificationOptions) {
    const result = validateModificationCandidate(context, obligation, option);
    if ("code" in result) rejected.push(result);
    else valid.push(result);
  }
  return { valid, rejected };
}

function validateModificationCandidate(
  context: EvaluatorContext,
  obligation: Obligation,
  option: ModificationOption,
): ConstructibleModification | RejectedModificationOption {
  if (obligation.protected) {
    return modificationFailure(
      obligation,
      option,
      "protected_obligation",
      null,
      null,
    );
  }
  const changeEntries = Object.entries(option.changes).sort(([left], [right]) =>
    compareStableStrings(left, right),
  );
  if (changeEntries.length === 0) {
    return modificationFailure(
      obligation,
      option,
      "unmodifiable_field",
      null,
      null,
    );
  }

  for (const reservation of context.reservations) {
    if (!reservation.affectedObligationIds.includes(obligation.obligationId)) {
      continue;
    }
    const proof = option.reservationCompatibilityProofs.find(
      (candidate) => candidate.reservationId === reservation.reservationId,
    );
    if (
      proof === undefined ||
      proof.reservationDigest !== reservationDigest(reservation)
    ) {
      return modificationFailure(
        obligation,
        option,
        "fixed_reservation_conflict",
        null,
        reservation.reservationId,
      );
    }
  }

  const representedReservations = context.reservations.filter(
    (reservation) =>
      reservation.claimAccounting === "already_in_portfolio" &&
      reservation.affectedObligationIds.length === 1 &&
      reservation.affectedObligationIds[0] === obligation.obligationId,
  );
  for (const resourceKey of context.resourceKeys) {
    const lockedClaim = representedReservations.reduce(
      (total, reservation) =>
        safeAdd(
          total,
          demandValue(reservation.resourceClaims, resourceKey),
          `candidate locked claim for ${resourceKey}`,
        ),
      0,
    );
    if (demandValue(option.resourceDemand, resourceKey) < lockedClaim) {
      return modificationFailure(
        obligation,
        option,
        "fixed_reservation_conflict",
        null,
        representedReservations[0]?.reservationId ?? null,
      );
    }
  }

  const proposedServiceLevel: Record<string, number> = {
    ...obligation.serviceLevel,
  };
  for (const [field, newValue] of changeEntries) {
    const policies = obligation.modificationPolicy.modifiableFields;
    const policy = Object.hasOwn(policies, field)
      ? policies[field]
      : undefined;
    if (policy === undefined) {
      return modificationFailure(
        obligation,
        option,
        "unmodifiable_field",
        field,
        null,
      );
    }
    if (
      newValue < policy.allowedBounds.minimum ||
      newValue > policy.allowedBounds.maximum
    ) {
      return modificationFailure(
        obligation,
        option,
        "outside_allowed_bounds",
        field,
        null,
      );
    }
    const floor = obligation.minimumService[field];
    if (floor === undefined || newValue < floor) {
      return modificationFailure(
        obligation,
        option,
        "minimum_service_floor",
        field,
        null,
      );
    }
    proposedServiceLevel[field] = newValue;
  }

  const loss = calculateServiceLoss(obligation, proposedServiceLevel);
  if ("code" in loss) {
    return modificationFailure(
      obligation,
      option,
      loss.code,
      loss.field,
      null,
    );
  }
  return {
    obligation,
    option,
    proposedServiceLevel,
    calibratedDemand: context.calibration.calibratedDemand(
      obligation,
      option.resourceDemand,
    ),
    serviceLoss: loss.value,
    dimensionLosses: loss.dimensionLosses,
  };
}

function calculateServiceLoss(
  obligation: Obligation,
  proposedServiceLevel: ServiceLevel,
):
  | {
      readonly value: Rational;
      readonly dimensionLosses: readonly ServiceDimensionLoss[];
    }
  | {
      readonly code: "non_degrading_utility" | "invalid_utility_policy";
      readonly field: string | null;
    } {
  let weightedLoss = rational(0);
  let totalWeight = rational(0);
  const dimensionLosses: ServiceDimensionLoss[] = [];
  const policyEntries = Object.entries(
    obligation.modificationPolicy.modifiableFields,
  ).sort(([left], [right]) => compareStableStrings(left, right));
  for (const [field, policy] of policyEntries) {
    const weight = normalizeRational(policy.dimensionWeight);
    totalWeight = addRational(totalWeight, weight);
    const oldValue = obligation.serviceLevel[field];
    const newValue = proposedServiceLevel[field];
    const floor = obligation.minimumService[field];
    if (oldValue === undefined || newValue === undefined || floor === undefined) {
      return { code: "invalid_utility_policy", field };
    }
    if (oldValue === newValue) continue;
    const denominator = subtractRational(
      linearUtility(policy.utilityRule, oldValue),
      linearUtility(policy.utilityRule, floor),
    );
    if (compareRational(denominator, rational(0)) <= 0) {
      return { code: "invalid_utility_policy", field };
    }
    const dimensionLoss = divideRational(
      subtractRational(
        linearUtility(policy.utilityRule, oldValue),
        linearUtility(policy.utilityRule, newValue),
      ),
      denominator,
    );
    if (
      compareRational(dimensionLoss, rational(0)) < 0 ||
      compareRational(dimensionLoss, rational(1)) > 0
    ) {
      return { code: "non_degrading_utility", field };
    }
    dimensionLosses.push({ field, loss: dimensionLoss });
    weightedLoss = addRational(
      weightedLoss,
      multiplyRational(weight, dimensionLoss),
    );
  }
  if (compareRational(totalWeight, rational(0)) <= 0) {
    return { code: "invalid_utility_policy", field: null };
  }
  const serviceLoss = divideRational(weightedLoss, totalWeight);
  if (
    compareRational(serviceLoss, rational(0)) < 0 ||
    compareRational(serviceLoss, rational(1)) > 0
  ) {
    return { code: "invalid_utility_policy", field: null };
  }
  return { value: serviceLoss, dimensionLosses };
}

function evaluateCandidate(
  context: EvaluatorContext,
  state: PlanState,
): ReplanCandidate {
  const changes = selectedChanges(state);
  const existingChanges = state.acceptedChoices.filter(
    (choice): choice is ConstructibleModification => choice !== null,
  );
  const affectedObligations = changes
    .map((change) => createObligationChange(context, change))
    .sort((left, right) =>
      compareStableStrings(left.obligationId, right.obligationId),
    );
  const requiredOwnerApprovals = changes
    .map(createRequiredApproval)
    .sort((left, right) =>
      compareStableStrings(left.requirementId, right.requirementId),
    );
  const capacity = evaluatePlan(context, state);
  const candidatePlanId = replanCandidatePlanId(
    context.input.proposal.obligationId,
    state.proposalChoice,
    existingChanges,
  );
  return {
    candidatePlanId,
    strategy:
      state.proposalChoice !== null && existingChanges.length > 0
        ? "modify_both"
        : state.proposalChoice !== null
          ? "modify_proposal"
          : "modify_existing",
    feasible: capacity.violations.length === 0,
    affectedObligations,
    requiredOwnerApprovals,
    capacity,
    assumptions: normalizeProvenance([
      ...context.input.assumptions,
      ...changes.flatMap((change) => change.option.assumptions),
    ]),
    score: candidateScore(context, changes, capacity),
  };
}

function candidateScore(
  context: EvaluatorContext,
  changes: readonly ConstructibleModification[],
  capacity: CapacityEvaluation,
): CandidateScore {
  let degradation = rational(0);
  let acceptedChanged = 0;
  for (const change of changes) {
    degradation = addRational(
      degradation,
      multiplyRational(
        rational(criticalityWeight(change.obligation.criticality)),
        change.serviceLoss,
      ),
    );
    if (change.obligation.status === "accepted") acceptedChanged += 1;
  }
  return {
    protectedObligationViolations: 0,
    criticalityWeightedServiceDegradation: degradation,
    previouslyAcceptedObligationsChanged: acceptedChanged,
    addedCapacityCost: costVector(
      changes.map((change) => change.option.addedCapacityCost),
    ),
    bottleneckSlack: bottleneckSlack(context, capacity.capacityAfter),
  };
}

function buildDecisionFrontier(
  requirementsInput: readonly DecisionRequirement[],
  proofs: readonly CombinedDecisionProof[],
): MeaningfulDecisionFrontier {
  const requirements = [...requirementsInput].sort(compareDecisionRequirements);
  assertUnique(
    requirements.map((requirement) => requirement.requirementId),
    "decisionRequirements.requirementId",
  );
  const requirementById = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  const covered = new Set<string>();
  const decisions: MeaningfulDecision[] = [];
  for (const proof of proofs) {
    if (
      !proof.coveredRequirementIds.every((requirementId) =>
        requirementById.has(requirementId),
      )
    ) {
      continue;
    }
    for (const requirementId of proof.coveredRequirementIds) {
      covered.add(requirementId);
    }
    decisions.push({
      decisionId: proof.decisionId,
      requirementIds: [...proof.coveredRequirementIds].sort(compareStableStrings),
      objectiveId: proof.objectiveId,
      evidencePacketId: proof.evidencePacketId,
      approverId: proof.approverId,
      executionBoundaryId: proof.executionBoundaryId,
      combinedByProofId: proof.proofId,
    });
  }
  for (const requirement of requirements) {
    if (covered.has(requirement.requirementId)) continue;
    decisions.push({
      decisionId: requirement.requirementId,
      requirementIds: [requirement.requirementId],
      objectiveId: requirement.objectiveId,
      evidencePacketId: requirement.evidencePacketId,
      approverId: requirement.approverId,
      executionBoundaryId: requirement.executionBoundaryId,
      combinedByProofId: null,
    });
  }
  decisions.sort((left, right) =>
    compareStableStrings(left.decisionId, right.decisionId),
  );
  return { requirements, decisions, requiredDecisionCount: decisions.length };
}

function acceptanceRequirement(
  proposal: ProposedObligation,
): DecisionRequirement {
  return {
    requirementId: acceptanceRequirementId(proposal.obligationId),
    kind: "accept_promise",
    obligationId: proposal.obligationId,
    ...proposal.acceptanceDecision,
  };
}

function modificationRequirement(
  change: ConstructibleModification,
): DecisionRequirement {
  return {
    requirementId: modificationRequirementId(
      change.obligation.obligationId,
      change.option.optionId,
    ),
    kind:
      change.obligation.status === "accepted"
        ? "modify_accepted_obligation"
        : "modify_proposal",
    obligationId: change.obligation.obligationId,
    ...change.option.decisionSemantics,
  };
}

function pendingRequirements(obligation: Obligation): DecisionRequirement[] {
  return obligation.pendingOwnerDecisions.map((decision) => ({
    requirementId: stableTupleId("requirement", [
      "consequential_effect",
      obligation.obligationId,
      decision.decisionId,
    ]),
    kind: "consequential_effect",
    obligationId: obligation.obligationId,
    objectiveId: decision.objectiveId,
    evidencePacketId: decision.evidencePacketId,
    approverId: decision.approverId,
    executionBoundaryId: decision.executionBoundaryId,
  }));
}

function paretoMinimalSuggestions(
  context: EvaluatorContext,
  plans: readonly SensitivityPlan[],
): readonly FeasibilityRestoringSuggestion[] {
  const suggestions = plans
    .filter((plan) =>
      plan.capacity.violations.every(
        (violation) => violation.kind === "resource_capacity",
      ),
    )
    .map(createSensitivitySuggestion)
    .sort((left, right) =>
      compareStableStrings(left.candidatePlanId, right.candidatePlanId),
    );
  return suggestions.filter(
    (candidate, candidateIndex) =>
      !suggestions.some(
        (other, otherIndex) =>
          candidateIndex !== otherIndex &&
          dominatesSuggestion(context, other, candidate),
      ),
  );
}

function createSensitivitySuggestion(
  plan: SensitivityPlan,
): FeasibilityRestoringSuggestion {
  return {
    candidatePlanId: plan.candidatePlanId,
    capacityExpansion: plan.capacity.capacityAfter
      .filter((entry) => entry.value < 0)
      .map((entry) => ({ resourceKey: entry.resourceKey, value: -entry.value })),
    boundedModifications: plan.affectedObligations,
    serviceDimensionChanges: plan.affectedObligations
      .flatMap((change) =>
        change.serviceDimensionLosses.map((dimension) => ({
          obligationId: change.obligationId,
          field: dimension.field,
          loss: dimension.loss,
        })),
      )
      .sort(compareServiceCoordinates),
    temporalConstraintChanges: [],
  };
}

function dominatesSuggestion(
  context: EvaluatorContext,
  left: FeasibilityRestoringSuggestion,
  right: FeasibilityRestoringSuggestion,
): boolean {
  let strictlyBetter = false;
  for (const resourceKey of context.resourceKeys) {
    const comparison = compareNumber(
      amountValue(left.capacityExpansion, resourceKey),
      amountValue(right.capacityExpansion, resourceKey),
    );
    if (comparison > 0) return false;
    if (comparison < 0) strictlyBetter = true;
  }

  const serviceKeys = [
    ...new Set([
      ...left.serviceDimensionChanges.map(serviceCoordinateKey),
      ...right.serviceDimensionChanges.map(serviceCoordinateKey),
    ]),
  ].sort(compareStableStrings);
  for (const key of serviceKeys) {
    const comparison = compareRational(
      serviceCoordinateValue(left, key),
      serviceCoordinateValue(right, key),
    );
    if (comparison > 0) return false;
    if (comparison < 0) strictlyBetter = true;
  }

  const temporalKeys = [
    ...new Set([
      ...left.temporalConstraintChanges.map(
        (change) => change.obligationId,
      ),
      ...right.temporalConstraintChanges.map(
        (change) => change.obligationId,
      ),
    ]),
  ].sort(compareStableStrings);
  for (const obligationId of temporalKeys) {
    const leftChange = left.temporalConstraintChanges.find(
      (change) => change.obligationId === obligationId,
    );
    const rightChange = right.temporalConstraintChanges.find(
      (change) => change.obligationId === obligationId,
    );
    if (
      leftChange !== undefined &&
      rightChange !== undefined &&
      leftChange.timeUnit !== rightChange.timeUnit
    ) {
      return false;
    }
    const comparison = compareNumber(
      leftChange?.extension ?? 0,
      rightChange?.extension ?? 0,
    );
    if (comparison > 0) return false;
    if (comparison < 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

function createPromiseBasis(
  context: EvaluatorContext,
  decision: PromiseBasis["decision"],
  directPlan: CapacityEvaluation,
  candidates: readonly ReplanCandidate[],
  selectedPlanIds: readonly string[],
  suggestions: readonly FeasibilityRestoringSuggestion[],
  uncalculable: readonly UncalculableFeasibilityChange[],
): PromiseBasis {
  return canonicalClone<PromiseBasis>({
    schemaVersion: "flakebrake-promise-basis/v0.1-m1",
    decision,
    versions: context.input.versions,
    calibrationFrontierDigest: context.calibration.digest,
    calibrationFrontierProvenance: context.calibration.provenance,
    calibratedDemands: context.calibration.snapshots,
    proposal: context.input.proposal,
    acceptedPortfolio: context.acceptedObligations,
    resources: context.resources,
    assumptions: context.input.assumptions,
    authorizationFacts: context.input.authorizationFacts,
    fixedCapacityReservations: context.reservations,
    combinedDecisionProofs: context.input.combinedDecisionProofs,
    expectedAcceptanceBasis:
      decision === "ADMITTABLE"
        ? expectedAcceptanceBasis(context)
        : "NOT_APPLICABLE",
    directPlan,
    candidatePlans: candidates,
    selectedPlanIds,
    feasibilityRestoringSuggestions: suggestions,
    uncalculableFeasibilityChanges: uncalculable,
  });
}

function expectedAcceptanceBasis(
  context: EvaluatorContext,
): ExpectedAdmissionBasis {
  return {
    expectedPortfolioVersion: context.input.versions.portfolioVersion,
    expectedCapacityModelVersion: context.input.versions.capacityModelVersion,
    expectedCapacityPlanVersion: context.input.versions.capacityPlanVersion,
    expectedAuthorizationStateVersion:
      context.input.versions.authorizationStateVersion,
    expectedCalibrationFrontierDigest: context.calibration.digest,
  };
}

function createAdmissionBasis(context: EvaluatorContext): AdmissionBasis {
  return {
    portfolioVersion: context.input.versions.portfolioVersion,
    capacityModelVersion: context.input.versions.capacityModelVersion,
    capacityPlanVersion: context.input.versions.capacityPlanVersion,
    authorizationStateVersion: context.input.versions.authorizationStateVersion,
    calibrationFrontierDigest: context.calibration.digest,
    calibrationFrontierProvenance: context.calibration.provenance,
    capacityConstraints: context.resources.map((resource) => ({
      resourceKey: resource.resourceKey,
      side: resource.side,
      capacityKind: resource.capacityKind,
      unit: resource.unit,
      timeUnit: resource.timeUnit,
      horizonStart: resource.horizonStart,
      horizonEnd: resource.horizonEnd,
      declaredCapacity: resource.capacity,
      safetyReserve: resource.safetyReserve,
      estimatorRule: resource.estimatorRule,
      assumptions: resource.assumptions,
    })),
    assumptions: context.input.assumptions,
    authorizationFacts: context.input.authorizationFacts,
    fixedCapacityReservations: context.reservations,
  };
}

function rankCandidateLayers(
  candidates: readonly ReplanCandidate[],
): readonly (readonly ReplanCandidate[])[] {
  return nondominatedFrontierLayers(
    candidates,
    compareReplanCandidates,
    (candidate) => candidate.candidatePlanId,
  );
}

function compareCostVectors(
  left: CostVector,
  right: CostVector,
): CandidateComparison {
  const leftComponents = left.components.filter(
    (component) => compareRational(component.amount, rational(0)) > 0,
  );
  const rightComponents = right.components.filter(
    (component) => compareRational(component.amount, rational(0)) > 0,
  );
  if (leftComponents.length === 0 && rightComponents.length === 0) {
    return "equivalent";
  }
  if (leftComponents.length === 0) return "left_preferred";
  if (rightComponents.length === 0) return "right_preferred";
  const leftBases = leftComponents.map((component) => component.basisKey);
  const rightBases = rightComponents.map((component) => component.basisKey);
  if (!exactStringSequencesEqual(leftBases, rightBases)) {
    return "incomparable";
  }
  let leftBetter = false;
  let rightBetter = false;
  for (const [index, leftComponent] of leftComponents.entries()) {
    const rightComponent = rightComponents[index];
    if (rightComponent === undefined) return "incomparable";
    const comparison = compareRational(
      leftComponent.amount,
      rightComponent.amount,
    );
    if (comparison < 0) leftBetter = true;
    if (comparison > 0) rightBetter = true;
  }
  if (leftBetter && rightBetter) return "incomparable";
  if (leftBetter) return "left_preferred";
  if (rightBetter) return "right_preferred";
  return "equivalent";
}

function costVector(costs: readonly (TypedCost | null)[]): CostVector {
  const totals = new Map<string, Rational>();
  for (const cost of costs) {
    if (cost === null) continue;
    totals.set(
      cost.basisKey,
      addRational(totals.get(cost.basisKey) ?? rational(0), cost.amount),
    );
  }
  return {
    components: [...totals.entries()]
      .filter(([, amount]) => compareRational(amount, rational(0)) > 0)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([basisKey, amount]) => ({ basisKey, amount })),
  };
}

function bindingOrLimiting(
  context: EvaluatorContext,
  capacityAfter: readonly ResourceAmount[],
): BindingOrLimitingResources {
  const violated = capacityAfter
    .filter((entry) => entry.value < 0)
    .map((entry) => entry.resourceKey);
  if (violated.length > 0) return { kind: "violated", resourceKeys: violated };
  const binding = capacityAfter
    .filter((entry) => entry.value === 0)
    .map((entry) => entry.resourceKey);
  if (binding.length > 0) return { kind: "binding", resourceKeys: binding };
  let minimum: Rational | undefined;
  const limiting: string[] = [];
  for (const entry of capacityAfter) {
    const resource = context.resourceByKey.get(entry.resourceKey);
    if (resource === undefined) throw new Error(`Missing resource ${entry.resourceKey}`);
    const normalized = rational(entry.value, Math.max(resource.capacity, 1));
    if (minimum === undefined || compareRational(normalized, minimum) < 0) {
      minimum = normalized;
      limiting.length = 0;
      limiting.push(entry.resourceKey);
    } else if (compareRational(normalized, minimum) === 0) {
      limiting.push(entry.resourceKey);
    }
  }
  return { kind: "limiting", resourceKeys: limiting };
}

function bottleneckSlack(
  context: EvaluatorContext,
  capacityAfter: readonly ResourceAmount[],
): Rational {
  let result: Rational | undefined;
  for (const entry of capacityAfter) {
    const resource = context.resourceByKey.get(entry.resourceKey);
    if (resource === undefined) throw new Error(`Missing resource ${entry.resourceKey}`);
    const normalized = rational(entry.value, Math.max(resource.capacity, 1));
    if (result === undefined || compareRational(normalized, result) < 0) {
      result = normalized;
    }
  }
  if (result === undefined) throw new Error("Cannot score a plan without resources");
  return result;
}

function finalCalibratedDemand(
  context: EvaluatorContext,
  obligation: Obligation,
  choice: ConstructibleModification | null,
): ResourceDemand {
  return choice?.calibratedDemand ??
    context.calibration.calibratedDemand(obligation, obligation.resourceDemand);
}

function selectedChanges(state: PlanState): ConstructibleModification[] {
  return [
    ...(state.proposalChoice === null ? [] : [state.proposalChoice]),
    ...state.acceptedChoices.filter(
      (choice): choice is ConstructibleModification => choice !== null,
    ),
  ];
}

function createObligationChange(
  context: EvaluatorContext,
  change: ConstructibleModification,
): ObligationChange {
  return {
    obligationId: change.obligation.obligationId,
    obligationStatus: change.obligation.status,
    optionId: change.option.optionId,
    previousServiceLevel: serviceValues(change.obligation.serviceLevel),
    proposedServiceLevel: serviceValues(change.proposedServiceLevel),
    previousResourceDemand: demandAmounts(
      context.calibration.calibratedDemand(
        change.obligation,
        change.obligation.resourceDemand,
      ),
      context.resourceKeys,
    ),
    proposedResourceDemand: demandAmounts(
      change.calibratedDemand,
      context.resourceKeys,
    ),
    serviceDimensionLosses: change.dimensionLosses,
    obligationServiceLoss: change.serviceLoss,
  };
}

function createRequiredApproval(
  change: ConstructibleModification,
): RequiredOwnerApproval {
  return {
    kind:
      change.obligation.status === "accepted"
        ? "modify_accepted_obligation"
        : "modify_proposal",
    obligationId: change.obligation.obligationId,
    optionId: change.option.optionId,
    requirementId: modificationRequirementId(
      change.obligation.obligationId,
      change.option.optionId,
    ),
    changes: Object.entries(change.option.changes)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([field, value]) => ({ field, value })),
  };
}

function uncalculableChanges(
  directPlan: CapacityEvaluation,
): readonly UncalculableFeasibilityChange[] {
  return directPlan.violations
    .filter(
      (constraint) => constraint.kind === "scheduling_constraint",
    )
    .map((constraint) => ({
      constraint,
      missingVariable: "bounded_scheduling_alternative" as const,
    }));
}

function normalizeInput(input: AdmissionEvaluationInput): AdmissionEvaluationInput {
  const cloned = canonicalClone<AdmissionEvaluationInput>(input);
  return {
    ...cloned,
    resources: [...cloned.resources].sort((left, right) =>
      compareStableStrings(left.resourceKey, right.resourceKey),
    ),
    acceptedObligations: [...cloned.acceptedObligations]
      .map(normalizeAcceptedObligation)
      .sort((left, right) =>
        compareStableStrings(left.obligationId, right.obligationId),
      ),
    proposal: normalizeProposedObligation(cloned.proposal),
    fixedCapacityReservations: [...cloned.fixedCapacityReservations]
      .map((reservation) => ({
        ...reservation,
        affectedObligationIds: [...reservation.affectedObligationIds].sort(
          compareStableStrings,
        ),
      }))
      .sort((left, right) =>
        compareStableStrings(left.reservationId, right.reservationId),
      ),
    combinedDecisionProofs: [...cloned.combinedDecisionProofs]
      .map((proof) => ({
        ...proof,
        coveredRequirementIds: [...proof.coveredRequirementIds].sort(
          compareStableStrings,
        ),
        alternatives: [...proof.alternatives]
          .map((bundle) => ({
            ...bundle,
            requirementIds: [...bundle.requirementIds].sort(
              compareStableStrings,
            ),
          }))
          .sort((left, right) =>
            compareStableStrings(left.bundleId, right.bundleId),
          ),
      }))
      .sort((left, right) => compareStableStrings(left.proofId, right.proofId)),
    calibration: {
      ...cloned.calibration,
      historyRecords: [...cloned.calibration.historyRecords].sort((left, right) =>
        compareStableStrings(left.recordId, right.recordId),
      ),
    },
    assumptions: normalizeProvenance(cloned.assumptions),
    authorizationFacts: normalizeProvenance(cloned.authorizationFacts),
  };
}

function normalizeAcceptedObligation(
  obligation: AcceptedObligation,
): AcceptedObligation {
  return normalizeObligation(obligation) as AcceptedObligation;
}

function normalizeProposedObligation(
  obligation: ProposedObligation,
): ProposedObligation {
  return normalizeObligation(obligation) as ProposedObligation;
}

function normalizeObligation(obligation: Obligation): Obligation {
  return {
    ...obligation,
    modificationOptions: [...obligation.modificationOptions]
      .map((option) => ({
        ...option,
        reservationCompatibilityProofs: [
          ...option.reservationCompatibilityProofs,
        ].sort((left, right) =>
          compareStableStrings(left.reservationId, right.reservationId),
        ),
        assumptions: normalizeProvenance(option.assumptions),
      }))
      .sort((left, right) => compareStableStrings(left.optionId, right.optionId)),
    pendingOwnerDecisions: [...obligation.pendingOwnerDecisions].sort(
      (left, right) => compareStableStrings(left.decisionId, right.decisionId),
    ),
    assumptions: normalizeProvenance(obligation.assumptions),
    evidenceRefs: [...obligation.evidenceRefs].sort(compareStableStrings),
    requiredEffects: [...obligation.requiredEffects].sort(compareStableStrings),
  };
}

function normalizeProvenance(
  provenance: readonly ProvenanceEntry[],
): readonly ProvenanceEntry[] {
  return [...provenance]
    .map((entry) => canonicalClone<ProvenanceEntry>(entry))
    .sort((left, right) => {
      const keyComparison = compareStableStrings(left.key, right.key);
      if (keyComparison !== 0) return keyComparison;
      const sourceComparison = compareStableStrings(left.source, right.source);
      return sourceComparison !== 0
        ? sourceComparison
        : compareStableStrings(
            canonicalSerialize(left.value),
            canonicalSerialize(right.value),
          );
    });
}

function finalizeResult(result: AdmissionResult): AdmissionResult {
  return deepFreeze(canonicalClone<AdmissionResult>(result));
}

function validateAdmissionInput(value: unknown): AdmissionEvaluationInput {
  const root = objectValue(value, "input");
  requireExactKeys(
    root,
    [
      "versions",
      "calibration",
      "resources",
      "acceptedObligations",
      "proposal",
      "fixedCapacityReservations",
      "combinedDecisionProofs",
      "authorizationFacts",
      "assumptions",
    ],
    "input",
  );
  validateVersions(root["versions"]);
  const resourcesRaw = arrayValue(root["resources"], "resources");
  if (resourcesRaw.length === 0) {
    throw new AdmissionInputError("resources", "at least one resource is required");
  }
  resourcesRaw.forEach((resource, index) =>
    validateResource(resource, `resources.${index}`),
  );
  const resources = resourcesRaw as unknown as CapacityResource[];
  assertUnique(
    resources.map((resource) => resource.resourceKey),
    "resources.resourceKey",
  );
  const resourceKeys = resources
    .map((resource) => resource.resourceKey)
    .sort(compareStableStrings);
  const resourceByKey = new Map(
    resources.map((resource) => [resource.resourceKey, resource]),
  );
  const meaningfulResources = resources.filter(
    (resource) => resource.capacityKind === "meaningful_decisions",
  );
  if (
    meaningfulResources.length !== 1 ||
    meaningfulResources[0]?.resourceKey !== HUMAN_REVIEW_RESOURCE_KEY ||
    meaningfulResources[0].side !== "human" ||
    meaningfulResources[0].unit !== "meaningful_decisions" ||
    meaningfulResources[0].timeUnit !== null
  ) {
    throw new AdmissionInputError(
      "resources",
      `must declare exactly one human meaningful-decisions resource named ${HUMAN_REVIEW_RESOURCE_KEY}`,
    );
  }
  const agentResource = resourceByKey.get(AGENT_WORK_RESOURCE_KEY);
  if (
    agentResource === undefined ||
    agentResource.side !== "agent" ||
    agentResource.capacityKind !== "generic" ||
    agentResource.unit !== "work_units" ||
    agentResource.timeUnit !== null
  ) {
    throw new AdmissionInputError(
      "resources",
      `must declare one agent generic work-unit resource named ${AGENT_WORK_RESOURCE_KEY}`,
    );
  }

  const reservationsRaw = arrayValue(
    root["fixedCapacityReservations"],
    "fixedCapacityReservations",
  );
  reservationsRaw.forEach((reservation, index) =>
    validateReservation(
      reservation,
      resourceKeys,
      resourceByKey,
      `fixedCapacityReservations.${index}`,
    ),
  );
  const reservations = reservationsRaw as unknown as FixedCapacityReservation[];
  assertUnique(
    reservations.map((reservation) => reservation.reservationId),
    "fixedCapacityReservations.reservationId",
  );
  assertUnique(
    reservations.map((reservation) => reservation.executionAttemptId),
    "fixedCapacityReservations.executionAttemptId",
  );

  const acceptedRaw = arrayValue(
    root["acceptedObligations"],
    "acceptedObligations",
  );
  acceptedRaw.forEach((obligation, index) =>
    validateObligation(
      obligation,
      "accepted",
      resourceKeys,
      resourceByKey,
      reservations,
      `acceptedObligations.${index}`,
    ),
  );
  validateObligation(
    root["proposal"],
    "proposed",
    resourceKeys,
    resourceByKey,
    reservations,
    "proposal",
  );
  const accepted = acceptedRaw as unknown as AcceptedObligation[];
  const proposal = root["proposal"] as ProposedObligation;
  const obligationIds = [...accepted.map((item) => item.obligationId), proposal.obligationId];
  const acceptedIds = accepted.map((item) => item.obligationId);
  assertUnique(obligationIds, "obligations.obligationId");
  for (const reservation of reservations) {
    for (const obligationId of reservation.affectedObligationIds) {
      if (!acceptedIds.includes(obligationId)) {
        throw new AdmissionInputError(
          `fixedCapacityReservations.${reservation.reservationId}.affectedObligationIds`,
          `must reference an accepted obligation; found ${obligationId}`,
        );
      }
    }
  }
  validateAggregateReservationAccounting(accepted, reservations, resourceKeys);

  validateCalibration(root["calibration"], resourceKeys);
  validateProvenanceInput(root["assumptions"], "assumptions");
  validateProvenanceInput(root["authorizationFacts"], "authorizationFacts");
  const proofsRaw = arrayValue(
    root["combinedDecisionProofs"],
    "combinedDecisionProofs",
  );
  proofsRaw.forEach((proof, index) =>
    validateCombinedDecisionProof(proof, `combinedDecisionProofs.${index}`),
  );
  const proofs = proofsRaw as unknown as CombinedDecisionProof[];
  assertUnique(
    proofs.map((proof) => proof.proofId),
    "combinedDecisionProofs.proofId",
  );
  validateDecisionProofSemantics(accepted, proposal, proofs);
  return value as AdmissionEvaluationInput;
}

function validateVersions(value: unknown): void {
  const versions = objectValue(value, "versions");
  const keys = [
    "portfolioVersion",
    "capacityModelVersion",
    "capacityPlanVersion",
    "authorizationStateVersion",
  ] as const;
  requireExactKeys(versions, keys, "versions");
  for (const key of keys) assertNonEmptyString(versions[key], `versions.${key}`);
}

function validateResource(value: unknown, path: string): void {
  const resource = objectValue(value, path);
  requireExactKeys(
    resource,
    [
      "resourceKey",
      "side",
      "capacityKind",
      "unit",
      "timeUnit",
      "horizonStart",
      "horizonEnd",
      "capacity",
      "safetyReserve",
      "estimatorRule",
      "assumptions",
    ],
    path,
  );
  assertNonEmptyString(resource["resourceKey"], `${path}.resourceKey`);
  assertOneOf(resource["side"], ["human", "agent", "operational"], `${path}.side`);
  assertOneOf(
    resource["capacityKind"],
    ["generic", "meaningful_decisions"],
    `${path}.capacityKind`,
  );
  assertNonEmptyString(resource["unit"], `${path}.unit`);
  if (resource["timeUnit"] !== null) {
    assertOneOf(resource["timeUnit"], ["minutes", "hours"], `${path}.timeUnit`);
  }
  if (
    resource["capacityKind"] === "meaningful_decisions" &&
    resource["timeUnit"] !== null
  ) {
    throw new AdmissionInputError(
      `${path}.timeUnit`,
      "meaningful decisions are not a temporal duration basis",
    );
  }
  validateIsoTimestamp(resource["horizonStart"], `${path}.horizonStart`);
  validateIsoTimestamp(resource["horizonEnd"], `${path}.horizonEnd`);
  assertIncreasingWindow(
    resource["horizonStart"] as string,
    resource["horizonEnd"] as string,
    `${path}.horizon`,
  );
  assertNonNegativeSafeInteger(resource["capacity"], `${path}.capacity`);
  assertNonNegativeSafeInteger(
    resource["safetyReserve"],
    `${path}.safetyReserve`,
  );
  assertNonEmptyString(resource["estimatorRule"], `${path}.estimatorRule`);
  validateProvenanceInput(resource["assumptions"], `${path}.assumptions`);
}

function validateObligation(
  value: unknown,
  expectedStatus: "accepted" | "proposed",
  resourceKeys: readonly string[],
  resourceByKey: ReadonlyMap<string, CapacityResource>,
  reservations: readonly FixedCapacityReservation[],
  path: string,
): void {
  const obligation = objectValue(value, path);
  const commonKeys = [
    "obligationId",
    "beneficiary",
    "objective",
    "serviceLevel",
    "protected",
    "criticality",
    "minimumService",
    "modificationPolicy",
    "modificationOptions",
    "resourceDemand",
    "workClassByResource",
    "schedulingConstraint",
    "pendingOwnerDecisions",
    "assumptions",
    "evidenceRefs",
    "requiredEffects",
    "status",
  ];
  requireExactKeys(
    obligation,
    expectedStatus === "proposed"
      ? [...commonKeys, "acceptanceDecision"]
      : commonKeys,
    path,
  );
  if (obligation["status"] !== expectedStatus) {
    throw new AdmissionInputError(`${path}.status`, `must be ${expectedStatus}`);
  }
  assertNonEmptyString(obligation["obligationId"], `${path}.obligationId`);
  assertNonEmptyString(obligation["beneficiary"], `${path}.beneficiary`);
  assertNonEmptyString(obligation["objective"], `${path}.objective`);
  if (typeof obligation["protected"] !== "boolean") {
    throw new AdmissionInputError(`${path}.protected`, "must be boolean");
  }
  assertOneOf(
    obligation["criticality"],
    ["protected", "important", "best_effort"],
    `${path}.criticality`,
  );
  if (
    obligation["protected"] !== (obligation["criticality"] === "protected")
  ) {
    throw new AdmissionInputError(
      `${path}.protected`,
      "must agree with protected criticality",
    );
  }

  const service = numericRecord(obligation["serviceLevel"], `${path}.serviceLevel`);
  const floor = numericRecord(obligation["minimumService"], `${path}.minimumService`);
  const serviceKeys = Object.keys(service).sort(compareStableStrings);
  if (serviceKeys.length === 0) {
    throw new AdmissionInputError(`${path}.serviceLevel`, "cannot be empty");
  }
  if (
    !exactStringSequencesEqual(
      serviceKeys,
      sortedStrings(Object.keys(floor)),
    )
  ) {
    throw new AdmissionInputError(
      `${path}.minimumService`,
      "must contain exactly the service fields",
    );
  }
  for (const key of serviceKeys) {
    if ((floor[key] as number) > (service[key] as number)) {
      throw new AdmissionInputError(
        `${path}.minimumService.${key}`,
        "cannot exceed current service",
      );
    }
  }
  validateDemand(obligation["resourceDemand"], resourceKeys, `${path}.resourceDemand`);
  validateStringRecord(
    obligation["workClassByResource"],
    resourceKeys,
    `${path}.workClassByResource`,
  );
  validateSchedulingConstraint(
    obligation["schedulingConstraint"],
    resourceByKey,
    path,
  );
  validateModificationPolicy(
    obligation["modificationPolicy"],
    service,
    floor,
    path,
  );
  const optionsRaw = arrayValue(
    obligation["modificationOptions"],
    `${path}.modificationOptions`,
  );
  optionsRaw.forEach((option, index) =>
    validateModificationOptionInput(
      option,
      resourceKeys,
      reservations,
      `${path}.modificationOptions.${index}`,
    ),
  );
  assertUnique(
    (optionsRaw as unknown as ModificationOption[]).map((option) => option.optionId),
    `${path}.modificationOptions.optionId`,
  );
  const pendingRaw = arrayValue(
    obligation["pendingOwnerDecisions"],
    `${path}.pendingOwnerDecisions`,
  );
  pendingRaw.forEach((decision, index) =>
    validatePendingDecision(decision, `${path}.pendingOwnerDecisions.${index}`),
  );
  assertUnique(
    (pendingRaw as unknown as { decisionId: string }[]).map(
      (decision) => decision.decisionId,
    ),
    `${path}.pendingOwnerDecisions.decisionId`,
  );
  validateProvenanceInput(obligation["assumptions"], `${path}.assumptions`);
  validateStringArray(obligation["evidenceRefs"], `${path}.evidenceRefs`);
  validateStringArray(obligation["requiredEffects"], `${path}.requiredEffects`);
  if (expectedStatus === "proposed") {
    validateDecisionSemantics(
      obligation["acceptanceDecision"],
      `${path}.acceptanceDecision`,
    );
  }
}

function validateModificationPolicy(
  value: unknown,
  service: Readonly<Record<string, number>>,
  floor: Readonly<Record<string, number>>,
  path: string,
): void {
  const policy = objectValue(value, `${path}.modificationPolicy`);
  requireExactKeys(policy, ["modifiableFields"], `${path}.modificationPolicy`);
  const fields = objectValue(
    policy["modifiableFields"],
    `${path}.modificationPolicy.modifiableFields`,
  );
  let weightSum = rational(0);
  for (const field of Object.keys(fields).sort(compareStableStrings)) {
    if (!Object.hasOwn(service, field)) {
      throw new AdmissionInputError(
        `${path}.modificationPolicy.modifiableFields.${field}`,
        "unknown service field",
      );
    }
    const fieldPolicy = objectValue(
      fields[field],
      `${path}.modificationPolicy.modifiableFields.${field}`,
    );
    requireExactKeys(
      fieldPolicy,
      ["allowedBounds", "utilityRule", "dimensionWeight"],
      `${path}.modificationPolicy.modifiableFields.${field}`,
    );
    const bounds = objectValue(
      fieldPolicy["allowedBounds"],
      `${path}.modificationPolicy.modifiableFields.${field}.allowedBounds`,
    );
    requireExactKeys(bounds, ["minimum", "maximum"], `${path}.bounds`);
    assertSafeInteger(bounds["minimum"], `${path}.bounds.minimum`);
    assertSafeInteger(bounds["maximum"], `${path}.bounds.maximum`);
    if ((bounds["minimum"] as number) > (bounds["maximum"] as number)) {
      throw new AdmissionInputError(`${path}.bounds`, "minimum exceeds maximum");
    }
    const utility = objectValue(fieldPolicy["utilityRule"], `${path}.utilityRule`);
    requireExactKeys(utility, ["ruleId", "kind", "slope", "intercept"], `${path}.utilityRule`);
    assertNonEmptyString(utility["ruleId"], `${path}.utilityRule.ruleId`);
    if (utility["kind"] !== "linear") {
      throw new AdmissionInputError(`${path}.utilityRule.kind`, "must be linear");
    }
    validateCanonicalRational(utility["slope"], `${path}.utilityRule.slope`);
    validateCanonicalRational(utility["intercept"], `${path}.utilityRule.intercept`);
    validateCanonicalRational(fieldPolicy["dimensionWeight"], `${path}.dimensionWeight`);
    const slope = utility["slope"] as Rational;
    const weight = fieldPolicy["dimensionWeight"] as Rational;
    if (compareRational(slope, rational(0)) <= 0) {
      throw new AdmissionInputError(`${path}.utilityRule.slope`, "must be positive");
    }
    if (compareRational(weight, rational(0)) < 0) {
      throw new AdmissionInputError(`${path}.dimensionWeight`, "cannot be negative");
    }
    weightSum = addRational(weightSum, weight);
    if ((service[field] as number) <= (floor[field] as number)) {
      throw new AdmissionInputError(
        `${path}.modificationPolicy.modifiableFields.${field}`,
        "utility denominator must be positive",
      );
    }
  }
  if (Object.keys(fields).length > 0 && compareRational(weightSum, rational(0)) <= 0) {
    throw new AdmissionInputError(`${path}.modificationPolicy`, "weight sum must be positive");
  }
}

function validateModificationOptionInput(
  value: unknown,
  resourceKeys: readonly string[],
  reservations: readonly FixedCapacityReservation[],
  path: string,
): void {
  const option = objectValue(value, path);
  requireExactKeys(
    option,
    [
      "optionId",
      "changes",
      "resourceDemand",
      "addedCapacityCost",
      "decisionSemantics",
      "reservationCompatibilityProofs",
      "assumptions",
    ],
    path,
  );
  assertNonEmptyString(option["optionId"], `${path}.optionId`);
  numericRecord(option["changes"], `${path}.changes`);
  validateDemand(option["resourceDemand"], resourceKeys, `${path}.resourceDemand`);
  if (option["addedCapacityCost"] !== null) {
    validateTypedCost(option["addedCapacityCost"], `${path}.addedCapacityCost`);
  }
  validateDecisionSemantics(option["decisionSemantics"], `${path}.decisionSemantics`);
  const proofs = arrayValue(
    option["reservationCompatibilityProofs"],
    `${path}.reservationCompatibilityProofs`,
  );
  proofs.forEach((proofValue, index) => {
    const proof = objectValue(proofValue, `${path}.reservationCompatibilityProofs.${index}`);
    requireExactKeys(proof, ["reservationId", "reservationDigest"], `${path}.proof`);
    assertNonEmptyString(proof["reservationId"], `${path}.proof.reservationId`);
    assertSha256Digest(proof["reservationDigest"], `${path}.proof.reservationDigest`);
    if (
      !reservations.some(
        (reservation) => reservation.reservationId === proof["reservationId"],
      )
    ) {
      throw new AdmissionInputError(
        `${path}.proof.reservationId`,
        "references unknown reservation",
      );
    }
  });
  assertUnique(
    (proofs as unknown as ReservationCompatibilityProofLike[]).map(
      (proof) => proof.reservationId,
    ),
    `${path}.reservationCompatibilityProofs.reservationId`,
  );
  validateProvenanceInput(option["assumptions"], `${path}.assumptions`);
}

interface ReservationCompatibilityProofLike {
  readonly reservationId: string;
}

function validateSchedulingConstraint(
  value: unknown,
  resourceByKey: ReadonlyMap<string, CapacityResource>,
  obligationPath: string,
): void {
  const path = `${obligationPath}.schedulingConstraint`;
  const constraint = objectValue(value, path);
  requireExactKeys(
    constraint,
    ["kind", "start", "end", "resourceKey", "timeUnit"],
    path,
  );
  assertOneOf(constraint["kind"], ["deadline", "horizon"], `${path}.kind`);
  validateIsoTimestamp(constraint["start"], `${path}.start`);
  validateIsoTimestamp(constraint["end"], `${path}.end`);
  assertIncreasingWindow(
    constraint["start"] as string,
    constraint["end"] as string,
    path,
  );
  assertNonEmptyString(constraint["resourceKey"], `${path}.resourceKey`);
  assertOneOf(constraint["timeUnit"], ["minutes", "hours"], `${path}.timeUnit`);
  const resource = resourceByKey.get(constraint["resourceKey"] as string);
  if (resource === undefined || resource.timeUnit !== constraint["timeUnit"]) {
    throw new AdmissionInputError(
      path,
      "must reference a declared resource with the same explicit time unit",
    );
  }
  if (
    Date.parse(constraint["start"] as string) < Date.parse(resource.horizonStart) ||
    Date.parse(constraint["end"] as string) > Date.parse(resource.horizonEnd)
  ) {
    throw new AdmissionInputError(path, "must be inside the resource horizon");
  }
  windowDurationInUnit(
    constraint["start"] as string,
    constraint["end"] as string,
    constraint["timeUnit"] as TimeUnit,
  );
}

function validateReservation(
  value: unknown,
  resourceKeys: readonly string[],
  resourceByKey: ReadonlyMap<string, CapacityResource>,
  path: string,
): void {
  const reservation = objectValue(value, path);
  requireExactKeys(
    reservation,
    [
      "reservationId",
      "executionAttemptId",
      "authorizationIdentity",
      "lockedOperationId",
      "affectedObligationIds",
      "resourceClaims",
      "temporalClaim",
      "expectedPostcondition",
      "claimAccounting",
    ],
    path,
  );
  for (const key of [
    "reservationId",
    "executionAttemptId",
    "authorizationIdentity",
    "lockedOperationId",
  ]) {
    assertNonEmptyString(reservation[key], `${path}.${key}`);
  }
  validateStringArray(reservation["affectedObligationIds"], `${path}.affectedObligationIds`);
  if ((reservation["affectedObligationIds"] as readonly string[]).length === 0) {
    throw new AdmissionInputError(
      `${path}.affectedObligationIds`,
      "must identify at least one locked obligation",
    );
  }
  validateDemand(reservation["resourceClaims"], resourceKeys, `${path}.resourceClaims`);
  assertOneOf(
    reservation["claimAccounting"],
    ["additional", "already_in_portfolio"],
    `${path}.claimAccounting`,
  );
  validateCanonicalJson(reservation["expectedPostcondition"], `${path}.expectedPostcondition`);
  if (reservation["temporalClaim"] !== null) {
    const temporal = objectValue(reservation["temporalClaim"], `${path}.temporalClaim`);
    requireExactKeys(
      temporal,
      ["resourceKey", "start", "end", "requiredDuration", "timeUnit"],
      `${path}.temporalClaim`,
    );
    assertNonEmptyString(temporal["resourceKey"], `${path}.temporalClaim.resourceKey`);
    assertOneOf(temporal["timeUnit"], ["minutes", "hours"], `${path}.temporalClaim.timeUnit`);
    validateIsoTimestamp(temporal["start"], `${path}.temporalClaim.start`);
    validateIsoTimestamp(temporal["end"], `${path}.temporalClaim.end`);
    assertNonNegativeSafeInteger(
      temporal["requiredDuration"],
      `${path}.temporalClaim.requiredDuration`,
    );
    const resource = resourceByKey.get(temporal["resourceKey"] as string);
    if (resource === undefined || resource.timeUnit !== temporal["timeUnit"]) {
      throw new AdmissionInputError(
        `${path}.temporalClaim`,
        "must reference a compatible time resource",
      );
    }
    const window = windowDurationInUnit(
      temporal["start"] as string,
      temporal["end"] as string,
      temporal["timeUnit"] as TimeUnit,
    );
    if ((temporal["requiredDuration"] as number) > window) {
      throw new AdmissionInputError(`${path}.temporalClaim`, "duration exceeds fixed window");
    }
    if (
      Date.parse(temporal["start"] as string) < Date.parse(resource.horizonStart) ||
      Date.parse(temporal["end"] as string) > Date.parse(resource.horizonEnd)
    ) {
      throw new AdmissionInputError(
        `${path}.temporalClaim`,
        "must be inside the resource horizon",
      );
    }
    const resourceClaims = reservation["resourceClaims"] as ResourceDemand;
    if (
      resourceClaims[resource.resourceKey] !== temporal["requiredDuration"]
    ) {
      throw new AdmissionInputError(
        `${path}.temporalClaim.requiredDuration`,
        "must equal the fixed claim for its schedulable resource",
      );
    }
  }

  const scheduledClaims = [...resourceByKey.values()].filter(
    (resource) =>
      resource.timeUnit !== null &&
      ((reservation["resourceClaims"] as ResourceDemand)[resource.resourceKey] ?? 0) > 0,
  );
  if (scheduledClaims.length > 1) {
    throw new AdmissionInputError(
      `${path}.resourceClaims`,
      "M1 reservations support at most one nonzero schedulable resource claim",
    );
  }
  if (
    scheduledClaims.length === 1 &&
    (reservation["temporalClaim"] === null ||
      (reservation["temporalClaim"] as { readonly resourceKey: string }).resourceKey !==
        scheduledClaims[0]?.resourceKey)
  ) {
    throw new AdmissionInputError(
      `${path}.temporalClaim`,
      "is required for the nonzero schedulable resource claim",
    );
  }
}

function validateCalibration(value: unknown, resourceKeys: readonly string[]): void {
  const calibration = objectValue(value, "calibration");
  requireExactKeys(
    calibration,
    ["ruleId", "historyRecords", "expectedFrontierDigest"],
    "calibration",
  );
  if (calibration["ruleId"] !== "conservative-max/v1") {
    throw new AdmissionInputError("calibration.ruleId", "unsupported calibration rule");
  }
  if (calibration["expectedFrontierDigest"] !== null) {
    assertSha256Digest(
      calibration["expectedFrontierDigest"],
      "calibration.expectedFrontierDigest",
    );
  }
  const records = arrayValue(calibration["historyRecords"], "calibration.historyRecords");
  records.forEach((valueRecord, index) => {
    const path = `calibration.historyRecords.${index}`;
    const record = objectValue(valueRecord, path);
    requireExactKeys(
      record,
      [
        "recordId",
        "completedAt",
        "resourceKey",
        "workClassKey",
        "actualConsumption",
        "actualConsumptionAddendumId",
        "outcome",
        "outcomeAddendumId",
      ],
      path,
    );
    assertNonEmptyString(record["recordId"], `${path}.recordId`);
    validateIsoTimestamp(record["completedAt"], `${path}.completedAt`);
    assertNonEmptyString(record["resourceKey"], `${path}.resourceKey`);
    if (!resourceKeys.includes(record["resourceKey"] as string)) {
      throw new AdmissionInputError(`${path}.resourceKey`, "unknown resource");
    }
    assertNonEmptyString(record["workClassKey"], `${path}.workClassKey`);
    assertNonNegativeSafeInteger(record["actualConsumption"], `${path}.actualConsumption`);
    assertNonEmptyString(
      record["actualConsumptionAddendumId"],
      `${path}.actualConsumptionAddendumId`,
    );
    if (record["outcome"] !== "completed") {
      throw new AdmissionInputError(`${path}.outcome`, "must be completed");
    }
    assertNonEmptyString(record["outcomeAddendumId"], `${path}.outcomeAddendumId`);
  });
  assertUnique(
    (records as unknown as { recordId: string }[]).map((record) => record.recordId),
    "calibration.historyRecords.recordId",
  );
}

function validateCombinedDecisionProof(value: unknown, path: string): void {
  const proof = objectValue(value, path);
  requireExactKeys(
    proof,
    [
      "proofId",
      "decisionId",
      "selectorId",
      "selectedBundleId",
      "coveredRequirementIds",
      "alternatives",
      "allOrNoneEnforced",
      "objectiveId",
      "evidencePacketId",
      "approverId",
      "executionBoundaryId",
    ],
    path,
  );
  for (const key of ["proofId", "decisionId", "selectorId", "selectedBundleId"]) {
    assertNonEmptyString(proof[key], `${path}.${key}`);
  }
  validateDecisionSemantics(proof, path);
  if (proof["allOrNoneEnforced"] !== true) {
    throw new AdmissionInputError(`${path}.allOrNoneEnforced`, "must be true");
  }
  validateStringArray(proof["coveredRequirementIds"], `${path}.coveredRequirementIds`);
  const covered = proof["coveredRequirementIds"] as string[];
  if (covered.length === 0) {
    throw new AdmissionInputError(`${path}.coveredRequirementIds`, "cannot be empty");
  }
  const alternatives = arrayValue(proof["alternatives"], `${path}.alternatives`);
  if (alternatives.length < 2) {
    throw new AdmissionInputError(`${path}.alternatives`, "requires at least two alternatives");
  }
  alternatives.forEach((alternativeValue, index) => {
    const alternativePath = `${path}.alternatives.${index}`;
    const alternative = objectValue(alternativeValue, alternativePath);
    requireExactKeys(
      alternative,
      ["bundleId", "selectorValue", "requirementIds", "fullySpecified"],
      alternativePath,
    );
    assertNonEmptyString(alternative["bundleId"], `${alternativePath}.bundleId`);
    validateJsonPrimitive(alternative["selectorValue"], `${alternativePath}.selectorValue`);
    validateStringArray(alternative["requirementIds"], `${alternativePath}.requirementIds`);
    if (alternative["fullySpecified"] !== true) {
      throw new AdmissionInputError(`${alternativePath}.fullySpecified`, "must be true");
    }
  });
  const bundles = alternatives as unknown as {
    bundleId: string;
    selectorValue: JsonPrimitive;
    requirementIds: string[];
  }[];
  assertUnique(bundles.map((bundle) => bundle.bundleId), `${path}.alternatives.bundleId`);
  assertUnique(
    bundles.map((bundle) => canonicalSerialize(bundle.selectorValue)),
    `${path}.alternatives.selectorValue`,
  );
  const selected = bundles.find(
    (bundle) => bundle.bundleId === proof["selectedBundleId"],
  );
  if (
    selected === undefined ||
    !exactStringSequencesEqual(
      sortedStrings(selected.requirementIds),
      sortedStrings(covered),
    )
  ) {
    throw new AdmissionInputError(
      `${path}.selectedBundleId`,
      "selected bundle must fully specify exactly the covered requirements",
    );
  }
}

function validateDecisionProofSemantics(
  accepted: readonly AcceptedObligation[],
  proposal: ProposedObligation,
  proofs: readonly CombinedDecisionProof[],
): void {
  const requirements = [
    ...accepted.flatMap(pendingRequirements),
    ...pendingRequirements(proposal),
    acceptanceRequirement(proposal),
    ...[...accepted, proposal].flatMap((obligation) =>
      obligation.modificationOptions.map((option) => ({
        requirementId: modificationRequirementId(
          obligation.obligationId,
          option.optionId,
        ),
        kind:
          obligation.status === "accepted"
            ? ("modify_accepted_obligation" as const)
            : ("modify_proposal" as const),
        obligationId: obligation.obligationId,
        ...option.decisionSemantics,
      })),
    ),
  ];
  assertUnique(
    requirements.map((requirement) => requirement.requirementId),
    "decisionRequirements.requirementId",
  );
  const byId = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  const claimed = new Set<string>();
  for (const proof of proofs) {
    const referencedRequirementIds = [
      ...new Set(
        proof.alternatives.flatMap((alternative) => alternative.requirementIds),
      ),
    ].sort(compareStableStrings);
    for (const requirementId of referencedRequirementIds) {
      const requirement = byId.get(requirementId);
      if (requirement === undefined) {
        throw new AdmissionInputError(
          `combinedDecisionProofs.${proof.proofId}.alternatives`,
          `unknown requirement ${requirementId}`,
        );
      }
      for (const key of [
        "objectiveId",
        "evidencePacketId",
        "approverId",
        "executionBoundaryId",
      ] as const) {
        if (requirement[key] !== proof[key]) {
          throw new AdmissionInputError(
            `combinedDecisionProofs.${proof.proofId}.${key}`,
            `does not match requirement ${requirementId}`,
          );
        }
      }
    }
    for (const requirementId of proof.coveredRequirementIds) {
      if (claimed.has(requirementId)) {
        throw new AdmissionInputError(
          `combinedDecisionProofs.${proof.proofId}`,
          `requirement ${requirementId} is covered by multiple proofs`,
        );
      }
      claimed.add(requirementId);
    }
  }
}

function validateRankableCandidate(
  value: unknown,
  path: string,
): asserts value is RankableReplanCandidate {
  const candidate = objectValue(value, path);
  assertNonEmptyString(candidate["candidatePlanId"], `${path}.candidatePlanId`);
  const score = objectValue(candidate["score"], `${path}.score`);
  requireFields(
    score,
    [
      "protectedObligationViolations",
      "criticalityWeightedServiceDegradation",
      "previouslyAcceptedObligationsChanged",
      "addedCapacityCost",
      "bottleneckSlack",
    ],
    `${path}.score`,
  );
  assertNonNegativeSafeInteger(
    score["protectedObligationViolations"],
    `${path}.score.protectedObligationViolations`,
  );
  validateCanonicalRational(
    score["criticalityWeightedServiceDegradation"],
    `${path}.score.criticalityWeightedServiceDegradation`,
  );
  assertNonNegativeSafeInteger(
    score["previouslyAcceptedObligationsChanged"],
    `${path}.score.previouslyAcceptedObligationsChanged`,
  );
  validateCostVector(score["addedCapacityCost"], `${path}.score.addedCapacityCost`);
  validateCanonicalRational(score["bottleneckSlack"], `${path}.score.bottleneckSlack`);
}

function validateCostVector(value: unknown, path: string): void {
  const vector = objectValue(value, path);
  requireExactKeys(vector, ["components"], path);
  const components = arrayValue(vector["components"], `${path}.components`);
  components.forEach((component, index) =>
    validateTypedCost(component, `${path}.components.${index}`),
  );
  const bases = (components as unknown as TypedCost[]).map((item) => item.basisKey);
  assertUnique(bases, `${path}.components.basisKey`);
  if (!exactStringSequencesEqual(bases, sortedStrings(bases))) {
    throw new AdmissionInputError(
      `${path}.components`,
      "must be in stable basis-key order",
    );
  }
}

function validateTypedCost(value: unknown, path: string): void {
  const cost = objectValue(value, path);
  requireExactKeys(cost, ["basisKey", "amount"], path);
  assertNonEmptyString(cost["basisKey"], `${path}.basisKey`);
  validateCanonicalRational(cost["amount"], `${path}.amount`);
  if (compareRational(cost["amount"] as Rational, rational(0)) < 0) {
    throw new AdmissionInputError(`${path}.amount`, "cannot be negative");
  }
}

function validateDecisionSemantics(value: unknown, path: string): void {
  const decision = objectValue(value, path);
  for (const key of [
    "objectiveId",
    "evidencePacketId",
    "approverId",
    "executionBoundaryId",
  ]) {
    if (!Object.hasOwn(decision, key)) {
      throw new AdmissionInputError(`${path}.${key}`, "required field is missing");
    }
    assertNonEmptyString(decision[key], `${path}.${key}`);
  }
}

function validatePendingDecision(value: unknown, path: string): void {
  const decision = objectValue(value, path);
  requireExactKeys(
    decision,
    [
      "decisionId",
      "kind",
      "objectiveId",
      "evidencePacketId",
      "approverId",
      "executionBoundaryId",
    ],
    path,
  );
  assertNonEmptyString(decision["decisionId"], `${path}.decisionId`);
  if (decision["kind"] !== "consequential_effect") {
    throw new AdmissionInputError(`${path}.kind`, "must be consequential_effect");
  }
  validateDecisionSemantics(decision, path);
}

function validateProvenanceInput(value: unknown, path: string): void {
  const entries = arrayValue(value, path);
  entries.forEach((entryValue, index) => {
    const entryPath = `${path}.${index}`;
    const entry = objectValue(entryValue, entryPath);
    requireExactKeys(entry, ["key", "source", "value"], entryPath);
    assertNonEmptyString(entry["key"], `${entryPath}.key`);
    assertNonEmptyString(entry["source"], `${entryPath}.source`);
    validateCanonicalJson(entry["value"], `${entryPath}.value`);
  });
}

function validateCanonicalJson(value: unknown, path: string): void {
  try {
    canonicalSerialize(value);
  } catch (error: unknown) {
    throw new AdmissionInputError(
      path,
      error instanceof Error ? error.message : "invalid canonical JSON",
    );
  }
}

function validateJsonPrimitive(value: unknown, path: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new AdmissionInputError(path, "must be a JSON primitive");
  }
}

function validateDemand(
  value: unknown,
  resourceKeys: readonly string[],
  path: string,
): void {
  const demand = numericRecord(value, path);
  const keys = Object.keys(demand).sort(compareStableStrings);
  if (!exactStringSequencesEqual(keys, resourceKeys)) {
    throw new AdmissionInputError(
      path,
      "must contain every and only declared resource key",
    );
  }
  for (const key of keys) assertNonNegativeSafeInteger(demand[key], `${path}.${key}`);
}

function validateStringRecord(
  value: unknown,
  requiredKeys: readonly string[],
  path: string,
): void {
  const record = objectValue(value, path);
  const keys = Object.keys(record).sort(compareStableStrings);
  if (!exactStringSequencesEqual(keys, requiredKeys)) {
    throw new AdmissionInputError(path, "must contain every declared resource key");
  }
  for (const key of keys) assertNonEmptyString(record[key], `${path}.${key}`);
}

function validateStringArray(value: unknown, path: string): void {
  const items = arrayValue(value, path);
  items.forEach((item, index) => assertNonEmptyString(item, `${path}.${index}`));
  assertUnique(items as string[], path);
}

function numericRecord(value: unknown, path: string): Record<string, number> {
  const record = objectValue(value, path);
  for (const [key, item] of Object.entries(record)) {
    assertSafeInteger(item, `${path}.${key}`);
  }
  return record as Record<string, number>;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionInputError(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdmissionInputError(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdmissionInputError(path, "must be an array");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new AdmissionInputError(`${path}.${index}`, "sparse arrays are invalid");
    }
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  requireFields(value, expected, path);
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new AdmissionInputError(`${path}.${key}`, "unknown field");
    }
  }
}

function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      throw new AdmissionInputError(`${path}.${key}`, "required field is missing");
    }
  }
}

function assertOneOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AdmissionInputError(path, `must be one of ${allowed.join(", ")}`);
  }
}

function assertSha256Digest(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new AdmissionInputError(path, "must be a canonical SHA-256 digest");
  }
}

function validateIsoTimestamp(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  const validShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
  const parsed = Date.parse(value);
  const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  const expected = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!validShape || canonical !== expected) {
    throw new AdmissionInputError(path, "must be a deterministic UTC ISO timestamp");
  }
}

function assertIncreasingWindow(start: string, end: string, path: string): void {
  if (Date.parse(end) <= Date.parse(start)) {
    throw new AdmissionInputError(path, "end must be after start");
  }
}

function windowDurationInUnit(
  start: string,
  end: string,
  unit: TimeUnit,
): number {
  const milliseconds = Date.parse(end) - Date.parse(start);
  const divisor = TIME_UNIT_MILLISECONDS[unit];
  if (milliseconds <= 0 || milliseconds % divisor !== 0) {
    throw new AdmissionInputError(
      "schedulingConstraint",
      `window must be an exact positive number of ${unit}`,
    );
  }
  const duration = milliseconds / divisor;
  if (!Number.isSafeInteger(duration)) {
    throw new AdmissionInputError("schedulingConstraint", "window is outside safe range");
  }
  return duration;
}

function reservationDigest(reservation: FixedCapacityReservation): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(reservation), "utf8")
    .digest("hex")}`;
}

function strategyStatus(
  declaredOptionCount: number,
  candidates: readonly ReplanCandidate[],
): StrategyFamilySummary["status"] {
  if (declaredOptionCount === 0) return "no_declared_options";
  if (candidates.length === 0) return "all_options_rejected";
  if (!candidates.some((candidate) => candidate.feasible)) {
    return "no_feasible_candidate";
  }
  return "available";
}

function enumerateAcceptedChoices(
  entries: readonly {
    readonly obligation: AcceptedObligation;
    readonly options: { readonly valid: readonly ConstructibleModification[] };
  }[],
  index: number,
  selected: readonly (ConstructibleModification | null)[],
  visit: (selected: readonly (ConstructibleModification | null)[]) => void,
): void {
  if (index === entries.length) {
    visit(selected);
    return;
  }
  const entry = entries[index];
  if (entry === undefined) throw new Error(`Missing option entry ${index}`);
  for (const choice of [null, ...entry.options.valid]) {
    enumerateAcceptedChoices(entries, index + 1, [...selected, choice], visit);
  }
}

function linearUtility(
  rule: { readonly slope: Rational; readonly intercept: Rational },
  value: number,
): Rational {
  return addRational(
    multiplyRational(rule.slope, rational(value)),
    rule.intercept,
  );
}

function modificationFailure(
  obligation: Obligation,
  option: ModificationOption,
  code: ModificationFailureCode,
  field: string | null,
  reservationId: string | null,
): RejectedModificationOption {
  return {
    obligationId: obligation.obligationId,
    optionId: option.optionId,
    code,
    field,
    reservationId,
  };
}

function compareRejectedOptions(
  left: RejectedModificationOption,
  right: RejectedModificationOption,
): number {
  for (const comparison of [
    compareStableStrings(left.obligationId, right.obligationId),
    compareStableStrings(left.optionId, right.optionId),
    compareStableStrings(left.code, right.code),
    compareStableStrings(left.field ?? "", right.field ?? ""),
    compareStableStrings(left.reservationId ?? "", right.reservationId ?? ""),
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareDecisionRequirements(
  left: DecisionRequirement,
  right: DecisionRequirement,
): number {
  return compareStableStrings(left.requirementId, right.requirementId);
}

function compareServiceCoordinates(
  left: { obligationId: string; field: string },
  right: { obligationId: string; field: string },
): number {
  const obligationComparison = compareStableStrings(
    left.obligationId,
    right.obligationId,
  );
  return obligationComparison !== 0
    ? obligationComparison
    : compareStableStrings(left.field, right.field);
}

function serviceCoordinateKey(value: {
  obligationId: string;
  field: string;
}): string {
  return canonicalSerialize([value.obligationId, value.field]);
}

function serviceCoordinateValue(
  suggestion: FeasibilityRestoringSuggestion,
  key: string,
): Rational {
  return (
    suggestion.serviceDimensionChanges.find(
      (change) => serviceCoordinateKey(change) === key,
    )?.loss ?? rational(0)
  );
}

function serviceValues(serviceLevel: ServiceLevel): readonly {
  readonly field: string;
  readonly value: number;
}[] {
  return Object.entries(serviceLevel)
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([field, value]) => ({ field, value }));
}

function demandAmounts(
  demand: ResourceDemand,
  resourceKeys: readonly string[],
): readonly ResourceAmount[] {
  return resourceKeys.map((resourceKey) => ({
    resourceKey,
    value: demandValue(demand, resourceKey),
  }));
}

function mapAmounts(
  values: ReadonlyMap<string, number>,
  resourceKeys: readonly string[],
): readonly ResourceAmount[] {
  return resourceKeys.map((resourceKey) => ({
    resourceKey,
    value: requiredMapValue(values, resourceKey),
  }));
}

function demandValue(demand: ResourceDemand, resourceKey: string): number {
  const value = demand[resourceKey];
  if (value === undefined) {
    throw new AdmissionInputError(
      `resourceDemand.${resourceKey}`,
      "required resource is missing",
    );
  }
  return value;
}

function requiredMapValue(map: ReadonlyMap<string, number>, key: string): number {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing map value ${key}`);
  return value;
}

function amountValue(
  amounts: readonly ResourceAmount[],
  resourceKey: string,
): number {
  return amounts.find((entry) => entry.resourceKey === resourceKey)?.value ?? 0;
}

function criticalityWeight(criticality: Obligation["criticality"]): number {
  switch (criticality) {
    case "best_effort":
      return 1;
    case "important":
    case "protected":
      return 10;
  }
}

function modificationRequirementId(
  obligationId: string,
  optionId: string,
): string {
  return stableTupleId("requirement", ["modify", obligationId, optionId]);
}

function acceptanceRequirementId(obligationId: string): string {
  return stableTupleId("requirement", ["accept", obligationId]);
}

function replanCandidatePlanId(
  proposalId: string,
  proposalChoice: ConstructibleModification | null,
  existingChanges: readonly ConstructibleModification[],
): string {
  const existing = [...existingChanges]
    .sort((left, right) =>
      compareStableStrings(
        left.obligation.obligationId,
        right.obligation.obligationId,
      ),
    )
    .map((change) => [
      change.obligation.obligationId,
      change.option.optionId,
    ]);
  return stableTupleId("replan-plan", [
    proposalId,
    proposalChoice?.option.optionId ?? null,
    existing,
  ]);
}

function directCandidatePlanId(proposalId: string): string {
  return stableTupleId("direct-plan", [proposalId]);
}

function preference(comparison: number): CandidateComparison {
  return comparison < 0 ? "left_preferred" : "right_preferred";
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeAdd(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new AdmissionInputError(path, "integer arithmetic exceeded safe range");
  }
  return result;
}

function safeSubtract(left: number, right: number, path: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result)) {
    throw new AdmissionInputError(path, "integer arithmetic exceeded safe range");
  }
  return result;
}

function assertSafeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AdmissionInputError(path, "must be a safe integer");
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  assertSafeInteger(value, path);
  if (value < 0) throw new AdmissionInputError(path, "cannot be negative");
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdmissionInputError(path, "must be a non-empty string");
  }
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmptyString(value, path);
    if (seen.has(value)) {
      throw new AdmissionInputError(path, `contains duplicate ${value}`);
    }
    seen.add(value);
  }
}
