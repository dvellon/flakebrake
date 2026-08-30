import { canonicalSerialize } from "./canonical.js";
import {
  CAPACITY_SHOCK_ALTERNATIVE_END,
  CAPACITY_SHOCK_ALTERNATIVE_START,
  CAPACITY_SHOCK_ATTEMPT_ID,
  CAPACITY_SHOCK_ENVIRONMENT_ID,
  CAPACITY_SHOCK_HORIZON_END,
  CAPACITY_SHOCK_HORIZON_START,
  CAPACITY_SHOCK_MISSION_ID,
  CAPACITY_SHOCK_OWNER_ID,
  CAPACITY_SHOCK_PRIMARY_END,
  CAPACITY_SHOCK_PRIMARY_START,
  CAPACITY_SHOCK_PRODUCTION_CELL_ID,
  CAPACITY_SHOCK_RESOURCE_KEYS,
  CAPACITY_SHOCK_SCHEDULE_COMMITMENTS,
  createCapacityShockInitialState,
  createCapacityShockPlanResources,
  createCapacityShockProposal,
} from "./capacity-shock-fixture.js";
import type { JsonValue, ReplanCandidate } from "./domain.js";
import { canonicalGrantAllowanceKey } from "./effects.js";
import {
  claimedExecutionReference,
  factoryStateDigest,
  readAuthoritativeFactoryExecution,
  resultingScheduleState,
  SyntheticFactoryEnvironment,
  type CanonicalScheduleCommand,
} from "./factory-environment.js";
import { stableTupleId } from "./identity.js";
import {
  type M4ApprovalRecord,
  type M4MissionCheckpoint,
  type M4OwnerApprovalRequest,
  type M4OwnerDecisionProvider,
  type M4OwnerDecisionResponse,
} from "./m4-mission-controller.js";
import {
  M4MissionStore,
  type M4BridgeAction,
  type M4MissionSnapshot,
} from "./m4-mission-store.js";
import { applyM4PortfolioModification } from "./mcp.js";
import { readDatabaseInstanceIdentity } from "./sqlite.js";
import { createStore, type FlakeBrakeStore } from "./store.js";
import type {
  AdmissionRecordBody,
  ApprovalScope,
  ClaimExecutionInput,
  EffectFingerprint,
} from "./stateful-domain.js";

const CAPACITY_PLAN_DECISION_ID = "owner-decision/capacity-shock/capacity-plan-v2";
const MODIFY_DECISION_ID = "owner-decision/capacity-shock/select-replan";
const ACCEPT_DECISION_ID = "owner-decision/capacity-shock/accept-promise";
const GRANT_DECISION_ID = "owner-decision/capacity-shock/execution-scope";
const GRANT_ID = "grant/capacity-shock/schedule/v1";
const GRANT_VERSION = "grant/v1";
const BUNDLE_ID = "bundle/capacity-shock/schedule";
const DENIAL_ID = "denial/capacity-shock/primary-maintenance-window";
const STALE_ACCEPT_DECISION_ID = "owner-decision/capacity-shock/stale-direct-attempt";
const AGENT_ID = "agent/flakebrake-capacity-shock";
const THREAD_ID = "thread/capacity-shock/root";

export interface CapacityShockMissionOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly ownerDecisionProvider: M4OwnerDecisionProvider;
  readonly checkpointObserver?: (
    checkpoint: M4MissionCheckpoint,
  ) => Promise<void> | void;
}

export interface CapacityShockMissionResult {
  readonly mission: {
    readonly status: "VERIFIED_COMPLETE";
    readonly missionId: typeof CAPACITY_SHOCK_MISSION_ID;
    readonly trueforgeSessionId: string;
    readonly finalTurnId: string;
    readonly approvals: readonly M4ApprovalRecord[];
    readonly disconnectedAndResumed: boolean;
    readonly missionSnapshot: M4MissionSnapshot;
    readonly projectionDigest: string;
  };
  readonly rootAgentId: string;
  readonly rootAgentName: string;
  readonly finalAttempt: ReturnType<FlakeBrakeStore["getExecutionAttempt"]>;
  readonly factoryExecution: NonNullable<ReturnType<typeof readAuthoritativeFactoryExecution>>;
  readonly activeDenials: ReturnType<FlakeBrakeStore["getDenials"]>;
  readonly actualConsumptionFacts: number;
  readonly staleBasisRejectionCount: number;
}

export async function runCapacityShockMission(
  options: CapacityShockMissionOptions,
): Promise<CapacityShockMissionResult> {
  initializeEnvironment(options);
  const store = createStore({
    path: options.m2DatabasePath,
    authoritativeFactoryDatabasePath: options.factoryDatabasePath,
    now: () => CAPACITY_SHOCK_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: options.factoryDatabasePath,
    environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
    now: () => CAPACITY_SHOCK_HORIZON_END,
    initialScheduleCommitments: CAPACITY_SHOCK_SCHEDULE_COMMITMENTS,
    incomingProposals: [asJson(createCapacityShockProposal())],
  });
  const missionStore = new M4MissionStore({
    path: options.missionDatabasePath,
    now: () => CAPACITY_SHOCK_HORIZON_END,
  });
  try {
    const identities = databaseIdentities(options);
    const existing = missionStore.getSnapshotOrNull(CAPACITY_SHOCK_MISSION_ID);
    const sessionId =
      existing?.mission.trueforgeSessionId ??
      stableTupleId("capacity-shock-session", [
        CAPACITY_SHOCK_MISSION_ID,
        identities.m2,
        identities.factory,
      ]);
    missionStore.bindMission({
      missionId: CAPACITY_SHOCK_MISSION_ID,
      environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
      trueforgeAgentId: AGENT_ID,
      trueforgeSessionId: sessionId,
      m2EnvironmentIdentity: identities.m2,
      factoryEnvironmentIdentity: identities.factory,
    });
    const replayedTerminal = store
      .getReservations()
      .some(
        (reservation) =>
          reservation.executionAttemptId === CAPACITY_SHOCK_ATTEMPT_ID &&
          reservation.claimState === "terminal_verified",
      );
    const assertDatabaseBinding = (): void => {
      const current = databaseIdentities(options);
      if (current.m2 !== identities.m2 || current.factory !== identities.factory) {
        throw new Error("Capacity-shock durable database binding changed");
      }
    };

    const source = establishCapacityShock(store);
    const winner = selectedCapacityShockPlan(source);
    await ownerBridge({
      missionStore,
      sessionId,
      identities,
      turnId: "turn/capacity-shock/01-select-replan",
      toolCallId: "capacity-shock-select-replan",
      toolName: "select_portfolio_modification",
      phase: "portfolio_modification",
      arguments: {
        admission_record_id: source.admissionRecordId,
        selected_plan_id: winner.candidatePlanId,
        owner_decision_id: MODIFY_DECISION_ID,
        approver_id: CAPACITY_SHOCK_OWNER_ID,
      },
      expectedDecision: "allow",
      provider: options.ownerDecisionProvider,
      checkpointObserver: options.checkpointObserver,
      apply: () =>
        applyM4PortfolioModification(
          store,
          {
            admission_record_id: source.admissionRecordId,
            selected_plan_id: winner.candidatePlanId,
            owner_decision_id: MODIFY_DECISION_ID,
            approver_id: CAPACITY_SHOCK_OWNER_ID,
          },
          assertDatabaseBinding,
        ),
    });

    const fresh = selectedFreshAdmission(store);
    const selectedPlanId = selectedAdmissionPlan(fresh);
    const scope = capacityShockExecutionScope(fresh.promiseBasisId);
    await ownerBridge({
      missionStore,
      sessionId,
      identities,
      turnId: "turn/capacity-shock/02-accept-promise",
      toolCallId: "capacity-shock-accept-promise",
      toolName: "accept_promise",
      phase: "promise_choice",
      arguments: {
        admission_record_id: fresh.admissionRecordId,
        selected_plan_id: selectedPlanId,
        owner_decision_id: ACCEPT_DECISION_ID,
        approver_id: CAPACITY_SHOCK_OWNER_ID,
      },
      expectedDecision: "allow",
      provider: options.ownerDecisionProvider,
      checkpointObserver: options.checkpointObserver,
      apply: (response) => {
        const result = store.acceptPromiseAndIssueGrant({
          acceptance: {
            admissionRecordId: fresh.admissionRecordId,
            selectedPlanId,
            ownerDecisionId: ACCEPT_DECISION_ID,
            approverId: CAPACITY_SHOCK_OWNER_ID,
            ownerSourceIdentity: response.ownerSourceIdentity,
            expectedPortfolioVersion: fresh.portfolioVersion,
            expectedCapacityModelVersion: fresh.capacityModelVersion,
            expectedCapacityPlanVersion: fresh.capacityPlanVersion,
            expectedAuthorizationStateVersion: fresh.authorizationStateVersion,
            expectedCalibrationFrontierDigest: fresh.calibrationFrontierDigest,
          },
          grant: {
            grantId: GRANT_ID,
            grantVersion: GRANT_VERSION,
            admissionRecordId: fresh.admissionRecordId,
            promiseBasisId: fresh.promiseBasisId,
            acceptedOwnerDecisionId: ACCEPT_DECISION_ID,
            ownerDecisionId: GRANT_DECISION_ID,
            selectedBundleId: BUNDLE_ID,
            selectedPlanId,
            scope,
            postDenialAuthorization: null,
          },
        });
        if (result.acceptance.status !== "COMMITTED" || result.grant === null) {
          throw new Error("Capacity-shock fresh promise was not committed");
        }
        return result;
      },
    });

    const primaryEffect = scheduleEffect(
      "microfactory-effect/v1",
      CAPACITY_SHOCK_PRIMARY_START,
      CAPACITY_SHOCK_PRIMARY_END,
    );
    await ownerBridge({
      missionStore,
      sessionId,
      identities,
      turnId: "turn/capacity-shock/03-deny-primary",
      toolCallId: "capacity-shock-deny-primary",
      toolName: "create_schedule_reservation",
      phase: "consequential_effect",
      arguments: scheduleArguments(
        "attempt/capacity-shock/denied-primary",
        primaryEffect,
      ),
      expectedDecision: "deny",
      provider: options.ownerDecisionProvider,
      checkpointObserver: options.checkpointObserver,
      denialId: DENIAL_ID,
      apply: (response) => {
        if (response.decision.status !== "deny") {
          throw new Error("Capacity-shock primary effect must be denied");
        }
        return store.createDenial({
          denialId: DENIAL_ID,
          deniedEffectFingerprint: primaryEffect,
          deniedScope: deniedScope(fresh.promiseBasisId, primaryEffect),
          objectiveId: createCapacityShockProposal().objective,
          approverId: CAPACITY_SHOCK_OWNER_ID,
          evidencePacketId: "evidence-packet/capacity-shock/primary-maintenance-window",
          missionId: CAPACITY_SHOCK_MISSION_ID,
          reason: response.decision.reason,
        });
      },
    });

    mechanicalDenialBridge({
      missionStore,
      store,
      sessionId,
      identities,
      fresh,
      primaryEffect: scheduleEffect(
        "microfactory-effect/v2",
        CAPACITY_SHOCK_PRIMARY_START,
        CAPACITY_SHOCK_PRIMARY_END,
      ),
      checkpointObserver: options.checkpointObserver,
    });

    const alternativeEffect = scheduleEffect(
      "microfactory-effect/v1",
      CAPACITY_SHOCK_ALTERNATIVE_START,
      CAPACITY_SHOCK_ALTERNATIVE_END,
    );
    const command = scheduleCommand(
      CAPACITY_SHOCK_ALTERNATIVE_START,
      CAPACITY_SHOCK_ALTERNATIVE_END,
    );
    await ownerBridge({
      missionStore,
      sessionId,
      identities,
      turnId: "turn/capacity-shock/05-approve-alternative",
      toolCallId: "capacity-shock-approve-alternative",
      toolName: "create_schedule_reservation",
      phase: "consequential_effect",
      arguments: scheduleArguments(CAPACITY_SHOCK_ATTEMPT_ID, alternativeEffect),
      expectedDecision: "allow",
      provider: options.ownerDecisionProvider,
      checkpointObserver: options.checkpointObserver,
      executionAttemptId: CAPACITY_SHOCK_ATTEMPT_ID,
      apply: () => executeAlternative(store, factory, fresh, scope, alternativeEffect, command),
    });

    const evidence = factory.readAuthoritativeExecution(CAPACITY_SHOCK_ATTEMPT_ID);
    if (evidence === null) {
      throw new Error("Capacity-shock factory result is missing before read-back");
    }
    await options.checkpointObserver?.({
      phase: "factory_committed_before_verification",
      turnId: "turn/capacity-shock/06-independent-read-back",
      executionAttemptId: CAPACITY_SHOCK_ATTEMPT_ID,
      receiptId: evidence.result.receipt.receiptId,
    });
    store.verifyExecutionWithEvidence(CAPACITY_SHOCK_ATTEMPT_ID, evidence);
    missionStore.advanceCursor(
      CAPACITY_SHOCK_MISSION_ID,
      "turn/capacity-shock/07-verified",
      7,
    );
    return capacityShockResult(
      store,
      missionStore,
      sessionId,
      evidence,
      replayedTerminal,
    );
  } finally {
    missionStore.close();
    factory.close();
    store.close();
  }
}

function initializeEnvironment(options: CapacityShockMissionOptions): void {
  const store = createStore({
    path: options.m2DatabasePath,
    ...(exists(options.m2DatabasePath)
      ? {}
      : { initialState: createCapacityShockInitialState() }),
    authoritativeFactoryDatabasePath: options.factoryDatabasePath,
    now: () => CAPACITY_SHOCK_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: options.factoryDatabasePath,
    environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
    now: () => CAPACITY_SHOCK_HORIZON_END,
    initialScheduleCommitments: CAPACITY_SHOCK_SCHEDULE_COMMITMENTS,
    incomingProposals: [asJson(createCapacityShockProposal())],
  });
  store.close();
  factory.close();
}

function exists(path: string): boolean {
  try {
    readDatabaseInstanceIdentity(path, "m2", CAPACITY_SHOCK_ENVIRONMENT_ID);
    return true;
  } catch {
    return false;
  }
}

function databaseIdentities(options: CapacityShockMissionOptions): {
  readonly m2: string;
  readonly factory: string;
} {
  return {
    m2: readDatabaseInstanceIdentity(
      options.m2DatabasePath,
      "m2",
      CAPACITY_SHOCK_ENVIRONMENT_ID,
    ),
    factory: readDatabaseInstanceIdentity(
      options.factoryDatabasePath,
      "factory",
      CAPACITY_SHOCK_ENVIRONMENT_ID,
    ),
  };
}

function establishCapacityShock(store: FlakeBrakeStore): AdmissionRecordBody {
  let initial = store
    .getAdmissionHistory()
    .map((item) => item.record)
    .find(
      (record) =>
        record.proposalSnapshot.obligationId === createCapacityShockProposal().obligationId &&
        record.capacityPlanVersion === "capacity-plan/v1" &&
        record.decision === "ADMITTABLE",
    );
  if (initial === undefined) {
    initial = store.evaluateAndRecordAdmissionOrReplay({
      proposal: createCapacityShockProposal(),
    });
  }
  if (initial.decision !== "ADMITTABLE") {
    throw new Error("Capacity-shock initial portfolio must be ADMITTABLE");
  }
  if (store.getPortfolio().versions.capacityPlanVersion === "capacity-plan/v1") {
    const versions = store.replaceCapacityPlan({
      resources: createCapacityShockPlanResources(),
      ownerDecisionId: CAPACITY_PLAN_DECISION_ID,
      approverId: CAPACITY_SHOCK_OWNER_ID,
    });
    if (versions.capacityPlanVersion !== "capacity-plan/v2") {
      throw new Error("Capacity shock did not create capacity-plan/v2");
    }
  }
  const existing = store
    .getAdmissionHistory()
    .map((item) => item.record)
    .filter(
      (record) =>
        record.proposalSnapshot.obligationId === initial?.proposalSnapshot.obligationId &&
        record.capacityPlanVersion === "capacity-plan/v2" &&
        record.portfolioVersion === "portfolio/v1" &&
        record.decision === "REPLAN",
    );
  if (existing.length > 1) {
    throw new Error("Capacity-shock stale rejection created duplicate current admissions");
  }
  if (existing[0] !== undefined) return existing[0];
  const selectedPlanId = selectedAdmissionPlan(initial);
  const stale = store.acceptPromise({
    admissionRecordId: initial.admissionRecordId,
    selectedPlanId,
    ownerDecisionId: STALE_ACCEPT_DECISION_ID,
    approverId: CAPACITY_SHOCK_OWNER_ID,
    ownerSourceIdentity: "owner-source/capacity-shock/stale-probe",
    expectedPortfolioVersion: initial.portfolioVersion,
    expectedCapacityModelVersion: initial.capacityModelVersion,
    expectedCapacityPlanVersion: initial.capacityPlanVersion,
    expectedAuthorizationStateVersion: initial.authorizationStateVersion,
    expectedCalibrationFrontierDigest: initial.calibrationFrontierDigest,
  });
  if (
    stale.status !== "STALE_READMISSION" ||
    canonicalSerialize(stale.mismatches) !== canonicalSerialize(["capacity_plan_version"]) ||
    stale.freshAdmissionRecord.decision !== "REPLAN"
  ) {
    throw new Error("Capacity-shock stale basis was not rejected into an exact REPLAN");
  }
  return stale.freshAdmissionRecord;
}

function selectedCapacityShockPlan(record: AdmissionRecordBody): ReplanCandidate {
  const candidate = record.candidatePlans.find((item) =>
    item.affectedObligations.some(
      (change) => change.optionId === "training-trays/reduce-to-8",
    ),
  );
  if (
    candidate === undefined ||
    candidate.feasible !== true ||
    record.m1Result.decision !== "REPLAN" ||
    record.m1Result.recommendedCandidate?.candidatePlanId !== candidate.candidatePlanId
  ) {
    throw new Error("Capacity-shock deterministic existing-order winner is missing");
  }
  return candidate;
}

function selectedFreshAdmission(store: FlakeBrakeStore): AdmissionRecordBody {
  const matches = store.getAdmissionHistory().filter(({ record, addenda }) =>
    record.decision === "ADMITTABLE" &&
    record.capacityPlanVersion === "capacity-plan/v2" &&
    addenda.some(
      (addendum) =>
        addendum.kind === "readmission_link" &&
        jsonObject(addendum.body)?.["kind"] === "M4_POST_MODIFICATION_ADMISSION",
    ),
  );
  if (matches.length !== 1) {
    throw new Error("Capacity-shock must have one fresh post-modification admission");
  }
  return matches[0]!.record;
}

function selectedAdmissionPlan(record: AdmissionRecordBody): string {
  if (record.selectedPlan.kind !== "selected") {
    throw new Error("Capacity-shock admission has no selected plan");
  }
  return record.selectedPlan.selectedPlanId;
}

interface OwnerBridgeInput {
  readonly missionStore: M4MissionStore;
  readonly sessionId: string;
  readonly identities: { readonly m2: string; readonly factory: string };
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly phase: M4OwnerApprovalRequest["phase"];
  readonly arguments: JsonValue;
  readonly expectedDecision: "allow" | "deny";
  readonly provider: M4OwnerDecisionProvider;
  readonly checkpointObserver?: CapacityShockMissionOptions["checkpointObserver"];
  readonly denialId?: string;
  readonly executionAttemptId?: string;
  readonly apply: (response: M4OwnerDecisionResponse) => unknown;
}

async function ownerBridge(input: OwnerBridgeInput): Promise<M4ApprovalRecord> {
  const action = bridgeAction(input);
  const existing = approvalBound(input.missionStore, action);
  if (existing !== null) return existing;
  const request = approvalRequest(input, action);
  const recordedResponse = ownerResponse(input.missionStore, action);
  const response = recordedResponse ?? (await input.provider(request));
  if (
    response.requestDigest !== request.requestDigest ||
    response.ownerSourceIdentity.trim().length === 0
  ) {
    throw new Error("Capacity-shock owner response did not match its durable action");
  }
  if (recordedResponse === null) {
    input.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "owner_decision_received",
      asJson(response),
    );
  }
  if (response.decision.status !== input.expectedDecision) {
    throw new Error(
      `Capacity-shock ${input.toolName} expected ${input.expectedDecision}, got ${response.decision.status}`,
    );
  }
  const result = input.apply(response);
  input.missionStore.recordBridgeOutcome(action.bridgeKey, "m2_applied", asJson(result));
  const record: M4ApprovalRecord = {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    threadId: THREAD_ID,
    decision: response.decision.status,
    reason:
      response.decision.status === "deny"
        ? response.decision.reason
        : "owner approved",
    source: "owner",
    ownerSourceIdentity: response.ownerSourceIdentity,
    bridgeKey: action.bridgeKey,
    denialId: input.denialId ?? null,
    executionAttemptId: input.executionAttemptId ?? null,
  };
  input.missionStore.recordBridgeOutcome(
    action.bridgeKey,
    "approval_bound",
    asJson(record),
  );
  input.missionStore.advanceCursor(
    CAPACITY_SHOCK_MISSION_ID,
    input.turnId,
    Number(input.turnId.slice("turn/capacity-shock/".length, "turn/capacity-shock/".length + 2)),
  );
  await input.checkpointObserver?.({ phase: "approval_bridge_bound", approval: record });
  return record;
}

function bridgeAction(input: OwnerBridgeInput): M4BridgeAction {
  return input.missionStore.recordBridgeAction({
    missionId: CAPACITY_SHOCK_MISSION_ID,
    trueforgeSessionId: input.sessionId,
    trueforgeTurnId: input.turnId,
    trueforgeThreadId: THREAD_ID,
    trueforgeToolCallId: input.toolCallId,
    actionKind:
      input.phase === "consequential_effect" ? "consequential_effect" : "owner_decision",
    toolName: input.toolName,
    arguments: input.arguments,
  });
}

function approvalRequest(input: OwnerBridgeInput, action: M4BridgeAction): M4OwnerApprovalRequest {
  return {
    missionId: CAPACITY_SHOCK_MISSION_ID,
    trueforgeSessionId: input.sessionId,
    trueforgeTurnId: input.turnId,
    trueforgeThreadId: THREAD_ID,
    trueforgeToolCallId: input.toolCallId,
    toolName: input.toolName,
    arguments: input.arguments,
    m2DatabaseInstanceIdentity: input.identities.m2,
    factoryDatabaseInstanceIdentity: input.identities.factory,
    phase: input.phase,
    requestDigest: action.bridgeKey,
  };
}

function ownerResponse(
  missionStore: M4MissionStore,
  action: M4BridgeAction,
): M4OwnerDecisionResponse | null {
  const result = missionStore
    .getSnapshot(CAPACITY_SHOCK_MISSION_ID)
    .bridgeOutcomes.find(
      (outcome) =>
        outcome.bridgeKey === action.bridgeKey &&
        outcome.status === "owner_decision_received",
    )?.result;
  if (result === undefined) return null;
  return result as unknown as M4OwnerDecisionResponse;
}

function approvalBound(
  missionStore: M4MissionStore,
  action: M4BridgeAction,
): M4ApprovalRecord | null {
  const result = missionStore
    .getSnapshot(CAPACITY_SHOCK_MISSION_ID)
    .bridgeOutcomes.find(
      (outcome) =>
        outcome.bridgeKey === action.bridgeKey && outcome.status === "approval_bound",
    )?.result;
  return result === undefined ? null : (result as unknown as M4ApprovalRecord);
}

function mechanicalDenialBridge(input: {
  readonly missionStore: M4MissionStore;
  readonly store: FlakeBrakeStore;
  readonly sessionId: string;
  readonly identities: { readonly m2: string; readonly factory: string };
  readonly fresh: AdmissionRecordBody;
  readonly primaryEffect: EffectFingerprint;
  readonly checkpointObserver?: CapacityShockMissionOptions["checkpointObserver"];
}): void {
  const action = input.missionStore.recordBridgeAction({
    missionId: CAPACITY_SHOCK_MISSION_ID,
    trueforgeSessionId: input.sessionId,
    trueforgeTurnId: "turn/capacity-shock/04-mechanical-denial",
    trueforgeThreadId: THREAD_ID,
    trueforgeToolCallId: "capacity-shock-equivalent-adapter",
    actionKind: "consequential_effect",
    toolName: "submit_schedule_change",
    arguments: scheduleArguments(
      "attempt/capacity-shock/denied-equivalent-adapter",
      input.primaryEffect,
    ),
  });
  if (approvalBound(input.missionStore, action) !== null) return;
  const versions = input.store.getPortfolio().versions;
  const authorization = input.store.evaluateAuthorization({
    effect: input.primaryEffect,
    objectiveId: createCapacityShockProposal().objective,
    promiseBasisId: input.fresh.promiseBasisId,
    resourceClaims: executionClaims(),
    attemptedAt: CAPACITY_SHOCK_HORIZON_END,
    grantId: GRANT_ID,
  });
  if (authorization.decision !== "DENY" || authorization.reason !== "active_denial") {
    throw new Error("Equivalent capacity-shock adapter bypassed the active denial");
  }
  input.missionStore.recordBridgeOutcome(action.bridgeKey, "m2_applied", asJson({
    ...authorization,
    versions,
    m2Identity: input.identities.m2,
    factoryIdentity: input.identities.factory,
  }));
  const record: M4ApprovalRecord = {
    toolName: "submit_schedule_change",
    toolCallId: "capacity-shock-equivalent-adapter",
    turnId: "turn/capacity-shock/04-mechanical-denial",
    threadId: THREAD_ID,
    decision: "deny",
    reason: authorization.explanation,
    source: "active_m2_denial",
    ownerSourceIdentity: null,
    bridgeKey: action.bridgeKey,
    denialId: authorization.denialId ?? null,
    executionAttemptId: null,
  };
  input.missionStore.recordBridgeOutcome(action.bridgeKey, "approval_bound", asJson(record));
  input.missionStore.advanceCursor(CAPACITY_SHOCK_MISSION_ID, record.turnId, 4);
  void input.checkpointObserver?.({ phase: "approval_bridge_bound", approval: record });
}

function executeAlternative(
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
  fresh: AdmissionRecordBody,
  scope: ApprovalScope,
  effect: EffectFingerprint,
  command: CanonicalScheduleCommand,
): object {
  try {
    const existing = store.getExecutionAttempt(CAPACITY_SHOCK_ATTEMPT_ID);
    const evidence = factory.readAuthoritativeExecution(CAPACITY_SHOCK_ATTEMPT_ID);
    return { claim: existing.result, factory: evidence?.result ?? null, replayed: true };
  } catch {
    // The first bounded execution follows the normal claim/fence path below.
  }
  const versions = store.getPortfolio().versions;
  const before = factory.getScheduleState();
  const after = resultingScheduleState(before, CAPACITY_SHOCK_ATTEMPT_ID, command);
  const allowanceKey = canonicalGrantAllowanceKey(
    GRANT_DECISION_ID,
    BUNDLE_ID,
    scope,
    CAPACITY_SHOCK_OWNER_ID,
  );
  const claimInput: ClaimExecutionInput = {
    executionAttemptId: CAPACITY_SHOCK_ATTEMPT_ID,
    admissionRecordId: fresh.admissionRecordId,
    promiseBasisId: fresh.promiseBasisId,
    acceptedOwnerDecisionId: ACCEPT_DECISION_ID,
    grantOwnerDecisionId: GRANT_DECISION_ID,
    grantId: GRANT_ID,
    expectedGrantVersion: GRANT_VERSION,
    grantAllowanceKey: allowanceKey,
    effect,
    affectedObligationIds: [createCapacityShockProposal().obligationId],
    affectedResourceIds: [
      CAPACITY_SHOCK_RESOURCE_KEYS.agent,
      CAPACITY_SHOCK_RESOURCE_KEYS.production,
    ],
    resourceCapacityClaims: executionClaims(),
    temporalClaim: {
      resourceKey: CAPACITY_SHOCK_RESOURCE_KEYS.production,
      start: command.start,
      end: command.end,
      requiredDuration: 24,
      timeUnit: "minutes",
    },
    claimAccounting: "already_in_portfolio",
    selectedBundleId: BUNDLE_ID,
    selectedPlanId: selectedAdmissionPlan(fresh),
    expectedEffect: command as unknown as JsonValue,
    expectedAfterState: JSON.parse(canonicalSerialize(after)) as JsonValue,
    attemptedAt: CAPACITY_SHOCK_HORIZON_END,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
    expectedAuthorizationStateVersion: versions.authorizationStateVersion,
    expectedCalibrationFrontierDigest: fresh.calibrationFrontierDigest,
  };
  store.claimExecution(claimInput);
  const attempt = store.getExecutionAttempt(CAPACITY_SHOCK_ATTEMPT_ID);
  const factoryResult = factory.executeAuthorizedScheduleMutation(store, {
    executionAttemptId: CAPACITY_SHOCK_ATTEMPT_ID,
    claim: claimedExecutionReference(attempt),
    command,
    expectedBeforeStateVersion: before.stateVersion,
    expectedBeforeStateDigest: factoryStateDigest(before),
  });
  return { claim: attempt.result, factory: factoryResult.result, replayed: false };
}

function capacityShockExecutionScope(promiseBasisId: string): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
    allowedEffectSchemaVersions: ["microfactory-effect/v1", "microfactory-effect/v2"],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: [CAPACITY_SHOCK_PRODUCTION_CELL_ID],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: 8 },
      start: {
        kind: "set",
        values: [CAPACITY_SHOCK_PRIMARY_START, CAPACITY_SHOCK_ALTERNATIVE_START],
      },
      end: {
        kind: "set",
        values: [CAPACITY_SHOCK_PRIMARY_END, CAPACITY_SHOCK_ALTERNATIVE_END],
      },
    },
    resourceConstraints: {
      [CAPACITY_SHOCK_RESOURCE_KEYS.agent]: { kind: "equals", value: 3 },
      [CAPACITY_SHOCK_RESOURCE_KEYS.human]: { kind: "equals", value: 0 },
      [CAPACITY_SHOCK_RESOURCE_KEYS.production]: { kind: "equals", value: 24 },
    },
    objectiveId: createCapacityShockProposal().objective,
    promiseBasisId,
    approverId: CAPACITY_SHOCK_OWNER_ID,
    validFrom: CAPACITY_SHOCK_HORIZON_START,
    validUntil: CAPACITY_SHOCK_HORIZON_END,
    maxExecutions: 1,
  };
}

function deniedScope(
  promiseBasisId: string,
  effect: EffectFingerprint,
): ApprovalScope {
  return {
    ...capacityShockExecutionScope(promiseBasisId),
    allowedEffectSchemaVersions: [effect.effectSchemaVersion],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: effect.materialParameters.quantity },
      start: { kind: "equals", value: effect.materialParameters.start },
      end: { kind: "equals", value: effect.materialParameters.end },
    },
  };
}

function scheduleEffect(
  schema: EffectFingerprint["effectSchemaVersion"],
  start: string,
  end: string,
): EffectFingerprint {
  return {
    effectSchemaVersion: schema,
    environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
    operation: "reserve",
    materialParameters: { quantity: 8, start, end },
  };
}

function scheduleCommand(start: string, end: string): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: CAPACITY_SHOCK_ENVIRONMENT_ID,
    orderId: createCapacityShockProposal().obligationId,
    productionCellId: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
    quantity: 8,
    start,
    end,
  };
}

function scheduleArguments(attemptId: string, effect: EffectFingerprint): JsonValue {
  return asJson({
    scenario_id: "capacity-shock",
    execution_attempt_id: attemptId,
    claim: { effect },
    schedule_command: {
      schema_version: "microfactory-schedule-command/v1",
      command_kind: "create_schedule_reservation",
      environment_id: CAPACITY_SHOCK_ENVIRONMENT_ID,
      order_id: createCapacityShockProposal().obligationId,
      production_cell_id: CAPACITY_SHOCK_PRODUCTION_CELL_ID,
      quantity: 8,
      start: effect.materialParameters.start,
      end: effect.materialParameters.end,
    },
  });
}

function executionClaims(): Record<string, number> {
  return {
    [CAPACITY_SHOCK_RESOURCE_KEYS.agent]: 3,
    [CAPACITY_SHOCK_RESOURCE_KEYS.human]: 0,
    [CAPACITY_SHOCK_RESOURCE_KEYS.production]: 24,
  };
}

function capacityShockResult(
  store: FlakeBrakeStore,
  missionStore: M4MissionStore,
  sessionId: string,
  evidence: NonNullable<ReturnType<typeof readAuthoritativeFactoryExecution>>,
  replayedTerminal: boolean,
): CapacityShockMissionResult {
  const snapshot = missionStore.getSnapshot(CAPACITY_SHOCK_MISSION_ID);
  const approvals = snapshot.bridgeOutcomes
    .filter((outcome) => outcome.status === "approval_bound")
    .map((outcome) => outcome.result as unknown as M4ApprovalRecord)
    .sort((left, right) => left.turnId.localeCompare(right.turnId));
  const history = store.getAdmissionHistory();
  const staleBasisRejectionCount = history
    .flatMap((item) => item.addenda)
    .filter((item) => item.kind === "stale_superseded").length;
  const actualConsumptionFacts = history
    .flatMap((item) => item.addenda)
    .filter((item) => item.kind === "actual_consumption").length;
  const projectionDigest = stableTupleId("capacity-shock-terminal-projection", [
    CAPACITY_SHOCK_MISSION_ID,
    sessionId,
    approvals.map((approval) => approval.bridgeKey),
    evidence.result.receipt.receiptId,
    asJson(store.getExecutionAttempt(CAPACITY_SHOCK_ATTEMPT_ID).result),
  ]);
  return {
    mission: {
      status: "VERIFIED_COMPLETE",
      missionId: CAPACITY_SHOCK_MISSION_ID,
      trueforgeSessionId: sessionId,
      finalTurnId: "turn/capacity-shock/07-verified",
      approvals,
      disconnectedAndResumed: replayedTerminal,
      missionSnapshot: snapshot,
      projectionDigest,
    },
    rootAgentId: AGENT_ID,
    rootAgentName: "Capacity-shock obligation commander",
    finalAttempt: store.getExecutionAttempt(CAPACITY_SHOCK_ATTEMPT_ID),
    factoryExecution: evidence,
    activeDenials: store.getDenials(),
    actualConsumptionFacts,
    staleBasisRejectionCount,
  };
}

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalSerialize(value)) as JsonValue;
}
