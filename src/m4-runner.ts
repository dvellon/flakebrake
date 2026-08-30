import { existsSync } from "node:fs";

import {
  M4MissionController,
  deterministicM4OwnerDecisions,
  type M4MissionCheckpoint,
  type M4MissionRunResult,
  type M4OwnerDecisionProvider,
} from "./m4-mission-controller.js";
import { startDeterministicM4Model } from "./m4-deterministic-model.js";
import { M4MissionStore } from "./m4-mission-store.js";
import {
  startFactoryMcpHttpCluster,
} from "./mcp-http.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  createHeroInitialState,
} from "./hero-fixture.js";
import {
  SyntheticFactoryEnvironment,
  readAuthoritativeFactoryExecution,
} from "./factory-environment.js";
import { createStore } from "./store.js";
import {
  configureDeterministicModelProvider,
  ensureFlakeBrakeRootAgent,
  registerFactoryMcpConnectors,
  startTrueForgeServer,
  type RunningTrueForgeServer,
} from "./trueforge-runtime.js";
import {
  DeterministicM4RunnerOwnership,
  retainM4RunnerCleanupDiagnostics,
} from "./m4-runner-lifecycle.js";

export const M4_HERO_MISSION_ID = "mission/flakebrake-m4-hero";

export interface DeterministicM4MissionOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly trueforgeDatabasePath: string;
  readonly localSandboxRootParent: string;
  readonly signal?: AbortSignal;
  readonly missionId?: string;
  readonly ownerDecisionProvider?: M4OwnerDecisionProvider;
  readonly disconnectInitialStreamAfterEvents?: number;
  readonly checkpointObserver?: (
    checkpoint: M4MissionCheckpoint,
  ) => Promise<void> | void;
}

export interface DeterministicM4MissionResult {
  readonly mission: M4MissionRunResult;
  readonly rootAgentId: string;
  readonly rootAgentName: string;
  readonly connectorUrls: Readonly<Record<string, string>>;
  readonly subagentThreads: readonly {
    readonly threadId: string;
    readonly title: string;
  }[];
  readonly sandboxIds: readonly string[];
  readonly finalAttempt: ReturnType<ReturnType<typeof createStore>["getExecutionAttempt"]>;
  readonly finalFence: ReturnType<ReturnType<typeof createStore>["getExecutionFence"]>;
  readonly factoryExecution: ReturnType<typeof readAuthoritativeFactoryExecution>;
  readonly activeDenials: ReturnType<ReturnType<typeof createStore>["getDenials"]>;
  readonly actualConsumptionFacts: number;
  readonly trueforgeModelRequests: number;
}

export async function runDeterministicM4Mission(
  options: DeterministicM4MissionOptions,
): Promise<DeterministicM4MissionResult> {
  const ownership = new DeterministicM4RunnerOwnership(options.signal);
  ownership.throwIfAborted();
  initializeEnvironment(options);
  const missionId = options.missionId ?? M4_HERO_MISSION_ID;
  const missionStore = ownership.own(
    new M4MissionStore({
      path: options.missionDatabasePath,
      now: () => HERO_HORIZON_END,
    }),
    (store) => store.close(),
  );
  let trueforge: RunningTrueForgeServer | undefined;
  let primaryError: Error | undefined;
  try {
    const acquiredHttp = await ownership.acquire(
      () =>
        startFactoryMcpHttpCluster({
          factoryDatabasePath: options.factoryDatabasePath,
          m2DatabasePath: options.m2DatabasePath,
          now: () => HERO_HORIZON_END,
          enableM4Tools: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      (running) => running.close(),
    );
    const acquiredModel = await ownership.acquire(
      () =>
        startDeterministicM4Model({
          m2DatabasePath: options.m2DatabasePath,
          factoryDatabasePath: options.factoryDatabasePath,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      (running) => running.close(),
    );
    const acquiredTrueForge = await ownership.acquire(
      () =>
        startTrueForgeServer({
          sqlitePath: options.trueforgeDatabasePath,
          localSandboxRootParent: options.localSandboxRootParent,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      (running) => running.close(),
    );
    trueforge = acquiredTrueForge;
    const connectors = await ownership.wait(() =>
      registerFactoryMcpConnectors(acquiredTrueForge.client, acquiredHttp),
    );
    await ownership.wait(() =>
      configureDeterministicModelProvider(
        acquiredTrueForge.client,
        acquiredModel.baseUrl,
      ),
    );
    const agent = await ownership.wait(() =>
      ensureFlakeBrakeRootAgent(acquiredTrueForge.client),
    );
    const existing = missionStore.getSnapshotOrNull(missionId)?.mission ?? null;
    if (existing !== null && existing.trueforgeAgentId !== agent.id) {
      throw new Error("Persisted M4 mission is bound to a different TrueForge agent");
    }
    const sessionId =
      existing?.trueforgeSessionId ??
      (
        await ownership.wait(() =>
          acquiredTrueForge.client.sessions.create({
            agent: { name: agent.name },
          }),
        )
      ).data.id;
    if (existing !== null) {
      await ownership.wait(() =>
        acquiredTrueForge.client.sessions.get(sessionId),
      );
    }
    const controller = new M4MissionController({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: agent.id,
      trueforgeSessionId: sessionId,
      trueforgeClient: acquiredTrueForge.client,
      missionStore,
      m2DatabasePath: options.m2DatabasePath,
      factoryDatabasePath: options.factoryDatabasePath,
      ownerDecisionProvider:
        options.ownerDecisionProvider ?? deterministicM4OwnerDecisions(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      disconnectInitialStreamAfterEvents:
        options.disconnectInitialStreamAfterEvents ?? 4,
      ...(options.checkpointObserver === undefined
        ? {}
        : { checkpointObserver: options.checkpointObserver }),
    });
    const mission = await ownership.wait(() => controller.runToCompletion());
    const store = createStore({
      path: options.m2DatabasePath,
      authoritativeFactoryDatabasePath: options.factoryDatabasePath,
      now: () => HERO_HORIZON_END,
    });
    try {
      const attempt = store.getExecutionAttempt(
        "attempt/m4-approved-alternative",
      );
      const actualConsumptionFacts = store
        .getAdmissionHistory()
        .flatMap((admission) => admission.addenda)
        .filter((addendum) => addendum.kind === "actual_consumption").length;
      const connectorUrls = Object.fromEntries(connectors);
      const subagentThreads = mission.trueforgeEvents
        .filter(
          (item): item is typeof item & {
            readonly event: Extract<
              (typeof item)["event"],
              { readonly type: "thread.created" }
            >;
          } => item.event.type === "thread.created",
        )
        .map((item) => ({
          threadId: item.event.threadId,
          title: item.event.title,
        }));
      const sandboxIds = mission.trueforgeEvents
        .filter((item) => item.event.type === "sandbox.created")
        .map((item) =>
          item.event.type === "sandbox.created" ? item.event.sandboxId : "",
        );
      return {
        mission,
        rootAgentId: agent.id,
        rootAgentName: agent.name,
        connectorUrls,
        subagentThreads,
        sandboxIds,
        finalAttempt: attempt,
        finalFence: store.getExecutionFence(attempt.executionAttemptId),
        factoryExecution: readAuthoritativeFactoryExecution(
          options.factoryDatabasePath,
          attempt.executionAttemptId,
        ),
        activeDenials: store.getDenials(),
        actualConsumptionFacts,
        trueforgeModelRequests: acquiredModel.requestCount(),
      };
    } finally {
      store.close();
    }
  } catch (error: unknown) {
    primaryError = retainM4RunnerCleanupDiagnostics(
      missionFailure(error, options.signal, trueforge),
      ownership.cleanupFailures,
    );
    throw primaryError;
  } finally {
    const cleanupFailures = await ownership.close();
    if (primaryError === undefined && cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "Deterministic M4 mission teardown failed",
      );
    }
  }
}

function missionFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  trueforge: RunningTrueForgeServer | undefined,
): Error {
  if (signal?.aborted === true && error === signal.reason) {
    return error instanceof Error
      ? error
      : new Error(String(error), { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}${
      trueforge === undefined
        ? ""
        : `; TrueForge diagnostic: ${trueforge.safeDiagnosticLog()}`
    }`,
    { cause: error },
  );
}

function initializeEnvironment(options: DeterministicM4MissionOptions): void {
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
