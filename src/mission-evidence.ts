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
  canonicalDatabasePath,
  databaseInstanceIdentityFromHandle,
} from "./sqlite.js";
import type { EffectFingerprint } from "./stateful-domain.js";

export const MISSION_EVIDENCE_SCHEMA_VERSION =
  "flakebrake-mission-evidence-bundle/v1" as const;
export const MISSION_EVIDENCE_PAYLOAD_SCHEMA_VERSION =
  "flakebrake-mission-evidence-payload/v1" as const;
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

/**
 * Distinguishes an unfinished mission from an evidence-export defect without
 * opening either durable store for mutation.
 */
export function isMissionEvidenceReady(
  options: MissionEvidenceBuildOptions,
): boolean {
  requireText(options.missionId, "missionId");
  if (!existsSync(options.missionDatabasePath)) return false;
  let mission: DatabaseSync | undefined;
  let m2: DatabaseSync | undefined;
  try {
    mission = openReadOnlyDatabase(options.missionDatabasePath, "mission");
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
    m2 = openReadOnlyDatabase(options.m2DatabasePath, "M2");
    return (
      countRows(
        m2,
        `SELECT COUNT(*) AS count FROM reservation_events
          WHERE event_kind = 'terminal_verified'`,
      ) > 0
    );
  } catch (error: unknown) {
    if (error instanceof MissionEvidenceError) throw error;
    throw new MissionEvidenceError(
      `mission evidence readiness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    try {
      m2?.close();
    } finally {
      mission?.close();
    }
  }
}

export function buildMissionEvidenceBundle(
  options: MissionEvidenceBuildOptions,
): MissionEvidenceBundle {
  validateBuildOptions(options);
  let m2: DatabaseSync | undefined;
  let factory: DatabaseSync | undefined;
  let mission: DatabaseSync | undefined;
  try {
    m2 = openReadOnlyDatabase(options.m2DatabasePath, "M2");
    mission = openReadOnlyDatabase(options.missionDatabasePath, "mission");
    factory = openReadOnlyDatabase(options.factoryDatabasePath, "factory");
    const missionRow = requireOneRow(
      mission,
      `SELECT mission_id, environment_id, trueforge_session_id, current_turn_id,
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
        factoryMutations: countFactoryRows(
          options.factoryDatabasePath,
          "mutation_events",
        ),
        mutationReceipts: countFactoryRows(
          options.factoryDatabasePath,
          "execution_results",
        ),
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
  } catch (error: unknown) {
    if (error instanceof MissionEvidenceError) throw error;
    throw new MissionEvidenceError(
      `mission evidence export failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    try {
      factory?.close();
    } finally {
      try {
        mission?.close();
      } finally {
        m2?.close();
      }
    }
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
  return serializeMissionEvidenceBundle(buildMissionEvidenceBundle(options));
}

export function verifyMissionEvidenceBytes(
  bytes: string,
  databases?: MissionEvidenceBuildOptions,
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
    const expected = exportMissionEvidenceBundle(databases);
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

function validateBuildOptions(options: MissionEvidenceBuildOptions): void {
  requireText(options.missionId, "missionId");
  for (const [name, path] of Object.entries({
    m2DatabasePath: options.m2DatabasePath,
    factoryDatabasePath: options.factoryDatabasePath,
    missionDatabasePath: options.missionDatabasePath,
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

function countFactoryRows(path: string, table: "execution_results" | "mutation_events"): number {
  const database = openReadOnlyDatabase(path, "factory");
  try {
    return countRows(database, `SELECT COUNT(*) AS count FROM ${table}`);
  } finally {
    database.close();
  }
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
