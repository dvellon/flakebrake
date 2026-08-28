import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { canonicalSerialize } from "./canonical.js";
import {
  M4MissionController,
  type M4ApprovalRecord,
  type M4MissionRunResult,
  type M4OwnerDecisionProvider,
} from "./m4-mission-controller.js";
import { M4MissionStore } from "./m4-mission-store.js";
import { startFactoryMcpHttpCluster } from "./mcp-http.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  createHeroInitialState,
} from "./hero-fixture.js";
import { SyntheticFactoryEnvironment } from "./factory-environment.js";
import { createStore, type FlakeBrakeStore } from "./store.js";
import {
  canonicalDatabasePath,
  readDatabaseInstanceIdentity,
} from "./sqlite.js";
import type { RunningFactoryMcpHttpCluster } from "./mcp-http.js";
import {
  ensureFlakeBrakeRootAgent,
  registerFactoryMcpConnectors,
  startTrueForgeServer,
  type RunningTrueForgeServer,
} from "./trueforge-runtime.js";

export const M4_LIVE_MISSION_ID = "mission/flakebrake-m4-live";

export type LiveM4AcquisitionStage =
  | "environment_initialized"
  | "http_started"
  | "trueforge_started"
  | "mission_store_opened"
  | "connectors_registered"
  | "model_provider_configured"
  | "sandbox_provider_configured"
  | "sandbox_provider_ready"
  | "agent_ready"
  | "session_ready";

export type LiveM4ValidationProfile =
  | "full_hero_evidence"
  | "operational_convergence";

export interface LiveM4MissionOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly trueforgeDatabasePath: string;
  readonly localSandboxRootParent: string;
  readonly m0TrueForgeDatabasePath: string;
  readonly model?: string;
  readonly validationProfile?: LiveM4ValidationProfile;
  readonly ownerDecisionProvider: M4OwnerDecisionProvider;
  readonly lifecycleObserver?: (
    stage: LiveM4AcquisitionStage,
  ) => Promise<void> | void;
  /** Deterministic acquisition barrier used by lock-concurrency verification. */
  readonly liveRunLockObserver?: (event: {
    readonly stage: "queued" | "acquired";
    readonly key: string;
  }) => Promise<void> | void;
}

export interface LiveM4MissionResult {
  readonly mission: M4MissionRunResult;
  readonly model: string;
  readonly sandboxProvider: "daytona";
  readonly connectorUrls: Readonly<Record<string, string>>;
  readonly subagentThreads: readonly {
    readonly threadId: string;
    readonly title: string;
  }[];
  readonly sandboxIds: readonly string[];
  readonly controlledWriteCount: number;
  readonly actualConsumptionFacts: number;
}

interface LiveResourceOwners {
  readonly missionStore: M4MissionStore | undefined;
  readonly clearMissionStore: () => void;
  readonly trueforge: RunningTrueForgeServer | undefined;
  readonly clearTrueForge: () => void;
  readonly http: RunningFactoryMcpHttpCluster | undefined;
  readonly clearHttp: () => void;
}

const LIVE_MISSION_RUNS = new Map<string, Promise<void>>();

/**
 * Separately invoked live acceptance run. Credentials are copied in memory
 * from the M0 TrueForge store into an isolated TrueForge 0.1.4 process and are
 * never returned, persisted in the repository, or logged by FlakeBrake.
 */
export async function runLiveM4Mission(
  options: LiveM4MissionOptions,
): Promise<LiveM4MissionResult> {
  if (typeof options.ownerDecisionProvider !== "function") {
    throw new TypeError(
      "An explicit external owner decision provider is required",
    );
  }
  if (
    typeof options.m0TrueForgeDatabasePath !== "string" ||
    options.m0TrueForgeDatabasePath.length === 0
  ) {
    throw new TypeError("An explicit M0 TrueForge database path is required");
  }
  const validationProfile = requireLiveValidationProfile(
    options.validationProfile ?? "full_hero_evidence",
  );
  const m0 = readM0Configuration(options.m0TrueForgeDatabasePath);
  const modelName = options.model ?? "openai/gpt-5-4-mini";
  if (!m0.modelNames.includes(modelName)) {
    throw new Error(
      `Live M4 smoke prerequisite is unavailable: model ${modelName} was not proven by M0`,
    );
  }
  const releaseMissionRun = await acquireLiveMissionRun(
    options,
  );
  try {
    let http: RunningFactoryMcpHttpCluster | undefined;
    let trueforge: RunningTrueForgeServer | undefined;
    let missionStore: M4MissionStore | undefined;
    let result: LiveM4MissionResult | undefined;
    let primaryFailure: unknown;
    try {
      initializeLiveEnvironment(options);
      await options.lifecycleObserver?.("environment_initialized");
      http = await startFactoryMcpHttpCluster({
        factoryDatabasePath: options.factoryDatabasePath,
        m2DatabasePath: options.m2DatabasePath,
        now: () => HERO_HORIZON_END,
        enableM4Tools: true,
      });
      await options.lifecycleObserver?.("http_started");
      trueforge = await startTrueForgeServer({
        sqlitePath: options.trueforgeDatabasePath,
        localSandboxRootParent: options.localSandboxRootParent,
      });
      await options.lifecycleObserver?.("trueforge_started");
      missionStore = new M4MissionStore({
        path: options.missionDatabasePath,
        now: () => HERO_HORIZON_END,
      });
      await options.lifecycleObserver?.("mission_store_opened");
      const connectors = await registerFactoryMcpConnectors(
        trueforge.client,
        http,
      );
      await options.lifecycleObserver?.("connectors_registered");
      await trueforge.client.settings.modelProviders.createOrUpdate({
        manifest: m0.modelProvider,
      });
      await options.lifecycleObserver?.("model_provider_configured");
      await trueforge.client.settings.sandboxProviders.createOrUpdate({
        manifest: m0.sandboxProvider,
      });
      await options.lifecycleObserver?.("sandbox_provider_configured");
      await waitForDaytona(trueforge.client);
      await options.lifecycleObserver?.("sandbox_provider_ready");
      const agent = await ensureFlakeBrakeRootAgent(
        trueforge.client,
        modelName,
      );
      await options.lifecycleObserver?.("agent_ready");
      let sessionId: string;
      const existing =
        missionStore.getSnapshotOrNull(M4_LIVE_MISSION_ID)?.mission;
      if (existing !== undefined && existing.trueforgeAgentId !== agent.id) {
        throw new Error(
          "Persisted live M4 mission is bound to a different TrueForge agent",
        );
      }
      sessionId =
        existing?.trueforgeSessionId ??
        (
          await trueforge.client.sessions.create({
            agent: { name: agent.name },
          })
        ).data.id;
      if (existing !== undefined) {
        await trueforge.client.sessions.get(sessionId);
      }
      missionStore.bindMission({
        missionId: M4_LIVE_MISSION_ID,
        environmentId: HERO_ENVIRONMENT_ID,
        trueforgeAgentId: agent.id,
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: readDatabaseInstanceIdentity(
          options.m2DatabasePath,
          "m2",
          HERO_ENVIRONMENT_ID,
        ),
        factoryEnvironmentIdentity: readDatabaseInstanceIdentity(
          options.factoryDatabasePath,
          "factory",
          HERO_ENVIRONMENT_ID,
        ),
      });
      await options.lifecycleObserver?.("session_ready");
      const controller = new M4MissionController({
        missionId: M4_LIVE_MISSION_ID,
        environmentId: HERO_ENVIRONMENT_ID,
        trueforgeAgentId: agent.id,
        trueforgeSessionId: sessionId,
        trueforgeClient: trueforge.client,
        missionStore,
        m2DatabasePath: options.m2DatabasePath,
        factoryDatabasePath: options.factoryDatabasePath,
        ownerDecisionProvider: options.ownerDecisionProvider,
        disconnectInitialStreamAfterEvents: 4,
      });
      const mission = await controller.runToCompletion();
      const store = createStore({ path: options.m2DatabasePath });
      const factory = new SyntheticFactoryEnvironment({
        path: options.factoryDatabasePath,
        now: () => HERO_HORIZON_END,
      });
      try {
        result = {
          mission,
          model: modelName,
          sandboxProvider: "daytona",
          connectorUrls: Object.fromEntries(connectors),
          subagentThreads: mission.trueforgeEvents
            .filter((item) => item.event.type === "thread.created")
            .map((item) =>
              item.event.type === "thread.created"
                ? {
                    threadId: item.event.threadId,
                    title: item.event.title,
                  }
                : { threadId: "", title: "" },
            ),
          sandboxIds: mission.trueforgeEvents
            .filter((item) => item.event.type === "sandbox.created")
            .map((item) =>
              item.event.type === "sandbox.created" ? item.event.sandboxId : "",
            ),
          controlledWriteCount: factory
            .getScheduleState()
            .reservations.filter(
              (reservation) => reservation.sourceExecutionAttemptId !== null,
            ).length,
          actualConsumptionFacts: store
            .getAdmissionHistory()
            .flatMap((admission) => admission.addenda)
            .filter((addendum) => addendum.kind === "actual_consumption")
            .length,
        };
        assertLiveMissionEvidence(result, store, factory, validationProfile);
      } finally {
        factory.close();
        store.close();
      }
    } catch (error: unknown) {
      primaryFailure = error;
    }
    const owners: LiveResourceOwners = {
      get missionStore() {
        return missionStore;
      },
      clearMissionStore() {
        missionStore = undefined;
      },
      get trueforge() {
        return trueforge;
      },
      clearTrueForge() {
        trueforge = undefined;
      },
      get http() {
        return http;
      },
      clearHttp() {
        http = undefined;
      },
    };
    const cleanupFailures = await cleanupLiveResources(owners);
    if (primaryFailure !== undefined) {
      attachCleanupDiagnostics(primaryFailure, cleanupFailures, () =>
        cleanupLiveResources(owners),
      );
      throw primaryFailure;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Live M4 cleanup failed");
    }
    if (result === undefined)
      throw new Error("Live M4 mission produced no result");
    return result;
  } finally {
    releaseMissionRun();
  }
}

async function acquireLiveMissionRun(
  options: LiveM4MissionOptions,
): Promise<() => void> {
  const keys = [
    options.factoryDatabasePath,
    options.m2DatabasePath,
    options.missionDatabasePath,
    options.trueforgeDatabasePath,
  ]
    .map((path) => `database:${canonicalLiveDatabasePath(path)}`)
    .filter((key, index, values) => values.indexOf(key) === index)
    .sort((left, right) => left.localeCompare(right));
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      releases.push(
        await acquireLiveResource(key, options.liveRunLockObserver),
      );
    }
  } catch (error: unknown) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

async function acquireLiveResource(
  key: string,
  observer: LiveM4MissionOptions["liveRunLockObserver"],
): Promise<() => void> {
  const predecessor = LIVE_MISSION_RUNS.get(key) ?? Promise.resolve();
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  const tail = predecessor.then(() => gate);
  LIVE_MISSION_RUNS.set(key, tail);
  const release = (): void => {
    releaseGate?.();
    if (LIVE_MISSION_RUNS.get(key) === tail) {
      LIVE_MISSION_RUNS.delete(key);
    }
  };
  try {
    await observer?.({ stage: "queued", key });
    await predecessor;
    await observer?.({ stage: "acquired", key });
    return release;
  } catch (error: unknown) {
    release();
    throw error;
  }
}

/** Resolve caller spellings to the one physical path used for live-run ownership. */
export function canonicalLiveDatabasePath(path: string): string {
  return canonicalDatabasePath(path);
}

async function cleanupLiveResources(
  owners: LiveResourceOwners,
): Promise<unknown[]> {
  let failures: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentFailures: unknown[] = [];
    if (owners.missionStore !== undefined) {
      try {
        owners.missionStore.close();
        owners.clearMissionStore();
      } catch (error: unknown) {
        currentFailures.push(error);
      }
    }
    if (owners.trueforge !== undefined) {
      try {
        await owners.trueforge.close();
        owners.clearTrueForge();
      } catch (error: unknown) {
        currentFailures.push(error);
      }
    }
    if (owners.http !== undefined) {
      try {
        await owners.http.close();
        owners.clearHttp();
      } catch (error: unknown) {
        currentFailures.push(error);
      }
    }
    failures = currentFailures;
    if (failures.length === 0) break;
  }
  return failures;
}

function attachCleanupDiagnostics(
  primary: unknown,
  failures: readonly unknown[],
  retryCleanup: () => Promise<unknown[]>,
): void {
  if (
    failures.length === 0 ||
    (typeof primary !== "object" && typeof primary !== "function") ||
    primary === null
  ) {
    return;
  }
  Object.defineProperties(primary, {
    cleanupDiagnostics: {
      configurable: true,
      enumerable: false,
      value: [...failures],
    },
    retryCleanup: {
      configurable: true,
      enumerable: false,
      value: retryCleanup,
    },
  });
}

export function assertLiveMissionEvidence(
  result: LiveM4MissionResult,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
  profile: LiveM4ValidationProfile = "full_hero_evidence",
): void {
  requireLiveValidationProfile(profile);
  assertGenuineExternalModelExecution(result);
  if (
    result.subagentThreads.length !== 3 ||
    new Set(result.subagentThreads.map((thread) => thread.threadId)).size !== 3
  ) {
    throw new Error(
      "Live M4 acceptance did not persist three distinct subagents",
    );
  }
  const assurance = result.subagentThreads.find(
    (thread) => thread.title === "Assurance and simulation engineer",
  );
  if (assurance === undefined) {
    throw new Error("Live M4 acceptance is missing the assurance subagent");
  }
  if (profile === "full_hero_evidence") {
    assertFullHeroAssuranceEvidence(result, assurance.threadId);
  }
  const route = validateLiveApprovalInvariants(result, store, factory);
  assertDurableHeroAcceptance(result, store, factory, route);
}

export function assertOperationalLiveConvergence(
  first: LiveM4MissionResult,
  second: LiveM4MissionResult,
): void {
  if (
    first.mission.missionId !== second.mission.missionId ||
    first.mission.trueforgeSessionId !== second.mission.trueforgeSessionId ||
    first.mission.finalTurnId !== second.mission.finalTurnId ||
    first.mission.projectionDigest !== second.mission.projectionDigest ||
    first.mission.status !== "VERIFIED_COMPLETE" ||
    second.mission.status !== "VERIFIED_COMPLETE"
  ) {
    throw new Error(
      "Operational live aliases did not converge on one terminal mission projection",
    );
  }
}

function assertGenuineExternalModelExecution(result: LiveM4MissionResult): void {
  if (
    !result.model.startsWith("openai/") ||
    !result.mission.trueforgeEvents.some(
      (item) => item.event.type === "model.message",
    )
  ) {
    throw new Error(
      "Live M4 validation requires genuine external-model execution",
    );
  }
}

function assertFullHeroAssuranceEvidence(
  result: LiveM4MissionResult,
  assuranceThreadId: string,
): void {
  const assuranceEvents = result.mission.trueforgeEvents
    .map((item) => item.event)
    .filter((event) => event.threadId === assuranceThreadId);
  const usedSandbox = assuranceEvents.some(
    (event) =>
      event.type === "model.message" &&
      event.toolCalls?.some(
        (toolCall) =>
          toolCall.toolInfo.type === "truefoundry-system" &&
          toolCall.toolInfo.name === "exec",
      ) === true,
  );
  const completed = assuranceEvents.some(
    (event) => event.type === "thread.done" && event.state.status === "done",
  );
  if (!usedSandbox || !completed) {
    throw new Error(
      "Live M4 assurance subagent did not complete genuine sandbox execution",
    );
  }
  if (
    result.sandboxIds.length === 0 ||
    !result.sandboxIds.every((sandboxId) => sandboxId.startsWith("v1:daytona:"))
  ) {
    throw new Error("Live M4 acceptance did not use the Daytona sandbox");
  }
}

function requireLiveValidationProfile(
  profile: LiveM4ValidationProfile,
): LiveM4ValidationProfile {
  if (
    profile !== "full_hero_evidence" &&
    profile !== "operational_convergence"
  ) {
    throw new TypeError(`Unsupported live validation profile ${String(profile)}`);
  }
  return profile;
}

interface LiveApprovalRoute {
  readonly denied: M4ApprovalRecord;
  readonly approved: M4ApprovalRecord;
}

/**
 * Validate safety properties that are independent of an external planner's
 * optional choice to demonstrate the active denial through a second adapter.
 */
export function assertLiveApprovalInvariants(
  result: LiveM4MissionResult,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
): void {
  validateLiveApprovalInvariants(result, store, factory);
}

function validateLiveApprovalInvariants(
  result: LiveM4MissionResult,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
): LiveApprovalRoute {
  const { missionSnapshot } = result.mission;
  const binding = missionSnapshot.mission;
  const approvals = [...result.mission.approvals];
  if (
    result.mission.status !== "VERIFIED_COMPLETE" ||
    binding.missionId !== result.mission.missionId ||
    binding.trueforgeSessionId !== result.mission.trueforgeSessionId ||
    binding.currentTurnId !== result.mission.finalTurnId ||
    result.mission.projectionDigest.length === 0
  ) {
    throw new Error(
      "Live M4 acceptance did not retain one bound terminal mission projection",
    );
  }
  const finalTurnDone = result.mission.trueforgeEvents.filter(
    (item) =>
      item.turnId === result.mission.finalTurnId &&
      item.event.type === "turn.done" &&
      item.event.state.status === "done",
  );
  if (finalTurnDone.length !== 1) {
    throw new Error("Live M4 acceptance did not retain exactly one completed final turn");
  }

  const approvalKeys = approvals.map((approval) => approval.bridgeKey);
  const approvalToolCalls = approvals.map((approval) => approval.toolCallId);
  if (
    new Set(approvalKeys).size !== approvals.length ||
    new Set(approvalToolCalls).size !== approvals.length
  ) {
    throw new Error("Live M4 acceptance contains duplicate approval identities");
  }
  const actions = missionSnapshot.bridgeActions;
  const actionByKey = new Map(actions.map((action) => [action.bridgeKey, action]));
  if (
    actions.length !== approvals.length ||
    new Set(actions.map((action) => action.bridgeKey)).size !== actions.length
  ) {
    throw new Error("Live M4 acceptance contains duplicate or unbound actions");
  }
  const outcomeKeys = missionSnapshot.bridgeOutcomes.map(
    (outcome) => `${outcome.bridgeKey}:${outcome.status}`,
  );
  if (new Set(outcomeKeys).size !== outcomeKeys.length) {
    throw new Error("Live M4 acceptance contains duplicate durable outcomes");
  }
  for (const approval of approvals) {
    const action = actionByKey.get(approval.bridgeKey);
    if (
      action === undefined ||
      action.missionId !== result.mission.missionId ||
      action.trueforgeSessionId !== result.mission.trueforgeSessionId ||
      action.trueforgeTurnId !== approval.turnId ||
      action.trueforgeThreadId !== approval.threadId ||
      action.trueforgeToolCallId !== approval.toolCallId ||
      action.toolName !== approval.toolName ||
      action.argumentsDigest !== digestCanonical(action.arguments)
    ) {
      throw new Error("Live M4 approval is not bound to its exact durable action");
    }
    const bound = missionSnapshot.bridgeOutcomes.filter(
      (outcome) =>
        outcome.bridgeKey === approval.bridgeKey &&
        outcome.status === "approval_bound",
    );
    if (
      bound.length !== 1 ||
      canonicalSerialize(bound[0]?.result) !== canonicalSerialize(approval)
    ) {
      throw new Error("Live M4 approval binding does not match its decision record");
    }
  }

  const selection = approvals.filter(
    (approval) => approval.toolName === "select_portfolio_modification",
  );
  if (
    selection.length !== 1 ||
    selection[0]?.source !== "owner" ||
    selection[0].decision !== "allow"
  ) {
    throw new Error("Live M4 requires exactly one owner-approved portfolio selection");
  }
  const acceptance = approvals.filter(
    (approval) => approval.toolName === "accept_promise",
  );
  if (
    acceptance.length !== 1 ||
    acceptance[0]?.source !== "owner" ||
    acceptance[0].decision !== "allow"
  ) {
    throw new Error("Live M4 requires exactly one owner-approved promise acceptance");
  }
  if (
    approvals.some(
      (approval) =>
        approval.toolName !== "select_portfolio_modification" &&
        approval.toolName !== "accept_promise" &&
        !isConsequentialScheduleTool(approval.toolName),
    )
  ) {
    throw new Error("Live M4 acceptance contains an unsupported approval action");
  }

  const ownerApprovals = approvals.filter(
    (approval) => approval.source === "owner",
  );
  const ownerConsequential = ownerApprovals.filter((approval) =>
    isConsequentialScheduleTool(approval.toolName),
  );
  const repeatedDenials = new Map<string, M4ApprovalRecord[]>();
  for (const approval of approvals.filter(
    (candidate) =>
      candidate.decision === "deny" && candidate.denialId !== null,
  )) {
    const denialId = approval.denialId;
    if (denialId === null) continue;
    const group = repeatedDenials.get(denialId) ?? [];
    group.push(approval);
    repeatedDenials.set(denialId, group);
  }
  for (const group of repeatedDenials.values()) {
    if (
      group.length > 1 &&
      (group.filter((approval) => approval.source === "owner").length !== 1 ||
        group.filter((approval) => approval.source === "active_m2_denial")
          .length !== group.length - 1)
    ) {
      throw new Error("Live M4 active M2 denial was reauthorized by an owner");
    }
  }
  const approved = ownerConsequential.filter(
    (approval) => approval.decision === "allow",
  );
  if (approved.length !== 1) {
    throw new Error(
      "Live M4 requires exactly one owner-approved consequential action",
    );
  }
  const denied = ownerConsequential.filter(
    (approval) => approval.decision === "deny",
  );
  if (denied.length !== 1) {
    throw new Error(
      "Live M4 requires exactly one owner-denied consequential action",
    );
  }
  if (ownerApprovals.length !== 4) {
    throw new Error("Live M4 requires exactly four external-owner calls");
  }

  const ownerOutcomes = missionSnapshot.bridgeOutcomes.filter(
    (outcome) => outcome.status === "owner_decision_received",
  );
  if (ownerOutcomes.length !== 4) {
    throw new Error("Live M4 durable owner-call count is not exactly four");
  }
  const ownerRequestDigests = new Set<string>();
  for (const approval of ownerApprovals) {
    if (
      approval.ownerSourceIdentity === null ||
      approval.ownerSourceIdentity.trim().length === 0
    ) {
      throw new Error("Live M4 owner approval is missing its owner source");
    }
    const action = actionByKey.get(approval.bridgeKey);
    if (action === undefined) {
      throw new Error("Live M4 owner approval has no durable action");
    }
    const expectedRequestDigest = digestCanonical({
      missionId: action.missionId,
      trueforgeSessionId: action.trueforgeSessionId,
      trueforgeTurnId: action.trueforgeTurnId,
      trueforgeThreadId: action.trueforgeThreadId,
      trueforgeToolCallId: action.trueforgeToolCallId,
      toolName: action.toolName,
      arguments: action.arguments,
      m2DatabaseInstanceIdentity: binding.m2EnvironmentIdentity,
      factoryDatabaseInstanceIdentity: binding.factoryEnvironmentIdentity,
      phase: ownerPhase(action.toolName),
    });
    const outcomes = ownerOutcomes.filter(
      (outcome) => outcome.bridgeKey === approval.bridgeKey,
    );
    const durable = jsonRecord(outcomes[0]?.result, "owner decision");
    const decision = jsonRecord(durable["decision"], "owner decision status");
    if (
      outcomes.length !== 1 ||
      durable["requestDigest"] !== expectedRequestDigest ||
      durable["ownerSourceIdentity"] !== approval.ownerSourceIdentity ||
      decision["status"] !== approval.decision
    ) {
      throw new Error(
        "Live M4 owner decision does not match its exact action digest and source",
      );
    }
    ownerRequestDigests.add(expectedRequestDigest);
  }
  if (ownerRequestDigests.size !== 4) {
    throw new Error("Live M4 external-owner calls are not distinct");
  }

  const deniedApproval = denied[0];
  const approvedApproval = approved[0];
  if (deniedApproval === undefined || approvedApproval === undefined) {
    throw new Error("Live M4 consequential route is incomplete");
  }

  const mechanicalDenials = approvals.filter(
    (approval) => approval.source === "active_m2_denial",
  );
  if (mechanicalDenials.length > 1) {
    throw new Error("Live M4 contains duplicate active-M2 denial effects");
  }
  for (const mechanical of mechanicalDenials) {
    if (
      mechanical.decision !== "deny" ||
      mechanical.ownerSourceIdentity !== null ||
      mechanical.denialId === null ||
      mechanical.denialId !== deniedApproval.denialId ||
      ownerOutcomes.some((outcome) => outcome.bridgeKey === mechanical.bridgeKey)
    ) {
      throw new Error(
        "Live M4 equivalent active-denial action was not mechanically denied",
      );
    }
  }

  const approvedAction = actionByKey.get(approvedApproval.bridgeKey);
  const approvedAttemptId = approvedApproval.executionAttemptId;
  if (
    approvedAction === undefined ||
    approvedAttemptId === null ||
    actionAttemptId(
      jsonRecord(approvedAction.arguments, "approved schedule arguments"),
    ) !== approvedAttemptId ||
    approvedApproval.denialId !== null
  ) {
    throw new Error(
      "Live M4 approved consequential action is not bound to one attempt",
    );
  }
  const deniedApprovals = approvals.filter(
    (approval) => approval.decision === "deny",
  );
  for (const rejected of deniedApprovals) {
    const action = actionByKey.get(rejected.bridgeKey);
    if (action === undefined) {
      throw new Error("Live M4 denied action has no durable action");
    }
    const attemptId = actionAttemptId(
      jsonRecord(action.arguments, "denied schedule arguments"),
    );
    if (
      rejected.executionAttemptId !== null ||
      attemptId === approvedAttemptId ||
      factory.readAuthoritativeExecution(attemptId) !== null
    ) {
      throw new Error("Live M4 denied action produced an unauthorized mutation");
    }
  }

  const history = store.getAdmissionHistory();
  const executionFacts = history
    .flatMap((admission) => admission.addenda)
    .filter((addendum) => addendum.kind === "execution_attempt");
  const executionAttemptIds = new Set(
    executionFacts.map((addendum) =>
      String(
        jsonRecord(addendum.body, "execution-attempt fact")[
          "executionAttemptId"
        ],
      ),
    ),
  );
  const acceptances = history
    .flatMap((admission) => admission.addenda)
    .filter((addendum) => addendum.kind === "acceptance_commit");
  const actuals = history
    .flatMap((admission) => admission.addenda)
    .filter((addendum) => addendum.kind === "actual_consumption");
  const reservations = store.getReservations(true);
  const evidence = factory.readAuthoritativeExecution(approvedAttemptId);
  if (
    result.controlledWriteCount !== 1 ||
    factory.getMutationCount() !== 1
  ) {
    throw new Error("Live M4 acceptance did not conserve one mutation");
  }
  if (
    executionAttemptIds.size !== 1 ||
    !executionAttemptIds.has(approvedAttemptId) ||
    acceptances.length !== 1
  ) {
    throw new Error("Live M4 acceptance duplicated its attempt or acceptance");
  }
  if (
    reservations.length !== 1 ||
    reservations[0]?.executionAttemptId !== approvedAttemptId ||
    reservations[0].claimState !== "terminal_verified"
  ) {
    throw new Error("Live M4 acceptance has a mixed or nonterminal attempt");
  }
  if (
    evidence === null ||
    evidence.request.executionAttemptId !== approvedAttemptId ||
    evidence.result.receipt.executionAttemptId !== approvedAttemptId
  ) {
    throw new Error("Live M4 mutation receipt is not bound to the approved action");
  }
  if (
    canonicalSerialize(evidence.request.claim) !==
    canonicalSerialize(
      jsonRecord(approvedAction.arguments, "approved schedule arguments")[
        "claim"
      ],
    )
  ) {
    throw new Error("Live M4 mutation claim does not match its approved action");
  }
  if (result.actualConsumptionFacts !== 2 || actuals.length !== 2) {
    throw new Error("Live M4 acceptance did not conserve two actual facts");
  }

  return { denied: deniedApproval, approved: approvedApproval };
}

function assertDurableHeroAcceptance(
  result: LiveM4MissionResult,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
  route: LiveApprovalRoute,
): void {
  const history = store.getAdmissionHistory();
  const initial = history.find(
    (candidate) =>
      candidate.record.portfolioVersion === "portfolio/v1" &&
      candidate.record.decision === "REPLAN",
  );
  const fresh = history.find((candidate) =>
    candidate.addenda.some(
      (addendum) =>
        addendum.kind === "readmission_link" &&
        jsonRecord(addendum.body, "M4 readmission link")["kind"] ===
          "M4_POST_MODIFICATION_ADMISSION",
    ),
  );
  if (
    initial === undefined ||
    fresh === undefined ||
    fresh.record.portfolioVersion !== "portfolio/v2" ||
    fresh.record.decision !== "ADMITTABLE" ||
    initial.addenda.some((addendum) => addendum.kind === "acceptance_commit") ||
    fresh.addenda.filter((addendum) => addendum.kind === "acceptance_commit")
      .length !== 1
  ) {
    throw new Error(
      "Live M4 acceptance did not bind Promise acceptance to one fresh v2 ADMITTABLE basis",
    );
  }

  const attempt = store.getExecutionAttempt("attempt/m4-approved-alternative");
  if (
    route.approved.executionAttemptId !== attempt.executionAttemptId ||
    attempt.admissionRecordId !== fresh.record.admissionRecordId ||
    attempt.result.grantExecutionOrdinal !== 1 ||
    attempt.input.resourceCapacityClaims["agent_work_units"] !== 6 ||
    attempt.input.resourceCapacityClaims["production_cell_minutes"] !== 30
  ) {
    throw new Error(
      "Live M4 execution was not bound to the exact fresh admission",
    );
  }
  const reservation = store
    .getReservations(true)
    .find(
      (candidate) =>
        candidate.executionAttemptId === attempt.executionAttemptId,
    );
  const fence = store.getExecutionFence(attempt.executionAttemptId);
  if (
    reservation?.claimState !== "terminal_verified" ||
    fence?.status !== "factory_result_bound" ||
    fence.resultBinding === null ||
    factory.getMutationCount() !== 1
  ) {
    throw new Error(
      "Live M4 root completion did not follow one receipt-bound terminal verification",
    );
  }

  const portfolio = store.getPortfolio();
  const initialProtected = createHeroInitialState().acceptedObligations.find(
    (order) => order.obligationId === "order/protected-medical",
  );
  const currentProtected = portfolio.acceptedObligations.find(
    (order) => order.obligationId === "order/protected-medical",
  );
  const bestEffort = portfolio.acceptedObligations.find(
    (order) => order.obligationId === "order/best-effort-display",
  );
  if (
    canonicalSerialize(currentProtected) !==
      canonicalSerialize(initialProtected) ||
    bestEffort?.serviceLevel["quantity"] !== 8
  ) {
    throw new Error(
      "Live M4 acceptance changed protected work or missed the approved quantity reduction",
    );
  }

  const actuals = fresh.addenda
    .filter((addendum) => addendum.kind === "actual_consumption")
    .map((addendum) => jsonRecord(addendum.body, "actual consumption"));
  const actualByResource = new Map(
    actuals.map((actual) => [
      actual["resourceKey"],
      actual["actualConsumption"],
    ]),
  );
  if (
    actualByResource.get("agent_work_units") !== 6 ||
    actualByResource.get("production_cell_minutes") !== 30
  ) {
    throw new Error(
      "Live M4 actual consumption was not exactly agent 6 and production 30",
    );
  }

  const actions = result.mission.missionSnapshot.bridgeActions;
  const denied = actions.find(
    (action) => action.bridgeKey === route.denied.bridgeKey,
  );
  const allowed = actions.find(
    (action) => action.bridgeKey === route.approved.bridgeKey,
  );
  const deniedArguments = jsonRecord(
    denied?.arguments,
    "denied schedule arguments",
  );
  const allowedArguments = jsonRecord(
    allowed?.arguments,
    "approved schedule arguments",
  );
  const deniedInterval = scheduleEffectInterval(deniedArguments);
  const allowedInterval = scheduleEffectInterval(allowedArguments);
  if (
    deniedInterval.start !== "2026-08-26T09:10:00.000Z" ||
    deniedInterval.end !== "2026-08-26T09:40:00.000Z" ||
    allowedInterval.start !== "2026-08-26T09:40:00.000Z" ||
    allowedInterval.end !== "2026-08-26T10:10:00.000Z"
  ) {
    throw new Error(
      "Live M4 denial or approved alternative interval was not exact",
    );
  }

  assertIndependentVerificationOrder(result, route.approved.toolName);
}

function isConsequentialScheduleTool(toolName: string): boolean {
  return (
    toolName === "create_schedule_reservation" ||
    toolName === "submit_schedule_change"
  );
}

function ownerPhase(
  toolName: string,
): "portfolio_modification" | "promise_choice" | "consequential_effect" {
  if (toolName === "select_portfolio_modification") {
    return "portfolio_modification";
  }
  if (toolName === "accept_promise") return "promise_choice";
  return "consequential_effect";
}

function actionAttemptId(
  arguments_: Readonly<Record<string, unknown>>,
): string {
  const attemptId = arguments_["execution_attempt_id"];
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw new Error("Live M4 consequential action has no execution attempt identity");
  }
  return attemptId;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex")}`;
}

function scheduleEffectInterval(
  arguments_: Readonly<Record<string, unknown>>,
): { readonly start: unknown; readonly end: unknown } {
  const claim = jsonRecord(arguments_["claim"], "schedule claim");
  const effect = jsonRecord(claim["effect"], "schedule effect");
  const material = jsonRecord(
    effect["materialParameters"],
    "schedule material parameters",
  );
  return { start: material["start"], end: material["end"] };
}

function assertIndependentVerificationOrder(
  result: LiveM4MissionResult,
  mutationToolName: string,
): void {
  const events = result.mission.trueforgeEvents.map((item) => item.event);
  const toolNames = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "model.message") continue;
    for (const call of event.toolCalls ?? []) {
      if (call.type === "function")
        toolNames.set(call.id, persistedToolName(call));
    }
  }
  const responseIndexes = (name: string): number[] =>
    events.flatMap((event, index) =>
      event.type === "tool.response" && toolNames.get(event.toolCallId) === name
        ? [index]
        : [],
    );
  const mutations = responseIndexes(mutationToolName);
  const reads = responseIndexes("read_schedule_state");
  const verifications = responseIndexes("verify_schedule_execution");
  const mutation = mutations.at(-1) ?? -1;
  const verification = verifications.at(-1) ?? -1;
  const independentRead = reads.some(
    (index) => index > mutation && index < verification,
  );
  const finalTurnDone = result.mission.trueforgeEvents.some(
    (item) =>
      item.turnId === result.mission.finalTurnId &&
      item.event.type === "turn.done" &&
      item.event.state.status === "done",
  );
  if (
    mutation < 0 ||
    !independentRead ||
    verification <= mutation ||
    !finalTurnDone
  ) {
    throw new Error(
      `Live M4 did not read back before verification or retain its completed final provider turn (mutation=${String(
        mutation,
      )}, reads=${reads.join(",")}, verification=${String(
        verification,
      )}, finalTurnDone=${String(finalTurnDone)})`,
    );
  }
}

function persistedToolName(call: TrueForgeApi.ToolCall): string {
  if (call.function.name !== "call_tool") return call.function.name;
  try {
    const envelope = jsonRecord(
      JSON.parse(call.function.arguments) as unknown,
      "generic MCP call",
    );
    return typeof envelope["tool_name"] === "string"
      ? envelope["tool_name"]
      : call.function.name;
  } catch {
    return call.function.name;
  }
}

function jsonRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

interface M0Configuration {
  readonly modelProvider: TrueForgeApi.ModelProviderManifest;
  readonly sandboxProvider: TrueForgeApi.SandboxProviderManifest;
  readonly modelNames: readonly string[];
}

function readM0Configuration(path: string): M0Configuration {
  if (!existsSync(path)) {
    throw new Error(
      "Live M4 smoke prerequisites are unavailable: the M0 TrueForge database was not found",
    );
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const modelRow = database
      .prepare(
        `SELECT name, json(manifest) AS manifest
           FROM model_provider WHERE name = 'openai'`,
      )
      .get() as Record<string, unknown> | undefined;
    const sandboxRow = database
      .prepare(
        "SELECT json(manifest) AS manifest FROM sandbox_provider LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (modelRow === undefined || sandboxRow === undefined) {
      throw new Error(
        "Live M4 smoke prerequisites are unavailable: M0 provider records are missing",
      );
    }
    const model = objectFromJson(modelRow["manifest"], "M0 model provider");
    const sandbox = objectFromJson(
      sandboxRow["manifest"],
      "M0 sandbox provider",
    );
    const modelAuth = object(model["auth"], "M0 model auth");
    const sandboxAuth = object(sandbox["auth"], "M0 sandbox auth");
    const modelApiKey = requiredSecret(modelAuth["api_key"], "model");
    const daytonaApiKey = requiredSecret(sandboxAuth["api_key"], "Daytona");
    if (model["type"] !== "openai" || sandbox["type"] !== "daytona") {
      throw new Error(
        "Live M4 smoke prerequisites are unavailable: M0 did not prove OpenAI plus Daytona",
      );
    }
    const models = array(model["models"], "M0 models").map((value) => {
      const entry = object(value, "M0 model");
      const properties = object(entry["properties"], "M0 model properties");
      return {
        name: string(entry["name"], "M0 model name"),
        modelId: string(entry["model_id"], "M0 model id"),
        properties: {
          contextLength: integer(
            properties["context_length"],
            "M0 context length",
          ),
          maxOutputTokens: integer(
            properties["max_output_tokens"],
            "M0 max output tokens",
          ),
          reasoningEfforts: array(
            properties["reasoning_efforts"],
            "M0 reasoning efforts",
          ).map((value) => string(value, "M0 reasoning effort")),
        },
      };
    });
    const baseUrl = string(model["base_url"], "M0 model base URL");
    const modelProvider = {
      type: "openai",
      auth: { apiKey: modelApiKey },
      baseUrl,
      models,
    } as TrueForgeApi.ModelProviderManifest;
    const sandboxProvider: TrueForgeApi.SandboxProviderManifest = {
      type: "daytona",
      auth: { apiKey: daytonaApiKey },
      autoArchiveIntervalInMinutes: integer(
        sandbox["auto_archive_interval_in_minutes"],
        "M0 Daytona auto archive",
      ),
      autoDeleteIntervalInMinutes: integer(
        sandbox["auto_delete_interval_in_minutes"],
        "M0 Daytona auto delete",
      ),
      autoStopIntervalInMinutes: integer(
        sandbox["auto_stop_interval_in_minutes"],
        "M0 Daytona auto stop",
      ),
      execTimeoutMs: integer(
        sandbox["exec_timeout_ms"],
        "M0 Daytona exec timeout",
      ),
    };
    return {
      modelProvider,
      sandboxProvider,
      modelNames: models.map((entry) => `openai/${entry.name}`),
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Live M4")) {
      throw error;
    }
    throw new Error(
      "Live M4 smoke prerequisites are unavailable: the M0 configuration could not be read",
      { cause: error },
    );
  } finally {
    database.close();
  }
}

async function waitForDaytona(
  client: import("@truefoundry/trueforge-sdk").TrueForge,
): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const configured = await client.settings.sandboxProviders.get();
    if (configured.data.status === "ready") return;
    if (configured.data.status === "failed") {
      throw new Error(
        `Live M4 Daytona prerequisite failed to build: ${configured.data.statusReason ?? "unknown reason"}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Live M4 Daytona prerequisite build timed out");
}

function initializeLiveEnvironment(options: LiveM4MissionOptions): void {
  const store = createStore({
    path: options.m2DatabasePath,
    ...(existsSync(options.m2DatabasePath)
      ? {}
      : { initialState: createHeroInitialState() }),
    authoritativeFactoryDatabasePath: options.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: options.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  store.close();
  factory.close();
}

function objectFromJson(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "string") throw new TypeError(`${field} must be JSON`);
  return object(JSON.parse(value) as unknown, field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function requiredSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 8) {
    throw new Error(
      `Live M4 smoke prerequisites are unavailable: ${label} credentials are missing`,
    );
  }
  return value;
}
