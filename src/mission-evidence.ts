import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { canonicalSerialize, compareStableStrings, deepFreeze } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import { normalizeEffect } from "./effects.js";
import {
  factoryStateDigest,
  readAuthoritativeFactoryExecution,
} from "./factory-environment.js";
import { stableTupleId } from "./identity.js";
import {
  EvidenceHandleLifecycleManager,
  withEvidenceHandleOwnership,
  type EvidenceHandleRequest,
} from "./mission-evidence-lifecycle.js";
import {
  canonicalDatabasePath,
  databaseInstanceIdentityFromHandle,
} from "./sqlite.js";
import type { EffectFingerprint } from "./stateful-domain.js";

export const MISSION_EVIDENCE_SCHEMA_VERSION =
  "flakebrake-mission-evidence-bundle/v2" as const;
export const MISSION_EVIDENCE_PAYLOAD_SCHEMA_VERSION =
  "flakebrake-mission-evidence-payload/v2" as const;
export const MISSION_EVIDENCE_CANONICALIZATION = "canonical-json/v1" as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXCLUDED_FIELD_NAMES = new Set([
  "attemptedAt",
  "completedAt",
  "createdAt",
  "issuedAt",
  "observedAt",
  "recordedAt",
  "updatedAt",
  "attempted_at",
  "completed_at",
  "created_at",
  "issued_at",
  "last_activity_at",
  "observed_at",
  "recorded_at",
  "updated_at",
]);
const SENSITIVE_FIELD_PATTERN =
  /(?:api[_-]?key|authorization[_-]?header|credential|password|secret|token)$/iu;
const MACHINE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
const nonEmptyText = z.string().min(1);
const digestText = z.string().regex(SHA256_PATTERN);
const countValue = z.number().int().nonnegative();

const evidenceAdmissionSchema = z
  .object({
    role: z.enum([
      "initial_replan",
      "accepted_execution_basis",
      "pre_execution_recomputation",
    ]),
    record: jsonValueSchema,
    recordDigest: digestText,
    addenda: z.array(
      z
        .object({
          sequence: countValue,
          addendumId: nonEmptyText,
          admissionRecordId: nonEmptyText,
          kind: nonEmptyText,
          body: jsonValueSchema,
        })
        .strict(),
    ),
  })
  .strict();

const ownerDecisionSchema = z
  .object({
    ownerDecisionId: nonEmptyText,
    decision: jsonValueSchema,
  })
  .strict();

const eventPositionSchema = z
  .object({
    turnOrdinal: z.number().int().positive(),
    eventOrdinal: z.number().int().positive(),
  })
  .strict();

const orderedResponseSchema = z
  .object({
    toolCallId: nonEmptyText,
    responseEventId: nonEmptyText,
    position: eventPositionSchema,
    responseDigest: digestText,
  })
  .strict();

const approvalBindingSchema = z
  .object({
    bridgeKey: digestIdentitySchema("m4-bridge"),
    trueforgeSessionId: nonEmptyText,
    trueforgeTurnId: nonEmptyText,
    trueforgeThreadId: nonEmptyText,
    trueforgeToolCallId: nonEmptyText,
    actionKind: z.enum(["owner_decision", "consequential_effect"]),
    toolName: nonEmptyText,
    argumentsDigest: digestText,
    arguments: jsonValueSchema,
    approval: jsonValueSchema,
    native: z
      .object({
        toolCallEventId: nonEmptyText,
        toolCallPosition: eventPositionSchema,
        approvalRequiredEventId: nonEmptyText,
        approvalRequiredPosition: eventPositionSchema,
        userApproval: z
          .object({
            successorTurnId: nonEmptyText,
            inputDigest: digestText,
            decision: z.enum(["allow", "deny"]),
            reasonDigest: digestText.nullable(),
          })
          .strict(),
        responseEventId: nonEmptyText,
        responsePosition: eventPositionSchema,
        responseStatus: z.enum(["completed", "rejected"]),
        responseDigest: digestText,
        resumeBridgeEventId: digestIdentitySchema("m4-bridge-event"),
      })
      .strict(),
    ownerRequest: z
      .object({
        bridgeEventId: digestIdentitySchema("m4-bridge-event"),
        requestDigest: digestText,
        phase: z.enum([
          "portfolio_modification",
          "promise_choice",
          "consequential_effect",
        ]),
      })
      .strict()
      .nullable(),
  })
  .strict();

const countsSchema = z
  .object({
    admissionRecords: countValue,
    acceptanceCommits: countValue,
    ownerDecisions: countValue,
    ownerApprovalBindings: countValue,
    mechanicalDenials: countValue,
    activeDenials: countValue,
    grantAllowances: countValue,
    grants: countValue,
    allowanceClaims: countValue,
    executionAttempts: countValue,
    executionFences: countValue,
    executionFenceBindings: countValue,
    factoryMutations: countValue,
    mutationReceipts: countValue,
    terminalEvents: countValue,
    actualConsumptionFacts: countValue,
    realizedEffects: countValue,
    receiptReferences: countValue,
    bridgeActions: countValue,
    trueforgeTurns: countValue,
    trueforgeSessionEvents: countValue,
    trueforgeSubagentThreads: countValue,
    trueforgeConnectors: countValue,
    trueforgeConnectorInitializations: countValue,
    trueforgeApprovalRequiredEvents: countValue,
    trueforgeUserApprovals: countValue,
    trueforgeToolResponses: countValue,
    trueforgeSandboxCreatedEvents: countValue,
    trueforgeSandboxExecutions: countValue,
    trueforgeOwnerDecisionEvents: countValue,
    trueforgeResumeEvents: countValue,
  })
  .strict();

export const missionEvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVIDENCE_PAYLOAD_SCHEMA_VERSION),
    mission: z
      .object({
        missionId: nonEmptyText,
        environmentId: nonEmptyText,
        trueforgeSessionId: nonEmptyText,
        terminalTurnId: nonEmptyText,
        terminalTurnLink: z
          .object({
            successorIntentKey: digestIdentitySchema("m4-successor-intent"),
            previousTurnId: nonEmptyText,
            successorTurnId: nonEmptyText,
            inputDigest: digestText,
            input: jsonValueSchema,
          })
          .strict(),
      })
      .strict(),
    trueforgeProvenance: z
      .object({
        runtimeProfile: z
          .object({
            runtimeId: z.literal("@truefoundry/trueforge"),
            profileKind: z.literal("deterministic_judge"),
            provider: z
              .object({
                name: nonEmptyText,
                type: z.literal("custom"),
                modelId: nonEmptyText,
                modelName: nonEmptyText,
              })
              .strict(),
            agent: z
              .object({
                agentId: nonEmptyText,
                agentName: nonEmptyText,
                modelName: nonEmptyText,
                iterationLimit: z.number().int().positive(),
                sandboxEnabled: z.literal(true),
                fileDownloadsEnabled: z.literal(false),
                dynamicSubagentsEnabled: z.literal(true),
                askUserQuestionsEnabled: z.literal(false),
                approvalRequiredTools: z.array(nonEmptyText),
              })
              .strict(),
          })
          .strict(),
        missionBinding: z
          .object({
            missionId: nonEmptyText,
            sessionId: nonEmptyText,
            agentId: nonEmptyText,
            m2DatabaseInstanceIdentity: digestIdentitySchema("database-instance"),
            factoryDatabaseInstanceIdentity: digestIdentitySchema("database-instance"),
          })
          .strict(),
        cursor: z
          .object({
            currentTurnId: nonEmptyText,
            sessionLastTurnId: nonEmptyText,
            lastEventSequence: countValue,
            terminalTurnEventCount: countValue,
            totalSessionEvents: countValue,
          })
          .strict(),
        turns: z.array(
          z
            .object({
              ordinal: z.number().int().positive(),
              turnId: nonEmptyText,
              previousTurnId: nonEmptyText.nullable(),
              nativeInputDigest: digestText,
              inputKind: z.enum(["user_message", "user_tool_approval"]),
              approval: z
                .object({
                  threadId: nonEmptyText,
                  toolCallId: nonEmptyText,
                  decision: z.enum(["allow", "deny"]),
                  reasonDigest: digestText.nullable(),
                })
                .strict()
                .nullable(),
              stateStatus: z.literal("done"),
              requiredApprovalEventId: nonEmptyText.nullable(),
              successorIntent: z
                .object({
                  intentKey: digestIdentitySchema("m4-successor-intent"),
                  previousTurnId: nonEmptyText,
                  successorTurnId: nonEmptyText,
                  inputDigest: digestText,
                })
                .strict(),
            })
            .strict(),
        ),
        subagentThreads: z.array(
          z
            .object({
              threadId: nonEmptyText,
              title: nonEmptyText,
              parentThreadId: nonEmptyText,
              parentToolCallId: nonEmptyText,
              createdTurnId: nonEmptyText,
              createdEventId: nonEmptyText,
              doneTurnId: nonEmptyText,
              doneEventId: nonEmptyText,
              completionStatus: z.literal("done"),
              outputDigest: digestText,
            })
            .strict(),
        ),
        connectors: z.array(
          z
            .object({
              registryId: nonEmptyText,
              serviceId: nonEmptyText,
              name: nonEmptyText,
              registrationType: z.literal("remote"),
              transportType: z.literal("streamable-http"),
              initializedTurnIds: z.array(nonEmptyText),
              initializationEventIds: z.array(nonEmptyText),
            })
            .strict(),
        ),
        sandbox: z
          .object({
            sandboxIdentity: digestIdentitySchema("trueforge-local-sandbox"),
            createdTurnId: nonEmptyText,
            createdEventId: nonEmptyText,
            executionThreadId: nonEmptyText,
            executionToolCallId: nonEmptyText,
            executionToolCallEventId: nonEmptyText,
            executionArgumentsDigest: digestText,
            responseEventId: nonEmptyText,
            responseStatus: z.literal("completed"),
            exitCode: z.literal(0),
            resultDigest: digestText,
          })
          .strict(),
        replayContinuity: z
          .object({
            ownerRequestEventIds: z.array(digestIdentitySchema("m4-bridge-event")),
            resumeEventIds: z.array(digestIdentitySchema("m4-bridge-event")),
            exactlyOnceEffectCount: z.literal(1),
            exactlyOnceReceiptCount: z.literal(1),
            exactlyOnceTerminalCount: z.literal(1),
          })
          .strict(),
        durableOrdering: z
          .object({
            mutationReceipt: orderedResponseSchema,
            independentReadBack: orderedResponseSchema,
            verification: orderedResponseSchema,
            terminal: orderedResponseSchema,
          })
          .strict(),
      })
      .strict(),
    authoritativeBasis: z
      .object({
        admissionRecordId: nonEmptyText,
        promiseBasisId: nonEmptyText,
        versions: z
          .object({
            portfolioVersion: nonEmptyText,
            capacityModelVersion: nonEmptyText,
            capacityPlanVersion: nonEmptyText,
            authorizationStateVersion: nonEmptyText,
          })
          .strict(),
        calibrationFrontierDigest: digestText,
        promiseBasis: jsonValueSchema,
      })
      .strict(),
    currentDurableVersions: z
      .object({
        portfolioVersion: nonEmptyText,
        capacityModelVersion: nonEmptyText,
        capacityPlanVersion: nonEmptyText,
        authorizationStateVersion: nonEmptyText,
      })
      .strict(),
    admissions: z.array(evidenceAdmissionSchema).length(3),
    selectedPlan: z
      .object({
        replanAdmissionRecordId: nonEmptyText,
        replanPlanId: nonEmptyText,
        replanCandidate: jsonValueSchema,
        executionAdmissionRecordId: nonEmptyText,
        executionPlanId: nonEmptyText,
        preExecutionAdmissionRecordId: nonEmptyText,
      })
      .strict(),
    promiseAcceptance: z
      .object({
        addendumId: nonEmptyText,
        admissionRecordId: nonEmptyText,
        body: jsonValueSchema,
      })
      .strict(),
    authorizationGrant: z
      .object({
        grantId: nonEmptyText,
        grantAllowanceKey: nonEmptyText,
        grant: jsonValueSchema,
        allowance: jsonValueSchema,
        allowanceClaim: z
          .object({
            ordinal: z.number().int().positive(),
            executionAttemptId: nonEmptyText,
          })
          .strict(),
      })
      .strict(),
    ownerDecisions: z.array(ownerDecisionSchema).min(1),
    ownerApprovalBindings: z.array(approvalBindingSchema).min(1),
    mechanicalAlternateRepresentationDenial: z
      .object({
        denialId: nonEmptyText,
        denial: jsonValueSchema,
        bridgeKey: digestIdentitySchema("m4-bridge"),
        toolName: nonEmptyText,
        argumentsDigest: digestText,
        arguments: jsonValueSchema,
        approval: jsonValueSchema,
      })
      .strict(),
    execution: z
      .object({
        attemptId: nonEmptyText,
        attempt: z
          .object({ input: jsonValueSchema, result: jsonValueSchema })
          .strict(),
        fence: z
          .object({ record: jsonValueSchema, resultBinding: jsonValueSchema })
          .strict(),
      })
      .strict(),
    mutationReceipt: jsonValueSchema,
    factoryMutation: z
      .object({
        request: jsonValueSchema,
        result: jsonValueSchema,
        mutationEvent: jsonValueSchema,
        resultDigest: digestText,
        canonicalResultDigest: digestText,
      })
      .strict(),
    independentReadBack: z
      .object({
        currentState: jsonValueSchema,
        currentStateDigest: digestText,
        terminalEventId: nonEmptyText,
        observedAfterState: jsonValueSchema,
        observedAfterStateDigest: digestText,
        receiptId: nonEmptyText,
      })
      .strict(),
    terminalProjection: z
      .object({
        status: z.literal("VERIFIED_COMPLETE"),
        terminalEvent: jsonValueSchema,
        reservationStatus: z.literal("terminal_verified"),
        executionAttemptId: nonEmptyText,
        receiptId: nonEmptyText,
        factoryResultDigest: digestText,
      })
      .strict(),
    actualConsumptionFacts: z.array(
      z
        .object({
          addendumId: nonEmptyText,
          admissionRecordId: nonEmptyText,
          body: jsonValueSchema,
        })
        .strict(),
    ),
    counts: countsSchema,
  })
  .strict();

export const missionEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVIDENCE_SCHEMA_VERSION),
    canonicalization: z.literal(MISSION_EVIDENCE_CANONICALIZATION),
    digestAlgorithm: z.literal("sha256"),
    payloadDigest: digestText,
    payload: missionEvidencePayloadSchema,
  })
  .strict();

export type MissionEvidencePayload = z.infer<typeof missionEvidencePayloadSchema>;
export type MissionEvidenceBundle = z.infer<typeof missionEvidenceBundleSchema>;

export interface MissionEvidenceDatabasePaths {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionDatabasePath: string;
  readonly trueforgeDatabasePath: string;
}

export interface MissionEvidenceBuildOptions extends MissionEvidenceDatabasePaths {
  readonly missionId: string;
}

export interface MissionEvidenceVerificationResult {
  readonly missionId: string;
  readonly payloadDigest: string;
  readonly canonicalByteLength: number;
  readonly databaseMatch: boolean;
}

export class MissionEvidenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MissionEvidenceError";
  }
}

type MissionEvidenceDatabaseLifecycle =
  EvidenceHandleLifecycleManager<DatabaseSync>;

/** @internal Caller-owned lifecycle for CLI and loopback-service boundaries. */
export function createMissionEvidenceDatabaseLifecycle(
  overrideOpen?: (
    request: EvidenceHandleRequest,
    openDefault: () => DatabaseSync,
  ) => DatabaseSync,
): MissionEvidenceDatabaseLifecycle {
  return new EvidenceHandleLifecycleManager((request) => {
    const openDefault = (): DatabaseSync =>
      openReadOnlyDatabase(request.path, request.label);
    return overrideOpen === undefined
      ? openDefault()
      : overrideOpen(request, openDefault);
  });
}

const defaultMissionEvidenceDatabaseLifecycle =
  createMissionEvidenceDatabaseLifecycle();

/** @internal Bounded drain for direct database-backed callers at shutdown. */
export function drainDefaultMissionEvidenceDatabaseLifecycle(): void {
  defaultMissionEvidenceDatabaseLifecycle.drain();
}

/**
 * Distinguishes an unfinished mission from an evidence-export defect without
 * opening either durable store for mutation.
 */
export function isMissionEvidenceReady(
  options: MissionEvidenceBuildOptions,
): boolean {
  return isMissionEvidenceReadyWithLifecycle(
    options,
    defaultMissionEvidenceDatabaseLifecycle,
  );
}

/** @internal Readiness projection using a caller-owned lifecycle. */
export function isMissionEvidenceReadyWithLifecycle(
  options: MissionEvidenceBuildOptions,
  lifecycle: MissionEvidenceDatabaseLifecycle,
): boolean {
  requireText(options.missionId, "missionId");
  if (!existsSync(options.missionDatabasePath)) return false;
  try {
    return withEvidenceHandleOwnership(
      lifecycle,
      ({ acquire }) => {
        const mission = acquire({
          key: "mission",
          path: options.missionDatabasePath,
          label: "mission",
        });
        const missionRow = mission
          .prepare(
            `SELECT current_turn_id FROM m4_missions WHERE mission_id = ?`,
          )
          .get(options.missionId) as Record<string, unknown> | undefined;
        if (
          missionRow === undefined ||
          typeof missionRow["current_turn_id"] !== "string" ||
          missionRow["current_turn_id"].length === 0
        ) {
          return false;
        }
        if (!existsSync(options.m2DatabasePath)) {
          throw new MissionEvidenceError(
            "terminal mission binding exists without its durable M2 database",
          );
        }
        const m2 = acquire({
          key: "m2",
          path: options.m2DatabasePath,
          label: "M2",
        });
        return (
          countRows(
            m2,
            `SELECT COUNT(*) AS count FROM reservation_events
              WHERE event_kind = 'terminal_verified'`,
          ) > 0
        );
      },
    );
  } catch (error: unknown) {
    if (error instanceof MissionEvidenceError) throw error;
    throw new MissionEvidenceError(
      `mission evidence readiness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function buildMissionEvidenceBundle(
  options: MissionEvidenceBuildOptions,
): MissionEvidenceBundle {
  return buildMissionEvidenceBundleWithLifecycle(
    options,
    defaultMissionEvidenceDatabaseLifecycle,
  );
}

/** @internal Canonical projection using a caller-owned lifecycle. */
export function buildMissionEvidenceBundleWithLifecycle(
  options: MissionEvidenceBuildOptions,
  lifecycle: MissionEvidenceDatabaseLifecycle,
): MissionEvidenceBundle {
  validateBuildOptions(options);
  function projectEvidenceFromHandles(
    m2: DatabaseSync,
    mission: DatabaseSync,
    factory: DatabaseSync,
    trueforge: DatabaseSync,
  ): MissionEvidenceBundle {
    const missionRow = requireOneRow(
      mission,
      `SELECT mission_id, environment_id, trueforge_agent_id, trueforge_session_id,
              current_turn_id, last_event_sequence,
              m2_environment_identity, factory_environment_identity
         FROM m4_missions WHERE mission_id = ?`,
      [options.missionId],
      "mission binding",
    );
    const environmentId = requireText(missionRow["environment_id"], "environment_id");
    const currentM2Identity = databaseInstanceIdentityFromHandle(
      m2,
      canonicalDatabasePath(options.m2DatabasePath),
      "m2",
      environmentId,
    );
    const currentFactoryIdentity = databaseInstanceIdentityFromHandle(
      factory,
      canonicalDatabasePath(options.factoryDatabasePath),
      "factory",
      environmentId,
    );
    if (
      requireText(missionRow["m2_environment_identity"], "m2_environment_identity") !==
        currentM2Identity ||
      requireText(
        missionRow["factory_environment_identity"],
        "factory_environment_identity",
      ) !== currentFactoryIdentity
    ) {
      throw new MissionEvidenceError(
        "mission database instance identities conflict with its durable environment binding",
      );
    }
    const currentTurnId = requireText(missionRow["current_turn_id"], "current_turn_id");
    const terminalTurnRow = requireOneRow(
      mission,
      `SELECT intent_key, previous_turn_id, input_digest, input_json
         FROM m4_successor_intents
        WHERE mission_id = ? AND trueforge_session_id = ? AND successor_turn_id = ?`,
      [
        options.missionId,
        requireText(missionRow["trueforge_session_id"], "trueforge_session_id"),
        currentTurnId,
      ],
      "terminal TrueForge successor intent",
    );
    const terminalTurnInput = sanitizeEvidenceValue(
      parseCanonicalStoredJson(terminalTurnRow["input_json"], "terminal turn input"),
    );

    const admissionRows = allRows(
      m2,
      `SELECT admission_record_id, body_json
         FROM admission_records ORDER BY created_at, admission_record_id`,
    );
    if (admissionRows.length !== 3) {
      throw new MissionEvidenceError(
        `completed deterministic mission requires exactly 3 admission records; found ${String(admissionRows.length)}`,
      );
    }
    const admissions = admissionRows.map((row) => {
      const admissionRecordId = requireText(
        row["admission_record_id"],
        "admission_record_id",
      );
      const record = requireObject(
        sanitizeEvidenceValue(
          parseCanonicalStoredJson(row["body_json"], `admission ${admissionRecordId}`),
        ),
        `admission ${admissionRecordId}`,
      );
      if (record["admissionRecordId"] !== admissionRecordId) {
        throw new MissionEvidenceError("admission row identity does not match its canonical body");
      }
      const addenda = allRows(
        m2!,
        `SELECT sequence, addendum_id, admission_record_id, kind, body_json
           FROM admission_addenda WHERE admission_record_id = ? ORDER BY sequence`,
        [admissionRecordId],
      ).map((addendum) => ({
        sequence: requireNonnegativeInteger(addendum["sequence"], "addendum sequence"),
        addendumId: requireText(addendum["addendum_id"], "addendum_id"),
        admissionRecordId: requireText(
          addendum["admission_record_id"],
          "addendum admission_record_id",
        ),
        kind: requireText(addendum["kind"], "addendum kind"),
        body: sanitizeEvidenceValue(
          parseCanonicalStoredJson(addendum["body_json"], "admission addendum"),
        ),
      }));
      return { admissionRecordId, record, addenda };
    });

    const attemptRow = requireOnlyRow(
      m2,
      `SELECT execution_attempt_id, input_json, result_json FROM execution_attempts`,
      "execution attempt",
    );
    const attemptId = requireText(
      attemptRow["execution_attempt_id"],
      "execution_attempt_id",
    );
    const attemptInput = requireObject(
      sanitizeEvidenceValue(
        parseCanonicalStoredJson(attemptRow["input_json"], "execution attempt input"),
      ),
      "execution attempt input",
    );
    const attemptResult = requireObject(
      sanitizeEvidenceValue(
        parseCanonicalStoredJson(attemptRow["result_json"], "execution attempt result"),
      ),
      "execution attempt result",
    );
    const acceptedAdmissionId = requireText(
      attemptInput["admissionRecordId"],
      "attempt admissionRecordId",
    );
    const preExecutionAdmissionId = requireText(
      attemptResult["preExecutionAdmissionRecordId"],
      "attempt preExecutionAdmissionRecordId",
    );
    const replanAdmission = requireSingle(
      admissions.filter((item) => item.record["decision"] === "REPLAN"),
      "initial REPLAN admission",
    );
    const acceptedAdmission = requireSingle(
      admissions.filter((item) => item.admissionRecordId === acceptedAdmissionId),
      "accepted execution admission",
    );
    const preExecutionAdmission = requireSingle(
      admissions.filter((item) => item.admissionRecordId === preExecutionAdmissionId),
      "pre-execution admission",
    );
    if (
      acceptedAdmission.record["decision"] !== "ADMITTABLE" ||
      preExecutionAdmission.record["decision"] !== "ADMITTABLE"
    ) {
      throw new MissionEvidenceError("execution admissions must both be ADMITTABLE");
    }
    const ownerChoice = requireSingle(
      replanAdmission.addenda.filter((item) => item.kind === "owner_choice"),
      "selected replan owner choice",
    );
    const ownerChoiceBody = requireObject(ownerChoice.body, "selected replan owner choice");
    const replanPlanId = requireText(
      ownerChoiceBody["selectedPlanId"],
      "selected replan plan ID",
    );
    const candidates = requireArray(
      replanAdmission.record["candidatePlans"],
      "REPLAN candidatePlans",
    );
    const replanCandidate = requireSingle(
      candidates.filter(
        (candidate) =>
          requireObject(candidate, "REPLAN candidate")["candidatePlanId"] === replanPlanId,
      ),
      "selected REPLAN candidate",
    );
    const executionPlanId = requireText(
      attemptInput["selectedPlanId"],
      "execution selectedPlanId",
    );
    const acceptance = requireSingle(
      acceptedAdmission.addenda.filter((item) => item.kind === "acceptance_commit"),
      "promise acceptance",
    );

    const grantRow = requireOnlyRow(
      m2,
      `SELECT grant_id, grant_allowance_key, body_json FROM grants`,
      "authorization grant",
    );
    const allowanceRow = requireOnlyRow(
      m2,
      `SELECT grant_allowance_key, body_json FROM grant_allowances`,
      "grant allowance",
    );
    const claimRow = requireOnlyRow(
      m2,
      `SELECT grant_allowance_key, ordinal, execution_attempt_id FROM allowance_claims`,
      "allowance claim",
    );
    const grant = sanitizeEvidenceValue(
      parseCanonicalStoredJson(grantRow["body_json"], "authorization grant"),
    );
    const allowance = sanitizeEvidenceValue(
      parseCanonicalStoredJson(allowanceRow["body_json"], "grant allowance"),
    );

    const ownerDecisions = allRows(
      m2,
      `SELECT owner_decision_id, body_json FROM owner_decisions ORDER BY owner_decision_id`,
    ).map((row) => ({
      ownerDecisionId: requireText(row["owner_decision_id"], "owner_decision_id"),
      decision: sanitizeEvidenceValue(
        parseCanonicalStoredJson(row["body_json"], "owner decision"),
      ),
    }));

    const actions = allRows(
      mission,
      `SELECT bridge_key, trueforge_session_id, trueforge_turn_id,
              trueforge_thread_id, trueforge_tool_call_id, action_kind,
              tool_name, arguments_digest, arguments_json
         FROM m4_bridge_actions WHERE mission_id = ? ORDER BY bridge_key`,
      [options.missionId],
    );
    const trueforgeProjection = buildTrueForgeProjection({
      trueforge,
      mission,
      missionRow,
      actions,
      m2DatabaseInstanceIdentity: currentM2Identity,
      factoryDatabaseInstanceIdentity: currentFactoryIdentity,
    });
    const approvalBindings = actions.map((action) => {
      const bridgeKey = requireText(action["bridge_key"], "bridge_key");
      const arguments_ = sanitizeEvidenceValue(
        parseCanonicalStoredJson(action["arguments_json"], "bridge arguments"),
      );
      const argumentsDigest = requireText(
        action["arguments_digest"],
        "arguments_digest",
      );
      if (sha256(canonicalSerialize(arguments_)) !== argumentsDigest) {
        throw new MissionEvidenceError(`bridge ${bridgeKey} arguments digest is inconsistent`);
      }
      const outcome = requireOneRow(
        mission!,
        `SELECT result_json FROM m4_bridge_events
           WHERE bridge_key = ? AND status = 'approval_bound'`,
        [bridgeKey],
        `approval binding ${bridgeKey}`,
      );
      return {
        bridgeKey,
        trueforgeSessionId: requireText(
          action["trueforge_session_id"],
          "bridge trueforge_session_id",
        ),
        trueforgeTurnId: requireText(
          action["trueforge_turn_id"],
          "bridge trueforge_turn_id",
        ),
        trueforgeThreadId: requireText(
          action["trueforge_thread_id"],
          "bridge trueforge_thread_id",
        ),
        trueforgeToolCallId: requireText(
          action["trueforge_tool_call_id"],
          "bridge trueforge_tool_call_id",
        ),
        actionKind: requireActionKind(action["action_kind"]),
        toolName: requireText(action["tool_name"], "bridge tool_name"),
        argumentsDigest,
        arguments: arguments_,
        approval: sanitizeEvidenceValue(
          parseCanonicalStoredJson(outcome["result_json"], "approval binding"),
        ),
        native: requireMapValue(
          trueforgeProjection.nativeByBridgeKey,
          bridgeKey,
          `native TrueForge provenance ${bridgeKey}`,
        ),
        ownerRequest:
          trueforgeProjection.ownerRequestByBridgeKey.get(bridgeKey) ?? null,
      };
    });
    const mechanicalBinding = requireSingle(
      approvalBindings.filter(
        (binding) =>
          requireObject(binding.approval, "approval binding")["source"] ===
          "active_m2_denial",
      ),
      "mechanical alternate-representation denial",
    );
    const mechanicalApproval = requireObject(
      mechanicalBinding.approval,
      "mechanical denial approval",
    );
    const denialId = requireText(mechanicalApproval["denialId"], "mechanical denialId");
    const denialRow = requireOneRow(
      m2,
      `SELECT body_json FROM denials WHERE denial_id = ?`,
      [denialId],
      "active denial",
    );
    const denial = sanitizeEvidenceValue(
      parseCanonicalStoredJson(denialRow["body_json"], "active denial"),
    );

    const fenceRow = requireOnlyRow(
      m2,
      `SELECT fence_id, body_json FROM execution_fences`,
      "execution fence",
    );
    const fenceId = requireText(fenceRow["fence_id"], "fence_id");
    const fenceRecord = sanitizeEvidenceValue(
      parseCanonicalStoredJson(fenceRow["body_json"], "execution fence"),
    );
    const fenceBindingRow = requireOneRow(
      m2,
      `SELECT body_json FROM execution_fence_events
         WHERE fence_id = ? AND event_kind = 'factory_result_bound'`,
      [fenceId],
      "execution fence result binding",
    );
    const fenceResultBinding = sanitizeEvidenceValue(
      parseCanonicalStoredJson(
        fenceBindingRow["body_json"],
        "execution fence result binding",
      ),
    );

    const factoryEvidence = readAuthoritativeFactoryExecution(
      options.factoryDatabasePath,
      attemptId,
    );
    if (factoryEvidence === null) {
      throw new MissionEvidenceError("completed mission has no authoritative factory mutation");
    }
    const sanitizedFactoryResult = requireObject(
      sanitizeEvidenceValue(factoryEvidence.result),
      "factory mutation result",
    );
    const receipt = requireObject(
      sanitizedFactoryResult["receipt"],
      "factory mutation receipt",
    );
    const receiptId = requireText(receipt["receiptId"], "factory receiptId");

    const terminalRow = requireOnlyRow(
      m2,
      `SELECT reservation_event_id, event_kind, body_json FROM reservation_events`,
      "terminal event",
    );
    if (terminalRow["event_kind"] !== "terminal_verified") {
      throw new MissionEvidenceError("mission terminal event is not terminal_verified");
    }
    const terminalEventId = requireText(
      terminalRow["reservation_event_id"],
      "terminal event ID",
    );
    const terminalEvent = requireObject(
      sanitizeEvidenceValue(
        parseCanonicalStoredJson(terminalRow["body_json"], "terminal event"),
      ),
      "terminal event",
    );
    const observedAfterState = requireJsonValue(
      terminalEvent["observedAfterState"],
      "terminal observedAfterState",
    );

    const actualConsumptionFacts = allRows(
      m2,
      `SELECT addendum_id, admission_record_id, body_json
         FROM admission_addenda WHERE kind = 'actual_consumption' ORDER BY addendum_id`,
    ).map((row) => ({
      addendumId: requireText(row["addendum_id"], "actual fact addendum_id"),
      admissionRecordId: requireText(
        row["admission_record_id"],
        "actual fact admission_record_id",
      ),
      body: sanitizeEvidenceValue(
        parseCanonicalStoredJson(row["body_json"], "actual-consumption fact"),
      ),
    }));

    const versionsRow = requireOneRow(
      m2,
      `SELECT portfolio_version, capacity_model_version, capacity_plan_version,
              authorization_state_version FROM state_versions WHERE singleton = 1`,
      [],
      "current durable versions",
    );
    const acceptedRecord = acceptedAdmission.record;
    const m1Result = requireObject(acceptedRecord["m1Result"], "accepted m1Result");
    const promiseBasis = requireJsonValue(m1Result["promiseBasis"], "accepted promiseBasis");

    const payload: MissionEvidencePayload = {
      schemaVersion: MISSION_EVIDENCE_PAYLOAD_SCHEMA_VERSION,
      mission: {
        missionId: requireText(missionRow["mission_id"], "mission_id"),
        environmentId,
        trueforgeSessionId: requireText(
          missionRow["trueforge_session_id"],
          "trueforge_session_id",
        ),
        terminalTurnId: currentTurnId,
        terminalTurnLink: {
          successorIntentKey: requireText(terminalTurnRow["intent_key"], "intent_key"),
          previousTurnId: requireText(
            terminalTurnRow["previous_turn_id"],
            "previous_turn_id",
          ),
          successorTurnId: currentTurnId,
          inputDigest: requireDigest(terminalTurnRow["input_digest"], "input_digest"),
          input: terminalTurnInput,
        },
      },
      trueforgeProvenance: trueforgeProjection.provenance,
      authoritativeBasis: {
        admissionRecordId: acceptedAdmissionId,
        promiseBasisId: requireText(acceptedRecord["promiseBasisId"], "promiseBasisId"),
        versions: admissionVersions(acceptedRecord),
        calibrationFrontierDigest: requireDigest(
          acceptedRecord["calibrationFrontierDigest"],
          "calibrationFrontierDigest",
        ),
        promiseBasis,
      },
      currentDurableVersions: versionTupleFromRow(versionsRow),
      admissions: [
        evidenceAdmission("initial_replan", replanAdmission),
        evidenceAdmission("accepted_execution_basis", acceptedAdmission),
        evidenceAdmission("pre_execution_recomputation", preExecutionAdmission),
      ],
      selectedPlan: {
        replanAdmissionRecordId: replanAdmission.admissionRecordId,
        replanPlanId,
        replanCandidate,
        executionAdmissionRecordId: acceptedAdmissionId,
        executionPlanId,
        preExecutionAdmissionRecordId: preExecutionAdmissionId,
      },
      promiseAcceptance: {
        addendumId: acceptance.addendumId,
        admissionRecordId: acceptance.admissionRecordId,
        body: acceptance.body,
      },
      authorizationGrant: {
        grantId: requireText(grantRow["grant_id"], "grant_id"),
        grantAllowanceKey: requireText(
          grantRow["grant_allowance_key"],
          "grant_allowance_key",
        ),
        grant,
        allowance,
        allowanceClaim: {
          ordinal: requirePositiveInteger(claimRow["ordinal"], "allowance ordinal"),
          executionAttemptId: requireText(
            claimRow["execution_attempt_id"],
            "allowance execution_attempt_id",
          ),
        },
      },
      ownerDecisions,
      ownerApprovalBindings: approvalBindings,
      mechanicalAlternateRepresentationDenial: {
        denialId,
        denial,
        bridgeKey: mechanicalBinding.bridgeKey,
        toolName: mechanicalBinding.toolName,
        argumentsDigest: mechanicalBinding.argumentsDigest,
        arguments: mechanicalBinding.arguments,
        approval: mechanicalBinding.approval,
      },
      execution: {
        attemptId,
        attempt: { input: attemptInput, result: attemptResult },
        fence: { record: fenceRecord, resultBinding: fenceResultBinding },
      },
      mutationReceipt: receipt,
      factoryMutation: {
        request: sanitizeEvidenceValue(factoryEvidence.request),
        result: sanitizedFactoryResult,
        mutationEvent: sanitizeEvidenceValue(factoryEvidence.mutationEvent),
        resultDigest: factoryEvidence.resultDigest,
        canonicalResultDigest: sha256(canonicalSerialize(sanitizedFactoryResult)),
      },
      independentReadBack: {
        currentState: sanitizeEvidenceValue(factoryEvidence.currentState),
        currentStateDigest: factoryEvidence.currentStateDigest,
        terminalEventId,
        observedAfterState,
        observedAfterStateDigest: factoryStateDigest(
          observedAfterState as unknown as Parameters<typeof factoryStateDigest>[0],
        ),
        receiptId,
      },
      terminalProjection: {
        status: "VERIFIED_COMPLETE",
        terminalEvent,
        reservationStatus: "terminal_verified",
        executionAttemptId: attemptId,
        receiptId,
        factoryResultDigest: factoryEvidence.resultDigest,
      },
      actualConsumptionFacts,
      counts: {
        admissionRecords: admissionRows.length,
        acceptanceCommits: countRows(
          m2,
          `SELECT COUNT(*) AS count FROM admission_addenda WHERE kind = 'acceptance_commit'`,
        ),
        ownerDecisions: ownerDecisions.length,
        ownerApprovalBindings: approvalBindings.filter(
          (binding) =>
            requireObject(binding.approval, "approval binding")["source"] === "owner",
        ).length,
        mechanicalDenials: 1,
        activeDenials: countRows(m2, `SELECT COUNT(*) AS count FROM denials`),
        grantAllowances: countRows(m2, `SELECT COUNT(*) AS count FROM grant_allowances`),
        grants: countRows(m2, `SELECT COUNT(*) AS count FROM grants`),
        allowanceClaims: countRows(m2, `SELECT COUNT(*) AS count FROM allowance_claims`),
        executionAttempts: countRows(m2, `SELECT COUNT(*) AS count FROM execution_attempts`),
        executionFences: countRows(m2, `SELECT COUNT(*) AS count FROM execution_fences`),
        executionFenceBindings: countRows(
          m2,
          `SELECT COUNT(*) AS count FROM execution_fence_events
             WHERE event_kind = 'factory_result_bound'`,
        ),
        factoryMutations: countFactoryRows(factory, "mutation_events"),
        mutationReceipts: countFactoryRows(factory, "execution_results"),
        terminalEvents: countRows(
          m2,
          `SELECT COUNT(*) AS count FROM reservation_events
             WHERE event_kind = 'terminal_verified'`,
        ),
        actualConsumptionFacts: actualConsumptionFacts.length,
        realizedEffects: countRows(m2, `SELECT COUNT(*) AS count FROM realized_effects`),
        receiptReferences: countRows(
          m2,
          `SELECT COUNT(*) AS count FROM admission_addenda WHERE kind = 'receipt_reference'`,
        ),
        bridgeActions: actions.length,
        trueforgeTurns: trueforgeProjection.counts.turns,
        trueforgeSessionEvents: trueforgeProjection.counts.sessionEvents,
        trueforgeSubagentThreads: trueforgeProjection.counts.subagentThreads,
        trueforgeConnectors: trueforgeProjection.counts.connectors,
        trueforgeConnectorInitializations:
          trueforgeProjection.counts.connectorInitializations,
        trueforgeApprovalRequiredEvents:
          trueforgeProjection.counts.approvalRequiredEvents,
        trueforgeUserApprovals: trueforgeProjection.counts.userApprovals,
        trueforgeToolResponses: trueforgeProjection.counts.toolResponses,
        trueforgeSandboxCreatedEvents:
          trueforgeProjection.counts.sandboxCreatedEvents,
        trueforgeSandboxExecutions: trueforgeProjection.counts.sandboxExecutions,
        trueforgeOwnerDecisionEvents:
          trueforgeProjection.counts.ownerDecisionEvents,
        trueforgeResumeEvents: trueforgeProjection.counts.resumeEvents,
      },
    };

    const parsedPayload = missionEvidencePayloadSchema.parse(payload);
    assertEvidenceHygiene(parsedPayload);
    verifyMissionEvidencePayload(parsedPayload);
    return deepFreeze({
      schemaVersion: MISSION_EVIDENCE_SCHEMA_VERSION,
      canonicalization: MISSION_EVIDENCE_CANONICALIZATION,
      digestAlgorithm: "sha256",
      payloadDigest: sha256(canonicalSerialize(parsedPayload)),
      payload: parsedPayload,
    });
  }

  try {
    return withEvidenceHandleOwnership(
      lifecycle,
      ({ acquire }) =>
        projectEvidenceFromHandles(
          acquire({
            key: "m2",
            path: options.m2DatabasePath,
            label: "M2",
          }),
          acquire({
            key: "mission",
            path: options.missionDatabasePath,
            label: "mission",
          }),
          acquire({
            key: "factory",
            path: options.factoryDatabasePath,
            label: "factory",
          }),
          acquire({
            key: "trueforge",
            path: options.trueforgeDatabasePath,
            label: "TrueForge",
          }),
        ),
    );
  } catch (error: unknown) {
    if (error instanceof MissionEvidenceError) throw error;
    throw new MissionEvidenceError(
      `mission evidence export failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function serializeMissionEvidenceBundle(
  bundle: MissionEvidenceBundle,
): string {
  const parsed = missionEvidenceBundleSchema.parse(bundle);
  verifyMissionEvidenceBundle(parsed);
  return canonicalSerialize(parsed);
}

export function exportMissionEvidenceBundle(
  options: MissionEvidenceBuildOptions,
): string {
  return exportMissionEvidenceBundleWithLifecycle(
    options,
    defaultMissionEvidenceDatabaseLifecycle,
  );
}

/** @internal Canonical export using a caller-owned lifecycle. */
export function exportMissionEvidenceBundleWithLifecycle(
  options: MissionEvidenceBuildOptions,
  lifecycle: MissionEvidenceDatabaseLifecycle,
): string {
  return serializeMissionEvidenceBundle(
    buildMissionEvidenceBundleWithLifecycle(options, lifecycle),
  );
}

export function verifyMissionEvidenceBytes(
  bytes: string,
  databases?: MissionEvidenceBuildOptions,
): MissionEvidenceVerificationResult {
  return verifyMissionEvidenceBytesWithLifecycle(
    bytes,
    databases,
    defaultMissionEvidenceDatabaseLifecycle,
  );
}

/** @internal Standalone/database-backed verification with outer cleanup ownership. */
export function verifyMissionEvidenceBytesWithLifecycle(
  bytes: string,
  databases: MissionEvidenceBuildOptions | undefined,
  lifecycle: MissionEvidenceDatabaseLifecycle,
): MissionEvidenceVerificationResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bytes) as unknown;
  } catch (error: unknown) {
    throw new MissionEvidenceError("evidence bundle is not valid JSON", {
      cause: error,
    });
  }
  if (canonicalSerialize(parsedJson) !== bytes) {
    throw new MissionEvidenceError("evidence bundle bytes are not exact canonical JSON");
  }
  const parsed = missionEvidenceBundleSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new MissionEvidenceError(
      `evidence bundle schema validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  verifyMissionEvidenceBundle(parsed.data);
  let databaseMatch = false;
  if (databases !== undefined) {
    const expected = exportMissionEvidenceBundleWithLifecycle(databases, lifecycle);
    if (expected !== bytes) {
      throw new MissionEvidenceError(
        "evidence bundle does not exactly match the read-only durable database projection",
      );
    }
    databaseMatch = true;
  }
  return deepFreeze({
    missionId: parsed.data.payload.mission.missionId,
    payloadDigest: parsed.data.payloadDigest,
    canonicalByteLength: Buffer.byteLength(bytes, "utf8"),
    databaseMatch,
  });
}

export function verifyMissionEvidenceBundle(bundle: MissionEvidenceBundle): void {
  const payloadBytes = canonicalSerialize(bundle.payload);
  if (sha256(payloadBytes) !== bundle.payloadDigest) {
    throw new MissionEvidenceError("evidence payload digest does not match its canonical bytes");
  }
  assertEvidenceHygiene(bundle.payload);
  verifyMissionEvidencePayload(bundle.payload);
}

export function verifyMissionEvidencePayload(payload: MissionEvidencePayload): void {
  const terminalTurnLink = payload.mission.terminalTurnLink;
  if (
    terminalTurnLink.successorTurnId !== payload.mission.terminalTurnId ||
    terminalTurnLink.successorIntentKey !==
      stableTupleId("m4-successor-intent", [
        payload.mission.trueforgeSessionId,
        terminalTurnLink.previousTurnId,
      ]) ||
    terminalTurnLink.inputDigest !== sha256(canonicalSerialize(terminalTurnLink.input))
  ) {
    throw new MissionEvidenceError(
      "TrueForge session and terminal-turn linkage is inconsistent",
    );
  }
  for (const binding of payload.ownerApprovalBindings) {
    if (
      binding.trueforgeSessionId !== payload.mission.trueforgeSessionId ||
      binding.bridgeKey !==
        stableTupleId("m4-bridge", [
          binding.trueforgeSessionId,
          binding.trueforgeTurnId,
          binding.trueforgeThreadId,
          binding.trueforgeToolCallId,
        ])
    ) {
      throw new MissionEvidenceError(
        `approval bridge ${binding.bridgeKey} has inconsistent TrueForge identity linkage`,
      );
    }
  }
  verifyTrueForgeProvenance(payload);
  const admissionByRole = new Map(payload.admissions.map((item) => [item.role, item]));
  if (admissionByRole.size !== 3) {
    throw new MissionEvidenceError("evidence admissions must contain each durable role once");
  }
  for (const admission of payload.admissions) {
    const record = requireObject(admission.record, `admission ${admission.role}`);
    const admissionRecordId = requireText(record["admissionRecordId"], "admissionRecordId");
    if (sha256(canonicalSerialize(admission.record)) !== admission.recordDigest) {
      throw new MissionEvidenceError(`admission ${admissionRecordId} digest is inconsistent`);
    }
    if (admission.addenda.some((item) => item.admissionRecordId !== admissionRecordId)) {
      throw new MissionEvidenceError(`admission ${admissionRecordId} has a foreign addendum`);
    }
  }
  const replan = requireMapValue(admissionByRole, "initial_replan", "initial REPLAN admission");
  const accepted = requireMapValue(
    admissionByRole,
    "accepted_execution_basis",
    "accepted execution admission",
  );
  const preExecution = requireMapValue(
    admissionByRole,
    "pre_execution_recomputation",
    "pre-execution admission",
  );
  const replanRecord = requireObject(replan.record, "REPLAN admission");
  const acceptedRecord = requireObject(accepted.record, "accepted admission");
  const preExecutionRecord = requireObject(preExecution.record, "pre-execution admission");
  if (
    replanRecord["decision"] !== "REPLAN" ||
    acceptedRecord["decision"] !== "ADMITTABLE" ||
    preExecutionRecord["decision"] !== "ADMITTABLE"
  ) {
    throw new MissionEvidenceError("admission roles are inconsistent with their decisions");
  }
  const replanAdmissionId = requireText(replanRecord["admissionRecordId"], "REPLAN ID");
  const acceptedAdmissionId = requireText(
    acceptedRecord["admissionRecordId"],
    "accepted admission ID",
  );
  const preExecutionAdmissionId = requireText(
    preExecutionRecord["admissionRecordId"],
    "pre-execution admission ID",
  );
  if (
    payload.selectedPlan.replanAdmissionRecordId !== replanAdmissionId ||
    payload.selectedPlan.executionAdmissionRecordId !== acceptedAdmissionId ||
    payload.selectedPlan.preExecutionAdmissionRecordId !== preExecutionAdmissionId ||
    payload.authoritativeBasis.admissionRecordId !== acceptedAdmissionId ||
    payload.promiseAcceptance.admissionRecordId !== acceptedAdmissionId
  ) {
    throw new MissionEvidenceError("selected plan, admission, and acceptance linkage is inconsistent");
  }
  if (
    payload.authoritativeBasis.promiseBasisId !== acceptedRecord["promiseBasisId"] ||
    payload.authoritativeBasis.calibrationFrontierDigest !==
      acceptedRecord["calibrationFrontierDigest"] ||
    canonicalSerialize(payload.authoritativeBasis.promiseBasis) !==
      canonicalSerialize(
        requireObject(acceptedRecord["m1Result"], "accepted M1 result")["promiseBasis"],
      ) ||
    canonicalSerialize(payload.authoritativeBasis.versions) !==
      canonicalSerialize(admissionVersions(acceptedRecord))
  ) {
    throw new MissionEvidenceError("authoritative Promise Basis identity or versions are inconsistent");
  }
  const selectedCandidate = requireObject(
    payload.selectedPlan.replanCandidate,
    "selected REPLAN candidate",
  );
  const replanCandidates = requireArray(replanRecord["candidatePlans"], "REPLAN candidates");
  const selectedReplanRecord = requireObject(
    replanRecord["selectedPlan"],
    "REPLAN selected plan",
  );
  const replanOwnerChoice = requireSingle(
    replan.addenda.filter((item) => item.kind === "owner_choice"),
    "REPLAN owner choice",
  );
  const replanOwnerChoiceBody = requireObject(
    replanOwnerChoice.body,
    "REPLAN owner choice",
  );
  if (
    selectedCandidate["candidatePlanId"] !== payload.selectedPlan.replanPlanId ||
    selectedReplanRecord["selectedPlanId"] !== payload.selectedPlan.replanPlanId ||
    replanOwnerChoiceBody["selectedPlanId"] !== payload.selectedPlan.replanPlanId ||
    !replanCandidates.some(
      (candidate) => canonicalSerialize(candidate) === canonicalSerialize(selectedCandidate),
    )
  ) {
    throw new MissionEvidenceError("selected REPLAN candidate and owner-choice linkage is inconsistent");
  }
  const acceptanceBody = requireObject(payload.promiseAcceptance.body, "promise acceptance");
  const acceptanceOwnerDecisionId = requireText(
    acceptanceBody["ownerDecisionId"],
    "acceptance ownerDecisionId",
  );
  const acceptanceOwnerDecision = requireSingle(
    payload.ownerDecisions.filter(
      (item) => item.ownerDecisionId === acceptanceOwnerDecisionId,
    ),
    "promise acceptance owner decision",
  );
  const acceptanceOwnerDecisionBody = requireObject(
    acceptanceOwnerDecision.decision,
    "promise acceptance owner decision",
  );
  const acceptedOwnerChoice = requireSingle(
    accepted.addenda.filter((item) => item.kind === "owner_choice"),
    "accepted-plan owner choice",
  );
  const acceptanceApproval = requireSingle(
    payload.ownerApprovalBindings.filter(
      (binding) => binding.toolName === "accept_promise",
    ),
    "Promise acceptance approval bridge",
  );
  const acceptanceApprovalBody = requireObject(
    acceptanceApproval.approval,
    "Promise acceptance approval",
  );
  const acceptedRecordPlan = requireObject(
    acceptedRecord["selectedPlan"],
    "accepted selected plan",
  );
  const acceptanceAddendum = requireSingle(
    accepted.addenda.filter((item) => item.kind === "acceptance_commit"),
    "acceptance addendum",
  );
  if (
    acceptanceBody["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    acceptedRecordPlan["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    acceptanceOwnerDecisionBody["kind"] !== "ACCEPT_PROMISE" ||
    acceptanceOwnerDecisionBody["ownerDecisionId"] !== acceptanceOwnerDecisionId ||
    acceptanceOwnerDecisionBody["admissionRecordId"] !== acceptedAdmissionId ||
    acceptanceOwnerDecisionBody["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    canonicalSerialize(acceptedOwnerChoice.body) !==
      canonicalSerialize(acceptanceOwnerDecision.decision) ||
    acceptanceApproval.actionKind !== "owner_decision" ||
    acceptanceApprovalBody["source"] !== "owner" ||
    acceptanceApprovalBody["decision"] !== "allow" ||
    acceptanceAddendum.addendumId !== payload.promiseAcceptance.addendumId ||
    canonicalSerialize(acceptanceAddendum.body) !==
      canonicalSerialize(payload.promiseAcceptance.body)
  ) {
    throw new MissionEvidenceError("promise acceptance does not bind the execution plan and owner decision");
  }

  const attemptInput = requireObject(payload.execution.attempt.input, "execution attempt input");
  const attemptResult = requireObject(payload.execution.attempt.result, "execution attempt result");
  const grant = requireObject(payload.authorizationGrant.grant, "authorization grant");
  const allowance = requireObject(payload.authorizationGrant.allowance, "grant allowance");
  const acceptanceCommittedPortfolioVersion = requireText(
    acceptanceBody["committedPortfolioVersion"],
    "acceptance committedPortfolioVersion",
  );
  if (
    attemptInput["executionAttemptId"] !== payload.execution.attemptId ||
    attemptResult["executionAttemptId"] !== payload.execution.attemptId ||
    attemptInput["admissionRecordId"] !== acceptedAdmissionId ||
    attemptInput["promiseBasisId"] !== payload.authoritativeBasis.promiseBasisId ||
    attemptInput["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    attemptResult["preExecutionAdmissionRecordId"] !== preExecutionAdmissionId ||
    attemptInput["grantId"] !== payload.authorizationGrant.grantId ||
    attemptInput["grantAllowanceKey"] !== payload.authorizationGrant.grantAllowanceKey ||
    payload.authorizationGrant.allowanceClaim.executionAttemptId !== payload.execution.attemptId ||
    grant["grantId"] !== payload.authorizationGrant.grantId ||
    grant["grantAllowanceKey"] !== payload.authorizationGrant.grantAllowanceKey ||
    allowance["grantAllowanceKey"] !== payload.authorizationGrant.grantAllowanceKey ||
    grant["admissionRecordId"] !== acceptedAdmissionId ||
    allowance["admissionRecordId"] !== acceptedAdmissionId ||
    grant["promiseBasisId"] !== payload.authoritativeBasis.promiseBasisId ||
    allowance["promiseBasisId"] !== payload.authoritativeBasis.promiseBasisId ||
    grant["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    allowance["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    attemptInput["expectedPortfolioVersion"] !== acceptanceCommittedPortfolioVersion ||
    payload.currentDurableVersions.portfolioVersion !== acceptanceCommittedPortfolioVersion ||
    payload.currentDurableVersions.capacityModelVersion !==
      payload.authoritativeBasis.versions.capacityModelVersion ||
    payload.currentDurableVersions.capacityPlanVersion !==
      payload.authoritativeBasis.versions.capacityPlanVersion
  ) {
    throw new MissionEvidenceError("grant, allowance, admission, and execution linkage is inconsistent");
  }
  const fence = requireObject(payload.execution.fence.record, "execution fence");
  const fenceBinding = requireObject(
    payload.execution.fence.resultBinding,
    "execution fence result binding",
  );
  const receipt = requireObject(payload.mutationReceipt, "mutation receipt");
  const factoryRequest = requireObject(payload.factoryMutation.request, "factory request");
  const factoryClaim = requireObject(factoryRequest["claim"], "factory claim");
  const factoryCommand = requireObject(factoryRequest["command"], "factory command");
  const factoryResult = requireObject(payload.factoryMutation.result, "factory result");
  const factoryResultReceipt = requireObject(factoryResult["receipt"], "factory result receipt");
  const mutationEvent = requireObject(
    payload.factoryMutation.mutationEvent,
    "factory mutation event",
  );
  const terminal = requireObject(payload.terminalProjection.terminalEvent, "terminal event");
  const beforeState = requireJsonValue(factoryResult["beforeState"], "factory before-state");
  const resultingState = requireJsonValue(
    factoryResult["resultingState"],
    "factory resultingState",
  );
  const resultingStateObject = requireObject(resultingState, "factory resultingState");
  const currentStateObject = requireObject(
    payload.independentReadBack.currentState,
    "factory current state",
  );
  const fenceId = requireText(fence["fenceId"], "fenceId");
  const receiptId = requireText(receipt["receiptId"], "receiptId");
  if (
    fence["executionAttemptId"] !== payload.execution.attemptId ||
    fence["admissionRecordId"] !== acceptedAdmissionId ||
    fence["selectedPlanId"] !== payload.selectedPlan.executionPlanId ||
    fenceBinding["fenceId"] !== fenceId ||
    fenceBinding["executionAttemptId"] !== payload.execution.attemptId ||
    fenceBinding["receiptId"] !== receiptId ||
    factoryRequest["executionAttemptId"] !== payload.execution.attemptId ||
    factoryResult["executionAttemptId"] !== payload.execution.attemptId ||
    factoryResult["fenceId"] !== fenceId ||
    mutationEvent["executionAttemptId"] !== payload.execution.attemptId ||
    mutationEvent["fenceId"] !== fenceId ||
    receipt["executionAttemptId"] !== payload.execution.attemptId ||
    receipt["fenceId"] !== fenceId ||
    fence["environmentId"] !== payload.mission.environmentId ||
    factoryCommand["environmentId"] !== payload.mission.environmentId ||
    resultingStateObject["environmentId"] !== payload.mission.environmentId ||
    currentStateObject["environmentId"] !== payload.mission.environmentId ||
    receipt["beforeStateDigest"] !== sha256(canonicalSerialize(beforeState)) ||
    receipt["beforeStateDigest"] !== factoryRequest["expectedBeforeStateDigest"] ||
    receipt["commandDigest"] !== sha256(canonicalSerialize(factoryCommand)) ||
    receipt["commandDigest"] !== fence["expectedCommandDigest"] ||
    receipt["resultingStateDigest"] !== sha256(canonicalSerialize(resultingState)) ||
    canonicalSerialize(factoryCommand) !==
      canonicalSerialize(factoryResult["canonicalCommand"]) ||
    canonicalSerialize(factoryCommand) !==
      canonicalSerialize(mutationEvent["canonicalCommand"]) ||
    canonicalSerialize(beforeState) !== canonicalSerialize(mutationEvent["beforeState"]) ||
    canonicalSerialize(resultingState) !==
      canonicalSerialize(mutationEvent["resultingState"]) ||
    canonicalSerialize(resultingState) !==
      canonicalSerialize(factoryClaim["expectedAfterState"]) ||
    factoryResultReceipt["receiptId"] !== receiptId ||
    canonicalSerialize(mutationEvent["receipt"]) !== canonicalSerialize(receipt) ||
    canonicalSerialize(receipt) !== canonicalSerialize(factoryResultReceipt) ||
    payload.independentReadBack.receiptId !== receiptId ||
    payload.terminalProjection.receiptId !== receiptId ||
    terminal["receiptReference"] !== receiptId ||
    terminal["executionAttemptId"] !== payload.execution.attemptId ||
    terminal["terminalEventId"] !== payload.independentReadBack.terminalEventId ||
    terminal["status"] !== "VERIFIED_SUCCESS"
  ) {
    throw new MissionEvidenceError("attempt, fence, receipt, read-back, and terminal linkage is inconsistent");
  }
  if (
    sha256(canonicalSerialize(factoryResult)) !==
      payload.factoryMutation.canonicalResultDigest ||
    fenceBinding["factoryResultDigest"] !== payload.factoryMutation.resultDigest ||
    payload.terminalProjection.factoryResultDigest !== payload.factoryMutation.resultDigest
  ) {
    throw new MissionEvidenceError("factory result digest linkage is inconsistent");
  }
  if (
    canonicalSerialize(resultingState) !==
      canonicalSerialize(payload.independentReadBack.observedAfterState) ||
    canonicalSerialize(resultingState) !==
      canonicalSerialize(payload.independentReadBack.currentState) ||
    sha256(canonicalSerialize(payload.independentReadBack.observedAfterState)) !==
      payload.independentReadBack.observedAfterStateDigest ||
    sha256(canonicalSerialize(payload.independentReadBack.currentState)) !==
      payload.independentReadBack.currentStateDigest
  ) {
    throw new MissionEvidenceError("independent read-back does not match the durable factory result");
  }

  const ownerApprovalCount = payload.ownerApprovalBindings.filter(
    (binding) => requireObject(binding.approval, "approval binding")["source"] === "owner",
  ).length;
  const mechanicalCount = payload.ownerApprovalBindings.filter(
    (binding) =>
      requireObject(binding.approval, "approval binding")["source"] ===
      "active_m2_denial",
  ).length;
  for (const binding of payload.ownerApprovalBindings) {
    if (sha256(canonicalSerialize(binding.arguments)) !== binding.argumentsDigest) {
      throw new MissionEvidenceError(`approval bridge ${binding.bridgeKey} arguments were tampered`);
    }
  }
  const mechanical = payload.mechanicalAlternateRepresentationDenial;
  const mechanicalApproval = requireObject(mechanical.approval, "mechanical denial approval");
  const denial = requireObject(mechanical.denial, "active denial");
  const mechanicalArguments = requireObject(mechanical.arguments, "mechanical denial arguments");
  const mechanicalClaim = requireObject(mechanicalArguments["claim"], "mechanical denial claim");
  if (
    mechanicalCount !== 1 ||
    mechanicalApproval["source"] !== "active_m2_denial" ||
    mechanicalApproval["decision"] !== "deny" ||
    mechanicalApproval["ownerSourceIdentity"] !== null ||
    mechanicalApproval["denialId"] !== mechanical.denialId ||
    denial["denialId"] !== mechanical.denialId ||
    mechanical.bridgeKey !== mechanicalApproval["bridgeKey"] ||
    mechanical.argumentsDigest !== sha256(canonicalSerialize(mechanical.arguments)) ||
    !payload.ownerApprovalBindings.some(
      (binding) =>
        binding.bridgeKey === mechanical.bridgeKey &&
        binding.actionKind === "consequential_effect" &&
        binding.toolName === mechanical.toolName &&
        binding.argumentsDigest === mechanical.argumentsDigest &&
        canonicalSerialize(binding.arguments) ===
          canonicalSerialize(mechanical.arguments) &&
        canonicalSerialize(binding.approval) ===
          canonicalSerialize(mechanical.approval),
    )
  ) {
    throw new MissionEvidenceError("mechanical alternate-representation denial is inconsistent");
  }
  const mechanicalEffect = requireObject(mechanicalClaim["effect"], "mechanical denial effect");
  const deniedEffect = requireObject(
    denial["deniedEffectFingerprint"],
    "durable denied effect",
  );
  if (
    canonicalSerialize(normalizeEffect(mechanicalEffect as unknown as EffectFingerprint)) !==
    canonicalSerialize(normalizeEffect(deniedEffect as unknown as EffectFingerprint))
  ) {
    throw new MissionEvidenceError(
      "alternate representation does not canonically match the durable denied effect",
    );
  }
  if (
    !payload.ownerApprovalBindings.some((binding) => {
      const approval = requireObject(binding.approval, "approval binding");
      return (
        approval["source"] === "owner" &&
        approval["decision"] === "deny" &&
        approval["denialId"] === mechanical.denialId &&
        approval["ownerSourceIdentity"] !== null
      );
    })
  ) {
    throw new MissionEvidenceError("durable denial has no exact external-owner source binding");
  }
  if (
    payload.ownerDecisions.some(
      (item) => requireObject(item.decision, "owner decision")["ownerDecisionId"] !== item.ownerDecisionId,
    ) ||
    !payload.ownerApprovalBindings
      .filter(
        (binding) => requireObject(binding.approval, "approval binding")["source"] === "owner",
      )
      .every(
        (binding) =>
          typeof requireObject(binding.approval, "approval binding")["ownerSourceIdentity"] ===
          "string",
      )
  ) {
    throw new MissionEvidenceError("owner decision identity or owner-source linkage is inconsistent");
  }

  const actualsFromTerminal = requireArray(terminal["actualConsumption"], "terminal actuals");
  if (
    payload.actualConsumptionFacts.some(
      (item) =>
        item.admissionRecordId !== acceptedAdmissionId ||
        requireObject(item.body, "actual-consumption fact")["sourceReceipt"] !== receiptId,
    )
  ) {
    throw new MissionEvidenceError("actual-consumption facts have inconsistent durable linkage");
  }
  const actualBodies = payload.actualConsumptionFacts.map((item) => item.body).sort(compareJson);
  const terminalActualBodies = actualsFromTerminal
    .map((item) => {
      const actual = requireObject(item, "terminal actual fact");
      return {
        actualConsumption: actual["value"],
        resourceKey: actual["resourceKey"],
        sourceReceipt: receiptId,
        workClassKey: actual["workClassKey"],
      } as JsonValue;
    })
    .sort(compareJson);
  if (canonicalSerialize(actualBodies) !== canonicalSerialize(terminalActualBodies)) {
    throw new MissionEvidenceError("actual-consumption facts do not match terminal verification");
  }

  const counts = payload.counts;
  if (
    counts.admissionRecords !== payload.admissions.length ||
    counts.acceptanceCommits !== 1 ||
    counts.ownerDecisions !== payload.ownerDecisions.length ||
    counts.ownerApprovalBindings !== ownerApprovalCount ||
    counts.mechanicalDenials !== mechanicalCount ||
    counts.activeDenials !== 1 ||
    counts.grantAllowances !== 1 ||
    counts.grants !== 1 ||
    counts.allowanceClaims !== 1 ||
    counts.executionAttempts !== 1 ||
    counts.executionFences !== 1 ||
    counts.executionFenceBindings !== 1 ||
    counts.factoryMutations !== 1 ||
    counts.mutationReceipts !== 1 ||
    counts.terminalEvents !== 1 ||
    counts.actualConsumptionFacts !== payload.actualConsumptionFacts.length ||
    counts.realizedEffects !== 1 ||
    counts.receiptReferences !== 1 ||
    counts.bridgeActions !== payload.ownerApprovalBindings.length
  ) {
    throw new MissionEvidenceError("exact relevant evidence counts are inconsistent");
  }
}

function verifyTrueForgeProvenance(payload: MissionEvidencePayload): void {
  const provenance = payload.trueforgeProvenance;
  const profile = provenance.runtimeProfile;
  const expectedApprovalTools = [
    "accept_promise",
    "create_schedule_reservation",
    "select_portfolio_modification",
    "submit_schedule_change",
  ];
  if (
    profile.provider.name !== "flakebrake-deterministic" ||
    profile.provider.modelId !== "m4-mission" ||
    profile.provider.modelName !== "m4-mission" ||
    profile.agent.agentName !== "flakebrake-root-obligation-commander" ||
    profile.agent.modelName !== "flakebrake-deterministic/m4-mission" ||
    profile.agent.iterationLimit !== 96 ||
    canonicalSerialize(profile.agent.approvalRequiredTools) !==
      canonicalSerialize(expectedApprovalTools)
  ) {
    throw new MissionEvidenceError(
      "TrueForge deterministic judge profile identity is inconsistent",
    );
  }
  const missionBinding = provenance.missionBinding;
  if (
    missionBinding.missionId !== payload.mission.missionId ||
    missionBinding.sessionId !== payload.mission.trueforgeSessionId ||
    missionBinding.agentId !== profile.agent.agentId
  ) {
    throw new MissionEvidenceError(
      "TrueForge agent and mission-bound session identity is inconsistent",
    );
  }

  const turns = provenance.turns;
  if (turns.length !== 7) {
    throw new MissionEvidenceError("TrueForge deterministic mission must contain seven turns");
  }
  const turnIds = new Set(turns.map((turn) => turn.turnId));
  if (turnIds.size !== turns.length) {
    throw new MissionEvidenceError("TrueForge turn identity was reused");
  }
  for (const [index, turn] of turns.entries()) {
    const previousTurn = turns[index - 1];
    const expectedPreviousTurnId = previousTurn?.turnId ?? null;
    const intentPreviousTurnId = expectedPreviousTurnId ?? "none";
    if (
      turn.ordinal !== index + 1 ||
      turn.previousTurnId !== expectedPreviousTurnId ||
      turn.successorIntent.previousTurnId !== intentPreviousTurnId ||
      turn.successorIntent.successorTurnId !== turn.turnId ||
      turn.successorIntent.intentKey !==
        stableTupleId("m4-successor-intent", [
          payload.mission.trueforgeSessionId,
          intentPreviousTurnId,
        ]) ||
      (turn.inputKind === "user_message") !== (turn.approval === null)
    ) {
      throw new MissionEvidenceError(
        "TrueForge turn chain, successor intent, or input identity is inconsistent",
      );
    }
  }
  const terminalTurn = turns.at(-1) as (typeof turns)[number];
  const cursor = provenance.cursor;
  if (
    turns[0]?.inputKind !== "user_message" ||
    terminalTurn.inputKind !== "user_message" ||
    turns.filter((turn) => turn.inputKind === "user_tool_approval").length !== 5 ||
    terminalTurn.turnId !== payload.mission.terminalTurnId ||
    cursor.currentTurnId !== terminalTurn.turnId ||
    cursor.sessionLastTurnId !== terminalTurn.turnId ||
    cursor.lastEventSequence < cursor.terminalTurnEventCount ||
    cursor.totalSessionEvents !== payload.counts.trueforgeSessionEvents ||
    terminalTurn.successorIntent.intentKey !==
      payload.mission.terminalTurnLink.successorIntentKey ||
    terminalTurn.successorIntent.previousTurnId !==
      payload.mission.terminalTurnLink.previousTurnId ||
    terminalTurn.successorIntent.successorTurnId !==
      payload.mission.terminalTurnLink.successorTurnId ||
    terminalTurn.successorIntent.inputDigest !==
      payload.mission.terminalTurnLink.inputDigest
  ) {
    throw new MissionEvidenceError(
      "TrueForge durable cursor or terminal-turn continuity is inconsistent",
    );
  }

  const requiredEventIds = new Set<string>();
  const ownerRequestEventIds: string[] = [];
  const resumeEventIds: string[] = [];
  for (const binding of payload.ownerApprovalBindings) {
    const native = binding.native;
    const approvalBody = requireObject(binding.approval, "approval binding");
    const decision = requireApprovalDecision(
      approvalBody["decision"],
      "approval binding decision",
    );
    const actionTurn = requireSingle(
      turns.filter((turn) => turn.turnId === binding.trueforgeTurnId),
      `TrueForge action turn ${binding.trueforgeTurnId}`,
    );
    const approvalTurn = requireSingle(
      turns.filter((turn) => turn.turnId === native.userApproval.successorTurnId),
      `TrueForge approval successor ${native.userApproval.successorTurnId}`,
    );
    if (
      actionTurn.requiredApprovalEventId !== native.approvalRequiredEventId ||
      approvalTurn.previousTurnId !== actionTurn.turnId ||
      approvalTurn.approval?.toolCallId !== binding.trueforgeToolCallId ||
      approvalTurn.approval.threadId !== binding.trueforgeThreadId ||
      approvalTurn.approval.decision !== decision ||
      approvalTurn.approval.reasonDigest !== native.userApproval.reasonDigest ||
      approvalTurn.successorIntent.inputDigest !== native.userApproval.inputDigest ||
      native.userApproval.decision !== decision ||
      native.toolCallPosition.turnOrdinal !== actionTurn.ordinal ||
      native.approvalRequiredPosition.turnOrdinal !== actionTurn.ordinal ||
      native.responsePosition.turnOrdinal !== approvalTurn.ordinal ||
      compareEventPositions(
        native.toolCallPosition,
        native.approvalRequiredPosition,
      ) >= 0 ||
      native.responseStatus !== (decision === "allow" ? "completed" : "rejected") ||
      native.resumeBridgeEventId !==
        stableTupleId("m4-bridge-event", [
          binding.bridgeKey,
          "trueforge_resumed",
          { nextTurnId: approvalTurn.turnId, decision },
        ])
    ) {
      throw new MissionEvidenceError(
        `native TrueForge approval linkage is inconsistent for ${binding.bridgeKey}`,
      );
    }
    if (decision === "deny") {
      const reason = requireText(approvalBody["reason"], "approval denial reason");
      if (
        native.userApproval.reasonDigest !== sha256(canonicalSerialize(reason))
      ) {
        throw new MissionEvidenceError(
          `native TrueForge denial reason commitment is inconsistent for ${binding.bridgeKey}`,
        );
      }
    } else if (native.userApproval.reasonDigest !== null) {
      throw new MissionEvidenceError(
        `native TrueForge allow decision has a denial reason for ${binding.bridgeKey}`,
      );
    }
    if (requiredEventIds.has(native.approvalRequiredEventId)) {
      throw new MissionEvidenceError("native TrueForge approval event identity was reused");
    }
    requiredEventIds.add(native.approvalRequiredEventId);
    resumeEventIds.push(native.resumeBridgeEventId);

    const source = requireText(approvalBody["source"], "approval source");
    if (source === "owner") {
      if (binding.ownerRequest === null) {
        throw new MissionEvidenceError("owner approval has no exact action request digest");
      }
      const ownerRequest = binding.ownerRequest;
      const expectedPhase = ownerPhaseForEvidence(binding.toolName);
      const expectedRequestDigest = sha256(
        canonicalSerialize({
          missionId: payload.mission.missionId,
          trueforgeSessionId: binding.trueforgeSessionId,
          trueforgeTurnId: binding.trueforgeTurnId,
          trueforgeThreadId: binding.trueforgeThreadId,
          trueforgeToolCallId: binding.trueforgeToolCallId,
          toolName: binding.toolName,
          arguments: binding.arguments,
          m2DatabaseInstanceIdentity:
            missionBinding.m2DatabaseInstanceIdentity,
          factoryDatabaseInstanceIdentity:
            missionBinding.factoryDatabaseInstanceIdentity,
          phase: expectedPhase,
        }),
      );
      const ownerDecisionResult = {
        requestDigest: expectedRequestDigest,
        ownerSourceIdentity: requireText(
          approvalBody["ownerSourceIdentity"],
          "owner source identity",
        ),
        decision:
          decision === "allow"
            ? { status: "allow" }
            : {
                status: "deny",
                reason: requireText(approvalBody["reason"], "owner denial reason"),
              },
      };
      if (
        ownerRequest.phase !== expectedPhase ||
        ownerRequest.requestDigest !== expectedRequestDigest ||
        ownerRequest.bridgeEventId !==
          stableTupleId("m4-bridge-event", [
            binding.bridgeKey,
            "owner_decision_received",
            ownerDecisionResult,
          ])
      ) {
        throw new MissionEvidenceError(
          "human owner decision is not bound to the exact FlakeBrake action digest",
        );
      }
      ownerRequestEventIds.push(ownerRequest.bridgeEventId);
    } else if (source === "active_m2_denial") {
      if (binding.ownerRequest !== null) {
        throw new MissionEvidenceError(
          "mechanical denial incorrectly contains a human owner request",
        );
      }
    } else {
      throw new MissionEvidenceError("approval binding has an unknown provenance source");
    }
  }

  const expectedThreadTitles = [
    "Assurance and simulation engineer",
    "Capacity and schedule analyst",
    "Portfolio and order analyst",
  ];
  const expectedParentCalls = new Map([
    ["Assurance and simulation engineer", "subagent-assurance"],
    ["Capacity and schedule analyst", "subagent-capacity"],
    ["Portfolio and order analyst", "subagent-portfolio"],
  ]);
  const threads = provenance.subagentThreads;
  if (
    threads.length !== 3 ||
    new Set(threads.map((thread) => thread.threadId)).size !== 3 ||
    canonicalSerialize(
      threads.map((thread) => thread.title).sort(compareStableStrings),
    ) !== canonicalSerialize(expectedThreadTitles)
  ) {
    throw new MissionEvidenceError("TrueForge genuine subagent identities are inconsistent");
  }
  for (const thread of threads) {
    if (
      thread.parentThreadId !== "main" ||
      thread.parentToolCallId !== expectedParentCalls.get(thread.title) ||
      !turnIds.has(thread.createdTurnId) ||
      !turnIds.has(thread.doneTurnId)
    ) {
      throw new MissionEvidenceError(
        "TrueForge subagent thread is not linked to the mission turn chain",
      );
    }
  }

  const expectedConnectorNames = [
    "factory-capacity",
    "factory-change-control",
    "factory-orders",
    "factory-simulator",
  ];
  const connectors = provenance.connectors;
  const initializationEventIds = connectors[0]?.initializationEventIds ?? [];
  if (
    connectors.length !== 4 ||
    canonicalSerialize(connectors.map((connector) => connector.name)) !==
      canonicalSerialize(expectedConnectorNames) ||
    new Set(connectors.map((connector) => connector.registryId)).size !== 4 ||
    connectors.some(
      (connector) =>
        connector.serviceId !== connector.name ||
        canonicalSerialize(connector.initializedTurnIds) !==
          canonicalSerialize(turns.map((turn) => turn.turnId)) ||
        canonicalSerialize(connector.initializationEventIds) !==
          canonicalSerialize(initializationEventIds),
    ) ||
    new Set(initializationEventIds).size !== turns.length
  ) {
    throw new MissionEvidenceError(
      "TrueForge MCP connector identities or initialization linkage is inconsistent",
    );
  }

  const sandbox = provenance.sandbox;
  const assuranceThread = requireSingle(
    threads.filter((thread) => thread.title === "Assurance and simulation engineer"),
    "TrueForge assurance subagent",
  );
  if (
    sandbox.sandboxIdentity !==
      stableTupleId("trueforge-local-sandbox", [
        payload.mission.trueforgeSessionId,
        sandbox.createdEventId,
        "local",
      ]) ||
    !turnIds.has(sandbox.createdTurnId) ||
    sandbox.executionThreadId !== assuranceThread.threadId ||
    sandbox.executionToolCallId !== "assurance-code-mode"
  ) {
    throw new MissionEvidenceError(
      "TrueForge local sandbox identity or execution linkage is inconsistent",
    );
  }

  const continuity = provenance.replayContinuity;
  if (
    canonicalSerialize([...ownerRequestEventIds].sort(compareStableStrings)) !==
      canonicalSerialize(
        [...continuity.ownerRequestEventIds].sort(compareStableStrings),
      ) ||
    canonicalSerialize([...resumeEventIds].sort(compareStableStrings)) !==
      canonicalSerialize([...continuity.resumeEventIds].sort(compareStableStrings))
  ) {
    throw new MissionEvidenceError(
      "TrueForge refresh/reconnect and restart replay continuity is inconsistent",
    );
  }

  const ordering = provenance.durableOrdering;
  const mutationBinding = requireSingle(
    payload.ownerApprovalBindings.filter(
      (binding) => binding.trueforgeToolCallId === "approve-alternative",
    ),
    "TrueForge mutation approval binding",
  );
  if (
    ordering.mutationReceipt.responseEventId !==
      mutationBinding.native.responseEventId ||
    ordering.mutationReceipt.responseDigest !==
      mutationBinding.native.responseDigest ||
    canonicalSerialize(ordering.mutationReceipt.position) !==
      canonicalSerialize(mutationBinding.native.responsePosition) ||
    ordering.mutationReceipt.toolCallId !== "approve-alternative" ||
    ordering.independentReadBack.toolCallId !== "read-after-write" ||
    ordering.verification.toolCallId !== "verify-authoritatively" ||
    ordering.terminal.toolCallId !== "read-terminal-status" ||
    !positionsIncrease([
      ordering.mutationReceipt.position,
      ordering.independentReadBack.position,
      ordering.verification.position,
      ordering.terminal.position,
    ])
  ) {
    throw new MissionEvidenceError(
      "mutation, receipt, independent read-back, verification, and terminal order is inconsistent",
    );
  }

  const counts = payload.counts;
  if (
    counts.trueforgeTurns !== turns.length ||
    counts.trueforgeTurns !== 7 ||
    counts.trueforgeSessionEvents !== cursor.totalSessionEvents ||
    counts.trueforgeSessionEvents !== 71 ||
    counts.trueforgeSubagentThreads !== threads.length ||
    counts.trueforgeSubagentThreads !== 3 ||
    counts.trueforgeConnectors !== connectors.length ||
    counts.trueforgeConnectors !== 4 ||
    counts.trueforgeConnectorInitializations !== initializationEventIds.length ||
    counts.trueforgeConnectorInitializations !== 7 ||
    counts.trueforgeApprovalRequiredEvents !== requiredEventIds.size ||
    counts.trueforgeApprovalRequiredEvents !== 5 ||
    counts.trueforgeUserApprovals !== 5 ||
    counts.trueforgeToolResponses !== 19 ||
    counts.trueforgeSandboxCreatedEvents !== 1 ||
    counts.trueforgeSandboxExecutions !== 1 ||
    counts.trueforgeOwnerDecisionEvents !== ownerRequestEventIds.length ||
    counts.trueforgeOwnerDecisionEvents !== 4 ||
    counts.trueforgeResumeEvents !== resumeEventIds.length ||
    counts.trueforgeResumeEvents !== 5 ||
    continuity.exactlyOnceEffectCount !== counts.factoryMutations ||
    continuity.exactlyOnceReceiptCount !== counts.mutationReceipts ||
    continuity.exactlyOnceTerminalCount !== counts.terminalEvents
  ) {
    throw new MissionEvidenceError("exact TrueForge provenance counts are inconsistent");
  }
}

export function sanitizeEvidenceValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MissionEvidenceError("evidence contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceValue(item));
  if (typeof value !== "object") {
    throw new MissionEvidenceError("evidence contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort(compareStableStrings)) {
    if (EXCLUDED_FIELD_NAMES.has(key)) continue;
    if (SENSITIVE_FIELD_PATTERN.test(key) || key.toLowerCase().includes("path")) {
      throw new MissionEvidenceError(`evidence source contains forbidden field ${key}`);
    }
    sanitized[key] = sanitizeEvidenceValue(record[key]);
  }
  return sanitized;
}

interface TrueForgeEventProjection {
  readonly turnId: string;
  readonly eventId: string;
  readonly event: Record<string, JsonValue>;
  readonly position: { readonly turnOrdinal: number; readonly eventOrdinal: number };
}

interface TrueForgeTurnProjection {
  readonly ordinal: number;
  readonly turnId: string;
  readonly previousTurnId: string | null;
  readonly nativeInputDigest: string;
  readonly inputKind: "user_message" | "user_tool_approval";
  readonly approval: {
    readonly threadId: string;
    readonly toolCallId: string;
    readonly decision: "allow" | "deny";
    readonly reasonDigest: string | null;
  } | null;
  readonly stateStatus: "done";
  readonly requiredApprovalEventId: string | null;
  readonly successorIntent: {
    readonly intentKey: string;
    readonly previousTurnId: string;
    readonly successorTurnId: string;
    readonly inputDigest: string;
  };
}

interface TrueForgeToolCallProjection {
  readonly turnId: string;
  readonly threadId: string;
  readonly eventId: string;
  readonly position: TrueForgeEventProjection["position"];
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly argumentsDigest: string;
}

interface TrueForgeResponseProjection {
  readonly turnId: string;
  readonly threadId: string;
  readonly eventId: string;
  readonly position: TrueForgeEventProjection["position"];
  readonly toolCallId: string;
  readonly body: JsonValue;
  readonly responseDigest: string;
}

function buildTrueForgeProjection(input: {
  readonly trueforge: DatabaseSync;
  readonly mission: DatabaseSync;
  readonly missionRow: Record<string, unknown>;
  readonly actions: readonly Record<string, unknown>[];
  readonly m2DatabaseInstanceIdentity: string;
  readonly factoryDatabaseInstanceIdentity: string;
}): {
  readonly provenance: MissionEvidencePayload["trueforgeProvenance"];
  readonly nativeByBridgeKey: ReadonlyMap<
    string,
    MissionEvidencePayload["ownerApprovalBindings"][number]["native"]
  >;
  readonly ownerRequestByBridgeKey: ReadonlyMap<
    string,
    NonNullable<MissionEvidencePayload["ownerApprovalBindings"][number]["ownerRequest"]>
  >;
  readonly counts: {
    readonly turns: number;
    readonly sessionEvents: number;
    readonly subagentThreads: number;
    readonly connectors: number;
    readonly connectorInitializations: number;
    readonly approvalRequiredEvents: number;
    readonly userApprovals: number;
    readonly toolResponses: number;
    readonly sandboxCreatedEvents: number;
    readonly sandboxExecutions: number;
    readonly ownerDecisionEvents: number;
    readonly resumeEvents: number;
  };
} {
  const missionId = requireText(input.missionRow["mission_id"], "mission_id");
  const sessionId = requireText(
    input.missionRow["trueforge_session_id"],
    "trueforge_session_id",
  );
  const agentId = requireText(
    input.missionRow["trueforge_agent_id"],
    "trueforge_agent_id",
  );
  const currentTurnId = requireText(
    input.missionRow["current_turn_id"],
    "current_turn_id",
  );
  const lastEventSequence = requireNonnegativeInteger(
    input.missionRow["last_event_sequence"],
    "last_event_sequence",
  );

  const session = requireOneRow(
    input.trueforge,
    `SELECT agent_id, agent_name, last_turn_id FROM session WHERE session_id = ?`,
    [sessionId],
    "mission-bound TrueForge session",
  );
  if (
    requireText(session["agent_id"], "TrueForge session agent_id") !== agentId ||
    requireText(session["last_turn_id"], "TrueForge session last_turn_id") !==
      currentTurnId
  ) {
    throw new MissionEvidenceError(
      "TrueForge session, agent, and terminal cursor do not match the mission binding",
    );
  }
  const agent = requireOneRow(
    input.trueforge,
    `SELECT id, name, json(manifest) AS manifest_json FROM agent WHERE id = ?`,
    [agentId],
    "mission-bound TrueForge agent",
  );
  const agentName = requireText(agent["name"], "TrueForge agent name");
  if (requireText(session["agent_name"], "TrueForge session agent_name") !== agentName) {
    throw new MissionEvidenceError("TrueForge session agent name is inconsistent");
  }
  const agentManifest = requireObject(
    parseSqliteJson(agent["manifest_json"], "TrueForge agent manifest"),
    "TrueForge agent manifest",
  );
  const agentModel = requireObject(agentManifest["model"], "TrueForge agent model");
  const agentModelName = requireText(agentModel["name"], "TrueForge agent model name");
  const providerName = requireText(
    agentModelName.split("/")[0],
    "TrueForge provider name",
  );
  const provider = requireOneRow(
    input.trueforge,
    `SELECT name, json(manifest) AS manifest_json FROM model_provider WHERE name = ?`,
    [providerName],
    "mission-bound TrueForge model provider",
  );
  const providerManifest = requireObject(
    parseSqliteJson(provider["manifest_json"], "TrueForge provider manifest"),
    "TrueForge provider manifest",
  );
  const providerModels = requireArray(
    providerManifest["models"],
    "TrueForge provider models",
  );
  const providerModel = requireSingle(
    providerModels.map((value) => requireObject(value, "TrueForge provider model")),
    "deterministic TrueForge provider model",
  );
  const modelId = requireText(providerModel["model_id"], "TrueForge model_id");
  const modelName = requireText(providerModel["name"], "TrueForge model name");
  const agentConfig = requireObject(agentManifest["config"], "TrueForge agent config");
  const sandboxConfig = requireObject(
    agentConfig["sandbox"],
    "TrueForge sandbox config",
  );
  const dynamicSubagentsConfig = requireObject(
    agentConfig["dynamic_sub_agents"],
    "TrueForge dynamic-subagent config",
  );
  const askUserConfig = requireObject(
    agentConfig["ask_user_questions"],
    "TrueForge ask-user config",
  );
  const manifestMcpServers = requireArray(
    agentManifest["mcp_servers"],
    "TrueForge agent MCP servers",
  ).map((value) => requireObject(value, "TrueForge agent MCP server"));
  const approvalRequiredTools = manifestMcpServers
    .flatMap((server) =>
      requireArray(
        server["require_approval_for_tools"],
        "TrueForge approval-required tools",
      ).map((tool) => requireText(tool, "TrueForge approval-required tool")),
    )
    .sort(compareStableStrings);

  const rawTurnRows = allRows(
    input.trueforge,
    `SELECT turn_id, previous_turn_id, json(input) AS input_json,
            json(state) AS state_json
       FROM turn WHERE session_id = ?`,
    [sessionId],
  );
  const turnRowsById = new Map(
    rawTurnRows.map((row) => [requireText(row["turn_id"], "TrueForge turn_id"), row]),
  );
  const orderedTurnRows: Record<string, unknown>[] = [];
  let next = requireSingle(
    rawTurnRows.filter((row) => row["previous_turn_id"] === null),
    "initial TrueForge turn",
  );
  for (;;) {
    orderedTurnRows.push(next);
    const nextRows = rawTurnRows.filter(
      (row) => row["previous_turn_id"] === next["turn_id"],
    );
    if (nextRows.length === 0) break;
    next = requireSingle(nextRows, "linear TrueForge successor turn");
  }
  if (
    orderedTurnRows.length !== turnRowsById.size ||
    requireText(orderedTurnRows.at(-1)?.["turn_id"], "terminal TrueForge turn") !==
      currentTurnId
  ) {
    throw new MissionEvidenceError(
      "TrueForge turn history is branched, disconnected, or not terminal",
    );
  }
  const turnOrdinalById = new Map(
    orderedTurnRows.map((row, index) => [
      requireText(row["turn_id"], "TrueForge turn_id"),
      index + 1,
    ]),
  );

  const rawEvents = allRows(
    input.trueforge,
    `SELECT turn_id, event_id, json(event) AS event_json
       FROM session_event WHERE session_id = ? ORDER BY event_id`,
    [sessionId],
  );
  const events: TrueForgeEventProjection[] = [];
  for (const row of orderedTurnRows) {
    const turnId = requireText(row["turn_id"], "TrueForge event turn_id");
    const rows = rawEvents
      .filter((candidate) => candidate["turn_id"] === turnId)
      .sort((left, right) =>
        compareStableStrings(
          requireText(left["event_id"], "TrueForge event_id"),
          requireText(right["event_id"], "TrueForge event_id"),
        ),
      );
    rows.forEach((eventRow, index) => {
      const eventId = requireText(eventRow["event_id"], "TrueForge event_id");
      const event = requireObject(
        parseSqliteJson(eventRow["event_json"], `TrueForge event ${eventId}`),
        `TrueForge event ${eventId}`,
      );
      if (event["id"] !== eventId) {
        throw new MissionEvidenceError("TrueForge event row identity is inconsistent");
      }
      events.push({
        turnId,
        eventId,
        event,
        position: {
          turnOrdinal: requireMapValue(
            turnOrdinalById,
            turnId,
            "TrueForge event turn ordinal",
          ),
          eventOrdinal: index + 1,
        },
      });
    });
  }
  if (events.length !== rawEvents.length) {
    throw new MissionEvidenceError("TrueForge session contains events from a foreign turn");
  }
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  if (eventsById.size !== events.length) {
    throw new MissionEvidenceError("TrueForge event identity was reused");
  }

  const turns: TrueForgeTurnProjection[] = orderedTurnRows.map((row, index) => {
    const turnId = requireText(row["turn_id"], "TrueForge turn_id");
    const previousTurnId = nullableText(
      row["previous_turn_id"],
      "TrueForge previous_turn_id",
    );
    const nativeInput = parseSqliteJson(
      row["input_json"],
      `TrueForge turn ${turnId} input`,
    );
    const nativeInputItems = requireArray(nativeInput, "TrueForge turn input");
    const nativeInputItem = requireSingle(
      nativeInputItems.map((value) => requireObject(value, "TrueForge turn input item")),
      "TrueForge turn input item",
    );
    const nativeInputType = requireText(
      nativeInputItem["type"],
      "TrueForge turn input type",
    );
    let inputKind: TrueForgeTurnProjection["inputKind"];
    let approval: TrueForgeTurnProjection["approval"];
    if (nativeInputType === "user.message") {
      inputKind = "user_message";
      approval = null;
    } else if (nativeInputType === "user.tool_approval") {
      inputKind = "user_tool_approval";
      const approvalBody = requireObject(
        nativeInputItem["approval"],
        "TrueForge user approval",
      );
      const decision = requireApprovalDecision(
        approvalBody["status"],
        "TrueForge user approval decision",
      );
      approval = {
        threadId: requireText(
          nativeInputItem["thread_id"],
          "TrueForge user approval thread_id",
        ),
        toolCallId: requireText(
          nativeInputItem["tool_call_id"],
          "TrueForge user approval tool_call_id",
        ),
        decision,
        reasonDigest:
          approvalBody["reason"] === undefined
            ? null
            : sha256(
                canonicalSerialize(
                  requireText(approvalBody["reason"], "TrueForge denial reason"),
                ),
              ),
      };
    } else {
      throw new MissionEvidenceError(
        `unsupported durable TrueForge turn input ${nativeInputType}`,
      );
    }
    const state = requireObject(
      parseSqliteJson(row["state_json"], `TrueForge turn ${turnId} state`),
      `TrueForge turn ${turnId} state`,
    );
    if (state["status"] !== "done") {
      throw new MissionEvidenceError("completed mission contains an unfinished TrueForge turn");
    }
    const requiredActions =
      state["required_actions"] === undefined
        ? []
        : requireArray(state["required_actions"], "TrueForge required actions");
    if (requiredActions.length > 1) {
      throw new MissionEvidenceError(
        "deterministic mission has more than one approval-required event in a turn",
      );
    }
    const requiredApprovalEventId =
      requiredActions.length === 0
        ? null
        : requireText(
            requireObject(
              requiredActions[0],
              "TrueForge required action",
            )["id"],
            "TrueForge required action id",
          );
    if (
      requiredApprovalEventId !== null &&
      requireMapValue(
        eventsById,
        requiredApprovalEventId,
        "TrueForge required-action event",
      ).event["type"] !== "tool.approval_required"
    ) {
      throw new MissionEvidenceError("TrueForge required action is not a native approval event");
    }
    const intent = requireOneRow(
      input.mission,
      `SELECT intent_key, previous_turn_id, successor_turn_id, input_digest, input_json
         FROM m4_successor_intents
        WHERE mission_id = ? AND trueforge_session_id = ? AND successor_turn_id = ?`,
      [missionId, sessionId, turnId],
      `TrueForge successor intent for ${turnId}`,
    );
    const intentPreviousTurnId = requireText(
      intent["previous_turn_id"],
      "successor intent previous_turn_id",
    );
    if (
      intentPreviousTurnId !== (previousTurnId ?? "none") ||
      requireText(intent["successor_turn_id"], "successor intent turn") !== turnId
    ) {
      throw new MissionEvidenceError("TrueForge turn and successor-intent chain conflict");
    }
    const intentInput = parseCanonicalStoredJson(
      intent["input_json"],
      `successor intent ${turnId} input`,
    );
    const intentInputDigest = requireDigest(
      intent["input_digest"],
      "successor intent input_digest",
    );
    if (intentInputDigest !== sha256(canonicalSerialize(intentInput))) {
      throw new MissionEvidenceError("TrueForge successor-intent input digest is inconsistent");
    }
    assertEquivalentTurnInput(inputKind, approval, intentInput);
    return {
      ordinal: index + 1,
      turnId,
      previousTurnId,
      nativeInputDigest: sha256(canonicalSerialize(nativeInput)),
      inputKind,
      approval,
      stateStatus: "done",
      requiredApprovalEventId,
      successorIntent: {
        intentKey: requireText(intent["intent_key"], "successor intent_key"),
        previousTurnId: intentPreviousTurnId,
        successorTurnId: turnId,
        inputDigest: intentInputDigest,
      },
    };
  });
  const toolCalls = new Map<string, TrueForgeToolCallProjection>();
  const responses = new Map<string, TrueForgeResponseProjection>();
  const approvalRequired = new Map<
    string,
    { readonly sourceEventId: string; readonly event: TrueForgeEventProjection }
  >();
  for (const item of events) {
    const type = item.event["type"];
    if (type === "model.message") {
      const calls =
        item.event["tool_calls"] === undefined
          ? []
          : requireArray(item.event["tool_calls"], "TrueForge tool calls");
      for (const callValue of calls) {
        const call = requireObject(callValue, "TrueForge tool call");
        const toolCallId = requireText(call["id"], "TrueForge tool call id");
        const function_ = requireObject(
          call["function"],
          "TrueForge tool-call function",
        );
        const rawArguments = requireText(
          function_["arguments"],
          "TrueForge tool-call arguments",
        );
        const arguments_ = parseJsonText(
          rawArguments,
          `TrueForge tool-call ${toolCallId} arguments`,
        );
        if (toolCalls.has(toolCallId)) {
          throw new MissionEvidenceError("TrueForge tool-call identity was reused");
        }
        toolCalls.set(toolCallId, {
          turnId: item.turnId,
          threadId: requireText(item.event["thread_id"], "tool-call thread_id"),
          eventId: item.eventId,
          position: item.position,
          toolCallId,
          toolName: requireText(function_["name"], "TrueForge tool name"),
          arguments: arguments_,
          argumentsDigest: sha256(canonicalSerialize(arguments_)),
        });
      }
    } else if (type === "tool.response") {
      const toolCallId = requireText(
        item.event["tool_call_id"],
        "TrueForge response tool_call_id",
      );
      const body = sanitizeEvidenceValue(
        parseJsonTextOrString(
          requireString(item.event["content"], "TrueForge response content"),
          `TrueForge response ${toolCallId}`,
        ),
      );
      if (responses.has(toolCallId)) {
        throw new MissionEvidenceError("TrueForge tool response identity was reused");
      }
      responses.set(toolCallId, {
        turnId: item.turnId,
        threadId: requireText(item.event["thread_id"], "response thread_id"),
        eventId: item.eventId,
        position: item.position,
        toolCallId,
        body,
        responseDigest: sha256(canonicalSerialize(body)),
      });
    } else if (type === "tool.approval_required") {
      const references = requireArray(
        item.event["tool_calls"],
        "TrueForge approval references",
      );
      const reference = requireSingle(
        references.map((value) =>
          requireObject(value, "TrueForge approval reference"),
        ),
        "TrueForge approval reference",
      );
      const toolCallId = requireText(
        reference["id"],
        "TrueForge approval tool-call id",
      );
      if (approvalRequired.has(toolCallId)) {
        throw new MissionEvidenceError("TrueForge approval identity was reused");
      }
      approvalRequired.set(toolCallId, {
        sourceEventId: requireText(
          reference["source_event_id"],
          "TrueForge approval source event",
        ),
        event: item,
      });
    }
  }

  const nativeByBridgeKey = new Map<
    string,
    MissionEvidencePayload["ownerApprovalBindings"][number]["native"]
  >();
  const ownerRequestByBridgeKey = new Map<
    string,
    NonNullable<MissionEvidencePayload["ownerApprovalBindings"][number]["ownerRequest"]>
  >();
  for (const action of input.actions) {
    const bridgeKey = requireText(action["bridge_key"], "bridge_key");
    const actionSessionId = requireText(
      action["trueforge_session_id"],
      "bridge trueforge_session_id",
    );
    const actionTurnId = requireText(
      action["trueforge_turn_id"],
      "bridge trueforge_turn_id",
    );
    const actionThreadId = requireText(
      action["trueforge_thread_id"],
      "bridge trueforge_thread_id",
    );
    const toolCallId = requireText(
      action["trueforge_tool_call_id"],
      "bridge trueforge_tool_call_id",
    );
    const toolName = requireText(action["tool_name"], "bridge tool_name");
    const arguments_ = parseCanonicalStoredJson(
      action["arguments_json"],
      `bridge ${bridgeKey} arguments`,
    );
    const argumentsDigest = requireDigest(
      action["arguments_digest"],
      `bridge ${bridgeKey} arguments_digest`,
    );
    const toolCall = requireMapValue(
      toolCalls,
      toolCallId,
      `TrueForge tool call ${toolCallId}`,
    );
    const required = requireMapValue(
      approvalRequired,
      toolCallId,
      `TrueForge approval-required event ${toolCallId}`,
    );
    const successorTurn = requireSingle(
      turns.filter(
        (turn) =>
          turn.previousTurnId === actionTurnId &&
          turn.approval?.toolCallId === toolCallId,
      ),
      `TrueForge user approval turn ${toolCallId}`,
    );
    const response = requireMapValue(
      responses,
      toolCallId,
      `TrueForge tool response ${toolCallId}`,
    );
    if (
      actionSessionId !== sessionId ||
      toolCall.turnId !== actionTurnId ||
      toolCall.threadId !== actionThreadId ||
      toolCall.toolName !== toolName ||
      toolCall.argumentsDigest !== argumentsDigest ||
      canonicalSerialize(toolCall.arguments) !== canonicalSerialize(arguments_) ||
      required.sourceEventId !== toolCall.eventId ||
      required.event.turnId !== actionTurnId ||
      required.event.event["thread_id"] !== actionThreadId ||
      successorTurn.approval?.threadId !== actionThreadId ||
      response.turnId !== successorTurn.turnId ||
      response.threadId !== actionThreadId
    ) {
      throw new MissionEvidenceError(
        `native TrueForge call, approval, and response linkage conflicts for ${toolCallId}`,
      );
    }
    const resume = requireOneRow(
      input.mission,
      `SELECT bridge_event_id, result_json FROM m4_bridge_events
        WHERE bridge_key = ? AND status = 'trueforge_resumed'`,
      [bridgeKey],
      `TrueForge resume event ${bridgeKey}`,
    );
    const resumeBody = requireObject(
      parseCanonicalStoredJson(resume["result_json"], "TrueForge resume result"),
      "TrueForge resume result",
    );
    if (
      resumeBody["nextTurnId"] !== successorTurn.turnId ||
      resumeBody["decision"] !== successorTurn.approval.decision
    ) {
      throw new MissionEvidenceError("TrueForge resume and user approval linkage conflict");
    }
    const resumeBridgeEventId = requireText(
      resume["bridge_event_id"],
      "TrueForge resume bridge_event_id",
    );
    if (
      resumeBridgeEventId !==
      stableTupleId("m4-bridge-event", [bridgeKey, "trueforge_resumed", resumeBody])
    ) {
      throw new MissionEvidenceError("TrueForge resume event identity is inconsistent");
    }
    const responseStatus =
      successorTurn.approval.decision === "allow" ? "completed" : "rejected";
    nativeByBridgeKey.set(bridgeKey, {
      toolCallEventId: toolCall.eventId,
      toolCallPosition: toolCall.position,
      approvalRequiredEventId: required.event.eventId,
      approvalRequiredPosition: required.event.position,
      userApproval: {
        successorTurnId: successorTurn.turnId,
        inputDigest: successorTurn.successorIntent.inputDigest,
        decision: successorTurn.approval.decision,
        reasonDigest: successorTurn.approval.reasonDigest,
      },
      responseEventId: response.eventId,
      responsePosition: response.position,
      responseStatus,
      responseDigest: response.responseDigest,
      resumeBridgeEventId,
    });

    const ownerRows = allRows(
      input.mission,
      `SELECT bridge_event_id, result_json FROM m4_bridge_events
        WHERE bridge_key = ? AND status = 'owner_decision_received'`,
      [bridgeKey],
    );
    if (ownerRows.length > 1) {
      throw new MissionEvidenceError("TrueForge bridge has duplicate owner decisions");
    }
    if (ownerRows.length === 1) {
      const ownerRow = ownerRows[0] as Record<string, unknown>;
      const ownerBody = requireObject(
        parseCanonicalStoredJson(ownerRow["result_json"], "owner decision result"),
        "owner decision result",
      );
      const phase = ownerPhaseForEvidence(toolName);
      const expectedRequestDigest = sha256(
        canonicalSerialize({
          missionId,
          trueforgeSessionId: sessionId,
          trueforgeTurnId: actionTurnId,
          trueforgeThreadId: actionThreadId,
          trueforgeToolCallId: toolCallId,
          toolName,
          arguments: arguments_,
          m2DatabaseInstanceIdentity: input.m2DatabaseInstanceIdentity,
          factoryDatabaseInstanceIdentity: input.factoryDatabaseInstanceIdentity,
          phase,
        }),
      );
      if (ownerBody["requestDigest"] !== expectedRequestDigest) {
        throw new MissionEvidenceError(
          "owner decision is not bound to the exact FlakeBrake mission action",
        );
      }
      const bridgeEventId = requireText(
        ownerRow["bridge_event_id"],
        "owner decision bridge_event_id",
      );
      if (
        bridgeEventId !==
        stableTupleId("m4-bridge-event", [
          bridgeKey,
          "owner_decision_received",
          ownerBody,
        ])
      ) {
        throw new MissionEvidenceError("owner decision bridge event identity is inconsistent");
      }
      ownerRequestByBridgeKey.set(bridgeKey, {
        bridgeEventId,
        requestDigest: expectedRequestDigest,
        phase,
      });
    }
  }

  const threadCreated = events.filter(
    (item) => item.event["type"] === "thread.created",
  );
  const threadDone = events.filter((item) => item.event["type"] === "thread.done");
  const subagentThreads = threadCreated
    .map((created) => {
      const threadId = requireText(created.event["thread_id"], "subagent thread_id");
      const done = requireSingle(
        threadDone.filter((candidate) => candidate.event["thread_id"] === threadId),
        `completed subagent thread ${threadId}`,
      );
      const createdParent = requireObject(
        created.event["parent"],
        "subagent thread parent",
      );
      const doneParent = requireObject(done.event["parent"], "subagent done parent");
      const title = requireText(created.event["title"], "subagent title");
      const doneState = requireObject(done.event["state"], "subagent done state");
      const output = requireObject(doneState["output"], "subagent output");
      const outputBody = parseJsonText(
        requireText(output["content"], "subagent output content"),
        "subagent output content",
      );
      if (
        done.event["title"] !== title ||
        doneState["status"] !== "done" ||
        canonicalSerialize(doneParent) !== canonicalSerialize(createdParent)
      ) {
        throw new MissionEvidenceError("TrueForge subagent completion linkage is inconsistent");
      }
      return {
        threadId,
        title,
        parentThreadId: requireText(
          createdParent["thread_id"],
          "subagent parent thread_id",
        ),
        parentToolCallId: requireText(
          createdParent["tool_call_id"],
          "subagent parent tool_call_id",
        ),
        createdTurnId: created.turnId,
        createdEventId: created.eventId,
        doneTurnId: done.turnId,
        doneEventId: done.eventId,
        completionStatus: "done" as const,
        outputDigest: sha256(canonicalSerialize(outputBody)),
      };
    })
    .sort((left, right) => compareStableStrings(left.threadId, right.threadId));

  const initializationEvents = events.filter(
    (item) => item.event["type"] === "mcp.initialize",
  );
  const connectorRows = allRows(
    input.trueforge,
    `SELECT id, name, json(manifest) AS manifest_json FROM mcp_server ORDER BY name`,
  );
  const connectors = connectorRows.map((row) => {
    const name = requireText(row["name"], "TrueForge MCP server name");
    const manifest = requireObject(
      parseSqliteJson(row["manifest_json"], `TrueForge MCP server ${name}`),
      `TrueForge MCP server ${name}`,
    );
    const initialized = initializationEvents.map((event) => {
      const servers = requireArray(
        event.event["mcp_servers"],
        "TrueForge initialized MCP servers",
      ).map((value) => requireObject(value, "TrueForge initialized MCP server"));
      const server = requireSingle(
        servers.filter((candidate) => candidate["name"] === name),
        `initialized MCP service ${name}`,
      );
      if (
        server["id"] !== name ||
        server["transport_type"] !== "streamable-http"
      ) {
        throw new MissionEvidenceError("TrueForge MCP initialization identity conflicts");
      }
      return event;
    });
    if (manifest["type"] !== "remote") {
      throw new MissionEvidenceError("deterministic TrueForge connector is not remote");
    }
    return {
      registryId: requireText(row["id"], "TrueForge MCP registry id"),
      serviceId: name,
      name,
      registrationType: "remote" as const,
      transportType: "streamable-http" as const,
      initializedTurnIds: initialized.map((event) => event.turnId),
      initializationEventIds: initialized.map((event) => event.eventId),
    };
  });

  const sandboxCreated = requireSingle(
    events.filter((item) => item.event["type"] === "sandbox.created"),
    "TrueForge local sandbox creation",
  );
  const rawSandboxId = requireText(
    sandboxCreated.event["sandbox_id"],
    "TrueForge sandbox_id",
  );
  if (
    !rawSandboxId.startsWith("v1:local:") ||
    !MACHINE_PATH_PATTERN.test(rawSandboxId.slice("v1:local:".length))
  ) {
    throw new MissionEvidenceError("TrueForge sandbox is not a local isolated sandbox");
  }
  const sandboxTool = requireMapValue(
    toolCalls,
    "assurance-code-mode",
    "TrueForge sandbox execution call",
  );
  const sandboxResponse = requireMapValue(
    responses,
    "assurance-code-mode",
    "TrueForge sandbox execution response",
  );
  const sandboxEnvelope = requireObject(
    sandboxResponse.body,
    "TrueForge sandbox response envelope",
  );
  const sandboxResult = requireObject(
    sandboxEnvelope["response"],
    "TrueForge sandbox response",
  );
  if (
    sandboxTool.toolName !== "exec" ||
    sandboxEnvelope["success"] !== true ||
    sandboxResult["exitCode"] !== 0 ||
    sandboxTool.threadId !== sandboxResponse.threadId ||
    !subagentThreads.some(
      (thread) =>
        thread.threadId === sandboxTool.threadId &&
        thread.title === "Assurance and simulation engineer",
    )
  ) {
    throw new MissionEvidenceError("TrueForge sandbox execution did not complete successfully");
  }

  const orderedResponse = (
    toolCallId: string,
  ): MissionEvidencePayload["trueforgeProvenance"]["durableOrdering"]["terminal"] => {
    const response = requireMapValue(
      responses,
      toolCallId,
      `ordered TrueForge response ${toolCallId}`,
    );
    return {
      toolCallId,
      responseEventId: response.eventId,
      position: response.position,
      responseDigest: response.responseDigest,
    };
  };
  const durableOrdering = {
    mutationReceipt: orderedResponse("approve-alternative"),
    independentReadBack: orderedResponse("read-after-write"),
    verification: orderedResponse("verify-authoritatively"),
    terminal: orderedResponse("read-terminal-status"),
  };
  if (
    !positionsIncrease([
      durableOrdering.mutationReceipt.position,
      durableOrdering.independentReadBack.position,
      durableOrdering.verification.position,
      durableOrdering.terminal.position,
    ])
  ) {
    throw new MissionEvidenceError(
      "TrueForge mutation, read-back, verification, and terminal order is inconsistent",
    );
  }

  const ownerEventRows = allRows(
    input.mission,
    `SELECT event.bridge_event_id
       FROM m4_bridge_events AS event
       JOIN m4_bridge_actions AS action ON action.bridge_key = event.bridge_key
      WHERE action.mission_id = ? AND event.status = 'owner_decision_received'
      ORDER BY event.sequence`,
    [missionId],
  );
  const resumeEventRows = allRows(
    input.mission,
    `SELECT event.bridge_event_id
       FROM m4_bridge_events AS event
       JOIN m4_bridge_actions AS action ON action.bridge_key = event.bridge_key
      WHERE action.mission_id = ? AND event.status = 'trueforge_resumed'
      ORDER BY event.sequence`,
    [missionId],
  );
  const terminalTurnEventCount = events.filter(
    (event) => event.turnId === currentTurnId,
  ).length;
  if (lastEventSequence < terminalTurnEventCount) {
    throw new MissionEvidenceError(
      "TrueForge durable cursor precedes the terminal turn event count",
    );
  }

  const provenance: MissionEvidencePayload["trueforgeProvenance"] = {
    runtimeProfile: {
      runtimeId: "@truefoundry/trueforge",
      profileKind: "deterministic_judge",
      provider: {
        name: requireText(provider["name"], "TrueForge provider name"),
        type:
          providerManifest["type"] === "custom"
            ? "custom"
            : failLiteral("TrueForge deterministic provider type"),
        modelId,
        modelName,
      },
      agent: {
        agentId,
        agentName,
        modelName: agentModelName,
        iterationLimit: requirePositiveInteger(
          agentConfig["iteration_limit"],
          "TrueForge iteration limit",
        ),
        sandboxEnabled: requireLiteralBoolean(
          sandboxConfig["enabled"],
          true,
          "TrueForge sandbox enabled",
        ),
        fileDownloadsEnabled: requireLiteralBoolean(
          sandboxConfig["file_downloads"],
          false,
          "TrueForge file downloads enabled",
        ),
        dynamicSubagentsEnabled: requireLiteralBoolean(
          dynamicSubagentsConfig["enabled"],
          true,
          "TrueForge dynamic subagents enabled",
        ),
        askUserQuestionsEnabled: requireLiteralBoolean(
          askUserConfig["enabled"],
          false,
          "TrueForge ask-user enabled",
        ),
        approvalRequiredTools,
      },
    },
    missionBinding: {
      missionId,
      sessionId,
      agentId,
      m2DatabaseInstanceIdentity: input.m2DatabaseInstanceIdentity,
      factoryDatabaseInstanceIdentity: input.factoryDatabaseInstanceIdentity,
    },
    cursor: {
      currentTurnId,
      sessionLastTurnId: requireText(
        session["last_turn_id"],
        "TrueForge session last_turn_id",
      ),
      lastEventSequence,
      terminalTurnEventCount,
      totalSessionEvents: events.length,
    },
    turns,
    subagentThreads,
    connectors,
    sandbox: {
      sandboxIdentity: stableTupleId("trueforge-local-sandbox", [
        sessionId,
        sandboxCreated.eventId,
        "local",
      ]),
      createdTurnId: sandboxCreated.turnId,
      createdEventId: sandboxCreated.eventId,
      executionThreadId: sandboxTool.threadId,
      executionToolCallId: sandboxTool.toolCallId,
      executionToolCallEventId: sandboxTool.eventId,
      executionArgumentsDigest: sandboxTool.argumentsDigest,
      responseEventId: sandboxResponse.eventId,
      responseStatus: "completed",
      exitCode: 0,
      resultDigest: sha256(
        canonicalSerialize(
          requireText(sandboxResult["result"], "TrueForge sandbox result"),
        ),
      ),
    },
    replayContinuity: {
      ownerRequestEventIds: ownerEventRows.map((row) =>
        requireText(row["bridge_event_id"], "owner request event id"),
      ),
      resumeEventIds: resumeEventRows.map((row) =>
        requireText(row["bridge_event_id"], "resume event id"),
      ),
      exactlyOnceEffectCount: 1,
      exactlyOnceReceiptCount: 1,
      exactlyOnceTerminalCount: 1,
    },
    durableOrdering,
  };
  return {
    provenance,
    nativeByBridgeKey,
    ownerRequestByBridgeKey,
    counts: {
      turns: turns.length,
      sessionEvents: events.length,
      subagentThreads: subagentThreads.length,
      connectors: connectors.length,
      connectorInitializations: initializationEvents.length,
      approvalRequiredEvents: approvalRequired.size,
      userApprovals: turns.filter((turn) => turn.inputKind === "user_tool_approval")
        .length,
      toolResponses: responses.size,
      sandboxCreatedEvents: 1,
      sandboxExecutions: 1,
      ownerDecisionEvents: ownerEventRows.length,
      resumeEvents: resumeEventRows.length,
    },
  };
}

function assertEquivalentTurnInput(
  inputKind: TrueForgeTurnProjection["inputKind"],
  approval: TrueForgeTurnProjection["approval"],
  intentInput: JsonValue,
): void {
  const items = requireArray(intentInput, "successor-intent input").map((value) =>
    requireObject(value, "successor-intent input item"),
  );
  const item = requireSingle(items, "successor-intent input item");
  if (inputKind === "user_message") {
    if (item["type"] !== "user.message") {
      throw new MissionEvidenceError("TrueForge message turn and successor intent conflict");
    }
    return;
  }
  if (approval === null || item["type"] !== "user.tool_approval") {
    throw new MissionEvidenceError("TrueForge approval turn and successor intent conflict");
  }
  const body = requireObject(item["approval"], "successor-intent approval");
  const reasonDigest =
    body["reason"] === undefined
      ? null
      : sha256(
          canonicalSerialize(requireText(body["reason"], "successor denial reason")),
        );
  if (
    item["threadId"] !== approval.threadId ||
    item["toolCallId"] !== approval.toolCallId ||
    body["status"] !== approval.decision ||
    reasonDigest !== approval.reasonDigest
  ) {
    throw new MissionEvidenceError("TrueForge native and durable approval inputs conflict");
  }
}

function parseSqliteJson(value: unknown, label: string): JsonValue {
  if (typeof value !== "string") {
    throw new MissionEvidenceError(`${label} is not readable SQLite JSON`);
  }
  return parseJsonText(value, label);
}

function parseJsonText(value: string, label: string): JsonValue {
  try {
    return requireJsonValue(JSON.parse(value) as unknown, label);
  } catch (error: unknown) {
    if (error instanceof MissionEvidenceError) throw error;
    throw new MissionEvidenceError(`${label} is not valid JSON`, { cause: error });
  }
}

function parseJsonTextOrString(value: string, label: string): JsonValue {
  try {
    return requireJsonValue(JSON.parse(value) as unknown, label);
  } catch {
    return value;
  }
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : requireText(value, label);
}

function requireApprovalDecision(value: unknown, label: string): "allow" | "deny" {
  if (value !== "allow" && value !== "deny") {
    throw new MissionEvidenceError(`${label} must be allow or deny`);
  }
  return value;
}

function ownerPhaseForEvidence(
  toolName: string,
): "portfolio_modification" | "promise_choice" | "consequential_effect" {
  if (toolName === "select_portfolio_modification") return "portfolio_modification";
  if (toolName === "accept_promise") return "promise_choice";
  if (toolName === "create_schedule_reservation") return "consequential_effect";
  throw new MissionEvidenceError(`tool ${toolName} has no external-owner phase`);
}

function requireLiteralBoolean<T extends boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new MissionEvidenceError(`${label} must be ${String(expected)}`);
  }
  return expected;
}

function failLiteral(label: string): never {
  throw new MissionEvidenceError(`${label} is inconsistent`);
}

function compareEventPositions(
  left: TrueForgeEventProjection["position"],
  right: TrueForgeEventProjection["position"],
): number {
  return left.turnOrdinal === right.turnOrdinal
    ? left.eventOrdinal - right.eventOrdinal
    : left.turnOrdinal - right.turnOrdinal;
}

function positionsIncrease(
  positions: readonly TrueForgeEventProjection["position"][],
): boolean {
  return positions.every(
    (position, index) =>
      index === 0 ||
      compareEventPositions(positions[index - 1] as TrueForgeEventProjection["position"], position) <
        0,
  );
}

function validateBuildOptions(options: MissionEvidenceBuildOptions): void {
  requireText(options.missionId, "missionId");
  for (const [name, path] of Object.entries({
    m2DatabasePath: options.m2DatabasePath,
    factoryDatabasePath: options.factoryDatabasePath,
    missionDatabasePath: options.missionDatabasePath,
    trueforgeDatabasePath: options.trueforgeDatabasePath,
  })) {
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) {
      throw new MissionEvidenceError(`${name} must be an existing absolute database path`);
    }
  }
}

function openReadOnlyDatabase(path: string, label: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(resolve(path), { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error: unknown) {
    try {
      database?.close();
    } catch {
      // Preserve the original open/configuration error.
    }
    throw new MissionEvidenceError(`could not open ${label} database read-only`, {
      cause: error,
    });
  }
}

function countFactoryRows(
  database: DatabaseSync,
  table: "execution_results" | "mutation_events",
): number {
  return countRows(database, `SELECT COUNT(*) AS count FROM ${table}`);
}

function allRows(
  database: DatabaseSync,
  sql: string,
  parameters: readonly (string | number | null)[] = [],
): Record<string, unknown>[] {
  return database.prepare(sql).all(...parameters) as Record<string, unknown>[];
}

function requireOneRow(
  database: DatabaseSync,
  sql: string,
  parameters: readonly (string | number | null)[],
  label: string,
): Record<string, unknown> {
  const rows = allRows(database, sql, parameters);
  if (rows.length !== 1) {
    throw new MissionEvidenceError(`${label} must have exactly one row; found ${String(rows.length)}`);
  }
  return rows[0] as Record<string, unknown>;
}

function requireOnlyRow(
  database: DatabaseSync,
  sql: string,
  label: string,
): Record<string, unknown> {
  return requireOneRow(database, sql, [], label);
}

function countRows(database: DatabaseSync, sql: string): number {
  const row = requireOneRow(database, sql, [], "count query");
  return requireNonnegativeInteger(row["count"], "count");
}

function parseCanonicalStoredJson(value: unknown, label: string): JsonValue {
  if (typeof value !== "string") {
    throw new MissionEvidenceError(`${label} is not stored JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new MissionEvidenceError(`${label} is not valid JSON`, { cause: error });
  }
  if (canonicalSerialize(parsed) !== value) {
    throw new MissionEvidenceError(`${label} is not stored as canonical JSON`);
  }
  return requireJsonValue(parsed, label);
}

function evidenceAdmission(
  role: MissionEvidencePayload["admissions"][number]["role"],
  admission: {
    readonly record: Record<string, JsonValue>;
    readonly addenda: MissionEvidencePayload["admissions"][number]["addenda"];
  },
): MissionEvidencePayload["admissions"][number] {
  return {
    role,
    record: admission.record,
    recordDigest: sha256(canonicalSerialize(admission.record)),
    addenda: admission.addenda,
  };
}

function admissionVersions(record: Record<string, JsonValue>): {
  readonly portfolioVersion: string;
  readonly capacityModelVersion: string;
  readonly capacityPlanVersion: string;
  readonly authorizationStateVersion: string;
} {
  return {
    portfolioVersion: requireText(record["portfolioVersion"], "portfolioVersion"),
    capacityModelVersion: requireText(record["capacityModelVersion"], "capacityModelVersion"),
    capacityPlanVersion: requireText(record["capacityPlanVersion"], "capacityPlanVersion"),
    authorizationStateVersion: requireText(
      record["authorizationStateVersion"],
      "authorizationStateVersion",
    ),
  };
}

function versionTupleFromRow(row: Record<string, unknown>): MissionEvidencePayload["currentDurableVersions"] {
  return {
    portfolioVersion: versionText("portfolio", row["portfolio_version"]),
    capacityModelVersion: versionText("capacity-model", row["capacity_model_version"]),
    capacityPlanVersion: versionText("capacity-plan", row["capacity_plan_version"]),
    authorizationStateVersion: versionText(
      "authorization",
      row["authorization_state_version"],
    ),
  };
}

function versionText(prefix: string, value: unknown): string {
  return `${prefix}/v${String(requirePositiveInteger(value, `${prefix} version`))}`;
}

function assertEvidenceHygiene(value: unknown, path = "$payload"): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (MACHINE_PATH_PATTERN.test(value)) {
      throw new MissionEvidenceError(`${path} contains a machine-local path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceHygiene(item, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== "object") {
    throw new MissionEvidenceError(`${path} contains a non-JSON value`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      EXCLUDED_FIELD_NAMES.has(key) ||
      SENSITIVE_FIELD_PATTERN.test(key) ||
      key.toLowerCase().includes("path")
    ) {
      throw new MissionEvidenceError(`${path}.${key} is forbidden in canonical evidence`);
    }
    assertEvidenceHygiene(child, `${path}.${key}`);
  }
}

function requireJsonValue(value: unknown, label: string): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new MissionEvidenceError(`${label} must be canonical JSON data`);
  return parsed.data;
}

function requireObject(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionEvidenceError(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function requireArray(value: unknown, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new MissionEvidenceError(`${label} must be an array`);
  return value as readonly JsonValue[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MissionEvidenceError(`${label} must be non-empty text`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new MissionEvidenceError(`${label} must be text`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  const digest = requireText(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new MissionEvidenceError(`${label} must be a SHA-256 digest`);
  return digest;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MissionEvidenceError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireNonnegativeInteger(value, label);
  if (integer < 1) throw new MissionEvidenceError(`${label} must be positive`);
  return integer;
}

function requireActionKind(value: unknown): "owner_decision" | "consequential_effect" {
  if (value !== "owner_decision" && value !== "consequential_effect") {
    throw new MissionEvidenceError("evidence bundle excludes non-approval bridge actions");
  }
  return value;
}

function requireSingle<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) {
    throw new MissionEvidenceError(`${label} must occur exactly once; found ${String(values.length)}`);
  }
  return values[0] as T;
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new MissionEvidenceError(`${label} is missing`);
  return value;
}

function compareJson(left: JsonValue, right: JsonValue): number {
  return compareStableStrings(canonicalSerialize(left), canonicalSerialize(right));
}

function digestIdentitySchema(prefix: string): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}/sha256:[0-9a-f]{64}$`, "u"));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
