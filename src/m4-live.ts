import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  M4MissionController,
  deterministicM4OwnerDecisions,
  type M4MissionRunResult,
} from "./m4-mission-controller.js";
import { M4MissionStore } from "./m4-mission-store.js";
import { startFactoryMcpHttpCluster } from "./mcp-http.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  createHeroInitialState,
} from "./hero-fixture.js";
import { SyntheticFactoryEnvironment } from "./factory-environment.js";
import { createStore } from "./store.js";
import {
  ensureFlakeBrakeRootAgent,
  registerFactoryMcpConnectors,
  startTrueForgeServer,
} from "./trueforge-runtime.js";

export const M4_LIVE_MISSION_ID = "mission/flakebrake-m4-live";
export const DEFAULT_M0_TRUEFORGE_DATABASE_PATH =
  "/home/cd/.local/share/flakebrake/trueforge.sqlite";

export interface LiveM4MissionOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly trueforgeDatabasePath: string;
  readonly localSandboxRootParent: string;
  readonly m0TrueForgeDatabasePath?: string;
  readonly model?: string;
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

/**
 * Separately invoked live acceptance run. Credentials are copied in memory
 * from the M0 TrueForge store into an isolated TrueForge 0.1.4 process and are
 * never returned, persisted in the repository, or logged by FlakeBrake.
 */
export async function runLiveM4Mission(
  options: LiveM4MissionOptions,
): Promise<LiveM4MissionResult> {
  initializeLiveEnvironment(options);
  const m0 = readM0Configuration(
    options.m0TrueForgeDatabasePath ?? DEFAULT_M0_TRUEFORGE_DATABASE_PATH,
  );
  const modelName = options.model ?? "openai/gpt-5-4-mini";
  if (!m0.modelNames.includes(modelName)) {
    throw new Error(
      `Live M4 smoke prerequisite is unavailable: model ${modelName} was not proven by M0`,
    );
  }
  const http = await startFactoryMcpHttpCluster({
    factoryDatabasePath: options.factoryDatabasePath,
    m2DatabasePath: options.m2DatabasePath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  const trueforge = await startTrueForgeServer({
    sqlitePath: options.trueforgeDatabasePath,
    localSandboxRootParent: options.localSandboxRootParent,
  });
  const missionStore = new M4MissionStore({
    path: options.missionDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  try {
    const connectors = await registerFactoryMcpConnectors(
      trueforge.client,
      http,
    );
    await trueforge.client.settings.modelProviders.createOrUpdate({
      manifest: m0.modelProvider,
    });
    await trueforge.client.settings.sandboxProviders.createOrUpdate({
      manifest: m0.sandboxProvider,
    });
    await waitForDaytona(trueforge.client);
    const agent = await ensureFlakeBrakeRootAgent(trueforge.client, modelName);
    const session = await trueforge.client.sessions.create({
      agent: { name: agent.name },
    });
    const controller = new M4MissionController({
      missionId: M4_LIVE_MISSION_ID,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: agent.id,
      trueforgeSessionId: session.data.id,
      trueforgeClient: trueforge.client,
      missionStore,
      m2DatabasePath: options.m2DatabasePath,
      factoryDatabasePath: options.factoryDatabasePath,
      ownerDecisionProvider: deterministicM4OwnerDecisions(),
      disconnectInitialStreamAfterEvents: 4,
    });
    const mission = await controller.runToCompletion();
    const store = createStore({ path: options.m2DatabasePath });
    const factory = new SyntheticFactoryEnvironment({
      path: options.factoryDatabasePath,
      now: () => HERO_HORIZON_END,
    });
    try {
      const result: LiveM4MissionResult = {
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
          .filter((addendum) => addendum.kind === "actual_consumption").length,
      };
      assertLiveAcceptance(result);
      return result;
    } finally {
      factory.close();
      store.close();
    }
  } finally {
    missionStore.close();
    await trueforge.close();
    await http.close();
  }
}

function assertLiveAcceptance(result: LiveM4MissionResult): void {
  if (
    result.subagentThreads.length !== 3 ||
    new Set(result.subagentThreads.map((thread) => thread.threadId)).size !== 3
  ) {
    throw new Error("Live M4 acceptance did not persist three distinct subagents");
  }
  const assurance = result.subagentThreads.find(
    (thread) => thread.title === "Assurance and simulation engineer",
  );
  if (assurance === undefined) {
    throw new Error("Live M4 acceptance is missing the assurance subagent");
  }
  const assuranceEvents = result.mission.trueforgeEvents
    .map((item) => item.event)
    .filter((event) => event.threadId === assurance.threadId);
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
  const approvals = result.mission.approvals.map((approval) => [
    approval.toolName,
    approval.decision,
    approval.source,
  ]);
  const expected = [
    ["select_portfolio_modification", "allow", "owner"],
    ["accept_promise", "allow", "owner"],
    ["create_schedule_reservation", "deny", "owner"],
    ["submit_schedule_change", "deny", "active_m2_denial"],
    ["create_schedule_reservation", "allow", "owner"],
  ];
  if (JSON.stringify(approvals) !== JSON.stringify(expected)) {
    throw new Error("Live M4 acceptance approval sequence was not exact");
  }
  if (
    result.controlledWriteCount !== 1 ||
    result.actualConsumptionFacts !== 2
  ) {
    throw new Error("Live M4 acceptance did not conserve exact-once effects");
  }
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
      .prepare("SELECT json(manifest) AS manifest FROM sandbox_provider LIMIT 1")
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

function objectFromJson(value: unknown, field: string): Record<string, unknown> {
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
