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
  JsonValue,
  ProposedObligation,
} from "./domain.js";
import {
  type AuthorizedScheduleMutation,
  type CanonicalScheduleCommand,
  SyntheticFactoryEnvironment,
} from "./factory-environment.js";
import { HERO_HORIZON_END, createHeroProposal } from "./hero-fixture.js";
import { stableTupleId } from "./identity.js";
import { StrictJsonLineInput } from "./mcp-stdio-guard.js";
import { createStore } from "./store.js";
import type { FlakeBrakeStore } from "./store.js";

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

export function createFactoryMcpService(
  serviceName: FactoryMcpServiceName,
  options: FactoryMcpServiceOptions,
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
      case "factory-change-control":
        registerChangeControlTools(
          server,
          requireM2Store(m2Store),
          requireFactory(factory),
        );
        break;
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

function registerChangeControlTools(
  server: McpServer,
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
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
      toolResult({
        state: factory.getScheduleState(),
        stateDigest: factory.getScheduleStateDigest(),
        controlledWriteCount: factory.getMutationCount(),
      }),
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
    (input) => {
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
      return toolResult(
        factory.executeAuthorizedScheduleMutation(
          store,
          normalizedMutation(input, command),
        ),
      );
    },
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
    (input) => {
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
      return toolResult(
        factory.executeAuthorizedScheduleMutation(
          store,
          normalizedMutation(input, command),
        ),
      );
    },
  );
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
