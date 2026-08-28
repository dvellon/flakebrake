import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { canonicalSerialize, compareStableStrings } from "./canonical.js";
import type {
  AcceptedObligation,
  AdmissionResult,
  JsonValue,
  ProposedObligation,
  ReplanCandidate,
} from "./domain.js";
import {
  StatefulInputError,
  type AdmissionRecordBody,
  type ApprovalScope,
  type OwnerDecisionInput,
} from "./stateful-domain.js";
import {
  type AuthorizedScheduleMutation,
  type CanonicalScheduleCommand,
  SyntheticFactoryEnvironment,
} from "./factory-environment.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  createHeroProposal,
} from "./hero-fixture.js";
import {
  m4AcceptanceArgumentsFromStore,
  m4MutationToolArgumentsFromHandles,
  m4PortfolioModificationArgumentsFromStore,
} from "./m4-deterministic-model.js";
import { stableTupleId } from "./identity.js";
import { StrictJsonLineInput } from "./mcp-stdio-guard.js";
import { createStore } from "./store.js";
import type { FlakeBrakeStore } from "./store.js";
import {
  canonicalDatabasePath,
  canonicalJson,
  parseCanonicalJson,
  readDatabaseInstanceIdentity,
} from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite.js";
import { advanceVersions, readVersions } from "./versioning.js";

export const FACTORY_MCP_SERVICE_NAMES = [
  "factory-orders",
  "factory-capacity",
  "factory-simulator",
  "factory-change-control",
] as const;

export type FactoryMcpServiceName =
  (typeof FACTORY_MCP_SERVICE_NAMES)[number];

export interface FactoryMcpServiceOptions {
  readonly factoryDatabasePath: string;
  readonly m2DatabasePath: string;
  readonly now?: () => string;
  /** Additive M4 owner-decision and authoritative-verification tools. */
  readonly enableM4Tools?: boolean;
  readonly databaseOperationObserver?: (
    event: FactoryDatabaseOperationEvent,
  ) => void;
}

export interface FactoryDatabaseOperationEvent {
  readonly operation: string;
  readonly stage:
    | "before_open"
    | "after_first_open"
    | "handles_validated"
    | "before_operation";
  readonly openedKinds: readonly ("factory" | "m2")[];
}

export interface FactoryMcpDatabaseBinding {
  readonly factoryIdentity: string;
  readonly m2Identity: string;
}

export interface RunningFactoryMcpService {
  readonly serviceName: FactoryMcpServiceName;
  readonly server: McpServer;
  readonly close: () => Promise<void>;
}

export interface FactoryMcpClientConnection {
  readonly serviceName: FactoryMcpServiceName;
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

export interface RunningFactoryMcpCluster {
  readonly transport: "stdio";
  readonly services: ReadonlyMap<
    FactoryMcpServiceName,
    FactoryMcpClientConnection
  >;
  readonly close: () => Promise<void>;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CONSEQUENTIAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const LEDGER_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const noArgumentsSchema = z.object({}).strict();

const effectSchema = z
  .object({
    effectSchemaVersion: z.enum([
      "microfactory-effect/v1",
      "microfactory-effect/v2",
    ]),
    environmentId: z.string().min(1).max(128),
    effectType: z.literal("schedule_reservation"),
    targetType: z.literal("production_cell"),
    targetId: z.string().min(1).max(128),
    operation: z.literal("reserve"),
    materialParameters: z
      .object({
        quantity: z.number().int().positive().max(10_000),
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

const scheduleReservationSchema = z
  .object({
    reservationId: z.string().min(1).max(256),
    orderId: z.string().min(1).max(256),
    productionCellId: z.string().min(1).max(128),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    quantity: z.number().int().positive().max(10_000),
    status: z.enum(["committed", "reserved"]),
    sourceExecutionAttemptId: z.string().min(1).max(256).nullable(),
  })
  .strict();

const scheduleStateSchema = z
  .object({
    schemaVersion: z.literal("microfactory-schedule-state/v1"),
    environmentId: z.string().min(1).max(128),
    stateVersion: z.string().regex(/^factory-state\/v[1-9][0-9]*$/u),
    reservations: z.array(scheduleReservationSchema).max(10_000),
  })
  .strict();

const claimReferenceSchema = z
  .object({
    admissionRecordId: z.string().min(1).max(256),
    promiseBasisId: z.string().min(1).max(256),
    acceptedOwnerDecisionId: z.string().min(1).max(256),
    grantOwnerDecisionId: z.string().min(1).max(256),
    grantId: z.string().min(1).max(256),
    expectedGrantVersion: z.string().min(1).max(128),
    grantAllowanceKey: z.string().min(1).max(256),
    grantExecutionOrdinal: z.number().int().positive().max(1_000_000),
    selectedBundleId: z.string().min(1).max(256),
    selectedPlanId: z.string().min(1).max(256),
    expectedPortfolioVersion: z.string().min(1).max(128),
    expectedCapacityModelVersion: z.string().min(1).max(128),
    expectedCapacityPlanVersion: z.string().min(1).max(128),
    expectedAuthorizationStateVersion: z.string().min(1).max(128),
    expectedCalibrationFrontierDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u),
    effect: effectSchema,
    expectedAfterState: scheduleStateSchema,
  })
  .strict();

const commonMutationFields = {
  execution_attempt_id: z.string().min(1).max(256),
  claim: claimReferenceSchema,
  expected_before_state_version: z
    .string()
    .regex(/^factory-state\/v[1-9][0-9]*$/u),
  expected_before_state_digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u),
} as const;

const scheduleCommandSchema = z
  .object({
    schema_version: z.literal("microfactory-schedule-command/v1"),
    command_kind: z.literal("create_schedule_reservation"),
    environment_id: z.string().min(1).max(128),
    order_id: z.string().min(1).max(256),
    production_cell_id: z.string().min(1).max(128),
    quantity: z.number().int().positive().max(10_000),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict();

const createReservationInputSchema = z
  .object({
    ...commonMutationFields,
    schedule_command: scheduleCommandSchema,
  })
  .strict();

const scheduleChangeSchema = z
  .object({
    schema_version: z.literal("microfactory-schedule-change/v1"),
    operation: z.literal("reserve_cell"),
    environment_id: z.string().min(1).max(128),
    order_id: z.string().min(1).max(256),
    cell_id: z.string().min(1).max(128),
    quantity: z.number().int().positive().max(10_000),
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
  })
  .strict();

const submitChangeInputSchema = z
  .object({
    ...commonMutationFields,
    schedule_change: scheduleChangeSchema,
  })
  .strict();

const simulationInputSchema = z
  .object({
    evaluation_input: z.record(z.string(), z.unknown()),
  })
  .strict();

const typedConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("equals"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal("set"), values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("range"), minimum: z.number().finite(), maximum: z.number().finite() }).strict(),
]);

const approvalScopeSchema = z
  .object({
    scopeSchemaVersion: z.literal("microfactory-approval-scope/v1"),
    environmentId: z.string().min(1).max(128),
    allowedEffectSchemaVersions: z
      .array(z.enum(["microfactory-effect/v1", "microfactory-effect/v2"]))
      .min(1)
      .max(2),
    allowedEffectTypes: z.array(z.literal("schedule_reservation")).min(1).max(1),
    allowedTargetTypes: z.array(z.literal("production_cell")).min(1).max(1),
    allowedTargetIds: z.array(z.string().min(1).max(128)).min(1).max(16),
    allowedOperations: z.array(z.literal("reserve")).min(1).max(1),
    materialParameterConstraints: z.record(z.string().min(1).max(128), typedConstraintSchema),
    resourceConstraints: z.record(z.string().min(1).max(128), typedConstraintSchema),
    objectiveId: z.string().min(1).max(512),
    promiseBasisId: z.string().min(1).max(256),
    approverId: z.string().min(1).max(256),
    validFrom: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    maxExecutions: z.number().int().positive().max(32),
  })
  .strict();

const selectPortfolioModificationSchema = z
  .object({
    admission_record_id: z.string().min(1).max(256),
    selected_plan_id: z.string().min(1).max(256),
    owner_decision_id: z.string().min(1).max(256),
    approver_id: z.string().min(1).max(256),
  })
  .strict();

const acceptPromiseSchema = z
  .object({
    admission_record_id: z.string().min(1).max(256),
    selected_plan_id: z.string().min(1).max(256),
    owner_decision_id: z.string().min(1).max(256),
    approver_id: z.string().min(1).max(256),
    expected_portfolio_version: z.string().min(1).max(128),
    expected_capacity_model_version: z.string().min(1).max(128),
    expected_capacity_plan_version: z.string().min(1).max(128),
    expected_authorization_state_version: z.string().min(1).max(128),
    expected_calibration_frontier_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    grant: z
      .object({
        grant_id: z.string().min(1).max(256),
        grant_version: z.string().min(1).max(128),
        grant_owner_decision_id: z.string().min(1).max(256),
        selected_bundle_id: z.string().min(1).max(256),
        scope: approvalScopeSchema,
      })
      .strict(),
  })
  .strict();

const executionStatusSchema = z
  .object({ execution_attempt_id: z.string().min(1).max(256) })
  .strict();

const prepareScheduleEffectSchema = z
  .object({
    tool_name: z.enum([
      "create_schedule_reservation",
      "submit_schedule_change",
    ]),
    execution_attempt_id: z.string().min(1).max(256),
    effect_schema_version: z.enum([
      "microfactory-effect/v1",
      "microfactory-effect/v2",
    ]),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict();

export function createFactoryMcpService(
  serviceName: FactoryMcpServiceName,
  options: FactoryMcpServiceOptions,
  durableBinding?: FactoryMcpDatabaseBinding,
): RunningFactoryMcpService {
  requireDatabasePath(options.factoryDatabasePath, "factoryDatabasePath");
  requireDatabasePath(options.m2DatabasePath, "m2DatabasePath");
  const server = new McpServer(
    { name: serviceName, version: "0.1.0-m3" },
    { instructions: instructionsFor(serviceName) },
  );
  const authoritativeNow = options.now ?? (() => HERO_HORIZON_END);
  let factory: SyntheticFactoryEnvironment | null = null;
  let m2Store: FlakeBrakeStore | null = null;
  try {
    factory =
      serviceName === "factory-capacity"
        ? null
        : new SyntheticFactoryEnvironment({
            path: options.factoryDatabasePath,
            now: authoritativeNow,
          });
    m2Store = createStore({
      path: options.m2DatabasePath,
      authoritativeFactoryDatabasePath: options.factoryDatabasePath,
      now: authoritativeNow,
    });

    switch (serviceName) {
      case "factory-orders":
        registerOrdersTools(
          server,
          requireM2Store(m2Store),
          requireFactory(factory),
        );
        break;
      case "factory-capacity":
        registerCapacityTools(server, requireM2Store(m2Store));
        break;
      case "factory-simulator":
        registerSimulatorTools(
          server,
          requireM2Store(m2Store),
          requireFactory(factory),
        );
        break;
      case "factory-change-control": {
        const context: ChangeControlDatabaseContext = {
          factoryDatabasePath: options.factoryDatabasePath,
          m2DatabasePath: options.m2DatabasePath,
          now: authoritativeNow,
          expectedFactoryIdentity:
            durableBinding?.factoryIdentity ??
            requireFactory(factory).databaseInstanceIdentity(),
          expectedM2Identity:
            durableBinding?.m2Identity ??
            requireM2Store(m2Store).databaseInstanceIdentity(
              HERO_ENVIRONMENT_ID,
            ),
          observer: options.databaseOperationObserver,
        };
        registerChangeControlTools(
          server,
          context,
        );
        if (options.enableM4Tools === true) {
          registerM4ChangeControlTools(
            server,
            context,
          );
        }
        break;
      }
      default:
        assertNever(serviceName);
    }
  } catch (error: unknown) {
    try {
      m2Store?.close();
    } catch {
      // Construction must preserve the original startup failure.
    }
    try {
      factory?.close();
    } catch {
      // Construction must preserve the original startup failure.
    }
    throw error;
  }

  let serverClosed = false;
  let storeClosed = false;
  let factoryClosed = factory === null;
  let closeInFlight: Promise<void> | null = null;
  const closeOwnedResources = async (): Promise<void> => {
    const failures: unknown[] = [];
    if (!serverClosed) {
      try {
        await server.close();
        serverClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (!storeClosed) {
      try {
        requireM2Store(m2Store).close();
        storeClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (!factoryClosed) {
      try {
        requireFactory(factory).close();
        factoryClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    throwCleanupFailures(failures, "Failed to close factory MCP service");
  };
  return {
    serviceName,
    server,
    close: () => {
      if (closeInFlight !== null) return closeInFlight;
      closeInFlight = closeOwnedResources().finally(() => {
        closeInFlight = null;
      });
      return closeInFlight;
    },
  };
}

export async function serveFactoryMcpStdio(
  serviceName: FactoryMcpServiceName,
  options: FactoryMcpServiceOptions,
): Promise<void> {
  const running = createFactoryMcpService(serviceName, options);
  const keepAlive = setInterval(() => undefined, 60_000);
  let shutdownStarted = false;
  let closeInFlight: Promise<void> | null = null;
  let closeError: unknown;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const guardedInput = new StrictJsonLineInput({
    onRejected: () => {
      if (shutdownStarted) return;
      const parseError =
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n';
      process.stdout.write(parseError, () => {
        void requestClose().catch(() => undefined);
      });
    },
  });
  const transport = new StdioServerTransport(guardedInput, process.stdout);
  const onSigint = (): void => {
    void requestClose().catch(() => undefined);
  };
  const onSigterm = (): void => {
    void requestClose().catch(() => undefined);
  };
  const onStdinEnd = (): void => {
    void requestClose().catch(() => undefined);
  };
  const closeOwnedResources = async (): Promise<void> => {
    shutdownStarted = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.stdin.removeListener("end", onStdinEnd);
    clearInterval(keepAlive);
    try {
      process.stdin.unpipe(guardedInput);
      process.stdin.pause();
      guardedInput.end();
    } catch {
      // Stream release continues through the owned MCP resources below.
    }
    const failures: unknown[] = [];
    try {
      await running.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      await transport.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    throwCleanupFailures(failures, "Failed to stop factory MCP stdio service");
  };
  const requestClose = (): Promise<void> => {
    if (closeInFlight !== null) return closeInFlight;
    closeInFlight = Promise.resolve()
      .then(closeOwnedResources)
      .catch((error: unknown) => {
        closeError = error;
        throw error;
      })
      .finally(() => resolveStopped?.());
    return closeInFlight;
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.stdin.once("end", onStdinEnd);
  try {
    await running.server.connect(transport);
    process.stdin.pipe(guardedInput);
    await stopped;
    if (closeError !== undefined) throw closeError;
  } catch (error: unknown) {
    try {
      await requestClose();
    } catch {
      // Cleanup failures must not replace the meaningful startup failure.
    }
    throw error;
  }
}

export async function startFactoryMcpCluster(
  options: FactoryMcpServiceOptions & {
    readonly command?: string;
    readonly modulePath?: string;
    readonly cwd?: string;
    readonly stderr?: StdioServerParameters["stderr"];
  },
): Promise<RunningFactoryMcpCluster> {
  const modulePath =
    options.modulePath ?? fileURLToPath(new URL("./mcp-cli.js", import.meta.url));
  const command = options.command ?? process.execPath;
  const attempts = await Promise.allSettled(
    FACTORY_MCP_SERVICE_NAMES.map(async (serviceName) => {
      const transport = new StdioClientTransport({
        command,
        args: [
          modulePath,
          "--service",
          serviceName,
          "--factory-db",
          options.factoryDatabasePath,
          "--m2-db",
          options.m2DatabasePath,
        ],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stderr: options.stderr ?? "pipe",
      });
      const client = new Client({
        name: "flakebrake-m3-lifecycle-client",
        version: "0.1.0-m3",
      });
      const connection = { serviceName, client, transport } as const;
      try {
        await client.connect(transport);
        return connection;
      } catch (error: unknown) {
        const cleanupErrors = await closeClientWithTransportFallback(connection);
        attachCleanupErrors(error, cleanupErrors);
        throw error;
      }
    }),
  );
  const connections = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );
  const failed = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
  );
  if (failed !== undefined) {
    const cleanupErrors = (
      await Promise.all(
        connections.map((connection) =>
          closeClientWithTransportFallback(connection),
        ),
      )
    ).flat();
    attachCleanupErrors(failed.reason, cleanupErrors);
    throw failed.reason;
  }
  {
    const services = new Map(
      connections.map((connection) => [connection.serviceName, connection]),
    );
    const closed = new Set<FactoryMcpServiceName>();
    let closeInFlight: Promise<void> | null = null;
    const closeConnections = async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const connection of services.values()) {
        if (closed.has(connection.serviceName)) continue;
        try {
          await connection.client.close();
          closed.add(connection.serviceName);
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      throwCleanupFailures(failures, "Failed to close factory MCP cluster");
    };
    return {
      transport: "stdio",
      services,
      close: () => {
        if (closeInFlight !== null) return closeInFlight;
        closeInFlight = closeConnections().finally(() => {
          closeInFlight = null;
        });
        return closeInFlight;
      },
    };
  }
}

function registerOrdersTools(
  server: McpServer,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
): void {
  server.registerTool(
    "read_orders",
    {
      title: "Read accepted factory orders",
      description:
        "Read the authoritative accepted portfolio, service floors, deadlines, and synthetic schedule commitments.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => {
      const portfolio = store.getPortfolio();
      const schedule = factory.getScheduleState();
      return toolResult({
        schemaVersion: "microfactory-orders-read/v1",
        portfolioVersion: portfolio.versions.portfolioVersion,
        orders: portfolio.acceptedObligations.map((order) => {
          const commitments = schedule.reservations.filter(
            (reservation) => reservation.orderId === order.obligationId,
          );
          return {
            ...order,
            deadlineOrHorizon: order.schedulingConstraint,
            schedulingCommitment: commitments[0] ?? null,
            schedulingCommitments: commitments,
          };
        }),
      });
    },
  );
  server.registerTool(
    "read_incoming_proposals",
    {
      title: "Read incoming factory proposals",
      description: "Read the immutable seeded incoming-order proposals.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () =>
      toolResult({
        schemaVersion: "microfactory-incoming-proposals-read/v1",
        proposals: factory.getIncomingProposals(),
      }),
  );
}

function registerCapacityTools(server: McpServer, store: FlakeBrakeStore): void {
  server.registerTool(
    "read_capacity_plan",
    {
      title: "Read factory capacity model and plan",
      description:
        "Read the versioned authoritative human, agent, and production-cell capacity model and plan.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => {
      const portfolio = store.getPortfolio();
      return toolResult({
        schemaVersion: "microfactory-capacity-read/v1",
        capacityModelVersion: portfolio.versions.capacityModelVersion,
        capacityPlanVersion: portfolio.versions.capacityPlanVersion,
        resources: portfolio.resources,
      });
    },
  );
  server.registerTool(
    "read_actual_consumption",
    {
      title: "Read authoritative actual consumption",
      description:
        "Read immutable actual-consumption facts recorded by the M2 admission ledger.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => {
      const facts = store
        .getAdmissionHistory()
        .flatMap((admission) =>
          admission.addenda
            .filter((addendum) => addendum.kind === "actual_consumption")
            .map((addendum) => ({
              admissionRecordId: admission.record.admissionRecordId,
              factId: addendum.addendumId,
              recordedAt: addendum.createdAt,
              fact: addendum.body,
            })),
        )
        .sort((left, right) => compareStableStrings(left.factId, right.factId));
      return toolResult({
        schemaVersion: "microfactory-actual-consumption-read/v1",
        facts,
      });
    },
  );
}

function registerSimulatorTools(
  server: McpServer,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
): void {
  server.registerTool(
    "evaluate_candidate_schedules",
    {
      title: "Evaluate candidate factory schedules",
      description:
        "Deterministically run the M1 admission kernel and return reproducible evidence without factory mutation.",
      inputSchema: simulationInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ evaluation_input }) =>
      toolResult(
        authoritativeSimulation(
          store,
          factory,
          proposalFromEvaluationInput(evaluation_input),
        ),
      ),
  );
  server.registerTool(
    "evaluate_hero_fixture",
    {
      title: "Evaluate deterministic hero fixture",
      description:
        "Evaluate the seeded rush proposal against the current authoritative M2 and factory basis; after acceptance, evaluate current portfolio health instead of replaying stale seed state.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => toolResult(authoritativeSimulation(store, factory, createHeroProposal())),
  );
}

function authoritativeSimulation(
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
  requestedProposal: ProposedObligation,
): object {
  for (let retry = 0; retry < 3; retry += 1) {
    const first = store.evaluateCurrentAdmission({
      proposal: currentProposal(store, requestedProposal),
    });
    const firstFactoryState = factory.getScheduleState();
    const firstFactoryDigest = factory.getScheduleStateDigest();
    const second = store.evaluateCurrentAdmission({
      proposal: currentProposal(store, requestedProposal),
    });
    const secondFactoryState = factory.getScheduleState();
    const secondFactoryDigest = factory.getScheduleStateDigest();
    if (
      canonicalSerialize(first.evaluationInput) ===
        canonicalSerialize(second.evaluationInput) &&
      canonicalSerialize(first.result) === canonicalSerialize(second.result) &&
      canonicalSerialize(firstFactoryState) ===
        canonicalSerialize(secondFactoryState) &&
      firstFactoryDigest === secondFactoryDigest
    ) {
      const evidenceBasis = {
        schemaVersion: "microfactory-simulation-basis/v1",
        evaluationInput: second.evaluationInput,
        factoryStateVersion: secondFactoryState.stateVersion,
        factoryStateDigest: secondFactoryDigest,
        factorySchedule: secondFactoryState,
      };
      return {
        schemaVersion: "microfactory-simulation-evidence/v1",
        basisStatus: "COHERENT",
        evidenceReceiptId: stableTupleId("simulation-evidence", [
          asJsonValue(evidenceBasis),
          asJsonValue(second.result),
        ]),
        evidenceBasis,
        mutationCount: 0,
        result: second.result,
      };
    }
  }
  return {
    schemaVersion: "microfactory-simulation-evidence/v1",
    basisStatus: "STALE_RETRY_REQUIRED",
    mutationCount: 0,
    reason: "authoritative M2 or factory state changed during basis assembly",
  };
}

function proposalFromEvaluationInput(
  evaluationInput: Record<string, unknown>,
): ProposedObligation {
  const proposal = evaluationInput["proposal"];
  if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new TypeError(
      "evaluation_input.proposal must contain the candidate proposal",
    );
  }
  return JSON.parse(canonicalSerialize(proposal)) as ProposedObligation;
}

function currentProposal(
  store: FlakeBrakeStore,
  requested: ProposedObligation,
): ProposedObligation {
  const portfolio = store.getPortfolio();
  const accepted = portfolio.acceptedObligations.find(
      (obligation) => obligation.obligationId === requested.obligationId,
    );
  if (accepted === undefined) return requested;
  return currentPortfolioProbe(portfolio, accepted, requested);
}

function currentPortfolioProbe(
  portfolio: ReturnType<FlakeBrakeStore["getPortfolio"]>,
  accepted: AcceptedObligation,
  source: ProposedObligation,
): ProposedObligation {
  return JSON.parse(
    canonicalSerialize({
      obligationId: `proposal/current-portfolio-health/${accepted.obligationId}`,
      beneficiary: "owner/microfactory-operations",
      objective: "Evaluate the complete current accepted portfolio",
      serviceLevel: { portfolioHealth: 1 },
      protected: false,
      criticality: "best_effort",
      minimumService: { portfolioHealth: 1 },
      modificationPolicy: { modifiableFields: {} },
      modificationOptions: [],
      resourceDemand: Object.fromEntries(
        portfolio.resources.map((resource) => [resource.resourceKey, 0]),
      ),
      workClassByResource: Object.fromEntries(
        portfolio.resources.map((resource) => [
          resource.resourceKey,
          `current-portfolio-health/${resource.resourceKey}`,
        ]),
      ),
      schedulingConstraint: source.schedulingConstraint,
      pendingOwnerDecisions: [],
      assumptions: [
        {
          key: "accepted-incoming-proposal",
          source: "m2-authoritative-portfolio",
          value: accepted.obligationId,
        },
      ],
      evidenceRefs: [`portfolio/${portfolio.versions.portfolioVersion}`],
      requiredEffects: [],
      status: "proposed",
      acceptanceDecision: source.acceptanceDecision,
    }),
  ) as ProposedObligation;
}

interface ChangeControlDatabaseContext {
  readonly factoryDatabasePath: string;
  readonly m2DatabasePath: string;
  readonly now: () => string;
  readonly expectedFactoryIdentity: string;
  readonly expectedM2Identity: string;
  readonly observer: FactoryMcpServiceOptions["databaseOperationObserver"];
}

interface VerifiedChangeControlHandles {
  readonly store: FlakeBrakeStore;
  readonly factory: SyntheticFactoryEnvironment;
  readonly assertDatabaseBinding: () => void;
}

function withVerifiedChangeControlHandles<T>(
  context: ChangeControlDatabaseContext,
  operation: string,
  callback: (handles: VerifiedChangeControlHandles) => T,
): T {
  context.observer?.({ operation, stage: "before_open", openedKinds: [] });
  const resources = [
    {
      kind: "factory" as const,
      path: canonicalDatabasePath(context.factoryDatabasePath),
    },
    {
      kind: "m2" as const,
      path: canonicalDatabasePath(context.m2DatabasePath),
    },
  ].sort((left, right) =>
    `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`),
  );
  let store: FlakeBrakeStore | null = null;
  let factory: SyntheticFactoryEnvironment | null = null;
  const openedKinds: Array<"factory" | "m2"> = [];
  let primaryFailure: unknown;
  try {
    for (const resource of resources) {
      if (resource.kind === "m2") {
        store = createStore({
          path: context.m2DatabasePath,
          authoritativeFactoryDatabasePath: context.factoryDatabasePath,
          now: context.now,
        });
      } else {
        factory = new SyntheticFactoryEnvironment({
          path: context.factoryDatabasePath,
          now: context.now,
        });
      }
      openedKinds.push(resource.kind);
      if (openedKinds.length === 1) {
        context.observer?.({
          operation,
          stage: "after_first_open",
          openedKinds: [...openedKinds],
        });
      }
    }
    const exactStore = requireM2Store(store);
    const exactFactory = requireFactory(factory);
    const assertDatabaseBinding = (): void => {
      const exactM2Identity = exactStore.databaseInstanceIdentity(
        HERO_ENVIRONMENT_ID,
      );
      const exactFactoryIdentity = exactFactory.databaseInstanceIdentity();
      const configuredM2Identity = readDatabaseInstanceIdentity(
        context.m2DatabasePath,
        "m2",
        HERO_ENVIRONMENT_ID,
      );
      const configuredFactoryIdentity = readDatabaseInstanceIdentity(
        context.factoryDatabasePath,
        "factory",
        HERO_ENVIRONMENT_ID,
      );
      if (
        exactM2Identity !== context.expectedM2Identity ||
        exactFactoryIdentity !== context.expectedFactoryIdentity ||
        configuredM2Identity !== exactM2Identity ||
        configuredFactoryIdentity !== exactFactoryIdentity
      ) {
        throw new StatefulInputError(
          "databaseBinding",
          "database instance identity conflicts with the exact authoritative operation handles",
        );
      }
    };
    context.observer?.({
      operation,
      stage: "handles_validated",
      openedKinds: [...openedKinds],
    });
    assertDatabaseBinding();
    context.observer?.({
      operation,
      stage: "before_operation",
      openedKinds: [...openedKinds],
    });
    assertDatabaseBinding();
    return callback({
      store: exactStore,
      factory: exactFactory,
      assertDatabaseBinding,
    });
  } catch (error: unknown) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      store?.close();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    try {
      factory?.close();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    if (primaryFailure === undefined) {
      throwCleanupFailures(
        cleanupFailures,
        `Failed to close verified handles for ${operation}`,
      );
    } else {
      attachCleanupErrors(primaryFailure, cleanupFailures);
    }
  }
}

function registerChangeControlTools(
  server: McpServer,
  context: ChangeControlDatabaseContext,
): void {
  server.registerTool(
    "read_schedule_state",
    {
      title: "Read authoritative synthetic schedule state",
      description:
        "Read the complete authoritative synthetic schedule for independent post-mutation verification.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () =>
      withVerifiedChangeControlHandles(
        context,
        "read_schedule_state",
        ({ factory, assertDatabaseBinding }) => {
          const state = factory.getScheduleState();
          const stateDigest = factory.getScheduleStateDigest();
          const controlledWriteCount = factory.getMutationCount();
          assertDatabaseBinding();
          return toolResult({
            state,
            stateDigest,
            controlledWriteCount,
            verifiedBasis: {
              environmentId: state.environmentId,
              factoryDatabaseIdentity: context.expectedFactoryIdentity,
            },
          });
        },
      ),
  );
  server.registerTool(
    "create_schedule_reservation",
    {
      title: "Create authorized schedule reservation",
      description:
        "Idempotently apply only the exact schedule reservation already claimed and reserved by M2.",
      inputSchema: createReservationInputSchema,
      annotations: CONSEQUENTIAL_ANNOTATIONS,
    },
    (input) =>
      withVerifiedChangeControlHandles(
        context,
        "create_schedule_reservation",
        ({ store, factory, assertDatabaseBinding }) => {
          const command: CanonicalScheduleCommand = {
            schemaVersion: input.schedule_command.schema_version,
            commandKind: input.schedule_command.command_kind,
            environmentId: input.schedule_command.environment_id,
            orderId: input.schedule_command.order_id,
            productionCellId: input.schedule_command.production_cell_id,
            quantity: input.schedule_command.quantity,
            start: input.schedule_command.start,
            end: input.schedule_command.end,
          };
          assertDatabaseBinding();
          return toolResult(
            factory.executeAuthorizedScheduleMutation(
              store,
              normalizedMutation(input, command),
              assertDatabaseBinding,
            ),
          );
        },
      ),
  );
  server.registerTool(
    "submit_schedule_change",
    {
      title: "Submit authorized schedule change",
      description:
        "Alternate bounded adapter for the same canonical M2-authorized schedule reservation effect.",
      inputSchema: submitChangeInputSchema,
      annotations: CONSEQUENTIAL_ANNOTATIONS,
    },
    (input) =>
      withVerifiedChangeControlHandles(
        context,
        "submit_schedule_change",
        ({ store, factory, assertDatabaseBinding }) => {
          const command: CanonicalScheduleCommand = {
            schemaVersion: "microfactory-schedule-command/v1",
            commandKind: "create_schedule_reservation",
            environmentId: input.schedule_change.environment_id,
            orderId: input.schedule_change.order_id,
            productionCellId: input.schedule_change.cell_id,
            quantity: input.schedule_change.quantity,
            start: input.schedule_change.starts_at,
            end: input.schedule_change.ends_at,
          };
          assertDatabaseBinding();
          return toolResult(
            factory.executeAuthorizedScheduleMutation(
              store,
              normalizedMutation(input, command),
              assertDatabaseBinding,
            ),
          );
        },
      ),
  );
}

function registerM4ChangeControlTools(
  server: McpServer,
  context: ChangeControlDatabaseContext,
): void {
  server.registerTool(
    "record_current_admission",
    {
      title: "Record current rush admission",
      description:
        "Run the existing M1 kernel against the current authoritative M2 basis and durably record its immutable admission result.",
      inputSchema: noArgumentsSchema,
      annotations: LEDGER_WRITE_ANNOTATIONS,
    },
    () =>
      withVerifiedChangeControlHandles(
        context,
        "record_current_admission",
        ({ store, assertDatabaseBinding }) => {
          assertDatabaseBinding();
          return toolResult(
            recordCurrentM4AdmissionOrReplay(store, assertDatabaseBinding),
          );
        },
      ),
  );

  server.registerTool(
    "select_portfolio_modification",
    {
      title: "Select approved portfolio modification",
      description:
        "Record the exact owner-approved M1 replan candidate and perform the authoritative fresh admission.",
      inputSchema: selectPortfolioModificationSchema,
      annotations: CONSEQUENTIAL_ANNOTATIONS,
    },
    (input) =>
      withVerifiedChangeControlHandles(
        context,
        "select_portfolio_modification",
        ({ store, assertDatabaseBinding }) =>
          toolResult(
            applyM4PortfolioModification(
              store,
              input,
              assertDatabaseBinding,
            ),
          ),
      ),
  );

  server.registerTool(
    "accept_promise",
    {
      title: "Accept promise and bounded execution scope",
      description:
        "Commit the exact owner-accepted promise and issue its exact M2 bounded execution grant. Both identities are immutable and replay-safe.",
      inputSchema: acceptPromiseSchema,
      annotations: CONSEQUENTIAL_ANNOTATIONS,
    },
    (input) =>
      withVerifiedChangeControlHandles(
        context,
        "accept_promise",
        ({ store, assertDatabaseBinding }) => {
          assertDatabaseBinding();
          const result = store.acceptPromiseAndIssueGrant({
            acceptance: {
              admissionRecordId: input.admission_record_id,
              selectedPlanId: input.selected_plan_id,
              ownerDecisionId: input.owner_decision_id,
              approverId: input.approver_id,
              ownerSourceIdentity: "owner-source/m4-native-owner-boundary",
              expectedPortfolioVersion: input.expected_portfolio_version,
              expectedCapacityModelVersion:
                input.expected_capacity_model_version,
              expectedCapacityPlanVersion: input.expected_capacity_plan_version,
              expectedAuthorizationStateVersion:
                input.expected_authorization_state_version,
              expectedCalibrationFrontierDigest:
                input.expected_calibration_frontier_digest,
            },
            grant: {
              grantId: input.grant.grant_id,
              grantVersion: input.grant.grant_version,
              admissionRecordId: input.admission_record_id,
              promiseBasisId: input.grant.scope.promiseBasisId,
              acceptedOwnerDecisionId: input.owner_decision_id,
              ownerDecisionId: input.grant.grant_owner_decision_id,
              selectedBundleId: input.grant.selected_bundle_id,
              selectedPlanId: input.selected_plan_id,
              scope: input.grant.scope as ApprovalScope,
              postDenialAuthorization: null,
            },
          });
          assertDatabaseBinding();
          return toolResult(result);
        },
      ),
  );

  server.registerTool(
    "prepare_portfolio_modification",
    {
      title: "Prepare exact portfolio modification",
      description:
        "Read the latest recorded M1 REPLAN and return the exact selected lexicographic winner arguments without recording an owner decision.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () =>
      withVerifiedChangeControlHandles(
        context,
        "prepare_portfolio_modification",
        ({ store, assertDatabaseBinding }) => {
          const arguments_ = m4PortfolioModificationArgumentsFromStore(store);
          assertDatabaseBinding();
          return toolResult({
            toolName: "select_portfolio_modification",
            arguments: arguments_,
          });
        },
      ),
  );

  server.registerTool(
    "prepare_promise_acceptance",
    {
      title: "Prepare exact promise acceptance",
      description:
        "Read the current selected M2 replan and return the exact bounded accept_promise arguments without recording a decision.",
      inputSchema: noArgumentsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () =>
      withVerifiedChangeControlHandles(
        context,
        "prepare_promise_acceptance",
        ({ store, assertDatabaseBinding }) => {
          const arguments_ = m4AcceptanceArgumentsFromStore(store);
          assertDatabaseBinding();
          return toolResult({
            toolName: "accept_promise",
            arguments: arguments_,
          });
        },
      ),
  );

  server.registerTool(
    "prepare_schedule_effect",
    {
      title: "Prepare exact bounded schedule effect",
      description:
        "Read the current M2 and factory basis and return strict arguments for one named consequential adapter without claiming or mutating.",
      inputSchema: prepareScheduleEffectSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) =>
      withVerifiedChangeControlHandles(
        context,
        "prepare_schedule_effect",
        ({ store, factory, assertDatabaseBinding }) => {
          const arguments_ = m4MutationToolArgumentsFromHandles(
            input.tool_name,
            store,
            factory,
            input.execution_attempt_id,
            input.effect_schema_version,
            input.start,
            input.end,
          );
          assertDatabaseBinding();
          return toolResult({
            toolName: input.tool_name,
            arguments: arguments_,
          });
        },
      ),
  );

  server.registerTool(
    "read_execution_status",
    {
      title: "Read authoritative execution status",
      description:
        "Read the immutable M2 execution attempt, execution fence, reservation, and authoritative factory result linkage.",
      inputSchema: executionStatusSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ execution_attempt_id }) =>
      withVerifiedChangeControlHandles(
        context,
        "read_execution_status",
        ({ store, factory, assertDatabaseBinding }) => {
          const attempt = store.getExecutionAttempt(execution_attempt_id);
          const fence = store.getExecutionFence(execution_attempt_id);
          const reservation =
            store
              .getReservations(true)
              .find(
                (candidate) =>
                  candidate.executionAttemptId === execution_attempt_id,
              ) ?? null;
          const factoryEvidence =
            factory.readAuthoritativeExecution(execution_attempt_id);
          assertDatabaseBinding();
          return toolResult({
        executionAttemptId: attempt.executionAttemptId,
        admissionRecordId: attempt.admissionRecordId,
        claimState: reservation?.claimState ?? null,
        terminalVerified: reservation?.claimState === "terminal_verified",
        fence:
          fence === null
            ? null
            : {
                fenceId: fence.fenceId,
                status: fence.status,
                environmentId: fence.environmentId,
                resultBinding: fence.resultBinding,
              },
        factory:
          factoryEvidence === null
            ? null
            : {
                environmentId: factoryEvidence.environmentId,
                stateVersion: factoryEvidence.currentState.stateVersion,
                currentStateDigest: factoryEvidence.currentStateDigest,
                mutationStatus: factoryEvidence.result.status,
                receiptId: factoryEvidence.result.receipt.receiptId,
                receiptDigest: factoryEvidence.resultDigest,
              },
          });
        },
      ),
  );

  server.registerTool(
    "verify_schedule_execution",
    {
      title: "Authoritatively verify schedule execution",
      description:
        "Independently acquire the durable factory result, receipt, event, and read-back, then record M2 verified completion and actuals exactly once.",
      inputSchema: executionStatusSchema,
      annotations: CONSEQUENTIAL_ANNOTATIONS,
    },
    ({ execution_attempt_id }) =>
      withVerifiedChangeControlHandles(
        context,
        "verify_schedule_execution",
        ({ store, factory, assertDatabaseBinding }) => {
          const evidence = factory.readAuthoritativeExecution(
            execution_attempt_id,
          );
          if (evidence === null) {
            throw new StatefulInputError(
              "executionAttemptId",
              "has no authoritative committed factory result",
            );
          }
          assertDatabaseBinding();
          const result = store.verifyExecutionWithEvidence(
            execution_attempt_id,
            evidence,
          );
          assertDatabaseBinding();
          return toolResult(result);
        },
      ),
  );
}

function applyM4PortfolioModification(
  store: FlakeBrakeStore,
  input: z.infer<typeof selectPortfolioModificationSchema>,
  assertDatabaseBinding: () => void,
): {
  readonly status: "READMITTED";
  readonly ownerDecisionId: string;
  readonly freshAdmissionRecord: AdmissionRecordBody;
} {
  return store.withImmediateTransaction((database) => {
    const source = store.getAdmissionRecord(input.admission_record_id);
    if (source.record.decision !== "REPLAN") {
      throw new TypeError("M4 portfolio modification requires a REPLAN admission");
    }
    if (
      source.addenda.some((addendum) => addendum.kind === "acceptance_commit")
    ) {
      throw new TypeError("The source REPLAN admission was already accepted");
    }
    const candidate = source.record.candidatePlans.find(
      (item) => item.candidatePlanId === input.selected_plan_id,
    );
    if (candidate?.feasible !== true) {
      throw new TypeError("M4 portfolio modification requires a feasible plan");
    }
    const decision: OwnerDecisionInput = {
      kind: "MODIFY",
      admissionRecordId: input.admission_record_id,
      selectedPlanId: input.selected_plan_id,
      ownerDecisionId: input.owner_decision_id,
      approverId: input.approver_id,
    };
    assertDatabaseBinding();
      const linked = m4LinkedAdmissionId(database, input.admission_record_id);
      const existingDecision = database
        .prepare(
          "SELECT body_json FROM owner_decisions WHERE owner_decision_id = ?",
        )
        .get(input.owner_decision_id) as Record<string, unknown> | undefined;
      if (existingDecision !== undefined) {
        const stored = parseCanonicalJson<OwnerDecisionInput>(
          existingDecision["body_json"],
          "M4 portfolio owner decision",
        );
        if (canonicalSerialize(stored) !== canonicalSerialize(decision)) {
          throw new TypeError("M4 owner decision identity was reused");
        }
        if (linked !== null) {
          const linkedRecord = readM4Admission(database, linked);
          assertM4FreshAdmission(
            linkedRecord,
            source.record.admissionRecordId,
          );
          return {
            status: "READMITTED" as const,
            ownerDecisionId: input.owner_decision_id,
            freshAdmissionRecord: linkedRecord,
          };
        }
        assertM4ModifiedPortfolio(database, source.record, candidate);
      } else if (linked !== null) {
        throw new Error("M4 readmission link exists without its owner decision");
      } else {
        const currentVersions = readVersions(database);
        if (
          currentVersions.portfolioVersion !== source.record.portfolioVersion
        ) {
          throw new TypeError("M4 source REPLAN portfolio basis is stale");
        }
        const currentPortfolio = readM4Portfolio(database);
        if (
          canonicalSerialize(currentPortfolio) !==
          canonicalSerialize(
            source.record.m1Result.promiseBasis.acceptedPortfolio,
          )
        ) {
          throw new TypeError("M4 source REPLAN portfolio bytes are stale");
        }
        const modified = materializeM4Portfolio(source.record, candidate);
        assertDatabaseBinding();
        for (const obligation of modified) {
          database
            .prepare(
              `UPDATE portfolio_obligations SET body_json = ?
                WHERE obligation_id = ?`,
            )
            .run(canonicalJson(obligation), obligation.obligationId);
        }
        database
          .prepare(
            `INSERT INTO owner_decisions
               (owner_decision_id, created_at, body_json) VALUES (?, ?, ?)`,
          )
          .run(
            input.owner_decision_id,
            HERO_HORIZON_END,
            canonicalJson(decision),
          );
        appendM4Addendum(
          database,
          stableTupleId("m4-portfolio-owner-choice", [
            input.admission_record_id,
            input.owner_decision_id,
            input.selected_plan_id,
          ]),
          input.admission_record_id,
          "owner_choice",
          decision,
        );
        const next = advanceVersions(database, new Set(["portfolio"]));
        const expectedNext = nextPortfolioVersion(source.record.portfolioVersion);
        if (next.portfolioVersion !== expectedNext) {
          throw new Error("M4 portfolio modification did not create exact v2 basis");
        }
      }

      const evaluation = store.evaluateCurrentAdmission({
        proposal: source.record.proposalSnapshot,
        assumptions: source.record.m1Result.promiseBasis.assumptions,
        combinedDecisionProofs:
          source.record.m1Result.promiseBasis.combinedDecisionProofs,
      });
      if (evaluation.result.decision !== "ADMITTABLE") {
        throw new Error(
          `M4 post-modification readmission must be ADMITTABLE, got ${evaluation.result.decision}`,
        );
      }
      const matching = (
        database
          .prepare(
            `SELECT body_json FROM admission_records
              WHERE proposal_obligation_id = ? AND decision = 'ADMITTABLE'
              ORDER BY created_at, admission_record_id`,
          )
          .all(source.record.proposalSnapshot.obligationId) as Record<
          string,
          unknown
        >[]
      )
        .map((row) =>
          parseCanonicalJson<AdmissionRecordBody>(
            row["body_json"],
            "M4 candidate readmission",
          ),
        )
        .filter(
          (record) =>
            record.portfolioVersion ===
              evaluation.result.basis.portfolioVersion &&
            canonicalSerialize(record.m1Result) ===
              canonicalSerialize(evaluation.result),
        );
      if (matching.length > 1) {
        throw new Error("M4 post-modification admission was duplicated");
      }
      const record = matching[0] ?? m4AdmissionRecord(evaluation.result);
      if (matching.length === 0) {
        assertDatabaseBinding();
        database
          .prepare(
            `INSERT INTO admission_records
               (admission_record_id, created_at, decision,
                proposal_obligation_id, body_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            record.admissionRecordId,
            record.createdAt,
            record.decision,
            record.proposalSnapshot.obligationId,
            canonicalJson(record),
          );
      }
      appendM4Addendum(
        database,
        stableTupleId("m4-source-readmission-link", [
          source.record.admissionRecordId,
          input.owner_decision_id,
          record.admissionRecordId,
        ]),
        source.record.admissionRecordId,
        "readmission_link",
        {
          kind: "M4_PORTFOLIO_MODIFICATION_READMISSION",
          ownerDecisionId: input.owner_decision_id,
          selectedPlanId: input.selected_plan_id,
          freshAdmissionRecordId: record.admissionRecordId,
        },
      );
      appendM4Addendum(
        database,
        stableTupleId("m4-fresh-readmission-link", [
          source.record.admissionRecordId,
          input.owner_decision_id,
          record.admissionRecordId,
        ]),
        record.admissionRecordId,
        "readmission_link",
        {
          kind: "M4_POST_MODIFICATION_ADMISSION",
          sourceAdmissionRecordId: source.record.admissionRecordId,
          ownerDecisionId: input.owner_decision_id,
          selectedModificationPlanId: input.selected_plan_id,
        },
      );
      assertDatabaseBinding();
      assertM4FreshAdmission(record, source.record.admissionRecordId);
      return {
        status: "READMITTED" as const,
        ownerDecisionId: input.owner_decision_id,
        freshAdmissionRecord: record,
      };
  });
}

function materializeM4Portfolio(
  source: AdmissionRecordBody,
  candidate: ReplanCandidate,
): readonly AcceptedObligation[] {
  if (
    candidate.affectedObligations.some(
      (change) => change.obligationStatus !== "accepted",
    )
  ) {
    throw new TypeError(
      "M4 selected modification must change only an existing accepted order",
    );
  }
  let changed = 0;
  const materialized = source.m1Result.promiseBasis.acceptedPortfolio.map(
    (obligation) => {
      const change = candidate.affectedObligations.find(
        (item) => item.obligationId === obligation.obligationId,
      );
      if (change === undefined) return obligation;
      if (obligation.protected) {
        throw new TypeError("M4 selected modification cannot change protected work");
      }
      const option = obligation.modificationOptions.find(
        (item) => item.optionId === change.optionId,
      );
      if (option === undefined) {
        throw new TypeError("M4 selected modification option is missing");
      }
      changed += 1;
      return JSON.parse(
        canonicalSerialize({
          ...obligation,
          serviceLevel: { ...obligation.serviceLevel, ...option.changes },
          resourceDemand: option.resourceDemand,
        }),
      ) as AcceptedObligation;
    },
  );
  if (changed === 0) {
    throw new TypeError("M4 selected modification changed no accepted order");
  }
  return materialized;
}

function assertM4ModifiedPortfolio(
  database: SqliteDatabase,
  source: AdmissionRecordBody,
  candidate: ReplanCandidate,
): void {
  const current = readM4Portfolio(database);
  const expected = materializeM4Portfolio(source, candidate);
  if (canonicalSerialize(current) !== canonicalSerialize(expected)) {
    throw new TypeError("M4 replay found conflicting portfolio bytes");
  }
  if (
    readVersions(database).portfolioVersion !==
    nextPortfolioVersion(source.portfolioVersion)
  ) {
    throw new TypeError("M4 replay found a conflicting portfolio version");
  }
}

function readM4Portfolio(database: SqliteDatabase): readonly AcceptedObligation[] {
  return (
    database
      .prepare(
        "SELECT body_json FROM portfolio_obligations ORDER BY obligation_id",
      )
      .all() as Record<string, unknown>[]
  ).map((row) =>
    parseCanonicalJson<AcceptedObligation>(row["body_json"], "M4 portfolio"),
  );
}

function nextPortfolioVersion(version: string): string {
  const match = /^portfolio\/v([1-9][0-9]*)$/u.exec(version);
  if (match === null) throw new TypeError("Invalid M4 portfolio version");
  return `portfolio/v${String(Number(match[1]) + 1)}`;
}

function m4AdmissionRecord(result: AdmissionResult): AdmissionRecordBody {
  if (result.decision !== "ADMITTABLE") {
    throw new TypeError("M4 fresh admission must be ADMITTABLE");
  }
  const selectedPlanId = result.promiseBasis.selectedPlanIds[0];
  if (selectedPlanId === undefined) {
    throw new Error("M4 fresh admission omitted its direct selected plan");
  }
  const expected = result.expectedBasis;
  const record: AdmissionRecordBody = {
    schemaVersion: "flakebrake-admission-record/v0.1-m2",
    admissionRecordId: `admission/${randomUUID()}`,
    promiseBasisId: stableTupleId("promise-basis", [
      asJsonValue(result.promiseBasis),
    ]),
    createdAt: HERO_HORIZON_END,
    decision: result.decision,
    portfolioVersion: result.basis.portfolioVersion,
    expectedPortfolioVersion: expected.expectedPortfolioVersion,
    capacityModelVersion: result.basis.capacityModelVersion,
    expectedCapacityModelVersion: expected.expectedCapacityModelVersion,
    capacityPlanVersion: result.basis.capacityPlanVersion,
    expectedCapacityPlanVersion: expected.expectedCapacityPlanVersion,
    authorizationStateVersion: result.basis.authorizationStateVersion,
    expectedAuthorizationStateVersion:
      expected.expectedAuthorizationStateVersion,
    calibrationFrontierDigest: result.basis.calibrationFrontierDigest,
    expectedCalibrationFrontierDigest:
      expected.expectedCalibrationFrontierDigest,
    calibrationFrontierProvenance:
      result.basis.calibrationFrontierProvenance,
    fixedInFlightExecutionReservations: result.basis.fixedCapacityReservations,
    proposalSnapshot: result.promiseBasis.proposal,
    candidatePlans: result.promiseBasis.candidatePlans,
    selectedPlan: { kind: "selected", selectedPlanId },
    capacityBefore: result.directPlan.capacityBefore,
    predictedConsumption: result.directPlan.predictedConsumption,
    capacityAfter: result.directPlan.capacityAfter,
    protectedObligationSlack: result.directPlan.protectedObligationSlack,
    bindingResourceFacts: result.directPlan.bindingOrLimitingResources,
    ownerChoice: "PENDING_OWNER_CHOICE",
    actualConsumption: "NOT_YET_KNOWN",
    outcome: "NOT_YET_KNOWN",
    additiveCorrections: "NOT_YET_KNOWN",
    m1Result: result,
  };
  return JSON.parse(canonicalSerialize(record)) as AdmissionRecordBody;
}

function m4LinkedAdmissionId(
  database: SqliteDatabase,
  sourceAdmissionRecordId: string,
): string | null {
  const rows = database
    .prepare(
      `SELECT body_json FROM admission_addenda
        WHERE admission_record_id = ? AND kind = 'readmission_link'
        ORDER BY sequence`,
    )
    .all(sourceAdmissionRecordId) as Record<string, unknown>[];
  for (const row of rows) {
    const body = parseCanonicalJson<JsonValue>(
      row["body_json"],
      "M4 source readmission link",
    );
    if (!isM4JsonObject(body)) continue;
    if (body["kind"] !== "M4_PORTFOLIO_MODIFICATION_READMISSION") continue;
    const freshAdmissionRecordId = body["freshAdmissionRecordId"];
    if (typeof freshAdmissionRecordId !== "string") {
      throw new TypeError("M4 source readmission link is malformed");
    }
    return freshAdmissionRecordId;
  }
  return null;
}

function isM4JsonObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readM4Admission(
  database: SqliteDatabase,
  admissionRecordId: string,
): AdmissionRecordBody {
  const row = database
    .prepare("SELECT body_json FROM admission_records WHERE admission_record_id = ?")
    .get(admissionRecordId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error("M4 linked admission is missing");
  return parseCanonicalJson<AdmissionRecordBody>(
    row["body_json"],
    "M4 linked admission",
  );
}

function appendM4Addendum(
  database: SqliteDatabase,
  addendumId: string,
  admissionRecordId: string,
  kind: "owner_choice" | "readmission_link",
  body: unknown,
): void {
  const bodyJson = canonicalJson(body);
  const existing = database
    .prepare(
      `SELECT admission_record_id, created_at, kind, body_json
         FROM admission_addenda WHERE addendum_id = ?`,
    )
    .get(addendumId) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    if (
      existing["admission_record_id"] !== admissionRecordId ||
      existing["created_at"] !== HERO_HORIZON_END ||
      existing["kind"] !== kind ||
      existing["body_json"] !== bodyJson
    ) {
      throw new Error(`M4 addendum ${addendumId} conflicts`);
    }
    return;
  }
  database
    .prepare(
      `INSERT INTO admission_addenda
         (addendum_id, admission_record_id, created_at, kind, body_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(addendumId, admissionRecordId, HERO_HORIZON_END, kind, bodyJson);
}

function assertM4FreshAdmission(
  record: AdmissionRecordBody,
  sourceAdmissionRecordId: string,
): void {
  if (
    record.decision !== "ADMITTABLE" ||
    record.portfolioVersion !== "portfolio/v2" ||
    record.admissionRecordId === sourceAdmissionRecordId
  ) {
    throw new TypeError("M4 linked admission is not the fresh v2 ADMITTABLE basis");
  }
}

function recordCurrentM4AdmissionOrReplay(
  store: FlakeBrakeStore,
  assertDatabaseBinding: () => void,
): ReturnType<FlakeBrakeStore["evaluateAndRecordAdmission"]> {
  return store.withImmediateTransaction(() => {
    const proposal = createHeroProposal();
    assertDatabaseBinding();
    const recorded = store.evaluateAndRecordAdmissionOrReplay({ proposal });
    assertDatabaseBinding();
    return recorded;
  });
}

function normalizedMutation(
  input: {
    readonly execution_attempt_id: string;
    readonly claim: AuthorizedScheduleMutation["claim"];
    readonly expected_before_state_version: string;
    readonly expected_before_state_digest: string;
  },
  command: CanonicalScheduleCommand,
): AuthorizedScheduleMutation {
  return {
    executionAttemptId: input.execution_attempt_id,
    claim: input.claim,
    command,
    expectedBeforeStateVersion: input.expected_before_state_version,
    expectedBeforeStateDigest: input.expected_before_state_digest,
  };
}

function toolResult(value: object): CallToolResult {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text", text: canonicalSerialize(value) }],
    structuredContent,
  };
}

function instructionsFor(serviceName: FactoryMcpServiceName): string {
  switch (serviceName) {
    case "factory-orders":
      return "Authoritative read-only accepted-order and incoming-proposal surface.";
    case "factory-capacity":
      return "Authoritative read-only capacity-plan and actual-consumption surface.";
    case "factory-simulator":
      return "Read-only deterministic M1 schedule evaluation over a coherent current M2 and factory basis; never mutates factory state.";
    case "factory-change-control":
      return "Controlled writes require an exact durable M2 claim and execution fence. Verified completion is available only through the configured authoritative factory verifier.";
    default:
      return assertNever(serviceName);
  }
}

function parseServiceName(value: string | undefined): FactoryMcpServiceName {
  if (
    value === undefined ||
    !FACTORY_MCP_SERVICE_NAMES.includes(value as FactoryMcpServiceName)
  ) {
    throw new TypeError(
      `--service must be one of ${FACTORY_MCP_SERVICE_NAMES.join(", ")}`,
    );
  }
  return value as FactoryMcpServiceName;
}

function cliValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function requireDatabasePath(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
  return value;
}

function requireM2Store(store: FlakeBrakeStore | null): FlakeBrakeStore {
  if (store === null) throw new Error("M2 store was not opened");
  return store;
}

function requireFactory(
  factory: SyntheticFactoryEnvironment | null,
): SyntheticFactoryEnvironment {
  if (factory === null) throw new Error("Factory environment was not opened");
  return factory;
}

function throwCleanupFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

async function closeClientWithTransportFallback(
  connection: FactoryMcpClientConnection,
): Promise<unknown[]> {
  let clientCloseError: unknown;
  try {
    await connection.client.close();
    if (connection.transport.pid === null) return [];
    clientCloseError = new Error(
      `Client close did not release ${connection.serviceName} transport`,
    );
  } catch (error: unknown) {
    clientCloseError = error;
  }
  const cleanupErrors = [clientCloseError];
  try {
    await connection.transport.close();
  } catch (transportCloseError: unknown) {
    cleanupErrors.push(transportCloseError);
  }
  return cleanupErrors;
}

function attachCleanupErrors(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (
    cleanupErrors.length === 0 ||
    !(primaryError instanceof Error) ||
    !Object.isExtensible(primaryError)
  ) {
    return;
  }
  const existing = (primaryError as Error & { cleanupErrors?: unknown })
    .cleanupErrors;
  const combined = [
    ...(Array.isArray(existing) ? existing : []),
    ...cleanupErrors,
  ];
  try {
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: Object.freeze(combined),
      writable: false,
    });
  } catch {
    // A non-configurable application error remains the authoritative failure.
  }
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalSerialize(value)) as JsonValue;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported value ${String(value)}`);
}

export async function runFactoryMcpCli(
  arguments_: readonly string[],
): Promise<void> {
  const factoryDatabasePath = requireDatabasePath(
    cliValue(arguments_, "--factory-db"),
    "--factory-db",
  );
  const m2DatabasePath = requireDatabasePath(
    cliValue(arguments_, "--m2-db"),
    "--m2-db",
  );
  if (arguments_.includes("--all")) {
    const cluster = await startFactoryMcpCluster({
      factoryDatabasePath,
      m2DatabasePath,
      stderr: "inherit",
    });
    process.stderr.write(
      `FlakeBrake M3 MCP cluster started (${FACTORY_MCP_SERVICE_NAMES.join(", ")}) over stdio\n`,
    );
    await new Promise<void>((resolve) => {
      const close = (): void => {
        void cluster.close().then(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return;
  }
  await serveFactoryMcpStdio(parseServiceName(cliValue(arguments_, "--service")), {
    factoryDatabasePath,
    m2DatabasePath,
  });
}
