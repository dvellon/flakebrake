import type {
  AcceptedObligation,
  AdmissionResult,
  CapacityEvaluation,
  CapacityResource,
  CombinedDecisionProof,
  ExpectedAdmissionBasis,
  FixedCapacityReservation,
  JsonPrimitive,
  JsonValue,
  ProposedObligation,
  ProvenanceEntry,
  ReplanCandidate,
  ReservationTemporalClaim,
  ResourceDemand,
  VersionTuple,
} from "./domain.js";

export interface StatefulInitialState {
  readonly acceptedObligations: readonly AcceptedObligation[];
  readonly resources: readonly CapacityResource[];
  readonly assumptions: readonly ProvenanceEntry[];
  readonly combinedDecisionProofs: readonly CombinedDecisionProof[];
}

export interface CreateStoreOptions {
  readonly path: string;
  readonly initialState?: StatefulInitialState;
  readonly now?: () => string;
}

export interface AdmissionRequest {
  readonly proposal: ProposedObligation;
  readonly assumptions?: readonly ProvenanceEntry[];
  readonly combinedDecisionProofs?: readonly CombinedDecisionProof[];
}

export type StoredSelectedPlan =
  | { readonly kind: "selected"; readonly selectedPlanId: string }
  | { readonly kind: "owner_choice_required"; readonly candidatePlanIds: readonly string[] }
  | { readonly kind: "no_feasible_plan" };

export interface AdmissionRecordBody {
  readonly schemaVersion: "flakebrake-admission-record/v0.1-m2";
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly createdAt: string;
  readonly decision: AdmissionResult["decision"];
  readonly portfolioVersion: string;
  readonly expectedPortfolioVersion: string | "NOT_APPLICABLE";
  readonly capacityModelVersion: string;
  readonly expectedCapacityModelVersion: string | "NOT_APPLICABLE";
  readonly capacityPlanVersion: string;
  readonly expectedCapacityPlanVersion: string | "NOT_APPLICABLE";
  readonly authorizationStateVersion: string;
  readonly expectedAuthorizationStateVersion: string | "NOT_APPLICABLE";
  readonly calibrationFrontierDigest: string;
  readonly expectedCalibrationFrontierDigest: string | "NOT_APPLICABLE";
  readonly calibrationFrontierProvenance: AdmissionResult["basis"]["calibrationFrontierProvenance"];
  readonly fixedInFlightExecutionReservations: readonly FixedCapacityReservation[];
  readonly proposalSnapshot: ProposedObligation;
  readonly candidatePlans: readonly ReplanCandidate[];
  readonly selectedPlan: StoredSelectedPlan;
  readonly capacityBefore: CapacityEvaluation["capacityBefore"];
  readonly predictedConsumption: CapacityEvaluation["predictedConsumption"];
  readonly capacityAfter: CapacityEvaluation["capacityAfter"];
  readonly protectedObligationSlack: CapacityEvaluation["protectedObligationSlack"];
  readonly bindingResourceFacts: CapacityEvaluation["bindingOrLimitingResources"];
  readonly ownerChoice: "PENDING_OWNER_CHOICE";
  readonly actualConsumption: "NOT_YET_KNOWN";
  readonly outcome: "NOT_YET_KNOWN";
  readonly additiveCorrections: "NOT_YET_KNOWN";
  readonly m1Result: AdmissionResult;
}

export type AdmissionAddendumKind =
  | "owner_choice"
  | "acceptance_commit"
  | "stale_superseded"
  | "readmission_link"
  | "actual_consumption"
  | "outcome"
  | "calibration_correction"
  | "execution_attempt"
  | "reservation_transition"
  | "receipt_reference";

export interface AdmissionAddendum {
  readonly sequence: number;
  readonly addendumId: string;
  readonly admissionRecordId: string;
  readonly createdAt: string;
  readonly kind: AdmissionAddendumKind;
  readonly body: JsonValue;
}

export interface AdmissionReadModel {
  readonly record: AdmissionRecordBody;
  readonly canonicalRecordBytes: string;
  readonly addenda: readonly AdmissionAddendum[];
}

export interface PortfolioReadModel {
  readonly versions: VersionTuple;
  readonly acceptedObligations: readonly AcceptedObligation[];
  readonly resources: readonly CapacityResource[];
  readonly activeReservations: readonly InFlightExecutionReservation[];
}

export interface AcceptPromiseInput extends ExpectedAdmissionBasis {
  readonly admissionRecordId: string;
  readonly selectedPlanId: string;
  readonly ownerDecisionId: string;
  readonly approverId: string;
}

export type AcceptPromiseResult =
  | {
      readonly status: "COMMITTED";
      readonly admissionRecordId: string;
      readonly selectedPlanId: string;
      readonly versions: VersionTuple;
    }
  | {
      readonly status: "STALE_READMISSION";
      readonly staleAdmissionRecordId: string;
      readonly freshAdmissionRecord: AdmissionRecordBody;
      readonly mismatches: readonly AdmissionBasisMismatch[];
    };

export type AdmissionBasisMismatch =
  | "portfolio_version"
  | "capacity_model_version"
  | "capacity_plan_version"
  | "authorization_state_version"
  | "calibration_frontier_digest";

export type OwnerDecisionInput =
  | {
      readonly kind: "DECLINE";
      readonly admissionRecordId: string;
      readonly ownerDecisionId: string;
      readonly approverId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "MODIFY";
      readonly admissionRecordId: string;
      readonly ownerDecisionId: string;
      readonly approverId: string;
      readonly selectedPlanId: string;
      readonly replacementProposal?: ProposedObligation;
    };

export type OwnerDecisionResult =
  | { readonly status: "DECLINED"; readonly ownerDecisionId: string }
  | {
      readonly status: "READMITTED";
      readonly ownerDecisionId: string;
      readonly freshAdmissionRecord: AdmissionRecordBody;
    };

export type EffectSchemaVersion =
  | "microfactory-effect/v1"
  | "microfactory-effect/v2";

export interface EffectFingerprint {
  readonly effectSchemaVersion: EffectSchemaVersion;
  readonly environmentId: string;
  readonly effectType: "schedule_reservation";
  readonly targetType: "production_cell";
  readonly targetId: string;
  readonly operation: "reserve";
  readonly materialParameters: {
    readonly quantity: number;
    readonly start: string;
    readonly end: string;
  };
}

export interface CanonicalNormalizedEffect {
  readonly canonicalEffectClass: "microfactory.schedule_reservation";
  readonly environmentId: string;
  readonly canonicalTargetType: "production_cell";
  readonly canonicalTargetId: string;
  readonly canonicalOperation: "reserve";
  readonly materialParameters: {
    readonly quantity: number;
    readonly start: string;
    readonly end: string;
  };
}

export type TypedConstraint =
  | { readonly kind: "equals"; readonly value: JsonPrimitive }
  | { readonly kind: "set"; readonly values: readonly JsonPrimitive[] }
  | { readonly kind: "range"; readonly minimum: number; readonly maximum: number };

export interface ApprovalScope {
  readonly scopeSchemaVersion: "microfactory-approval-scope/v1";
  readonly environmentId: string;
  readonly allowedEffectSchemaVersions: readonly EffectSchemaVersion[];
  readonly allowedEffectTypes: readonly "schedule_reservation"[];
  readonly allowedTargetTypes: readonly "production_cell"[];
  readonly allowedTargetIds: readonly string[];
  readonly allowedOperations: readonly "reserve"[];
  readonly materialParameterConstraints: Readonly<Record<string, TypedConstraint>>;
  readonly resourceConstraints: Readonly<Record<string, TypedConstraint>>;
  readonly objectiveId: string;
  readonly promiseBasisId: string;
  readonly approverId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly maxExecutions: number;
}

export interface CanonicalApprovalScope extends ApprovalScope {}

export interface IssueGrantInput {
  readonly grantId: string;
  readonly grantVersion: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly ownerDecisionId: string;
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly scope: ApprovalScope;
  readonly postDenialAuthorization: {
    readonly parentDenialId: string;
    readonly changeClass: "narrower_scope";
  } | null;
  readonly expectedPortfolioVersion: string;
  readonly expectedCapacityModelVersion: string;
  readonly expectedCapacityPlanVersion: string;
}

export interface GrantAllowanceReadModel {
  readonly grantAllowanceKey: string;
  readonly decisionId: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly canonicalApprovedScope: CanonicalApprovalScope;
  readonly approverId: string;
  readonly maxExecutions: number;
  readonly claimedExecutionSlots: readonly number[];
  readonly grantIds: readonly string[];
  readonly status: "live" | "revoked" | "expired" | "exhausted";
}

export interface IssuedGrantResult {
  readonly grantId: string;
  readonly grantAllowanceKey: string;
  readonly created: boolean;
  readonly allowance: GrantAllowanceReadModel;
  readonly versions: VersionTuple;
}

export interface DeniedScopePredicate {
  readonly scopeSchemaVersion: "microfactory-denied-scope/v1";
  readonly environmentId: string;
  readonly allowedCanonicalEffectClasses: readonly "microfactory.schedule_reservation"[];
  readonly allowedCanonicalTargetTypes: readonly "production_cell"[];
  readonly allowedTargetIds: readonly string[];
  readonly allowedCanonicalOperations: readonly "reserve"[];
  readonly materialParameterConstraints: Readonly<Record<string, TypedConstraint>>;
  readonly resourceConstraints: Readonly<Record<string, TypedConstraint>>;
  readonly objectiveId: string;
}

export interface CreateDenialInput {
  readonly denialId: string;
  readonly deniedEffectFingerprint: EffectFingerprint;
  readonly deniedScope: ApprovalScope;
  readonly objectiveId: string;
  readonly approverId: string;
  readonly evidencePacketId: string;
  readonly missionId: string;
  readonly reason: string;
}

export interface DenialConstraint {
  readonly denialId: string;
  readonly deniedEffectFingerprint: EffectFingerprint;
  readonly deniedEffectFingerprintDigest: string;
  readonly deniedScope: CanonicalApprovalScope;
  readonly deniedScopePredicate: DeniedScopePredicate;
  readonly objectiveId: string;
  readonly approverId: string;
  readonly evidencePacketId: string;
  readonly createdAt: string;
  readonly createdAuthorizationStateVersion: string;
  readonly missionId: string;
  readonly reason: string;
  readonly status: "active" | "superseded" | "mission_closed";
}

export interface CreateDenialExceptionInput {
  readonly denialExceptionId: string;
  readonly parentDenialId: string;
  readonly ownerDecisionId: string;
  readonly grantAllowanceKey: string;
}

export interface DenialExceptionReadModel {
  readonly denialExceptionId: string;
  readonly parentDenialId: string;
  readonly ownerDecisionId: string;
  readonly grantAllowanceKey: string;
  readonly approvedCanonicalEffectClasses: readonly string[];
  readonly approvedEffectSchemaVersions: readonly EffectSchemaVersion[];
  readonly approvedScope: CanonicalApprovalScope;
  readonly createdAt: string;
  readonly status: "active" | "revoked" | "expired" | "exhausted" | "mission_closed";
}

export interface AuthorizationOccurrence {
  readonly effect: EffectFingerprint;
  readonly objectiveId: string;
  readonly promiseBasisId: string;
  readonly resourceClaims: ResourceDemand;
  readonly attemptedAt: string;
  readonly grantId: string;
}

export type AuthorizationEvaluation =
  | {
      readonly decision: "ALLOW";
      readonly grantId: string;
      readonly grantAllowanceKey: string;
      readonly prospectiveOrdinal: number;
      readonly canonicalEffect: CanonicalNormalizedEffect;
      readonly explanation: "live_grant_covers_effect_and_no_denial_blocks";
    }
  | {
      readonly decision: "DENY";
      readonly reason:
        | "grant_not_found"
        | "grant_not_live"
        | "allowance_not_live"
        | "allowance_exhausted"
        | "scope_does_not_cover"
        | "active_denial"
        | "invalid_effect";
      readonly denialId: string | null;
      readonly explanation: string;
    };

export interface ClaimExecutionInput extends ExpectedAdmissionBasis {
  readonly executionAttemptId: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly grantOwnerDecisionId: string;
  readonly grantId: string;
  readonly expectedGrantVersion: string;
  readonly grantAllowanceKey: string;
  readonly effect: EffectFingerprint;
  readonly affectedObligationIds: readonly string[];
  readonly affectedResourceIds: readonly string[];
  readonly resourceCapacityClaims: ResourceDemand;
  readonly temporalClaim: ReservationTemporalClaim | null;
  readonly claimAccounting: FixedCapacityReservation["claimAccounting"];
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly expectedEffect: JsonValue;
  readonly expectedAfterState: JsonValue;
  readonly attemptedAt: string;
}

export interface ExecutionClaimResult {
  readonly status: "CLAIMED";
  readonly replayed: boolean;
  readonly executionAttemptId: string;
  readonly grantAllowanceKey: string;
  readonly grantExecutionOrdinal: number;
  readonly preExecutionAdmissionRecordId: string;
  readonly reservation: InFlightExecutionReservation;
  readonly versions: VersionTuple;
}

export interface ExecutionAttemptReadModel {
  readonly executionAttemptId: string;
  readonly admissionRecordId: string;
  readonly createdAt: string;
  readonly input: ClaimExecutionInput;
  readonly result: ExecutionClaimResult;
}

export interface InFlightExecutionReservation {
  readonly reservationId: string;
  readonly executionAttemptId: string;
  readonly grantAllowanceKey: string;
  readonly grantId: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly grantOwnerDecisionId: string;
  readonly canonicalNormalizedEffect: CanonicalNormalizedEffect;
  readonly rawEffectFingerprint: EffectFingerprint;
  readonly affectedObligationIds: readonly string[];
  readonly affectedResourceIds: readonly string[];
  readonly resourceCapacityClaims: ResourceDemand;
  readonly temporalClaim: ReservationTemporalClaim | null;
  readonly claimAccounting: FixedCapacityReservation["claimAccounting"];
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly expectedEffect: JsonValue;
  readonly expectedAfterState: JsonValue;
  readonly createdAt: string;
  readonly claimState:
    | "claimed_nonterminal"
    | "terminal_verified"
    | "terminal_failed_before_mutation"
    | "terminal_reconciled";
}

export interface RealizedConsumptionReservationFact {
  readonly schemaVersion: "flakebrake-realized-consumption/v0.1-m2";
  readonly realizedConsumptionId: string;
  readonly sourceTerminalEventId: string;
  readonly sourceReservationId: string;
  readonly executionAttemptId: string;
  readonly admissionRecordId: string;
  readonly authorizationIdentity: string;
  readonly lockedOperationId: string;
  readonly affectedObligationIds: readonly string[];
  readonly resourceClaims: ResourceDemand;
  readonly actualConsumptionCoordinates: readonly {
    readonly resourceKey: string;
    readonly workClassKey: string;
    readonly actualConsumptionFactId: string;
  }[];
  readonly temporalClaim: ReservationTemporalClaim | null;
  readonly expectedPostcondition: JsonValue;
  readonly claimAccounting: "additional";
  readonly applicableResourceHorizons: readonly {
    readonly resourceKey: string;
    readonly start: string;
    readonly end: string;
  }[];
  readonly recordedAt: string;
}

export type ExecutionTerminalInput =
  | {
      readonly terminalEventId: string;
      readonly executionAttemptId: string;
      readonly status: "VERIFIED_SUCCESS";
      readonly receiptReference: string;
      readonly observedAfterState: JsonValue;
      readonly actualConsumption: readonly ActualConsumptionValue[];
    }
  | {
      readonly terminalEventId: string;
      readonly executionAttemptId: string;
      readonly status: "DEFINITIVE_FAILURE_BEFORE_MUTATION";
      readonly evidenceReference: string;
    }
  | {
      readonly terminalEventId: string;
      readonly executionAttemptId: string;
      readonly status: "UNCERTAIN_OUTCOME";
      readonly evidenceReference: string;
      readonly observedState: JsonValue;
    }
  | {
      readonly terminalEventId: string;
      readonly executionAttemptId: string;
      readonly status: "RECONCILED";
      readonly receiptReference: string;
      readonly authoritativeState: JsonValue;
      readonly actualConsumption: readonly ActualConsumptionValue[];
    };

export interface ExecutionTerminalResult {
  readonly executionAttemptId: string;
  readonly claimState: InFlightExecutionReservation["claimState"];
  readonly replayed: boolean;
  readonly versions: VersionTuple;
}

export interface ActualConsumptionValue {
  readonly resourceKey: string;
  readonly workClassKey: string;
  readonly value: number;
}

export interface RecordActualConsumptionInput extends ActualConsumptionValue {
  readonly actualConsumptionFactId: string;
  readonly admissionRecordId: string;
  readonly observedAt: string;
  readonly sourceReceipt: string;
}

export interface RecordOutcomeInput {
  readonly outcomeFactId: string;
  readonly admissionRecordId: string;
  readonly outcome: "completed" | "failed" | "uncertain";
  readonly completedAt: string;
  readonly sourceReceipt: string;
}

export interface RecordCalibrationCorrectionInput {
  readonly correctionFactId: string;
  readonly admissionRecordId: string;
  readonly correctsActualConsumptionFactId: string;
  readonly correctedActualConsumption: number;
  readonly reason: string;
  readonly sourceReceipt: string;
}

export interface MaterialCapacityModelUpdate {
  readonly resources: readonly CapacityResource[];
}

export interface MaterialCapacityPlanUpdate {
  readonly resources: readonly CapacityResource[];
  readonly ownerDecisionId: string;
  readonly approverId: string;
}

export class StatefulInputError extends TypeError {
  public constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "StatefulInputError";
  }
}

export class ExecutionAttemptConflictError extends Error {
  public constructor(public readonly executionAttemptId: string) {
    super(`execution_attempt_id ${executionAttemptId} was reused with different material data`);
    this.name = "ExecutionAttemptConflictError";
  }
}

export class AuthorizationDeniedError extends Error {
  public constructor(public readonly evaluation: AuthorizationEvaluation) {
    super(
      evaluation.decision === "DENY"
        ? `Authorization denied: ${evaluation.reason}`
        : "Authorization denied",
    );
    this.name = "AuthorizationDeniedError";
  }
}
