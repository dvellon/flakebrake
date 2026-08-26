export type ResourceSide = "human" | "agent" | "operational";

export type ResourceCapacityKind = "generic" | "meaningful_decisions";

export type TimeUnit = "minutes" | "hours";

export type Criticality = "protected" | "important" | "best_effort";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface VersionTuple {
  readonly portfolioVersion: string;
  readonly capacityModelVersion: string;
  readonly capacityPlanVersion: string;
  readonly authorizationStateVersion: string;
}

export interface ProvenanceEntry {
  readonly key: string;
  readonly source: string;
  readonly value: JsonValue;
}

export interface CapacityResource {
  readonly resourceKey: string;
  readonly side: ResourceSide;
  readonly capacityKind: ResourceCapacityKind;
  readonly unit: string;
  readonly timeUnit: TimeUnit | null;
  readonly horizonStart: string;
  readonly horizonEnd: string;
  readonly capacity: number;
  readonly safetyReserve: number;
  readonly estimatorRule: string;
  readonly assumptions: readonly ProvenanceEntry[];
}

export type ResourceDemand = Readonly<Record<string, number>>;

export type ServiceLevel = Readonly<Record<string, number>>;

export interface SchedulingConstraint {
  readonly kind: "deadline" | "horizon";
  readonly start: string;
  readonly end: string;
  readonly resourceKey: string;
  readonly timeUnit: TimeUnit;
}

export interface LinearUtilityRule {
  readonly ruleId: string;
  readonly kind: "linear";
  readonly slope: Rational;
  readonly intercept: Rational;
}

export interface ModifiableFieldPolicy {
  readonly allowedBounds: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly utilityRule: LinearUtilityRule;
  readonly dimensionWeight: Rational;
}

export interface ModificationPolicy {
  readonly modifiableFields: Readonly<Record<string, ModifiableFieldPolicy>>;
}

export interface DecisionSemantics {
  readonly objectiveId: string;
  readonly evidencePacketId: string;
  readonly approverId: string;
  readonly executionBoundaryId: string;
}

export interface PendingOwnerDecision extends DecisionSemantics {
  readonly decisionId: string;
  readonly kind: "consequential_effect";
}

export interface TypedCost {
  readonly basisKey: string;
  readonly amount: Rational;
}

export interface ReservationCompatibilityProof {
  readonly reservationId: string;
  readonly reservationDigest: string;
}

export interface ModificationOption {
  readonly optionId: string;
  readonly changes: Readonly<Record<string, number>>;
  readonly resourceDemand: ResourceDemand;
  readonly addedCapacityCost: TypedCost | null;
  readonly decisionSemantics: DecisionSemantics;
  readonly reservationCompatibilityProofs: readonly ReservationCompatibilityProof[];
  readonly assumptions: readonly ProvenanceEntry[];
}

interface ObligationCore {
  readonly obligationId: string;
  readonly beneficiary: string;
  readonly objective: string;
  readonly serviceLevel: ServiceLevel;
  readonly protected: boolean;
  readonly criticality: Criticality;
  readonly minimumService: ServiceLevel;
  readonly modificationPolicy: ModificationPolicy;
  readonly modificationOptions: readonly ModificationOption[];
  /** Operational demand only; control-plane owner decisions are computed separately. */
  readonly resourceDemand: ResourceDemand;
  readonly workClassByResource: Readonly<Record<string, string>>;
  readonly schedulingConstraint: SchedulingConstraint;
  readonly pendingOwnerDecisions: readonly PendingOwnerDecision[];
  readonly assumptions: readonly ProvenanceEntry[];
  readonly evidenceRefs: readonly string[];
  readonly requiredEffects: readonly string[];
}

export interface AcceptedObligation extends ObligationCore {
  readonly status: "accepted";
}

export interface ProposedObligation extends ObligationCore {
  readonly status: "proposed";
  readonly acceptanceDecision: DecisionSemantics;
}

export interface ReservationTemporalClaim {
  readonly resourceKey: string;
  readonly start: string;
  readonly end: string;
  readonly requiredDuration: number;
  readonly timeUnit: TimeUnit;
}

export interface FixedCapacityReservation {
  readonly reservationId: string;
  readonly executionAttemptId: string;
  readonly authorizationIdentity: string;
  readonly lockedOperationId: string;
  readonly affectedObligationIds: readonly string[];
  readonly resourceClaims: ResourceDemand;
  readonly temporalClaim: ReservationTemporalClaim | null;
  readonly expectedPostcondition: JsonValue;
  readonly claimAccounting: "additional" | "already_in_portfolio";
}

export interface DecisionAlternativeBundle {
  readonly bundleId: string;
  readonly selectorValue: JsonPrimitive;
  readonly requirementIds: readonly string[];
  readonly fullySpecified: true;
}

export interface CombinedDecisionProof extends DecisionSemantics {
  readonly proofId: string;
  readonly decisionId: string;
  readonly selectorId: string;
  readonly selectedBundleId: string;
  readonly coveredRequirementIds: readonly string[];
  readonly alternatives: readonly DecisionAlternativeBundle[];
  readonly allOrNoneEnforced: true;
}

export interface CalibrationHistoryRecord {
  readonly recordId: string;
  readonly completedAt: string;
  readonly resourceKey: string;
  readonly workClassKey: string;
  readonly actualConsumption: number;
  readonly actualConsumptionAddendumId: string;
  readonly outcome: "completed";
  readonly outcomeAddendumId: string;
}

export interface CalibrationInput {
  readonly ruleId: "conservative-max/v1";
  readonly historyRecords: readonly CalibrationHistoryRecord[];
  readonly expectedFrontierDigest: string | null;
}

export interface AdmissionEvaluationInput {
  readonly versions: VersionTuple;
  readonly calibration: CalibrationInput;
  readonly resources: readonly CapacityResource[];
  readonly acceptedObligations: readonly AcceptedObligation[];
  readonly proposal: ProposedObligation;
  readonly fixedCapacityReservations: readonly FixedCapacityReservation[];
  readonly combinedDecisionProofs: readonly CombinedDecisionProof[];
  readonly authorizationFacts: readonly ProvenanceEntry[];
  readonly assumptions: readonly ProvenanceEntry[];
}

export interface ResourceAmount {
  readonly resourceKey: string;
  readonly value: number;
}

export interface CapacityConstraint {
  readonly resourceKey: string;
  readonly side: ResourceSide;
  readonly capacityKind: ResourceCapacityKind;
  readonly unit: string;
  readonly timeUnit: TimeUnit | null;
  readonly horizonStart: string;
  readonly horizonEnd: string;
  readonly declaredCapacity: number;
  readonly safetyReserve: number;
  readonly estimatorRule: string;
  readonly assumptions: readonly ProvenanceEntry[];
}

export interface TemporalSlack {
  readonly obligationId: string;
  readonly resourceKey: string;
  readonly constraintStart: string;
  readonly constraintEnd: string;
  readonly windowDuration: number;
  readonly requiredDuration: number;
  readonly slack: number;
  readonly timeUnit: TimeUnit;
  readonly protected: boolean;
  readonly status: "violated" | "binding" | "slack";
}

export interface ProtectedObligationSlack {
  readonly byResource: readonly ResourceAmount[];
  readonly bySchedulingConstraint: readonly TemporalSlack[];
}

export type ConstraintViolation =
  | {
      readonly kind: "resource_capacity";
      readonly resourceKey: string;
      readonly deficit: number;
    }
  | {
      readonly kind: "scheduling_constraint";
      readonly obligationId: string;
      readonly resourceKey: string;
      readonly deficit: number;
      readonly timeUnit: TimeUnit;
      readonly protected: boolean;
    }
  | {
      readonly kind: "fixed_reservation_compatibility";
      readonly obligationId: string;
      readonly reservationId: string;
    };

export interface BindingOrLimitingResources {
  readonly kind: "binding" | "limiting" | "violated";
  readonly resourceKeys: readonly string[];
}

export interface DecisionRequirement extends DecisionSemantics {
  readonly requirementId: string;
  readonly kind:
    | "accept_promise"
    | "modify_accepted_obligation"
    | "modify_proposal"
    | "consequential_effect";
  readonly obligationId: string;
}

export interface MeaningfulDecision extends DecisionSemantics {
  readonly decisionId: string;
  readonly requirementIds: readonly string[];
  readonly combinedByProofId: string | null;
}

export interface MeaningfulDecisionFrontier {
  readonly requirements: readonly DecisionRequirement[];
  readonly decisions: readonly MeaningfulDecision[];
  readonly requiredDecisionCount: number;
}

export interface CapacityEvaluation {
  readonly capacityBefore: readonly ResourceAmount[];
  readonly predictedOperationalConsumption: readonly ResourceAmount[];
  readonly predictedControlPlaneConsumption: readonly ResourceAmount[];
  readonly predictedConsumption: readonly ResourceAmount[];
  readonly capacityAfter: readonly ResourceAmount[];
  readonly temporalSlack: readonly TemporalSlack[];
  readonly protectedObligationSlack: ProtectedObligationSlack;
  readonly meaningfulDecisionFrontier: MeaningfulDecisionFrontier;
  readonly bindingOrLimitingResources: BindingOrLimitingResources;
  readonly violations: readonly ConstraintViolation[];
}

export type ModificationFailureCode =
  | "protected_obligation"
  | "unmodifiable_field"
  | "outside_allowed_bounds"
  | "minimum_service_floor"
  | "non_degrading_utility"
  | "invalid_utility_policy"
  | "fixed_reservation_conflict";

export interface RejectedModificationOption {
  readonly obligationId: string;
  readonly optionId: string;
  readonly code: ModificationFailureCode;
  readonly field: string | null;
  readonly reservationId: string | null;
}

export interface ServiceValue {
  readonly field: string;
  readonly value: number;
}

export interface ServiceDimensionLoss {
  readonly field: string;
  readonly loss: Rational;
}

export interface ObligationChange {
  readonly obligationId: string;
  readonly obligationStatus: "accepted" | "proposed";
  readonly optionId: string;
  readonly previousServiceLevel: readonly ServiceValue[];
  readonly proposedServiceLevel: readonly ServiceValue[];
  readonly previousResourceDemand: readonly ResourceAmount[];
  readonly proposedResourceDemand: readonly ResourceAmount[];
  readonly serviceDimensionLosses: readonly ServiceDimensionLoss[];
  readonly obligationServiceLoss: Rational;
}

export interface RequiredOwnerApproval {
  readonly kind: "modify_accepted_obligation" | "modify_proposal";
  readonly obligationId: string;
  readonly optionId: string;
  readonly requirementId: string;
  readonly changes: readonly ServiceValue[];
}

export interface CostVector {
  readonly components: readonly TypedCost[];
}

export interface CandidateScore {
  readonly protectedObligationViolations: number;
  readonly criticalityWeightedServiceDegradation: Rational;
  readonly previouslyAcceptedObligationsChanged: number;
  readonly addedCapacityCost: CostVector;
  readonly bottleneckSlack: Rational;
}

export interface RankableReplanCandidate {
  readonly candidatePlanId: string;
  readonly score: CandidateScore;
}

export type CandidateComparison =
  | "left_preferred"
  | "right_preferred"
  | "equivalent"
  | "incomparable";

export interface ReplanCandidate extends RankableReplanCandidate {
  readonly strategy:
    | "modify_proposal"
    | "modify_existing"
    | "modify_both";
  readonly feasible: boolean;
  readonly affectedObligations: readonly ObligationChange[];
  readonly requiredOwnerApprovals: readonly RequiredOwnerApproval[];
  readonly capacity: CapacityEvaluation;
  readonly assumptions: readonly ProvenanceEntry[];
}

export interface StrategyFamilySummary {
  readonly strategy: "modify_proposal" | "modify_existing";
  readonly status:
    | "available"
    | "no_declared_options"
    | "all_options_rejected"
    | "no_feasible_candidate";
  readonly declaredOptionCount: number;
  readonly constructibleCandidateCount: number;
  readonly feasibleCandidateCount: number;
  readonly rejectedOptions: readonly RejectedModificationOption[];
}

export interface CalibrationSelectedRecord {
  readonly recordId: string;
  readonly completedAt: string;
  readonly actualConsumption: number;
  readonly actualConsumptionAddendumId: string;
  readonly outcome: "completed";
  readonly outcomeAddendumId: string;
}

export interface CalibrationFrontierEntry {
  readonly resourceKey: string;
  readonly workClassKey: string;
  readonly selectedRecords: readonly CalibrationSelectedRecord[];
}

export interface CalibrationFrontierProvenance {
  readonly capacityModelVersion: string;
  readonly ruleId: "conservative-max/v1";
  readonly digestAlgorithm: "sha256";
  readonly serialization: "canonical-json/v1";
  readonly entries: readonly CalibrationFrontierEntry[];
}

export interface CalibratedDemandSnapshot {
  readonly obligationId: string;
  readonly variantId: "current" | string;
  readonly baseDemand: readonly ResourceAmount[];
  readonly calibratedDemand: readonly ResourceAmount[];
  readonly additiveCorrections: readonly ResourceAmount[];
}

export interface AdmissionBasis {
  readonly portfolioVersion: string;
  readonly capacityModelVersion: string;
  readonly capacityPlanVersion: string;
  readonly authorizationStateVersion: string;
  readonly calibrationFrontierDigest: string;
  readonly calibrationFrontierProvenance: CalibrationFrontierProvenance;
  readonly capacityConstraints: readonly CapacityConstraint[];
  readonly assumptions: readonly ProvenanceEntry[];
  readonly authorizationFacts: readonly ProvenanceEntry[];
  readonly fixedCapacityReservations: readonly FixedCapacityReservation[];
}

export interface ExpectedAdmissionBasis {
  readonly expectedPortfolioVersion: string;
  readonly expectedCapacityModelVersion: string;
  readonly expectedCapacityPlanVersion: string;
  readonly expectedAuthorizationStateVersion: string;
  readonly expectedCalibrationFrontierDigest: string;
}

export type PermissibleOwnerChoice =
  | "ACCEPT_PROMISE"
  | "MODIFY"
  | "DECLINE";

export interface ServiceDimensionChangeCoordinate {
  readonly obligationId: string;
  readonly field: string;
  readonly loss: Rational;
}

export interface TemporalConstraintChange {
  readonly obligationId: string;
  readonly extension: number;
  readonly timeUnit: TimeUnit;
}

export interface FeasibilityRestoringSuggestion {
  readonly candidatePlanId: string;
  readonly capacityExpansion: readonly ResourceAmount[];
  readonly boundedModifications: readonly ObligationChange[];
  readonly serviceDimensionChanges: readonly ServiceDimensionChangeCoordinate[];
  readonly temporalConstraintChanges: readonly TemporalConstraintChange[];
}

export interface UncalculableFeasibilityChange {
  readonly constraint: ConstraintViolation;
  readonly missingVariable: "bounded_scheduling_alternative";
}

export interface PromiseBasis {
  readonly schemaVersion: "flakebrake-promise-basis/v0.1-m1";
  readonly decision: "ADMITTABLE" | "REPLAN" | "REJECT";
  readonly versions: VersionTuple;
  readonly calibrationFrontierDigest: string;
  readonly calibrationFrontierProvenance: CalibrationFrontierProvenance;
  readonly calibratedDemands: readonly CalibratedDemandSnapshot[];
  readonly proposal: ProposedObligation;
  readonly acceptedPortfolio: readonly AcceptedObligation[];
  readonly resources: readonly CapacityResource[];
  readonly assumptions: readonly ProvenanceEntry[];
  readonly authorizationFacts: readonly ProvenanceEntry[];
  readonly fixedCapacityReservations: readonly FixedCapacityReservation[];
  readonly combinedDecisionProofs: readonly CombinedDecisionProof[];
  readonly expectedAcceptanceBasis: ExpectedAdmissionBasis | "NOT_APPLICABLE";
  readonly directPlan: CapacityEvaluation;
  readonly candidatePlans: readonly ReplanCandidate[];
  readonly selectedPlanIds: readonly string[];
  readonly feasibilityRestoringSuggestions: readonly FeasibilityRestoringSuggestion[];
  readonly uncalculableFeasibilityChanges: readonly UncalculableFeasibilityChange[];
}

export interface AdmittableResult {
  readonly decision: "ADMITTABLE";
  readonly basis: AdmissionBasis;
  readonly expectedBasis: ExpectedAdmissionBasis;
  readonly directPlan: CapacityEvaluation;
  readonly permissibleOwnerChoices: readonly PermissibleOwnerChoice[];
  readonly promiseBasis: PromiseBasis;
}

export interface ReplanResult {
  readonly decision: "REPLAN";
  readonly basis: AdmissionBasis;
  readonly expectedBasis: "NOT_APPLICABLE";
  readonly directPlan: CapacityEvaluation;
  readonly strategyFamilies: readonly StrategyFamilySummary[];
  readonly consideredCandidates: readonly ReplanCandidate[];
  readonly candidates: readonly ReplanCandidate[];
  readonly recommendedCandidates: readonly ReplanCandidate[];
  readonly recommendedCandidate: ReplanCandidate | null;
  readonly promiseBasis: PromiseBasis;
}

export interface RejectResult {
  readonly decision: "REJECT";
  readonly basis: AdmissionBasis;
  readonly expectedBasis: "NOT_APPLICABLE";
  readonly directPlan: CapacityEvaluation;
  readonly strategyFamilies: readonly StrategyFamilySummary[];
  readonly consideredCandidates: readonly ReplanCandidate[];
  readonly feasibilityRestoringSuggestions: readonly FeasibilityRestoringSuggestion[];
  readonly uncalculableFeasibilityChanges: readonly UncalculableFeasibilityChange[];
  readonly promiseBasis: PromiseBasis;
}

export type AdmissionResult = AdmittableResult | ReplanResult | RejectResult;
