import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { canonicalSerialize } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import type {
  ApprovalScope,
  ClaimExecutionInput,
  EffectFingerprint,
} from "./stateful-domain.js";
import {
  claimedExecutionReference,
  commandFromAttempt,
  factoryStateDigest,
  resultingScheduleState,
  SyntheticFactoryEnvironment,
  type AuthorizedScheduleMutation,
  type CanonicalScheduleCommand,
} from "./factory-environment.js";
import {
  createHeroInitialState,
  createHeroProposal,
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  HERO_OWNER_ID,
  HERO_PRODUCTION_CELL_ID,
  HERO_RESOURCE_KEYS,
} from "./hero-fixture.js";
import {
  RecoveryDemoFactoryInterruption,
  runWithRecoveryDemoFactoryInterruption,
} from "./recovery-demo-seam.js";
import { createStore, type FlakeBrakeStore } from "./store.js";

export const RECOVERY_DEMO_ATTEMPT_ID = "attempt/recovery-demo-approved";
export const RECOVERY_DEMO_START = "2026-08-26T09:40:00.000Z";
export const RECOVERY_DEMO_END = "2026-08-26T10:10:00.000Z";

export type RecoveryDemoBoundary =
  | "after_execution_fence_before_factory_mutation"
  | "after_factory_commit_before_m2_binding";

export interface RecoveryDemoPaths {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
}

export interface RecoveryDemoCounts {
  readonly acceptances: number;
  readonly attempts: number;
  readonly fences: number;
  readonly fenceBindings: number;
  readonly mutations: number;
  readonly receipts: number;
  readonly terminalEvents: number;
  readonly terminalFailures: number;
  readonly actualConsumptionFacts: number;
}

export interface RecoveryDemoEvidence {
  readonly boundary: RecoveryDemoBoundary;
  readonly attemptId: string;
  readonly fenceId: string;
  readonly fenceStatus: "active" | "factory_result_bound" | "released_without_mutation";
  readonly receiptId: string | null;
  readonly claimState:
    | "claimed_nonterminal"
    | "terminal_verified"
    | "terminal_failed_before_mutation"
    | "terminal_reconciled";
  readonly counts: RecoveryDemoCounts;
  readonly actualConsumption: readonly {
    readonly resourceKey: string;
    readonly workClassKey: string;
    readonly value: number;
  }[];
  readonly durableStateDigest: string;
  readonly exactOnce: boolean;
  readonly mixedTerminalFailureAndMutation: boolean;
}

export interface RecoveryDemoReplayEvidence extends RecoveryDemoEvidence {
  readonly executorReportedReplay: boolean;
  readonly verificationReportedReplay: boolean;
  readonly durableStateUnchanged: boolean;
}

export function interruptRecoveryDemonstration(
  paths: RecoveryDemoPaths,
  boundary: RecoveryDemoBoundary,
): RecoveryDemoEvidence {
  const request = prepareAuthorizedAttempt(paths);
  const store = openStore(paths);
  const factory = openFactory(paths);
  try {
    if (boundary === "after_execution_fence_before_factory_mutation") {
      store.createExecutionFence(
        {
          executionAttemptId: request.executionAttemptId,
          expectedCommandDigest: digest(request.command),
          executorAuthority: "factory-change-control/v1",
          environmentId: request.command.environmentId,
        },
        factory.getScheduleState(),
      );
    } else {
      let interruption: RecoveryDemoFactoryInterruption | null = null;
      try {
        runWithRecoveryDemoFactoryInterruption(() =>
          factory.executeAuthorizedScheduleMutation(store, request),
        );
      } catch (error: unknown) {
        if (!(error instanceof RecoveryDemoFactoryInterruption)) throw error;
        interruption = error;
      }
      if (interruption === null) {
        throw new Error("The deterministic factory-commit interruption was not reached");
      }
    }
  } finally {
    factory.close();
    store.close();
  }
  const evidence = inspectRecoveryDemo(paths, boundary);
  assertInterruptionEvidence(evidence);
  return evidence;
}

/** Opens and closes a fresh owner over the same durable databases without writing. */
export function restartRecoveryDemonstration(
  paths: RecoveryDemoPaths,
  boundary: RecoveryDemoBoundary,
): RecoveryDemoEvidence {
  const store = openStore(paths);
  const factory = openFactory(paths);
  try {
    store.getExecutionAttempt(RECOVERY_DEMO_ATTEMPT_ID);
    factory.getScheduleState();
  } finally {
    factory.close();
    store.close();
  }
  return inspectRecoveryDemo(paths, boundary);
}

export function recoverRecoveryDemonstration(
  paths: RecoveryDemoPaths,
  boundary: RecoveryDemoBoundary,
): RecoveryDemoEvidence {
  const store = openStore(paths);
  const factory = openFactory(paths);
  try {
    const request = requestFromDurableState(store, factory);
    if (boundary === "after_execution_fence_before_factory_mutation") {
      const mutation = factory.executeAuthorizedScheduleMutation(store, request);
      if (mutation.replayed) {
        throw new Error("Fence-boundary recovery unexpectedly replayed a prior mutation");
      }
    } else {
      const recovery = store.recoverExecutionFence(request.executionAttemptId);
      if (recovery.status !== "factory_result_bound") {
        throw new Error("Committed factory evidence did not recover its M2 fence binding");
      }
    }
    const verified = store.verifyExecutionAuthoritatively(
      request.executionAttemptId,
    );
    if (verified.claimState !== "terminal_verified" || verified.replayed) {
      throw new Error("Recovery did not create the single verified terminal event");
    }
  } finally {
    factory.close();
    store.close();
  }
  const evidence = inspectRecoveryDemo(paths, boundary);
  assertConvergedEvidence(evidence);
  return evidence;
}

export function replayCompletedRecoveryDemonstration(
  paths: RecoveryDemoPaths,
  boundary: RecoveryDemoBoundary,
): RecoveryDemoReplayEvidence {
  const before = durableStateDigest(paths);
  let executorReportedReplay = false;
  let verificationReportedReplay = false;
  const store = openStore(paths);
  const factory = openFactory(paths);
  try {
    const request = requestFromDurableState(store, factory);
    const mutation = factory.executeAuthorizedScheduleMutation(store, request);
    executorReportedReplay = mutation.replayed;
    const recovery = store.recoverExecutionFence(request.executionAttemptId);
    if (recovery.status !== "factory_result_bound") {
      throw new Error("Completed replay lost its durable factory-result binding");
    }
    const verification = store.verifyExecutionAuthoritatively(
      request.executionAttemptId,
    );
    verificationReportedReplay = verification.replayed;
  } finally {
    factory.close();
    store.close();
  }
  const after = durableStateDigest(paths);
  const evidence: RecoveryDemoReplayEvidence = {
    ...inspectRecoveryDemo(paths, boundary),
    executorReportedReplay,
    verificationReportedReplay,
    durableStateUnchanged: before === after,
  };
  assertConvergedEvidence(evidence);
  if (
    !evidence.executorReportedReplay ||
    !evidence.verificationReportedReplay ||
    !evidence.durableStateUnchanged
  ) {
    throw new Error("Completed replay was not a durable no-op");
  }
  return evidence;
}

export function inspectRecoveryDemo(
  paths: RecoveryDemoPaths,
  boundary: RecoveryDemoBoundary,
): RecoveryDemoEvidence {
  const store = openStore(paths);
  const factory = openFactory(paths);
  try {
    const attempt = store.getExecutionAttempt(RECOVERY_DEMO_ATTEMPT_ID);
    const fence = store.getExecutionFence(RECOVERY_DEMO_ATTEMPT_ID);
    if (fence === null) throw new Error("Recovery demonstration fence is missing");
    const reservation = store
      .getReservations(true)
      .find((candidate) => candidate.executionAttemptId === RECOVERY_DEMO_ATTEMPT_ID);
    if (reservation === undefined) {
      throw new Error("Recovery demonstration reservation is missing");
    }
    const factoryExecution = factory.readAuthoritativeExecution(
      RECOVERY_DEMO_ATTEMPT_ID,
    );
    const counts = readCounts(paths);
    const actualConsumption = store
      .getAdmissionHistory()
      .flatMap((entry) => entry.addenda)
      .filter((addendum) => addendum.kind === "actual_consumption")
      .map((addendum) => actualConsumptionValue(addendum.body))
      .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
    const exactOnce =
      counts.acceptances === 1 &&
      counts.attempts === 1 &&
      counts.fences === 1 &&
      counts.fenceBindings <= 1 &&
      counts.mutations <= 1 &&
      counts.receipts <= 1 &&
      counts.terminalEvents <= 1 &&
      counts.actualConsumptionFacts <= 2;
    return {
      boundary,
      attemptId: attempt.executionAttemptId,
      fenceId: fence.fenceId,
      fenceStatus: fence.status,
      receiptId: factoryExecution?.result.receipt.receiptId ?? null,
      claimState: reservation.claimState,
      counts,
      actualConsumption,
      durableStateDigest: durableStateDigest(paths),
      exactOnce,
      mixedTerminalFailureAndMutation:
        counts.terminalFailures > 0 && counts.mutations > 0,
    };
  } finally {
    factory.close();
    store.close();
  }
}

function prepareAuthorizedAttempt(paths: RecoveryDemoPaths): AuthorizedScheduleMutation {
  const store = createStore({
    path: paths.m2DatabasePath,
    initialState: createHeroInitialState(),
    authoritativeFactoryDatabasePath: paths.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  const factory = openFactory(paths);
  try {
    const initial = store.evaluateAndRecordAdmission({ proposal: createHeroProposal() });
    if (initial.decision !== "REPLAN") {
      throw new Error("Recovery demonstration hero did not produce REPLAN");
    }
    const selected = initial.candidatePlans.find(
      (candidate) =>
        candidate.feasible &&
        candidate.affectedObligations.some(
          (change) => change.optionId === "best-effort-order/reduce-to-8",
        ),
    );
    if (selected === undefined) {
      throw new Error("Recovery demonstration could not find the bounded hero replan");
    }
    const modification = store.recordOwnerDecision({
      kind: "MODIFY",
      admissionRecordId: initial.admissionRecordId,
      ownerDecisionId: "owner-decision/recovery-demo-replan",
      approverId: HERO_OWNER_ID,
      selectedPlanId: selected.candidatePlanId,
    });
    if (modification.status !== "READMITTED") {
      throw new Error("Recovery demonstration replan did not produce a readmission");
    }
    const accepted = modification.freshAdmissionRecord;
    const grant = store.acceptPromiseAndIssueGrant({
      acceptance: {
        admissionRecordId: accepted.admissionRecordId,
        selectedPlanId: selected.candidatePlanId,
        ownerDecisionId: "owner-decision/recovery-demo-accept",
        approverId: HERO_OWNER_ID,
        ownerSourceIdentity: "owner-source/deterministic-recovery-demo",
        expectedPortfolioVersion: accepted.portfolioVersion,
        expectedCapacityModelVersion: accepted.capacityModelVersion,
        expectedCapacityPlanVersion: accepted.capacityPlanVersion,
        expectedAuthorizationStateVersion: accepted.authorizationStateVersion,
        expectedCalibrationFrontierDigest: accepted.calibrationFrontierDigest,
      },
      grant: {
        grantId: "grant/recovery-demo/v1",
        grantVersion: "grant/v1",
        admissionRecordId: accepted.admissionRecordId,
        promiseBasisId: accepted.promiseBasisId,
        acceptedOwnerDecisionId: "owner-decision/recovery-demo-accept",
        ownerDecisionId: "owner-decision/recovery-demo-execution",
        selectedBundleId: "bundle/recovery-demo",
        selectedPlanId: selected.candidatePlanId,
        scope: recoveryApprovalScope(accepted.promiseBasisId),
        postDenialAuthorization: null,
      },
    });
    if (grant.acceptance.status !== "COMMITTED" || grant.grant === null) {
      throw new Error("Recovery demonstration acceptance and grant did not commit");
    }
    const before = factory.getScheduleState();
    const command = recoveryCommand();
    const expectedAfter = resultingScheduleState(
      before,
      RECOVERY_DEMO_ATTEMPT_ID,
      command,
    );
    const versions = store.getPortfolio().versions;
    const claim: ClaimExecutionInput = {
      executionAttemptId: RECOVERY_DEMO_ATTEMPT_ID,
      admissionRecordId: accepted.admissionRecordId,
      promiseBasisId: accepted.promiseBasisId,
      acceptedOwnerDecisionId: "owner-decision/recovery-demo-accept",
      grantOwnerDecisionId: "owner-decision/recovery-demo-execution",
      grantId: "grant/recovery-demo/v1",
      expectedGrantVersion: "grant/v1",
      grantAllowanceKey: grant.grant.grantAllowanceKey,
      effect: recoveryEffect(),
      affectedObligationIds: [createHeroProposal().obligationId],
      affectedResourceIds: [HERO_RESOURCE_KEYS.agent, HERO_RESOURCE_KEYS.production],
      resourceCapacityClaims: {
        [HERO_RESOURCE_KEYS.agent]: 6,
        [HERO_RESOURCE_KEYS.human]: 0,
        [HERO_RESOURCE_KEYS.production]: 30,
      },
      temporalClaim: {
        resourceKey: HERO_RESOURCE_KEYS.production,
        start: RECOVERY_DEMO_START,
        end: RECOVERY_DEMO_END,
        requiredDuration: 30,
        timeUnit: "minutes",
      },
      claimAccounting: "already_in_portfolio",
      selectedBundleId: "bundle/recovery-demo",
      selectedPlanId: selected.candidatePlanId,
      expectedEffect: command as unknown as JsonValue,
      expectedAfterState: expectedAfter as unknown as JsonValue,
      attemptedAt: HERO_HORIZON_START,
      expectedPortfolioVersion: versions.portfolioVersion,
      expectedCapacityModelVersion: versions.capacityModelVersion,
      expectedCapacityPlanVersion: versions.capacityPlanVersion,
      expectedAuthorizationStateVersion: versions.authorizationStateVersion,
      expectedCalibrationFrontierDigest: accepted.calibrationFrontierDigest,
    };
    const claimed = store.claimExecution(claim);
    if (claimed.status !== "CLAIMED" || claimed.replayed) {
      throw new Error("Recovery demonstration execution claim was not newly durable");
    }
    const attempt = store.getExecutionAttempt(RECOVERY_DEMO_ATTEMPT_ID);
    return {
      executionAttemptId: attempt.executionAttemptId,
      claim: claimedExecutionReference(attempt),
      command: commandFromAttempt(attempt),
      expectedBeforeStateVersion: before.stateVersion,
      expectedBeforeStateDigest: factoryStateDigest(before),
    };
  } finally {
    factory.close();
    store.close();
  }
}

function requestFromDurableState(
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
): AuthorizedScheduleMutation {
  const evidence = factory.readAuthoritativeExecution(RECOVERY_DEMO_ATTEMPT_ID);
  if (evidence !== null) return evidence.request;
  const attempt = store.getExecutionAttempt(RECOVERY_DEMO_ATTEMPT_ID);
  const before = factory.getScheduleState();
  return {
    executionAttemptId: attempt.executionAttemptId,
    claim: claimedExecutionReference(attempt),
    command: commandFromAttempt(attempt),
    expectedBeforeStateVersion: before.stateVersion,
    expectedBeforeStateDigest: factoryStateDigest(before),
  };
}

function recoveryCommand(): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: HERO_ENVIRONMENT_ID,
    orderId: createHeroProposal().obligationId,
    productionCellId: HERO_PRODUCTION_CELL_ID,
    quantity: 10,
    start: RECOVERY_DEMO_START,
    end: RECOVERY_DEMO_END,
  };
}

function recoveryEffect(): EffectFingerprint {
  return {
    effectSchemaVersion: "microfactory-effect/v1",
    environmentId: HERO_ENVIRONMENT_ID,
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: HERO_PRODUCTION_CELL_ID,
    operation: "reserve",
    materialParameters: {
      quantity: 10,
      start: RECOVERY_DEMO_START,
      end: RECOVERY_DEMO_END,
    },
  };
}

function recoveryApprovalScope(promiseBasisId: string): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: HERO_ENVIRONMENT_ID,
    allowedEffectSchemaVersions: ["microfactory-effect/v1"],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: [HERO_PRODUCTION_CELL_ID],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: 10 },
      start: { kind: "equals", value: RECOVERY_DEMO_START },
      end: { kind: "equals", value: RECOVERY_DEMO_END },
    },
    resourceConstraints: {
      [HERO_RESOURCE_KEYS.agent]: { kind: "equals", value: 6 },
      [HERO_RESOURCE_KEYS.human]: { kind: "equals", value: 0 },
      [HERO_RESOURCE_KEYS.production]: { kind: "equals", value: 30 },
    },
    objectiveId: createHeroProposal().objective,
    promiseBasisId,
    approverId: HERO_OWNER_ID,
    validFrom: HERO_HORIZON_START,
    validUntil: HERO_HORIZON_END,
    maxExecutions: 1,
  };
}

function openStore(paths: RecoveryDemoPaths): FlakeBrakeStore {
  return createStore({
    path: paths.m2DatabasePath,
    authoritativeFactoryDatabasePath: paths.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
}

function openFactory(paths: RecoveryDemoPaths): SyntheticFactoryEnvironment {
  return new SyntheticFactoryEnvironment({
    path: paths.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
}

function readCounts(paths: RecoveryDemoPaths): RecoveryDemoCounts {
  const m2 = new DatabaseSync(paths.m2DatabasePath, { readOnly: true });
  const factory = new DatabaseSync(paths.factoryDatabasePath, { readOnly: true });
  try {
    return {
      acceptances: count(m2, "SELECT COUNT(*) AS count FROM admission_addenda WHERE kind = 'acceptance_commit'"),
      attempts: count(m2, "SELECT COUNT(*) AS count FROM execution_attempts"),
      fences: count(m2, "SELECT COUNT(*) AS count FROM execution_fences"),
      fenceBindings: count(m2, "SELECT COUNT(*) AS count FROM execution_fence_events WHERE event_kind = 'factory_result_bound'"),
      mutations: count(factory, "SELECT COUNT(*) AS count FROM mutation_events"),
      receipts: count(factory, "SELECT COUNT(*) AS count FROM execution_results"),
      terminalEvents: count(m2, "SELECT COUNT(*) AS count FROM reservation_events"),
      terminalFailures: count(m2, "SELECT COUNT(*) AS count FROM reservation_events WHERE event_kind = 'terminal_failed_before_mutation'"),
      actualConsumptionFacts: count(m2, "SELECT COUNT(*) AS count FROM admission_addenda WHERE kind = 'actual_consumption'"),
    };
  } finally {
    factory.close();
    m2.close();
  }
}

function count(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row?.["count"];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Recovery demonstration count query returned invalid data");
  }
  return value as number;
}

function durableStateDigest(paths: RecoveryDemoPaths): string {
  return digest({
    m2: durableDatabaseProjection(paths.m2DatabasePath),
    factory: durableDatabaseProjection(paths.factoryDatabasePath),
  });
}

function durableDatabaseProjection(path: string): JsonValue {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => String(row["name"]));
    return Object.fromEntries(
      tables.map((table) => [
        table,
        database
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => row as JsonValue),
      ]),
    );
  } finally {
    database.close();
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value), "utf8")
    .digest("hex")}`;
}

function actualConsumptionValue(
  value: JsonValue,
): RecoveryDemoEvidence["actualConsumption"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery demonstration actual-consumption body is invalid");
  }
  const body = value as Readonly<Record<string, JsonValue>>;
  const resourceKey = body["resourceKey"];
  const workClassKey = body["workClassKey"];
  const amount = body["actualConsumption"];
  if (
    typeof resourceKey !== "string" ||
    typeof workClassKey !== "string" ||
    typeof amount !== "number"
  ) {
    throw new Error("Recovery demonstration actual-consumption fields are invalid");
  }
  return { resourceKey, workClassKey, value: amount };
}

function assertInterruptionEvidence(evidence: RecoveryDemoEvidence): void {
  const expectedMutationCount =
    evidence.boundary === "after_factory_commit_before_m2_binding" ? 1 : 0;
  if (
    evidence.fenceStatus !== "active" ||
    evidence.claimState !== "claimed_nonterminal" ||
    evidence.counts.fences !== 1 ||
    evidence.counts.fenceBindings !== 0 ||
    evidence.counts.mutations !== expectedMutationCount ||
    evidence.counts.receipts !== expectedMutationCount ||
    evidence.counts.terminalEvents !== 0 ||
    evidence.counts.actualConsumptionFacts !== 0 ||
    evidence.mixedTerminalFailureAndMutation ||
    !evidence.exactOnce
  ) {
    throw new Error("Recovery demonstration interruption evidence is inconsistent");
  }
}

function assertConvergedEvidence(evidence: RecoveryDemoEvidence): void {
  const actuals = new Map(
    evidence.actualConsumption.map((item) => [item.resourceKey, item.value]),
  );
  if (
    evidence.fenceStatus !== "factory_result_bound" ||
    evidence.claimState !== "terminal_verified" ||
    evidence.receiptId === null ||
    evidence.counts.acceptances !== 1 ||
    evidence.counts.attempts !== 1 ||
    evidence.counts.fences !== 1 ||
    evidence.counts.fenceBindings !== 1 ||
    evidence.counts.mutations !== 1 ||
    evidence.counts.receipts !== 1 ||
    evidence.counts.terminalEvents !== 1 ||
    evidence.counts.terminalFailures !== 0 ||
    evidence.counts.actualConsumptionFacts !== 2 ||
    actuals.get(HERO_RESOURCE_KEYS.agent) !== 6 ||
    actuals.get(HERO_RESOURCE_KEYS.production) !== 30 ||
    evidence.mixedTerminalFailureAndMutation ||
    !evidence.exactOnce
  ) {
    throw new Error("Recovery demonstration did not converge exactly once");
  }
}
