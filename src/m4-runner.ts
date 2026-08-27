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
  type RunningFactoryMcpHttpCluster,
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
import type { RunningDeterministicM4Model } from "./m4-deterministic-model.js";

export const M4_HERO_MISSION_ID = "mission/flakebrake-m4-hero";

export interface DeterministicM4MissionOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly trueforgeDatabasePath: string;
  readonly localSandboxRootParent: string;
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
  initializeEnvironment(options);
  const missionId = options.missionId ?? M4_HERO_MISSION_ID;
  const missionStore = new M4MissionStore({
    path: options.missionDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  let http: RunningFactoryMcpHttpCluster | undefined;
  let model: RunningDeterministicM4Model | undefined;
  let trueforge: RunningTrueForgeServer | undefined;
  try {
    http = await startFactoryMcpHttpCluster({
      factoryDatabasePath: options.factoryDatabasePath,
      m2DatabasePath: options.m2DatabasePath,
      now: () => HERO_HORIZON_END,
      enableM4Tools: true,
    });
    model = await startDeterministicM4Model({
      m2DatabasePath: options.m2DatabasePath,
      factoryDatabasePath: options.factoryDatabasePath,
    });
    trueforge = await startTrueForgeServer({
      sqlitePath: options.trueforgeDatabasePath,
      localSandboxRootParent: options.localSandboxRootParent,
    });
    const connectors = await registerFactoryMcpConnectors(
      trueforge.client,
      http,
    );
    await configureDeterministicModelProvider(trueforge.client, model.baseUrl);
    const agent = await ensureFlakeBrakeRootAgent(trueforge.client);
    const existing = missionStore.getSnapshotOrNull(missionId)?.mission ?? null;
    if (existing !== null && existing.trueforgeAgentId !== agent.id) {
      throw new Error("Persisted M4 mission is bound to a different TrueForge agent");
    }
    const sessionId =
      existing?.trueforgeSessionId ??
      (
        await trueforge.client.sessions.create({
          agent: { name: agent.name },
        })
      ).data.id;
    if (existing !== null) {
      await trueforge.client.sessions.get(sessionId);
    }
    const controller = new M4MissionController({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: agent.id,
      trueforgeSessionId: sessionId,
      trueforgeClient: trueforge.client,
      missionStore,
      m2DatabasePath: options.m2DatabasePath,
      factoryDatabasePath: options.factoryDatabasePath,
      ownerDecisionProvider:
        options.ownerDecisionProvider ?? deterministicM4OwnerDecisions(),
      disconnectInitialStreamAfterEvents:
        options.disconnectInitialStreamAfterEvents ?? 4,
      ...(options.checkpointObserver === undefined
        ? {}
        : { checkpointObserver: options.checkpointObserver }),
    });
    const mission = await controller.runToCompletion();
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
        trueforgeModelRequests: model.requestCount(),
      };
    } finally {
      store.close();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}${
        trueforge === undefined
          ? ""
          : `; TrueForge diagnostic: ${trueforge.safeDiagnosticLog()}`
      }`,
      { cause: error },
    );
  } finally {
    missionStore.close();
    await trueforge?.close();
    await model?.close();
    await http?.close();
  }
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
