import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalClone,
  canonicalSerialize,
  compareStableStrings,
  deepFreeze,
} from "./canonical.js";
import type { JsonValue } from "./domain.js";
import { normalizeEffect } from "./effects.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_SCHEDULE_COMMITMENTS,
  createHeroProposal,
} from "./hero-fixture.js";
import { stableTupleId } from "./identity.js";
import {
  closeSqliteAfterInitializationFailure,
  databaseIdentityPath,
  databaseInstanceIdentityFromHandle,
  inImmediateTransaction,
  openInitializedSqlite,
} from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite.js";
import type {
  ClaimExecutionInput,
  ExecutionFenceReadModel,
  ExecutionAttemptReadModel,
} from "./index.js";
import type { FlakeBrakeStore } from "./store.js";
import {
  ExecutionAttemptConflictError,
  StatefulInputError,
} from "./stateful-domain.js";

export type FactoryScheduleReservation =
  | {
      readonly reservationId: string;
      readonly orderId: string;
      readonly productionCellId: string;
      readonly start: string;
      readonly end: string;
      readonly quantity: number;
      readonly status: "committed";
      readonly sourceExecutionAttemptId: null;
    }
  | {
      readonly reservationId: string;
      readonly orderId: string;
      readonly productionCellId: string;
      readonly start: string;
      readonly end: string;
      readonly quantity: number;
      readonly status: "reserved";
      readonly sourceExecutionAttemptId: string;
    };

export interface FactoryScheduleState {
  readonly schemaVersion: "microfactory-schedule-state/v1";
  readonly environmentId: string;
  readonly stateVersion: string;
  readonly reservations: readonly FactoryScheduleReservation[];
}

export interface CanonicalScheduleCommand {
  readonly schemaVersion: "microfactory-schedule-command/v1";
  readonly commandKind: "create_schedule_reservation";
  readonly environmentId: string;
  readonly orderId: string;
  readonly productionCellId: string;
  readonly quantity: number;
  readonly start: string;
  readonly end: string;
}

export interface ClaimedExecutionReference {
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly grantOwnerDecisionId: string;
  readonly grantId: string;
  readonly expectedGrantVersion: string;
  readonly grantAllowanceKey: string;
  readonly grantExecutionOrdinal: number;
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly expectedPortfolioVersion: string;
  readonly expectedCapacityModelVersion: string;
  readonly expectedCapacityPlanVersion: string;
  readonly expectedAuthorizationStateVersion: string;
  readonly expectedCalibrationFrontierDigest: string;
  readonly effect: ClaimExecutionInput["effect"];
  readonly expectedAfterState: JsonValue;
}

export interface AuthorizedScheduleMutation {
  readonly executionAttemptId: string;
  readonly claim: ClaimedExecutionReference;
  readonly command: CanonicalScheduleCommand;
  readonly expectedBeforeStateVersion: string;
  readonly expectedBeforeStateDigest: string;
}

export interface SyntheticMutationReceipt {
  readonly schemaVersion: "microfactory-mutation-receipt/v1";
  readonly receiptId: string;
  readonly executionAttemptId: string;
  readonly fenceId: string;
  readonly commandDigest: string;
  readonly beforeStateDigest: string;
  readonly resultingStateDigest: string;
  readonly mutationStatus: "applied";
  readonly verificationStatus: "pending_independent_read_back";
  readonly recordedAt: string;
}

export interface SyntheticMutationResult {
  readonly schemaVersion: "microfactory-mutation-result/v1";
  readonly executionAttemptId: string;
  readonly fenceId: string;
  readonly status: "MUTATED_PENDING_VERIFICATION";
  readonly canonicalCommand: CanonicalScheduleCommand;
  readonly beforeState: FactoryScheduleState;
  readonly resultingState: FactoryScheduleState;
  readonly receipt: SyntheticMutationReceipt;
}

export interface SyntheticMutationResponse {
  readonly replayed: boolean;
  readonly result: SyntheticMutationResult;
}

export interface AuthoritativeFactoryExecutionEvidence {
  readonly environmentId: string;
  readonly currentState: FactoryScheduleState;
  readonly currentStateDigest: string;
  readonly request: AuthorizedScheduleMutation;
  readonly result: SyntheticMutationResult;
  readonly mutationEvent: JsonValue;
  readonly resultDigest: string;
}

export interface CreateFactoryEnvironmentOptions {
  readonly path: string;
  readonly environmentId?: string;
  readonly now?: () => string;
}

export class SyntheticFactoryEnvironment {
  readonly #database: SqliteDatabase;
  readonly #databasePath: string;
  readonly #environmentId: string;
  readonly #now: () => string;
  #closed = false;

  public constructor(options: CreateFactoryEnvironmentOptions) {
    if (typeof options.path !== "string" || options.path.length === 0) {
      throw new StatefulInputError("path", "must be a non-empty string");
    }
    this.#environmentId = requireNonBlankIdentifier(
      options.environmentId ?? HERO_ENVIRONMENT_ID,
      "environmentId",
    );
    this.#now = options.now ?? (() => HERO_HORIZON_END);
    this.#databasePath = databaseIdentityPath(options.path);
    this.#database = openInitializedSqlite(
      options.path,
      "factory",
      initializeFactorySchema,
    );
    try {
      inImmediateTransaction(this.#database, () => this.#seedIfEmpty());
    } catch (error: unknown) {
      closeSqliteAfterInitializationFailure(this.#database, error);
      this.#closed = true;
      throw error;
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  public databaseInstanceIdentity(): string {
    return databaseInstanceIdentityFromHandle(
      this.#database,
      this.#databasePath,
      "factory",
      this.#environmentId,
    );
  }

  public readAuthoritativeExecution(
    executionAttemptId: string,
  ): AuthoritativeFactoryExecutionEvidence | null {
    return readAuthoritativeFactoryExecutionFromDatabase(
      this.#database,
      executionAttemptId,
    );
  }

  public getScheduleState(): FactoryScheduleState {
    return deepFreeze(this.#readScheduleState());
  }

  public getScheduleStateDigest(): string {
    return stateDigest(this.#readScheduleState());
  }

  public getIncomingProposals(): readonly JsonValue[] {
    const rows = this.#database
      .prepare("SELECT body_json FROM incoming_proposals ORDER BY proposal_id")
      .all() as Record<string, unknown>[];
    return deepFreeze(
      rows.map((row) => parseCanonicalJsonValue(row["body_json"], "proposal")),
    );
  }

  public getMutationCount(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM mutation_events")
      .get() as Record<string, unknown> | undefined;
    const count = row?.["count"];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new TypeError("Invalid mutation event count");
    }
    return count as number;
  }

  public executeAuthorizedScheduleMutation(
    m2Store: FlakeBrakeStore,
    requestValue: AuthorizedScheduleMutation,
    assertDatabaseBinding?: () => void,
  ): SyntheticMutationResponse {
    const request = canonicalClone<AuthorizedScheduleMutation>(requestValue);
    validateAuthorizedScheduleMutation(request);
    assertDatabaseBinding?.();
    const canonicalRequestBytes = canonicalSerialize(request);
    const preexisting = this.#readExecutionResult(request.executionAttemptId);
    let fenceId: string;
    if (preexisting !== null) {
      if (preexisting.requestBytes !== canonicalRequestBytes) {
        throw new ExecutionAttemptConflictError(request.executionAttemptId);
      }
      fenceId = preexisting.result.fenceId;
    } else {
      try {
        const attempt = requireExactLiveAttempt(m2Store, request);
        const authoritativeCommand = commandFromAttempt(attempt);
        if (
          canonicalSerialize(authoritativeCommand) !==
          canonicalSerialize(request.command)
        ) {
          throw new StatefulInputError(
            "command",
            "does not match the canonical command authorized by the M2 claim",
          );
        }
        const preflightState = this.#readScheduleState();
        if (
          request.expectedBeforeStateVersion !== preflightState.stateVersion ||
          request.expectedBeforeStateDigest !== stateDigest(preflightState)
        ) {
          throw new StatefulInputError(
            "expectedBeforeState",
            "stale synthetic state compare-and-swap precondition",
          );
        }
        assertScheduleSlotAvailable(preflightState, request.command);
        const fence = m2Store.createExecutionFence({
          executionAttemptId: request.executionAttemptId,
          expectedCommandDigest: digest(request.command),
          executorAuthority: "factory-change-control/v1",
          environmentId: request.command.environmentId,
        }, preflightState);
        fenceId = fence.fenceId;
      } catch (error: unknown) {
        // A concurrent identical executor may commit between the first result
        // lookup and the authorization/CAS preflight. Once its immutable result
        // exists, replay that result instead of misclassifying the retry as
        // stale or terminal. A different payload remains a hard conflict.
        const concurrentResult = this.#readExecutionResult(
          request.executionAttemptId,
        );
        if (concurrentResult === null) throw error;
        if (concurrentResult.requestBytes !== canonicalRequestBytes) {
          throw new ExecutionAttemptConflictError(request.executionAttemptId);
        }
        fenceId = concurrentResult.result.fenceId;
      }
    }

    return m2Store.runWithExecutionFence(fenceId, (fence) =>
      inImmediateTransaction(this.#database, () => {
        const prior = this.#readExecutionResult(request.executionAttemptId);
        if (prior !== null) {
          if (prior.requestBytes !== canonicalRequestBytes) {
            throw new ExecutionAttemptConflictError(request.executionAttemptId);
          }
          if (prior.result.fenceId !== fence.fenceId) {
            throw new StatefulInputError(
              "fenceId",
              "factory result belongs to a different execution fence",
            );
          }
          return {
            value: deepFreeze({ replayed: true, result: prior.result }),
            binding: resultBinding(prior.result),
          };
        }
        if (fence.status !== "active") {
          throw new StatefulInputError(
            "fenceId",
            "a bound execution fence is missing its immutable factory result",
          );
        }

        const attempt = requireFencedAttempt(m2Store, request, fence);
        const beforeState = this.#readScheduleState();
        const beforeDigest = stateDigest(beforeState);
        if (
          request.expectedBeforeStateVersion !== beforeState.stateVersion ||
          request.expectedBeforeStateDigest !== beforeDigest
        ) {
          throw new StatefulInputError(
            "expectedBeforeState",
            "stale synthetic state compare-and-swap precondition",
          );
        }
        assertScheduleSlotAvailable(beforeState, request.command);

        const reservation = reservationFromCommand(
          request.executionAttemptId,
          request.command,
        );
        this.#database
          .prepare(
            `INSERT INTO schedule_reservations
             (reservation_id, order_id, production_cell_id, start_at, end_at,
              quantity, status, source_execution_attempt_id, body_json)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
          )
          .run(
            reservation.reservationId,
            reservation.orderId,
            reservation.productionCellId,
            reservation.start,
            reservation.end,
            reservation.quantity,
            request.executionAttemptId,
            canonicalSerialize(reservation),
          );
        this.#database
          .prepare(
            `UPDATE factory_metadata
              SET state_version = state_version + 1
            WHERE singleton = 1`,
          )
          .run();

        const resultingState = this.#readScheduleState();
        const reservationClaim = attempt.result.reservation;
        if (
          canonicalSerialize(resultingState) !==
          canonicalSerialize(reservationClaim.expectedAfterState)
        ) {
          throw new StatefulInputError(
            "expectedAfterState",
            "authorized M2 expected state does not match the canonical mutation result",
          );
        }
        const recordedAt = this.#timestamp();
        const commandDigest = digest(request.command);
        const resultingStateDigest = stateDigest(resultingState);
        const receiptId = stableTupleId("factory-mutation-receipt", [
          request.executionAttemptId,
          fence.fenceId,
          commandDigest,
          beforeDigest,
          resultingStateDigest,
        ]);
        const receipt: SyntheticMutationReceipt = {
          schemaVersion: "microfactory-mutation-receipt/v1",
          receiptId,
          executionAttemptId: request.executionAttemptId,
          fenceId: fence.fenceId,
          commandDigest,
          beforeStateDigest: beforeDigest,
          resultingStateDigest,
          mutationStatus: "applied",
          verificationStatus: "pending_independent_read_back",
          recordedAt,
        };
        const result: SyntheticMutationResult = {
          schemaVersion: "microfactory-mutation-result/v1",
          executionAttemptId: request.executionAttemptId,
          fenceId: fence.fenceId,
          status: "MUTATED_PENDING_VERIFICATION",
          canonicalCommand: request.command,
          beforeState,
          resultingState,
          receipt,
        };
        this.#database
          .prepare(
            `INSERT INTO execution_results
             (execution_attempt_id, fence_id, request_json, result_json,
              receipt_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.executionAttemptId,
            fence.fenceId,
            canonicalRequestBytes,
            canonicalSerialize(result),
            receiptId,
            recordedAt,
          );
        this.#database
          .prepare(
            `INSERT INTO mutation_events
             (event_id, execution_attempt_id, created_at, body_json)
           VALUES (?, ?, ?, ?)`,
          )
          .run(
            stableTupleId("factory-mutation-event", [
              request.executionAttemptId,
            ]),
            request.executionAttemptId,
            recordedAt,
            canonicalSerialize({
              executionAttemptId: request.executionAttemptId,
              fenceId: fence.fenceId,
              canonicalCommand: request.command,
              beforeState,
              resultingState,
              receipt,
            }),
          );
        const response = deepFreeze({ replayed: false, result });
        return { value: response, binding: resultBinding(result) };
      }),
    );
  }

  #seedIfEmpty(): void {
    const row = this.#database
      .prepare("SELECT environment_id FROM factory_metadata WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (row !== undefined) {
      if (row["environment_id"] !== this.#environmentId) {
        throw new StatefulInputError(
          "environmentId",
          "does not match the initialized synthetic environment",
        );
      }
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO factory_metadata
           (singleton, schema_version, environment_id, state_version)
         VALUES (1, 'microfactory-environment/v1', ?, 1)`,
      )
      .run(this.#environmentId);
    for (const commitment of HERO_SCHEDULE_COMMITMENTS) {
      const reservation: FactoryScheduleReservation = {
        ...commitment,
        sourceExecutionAttemptId: null,
      };
      this.#database
        .prepare(
          `INSERT INTO schedule_reservations
             (reservation_id, order_id, production_cell_id, start_at, end_at,
              quantity, status, source_execution_attempt_id, body_json)
           VALUES (?, ?, ?, ?, ?, ?, 'committed', NULL, ?)`,
        )
        .run(
          reservation.reservationId,
          reservation.orderId,
          reservation.productionCellId,
          reservation.start,
          reservation.end,
          reservation.quantity,
          canonicalSerialize(reservation),
        );
    }
    const proposal = createHeroProposal();
    this.#database
      .prepare(
        `INSERT INTO incoming_proposals
           (proposal_id, body_json) VALUES (?, ?)`,
      )
      .run(proposal.obligationId, canonicalSerialize(proposal));
  }

  #readScheduleState(): FactoryScheduleState {
    const metadata = this.#database
      .prepare(
        `SELECT environment_id, state_version
           FROM factory_metadata WHERE singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (metadata === undefined) throw new Error("Factory metadata is missing");
    const environmentId = requireNonBlankIdentifier(
      metadata["environment_id"],
      "environment_id",
    );
    const stateVersion = requirePositiveInteger(
      metadata["state_version"],
      "state_version",
    );
    const rows = this.#database
      .prepare(
        `SELECT body_json FROM schedule_reservations
          ORDER BY start_at, end_at, reservation_id`,
      )
      .all() as Record<string, unknown>[];
    return {
      schemaVersion: "microfactory-schedule-state/v1",
      environmentId,
      stateVersion: `factory-state/v${stateVersion}`,
      reservations: rows.map((row) =>
        parseCanonicalScheduleReservation(row["body_json"]),
      ),
    };
  }

  #readExecutionResult(
    executionAttemptId: string,
  ): { readonly requestBytes: string; readonly result: SyntheticMutationResult } | null {
    const row = this.#database
      .prepare(
        `SELECT request_json, result_json FROM execution_results
          WHERE execution_attempt_id = ?`,
      )
      .get(executionAttemptId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const requestBytes = requireString(row["request_json"], "request_json");
    const resultBytes = requireString(row["result_json"], "result_json");
    const result = JSON.parse(resultBytes) as SyntheticMutationResult;
    if (canonicalSerialize(result) !== resultBytes) {
      throw new TypeError("Stored mutation result is not canonical JSON");
    }
    return { requestBytes, result };
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (
      !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      throw new StatefulInputError("now", "must return a canonical ISO timestamp");
    }
    return timestamp;
  }
}

export function commandFromAttempt(
  attempt: ExecutionAttemptReadModel,
): CanonicalScheduleCommand {
  const effect = normalizeEffect(attempt.input.effect);
  const expectedEffect = attempt.result.reservation.expectedEffect;
  if (!isPlainObject(expectedEffect)) {
    throw new StatefulInputError(
      "expectedEffect",
      "must be the canonical schedule command object",
    );
  }
  const command: CanonicalScheduleCommand = {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: effect.environmentId,
    orderId: requireString(expectedEffect["orderId"], "expectedEffect.orderId"),
    productionCellId: effect.canonicalTargetId,
    quantity: effect.materialParameters.quantity,
    start: effect.materialParameters.start,
    end: effect.materialParameters.end,
  };
  if (attempt.input.affectedObligationIds.length !== 1) {
    throw new StatefulInputError(
      "affectedObligationIds",
      "schedule reservation execution requires exactly one affected order",
    );
  }
  if (attempt.input.affectedObligationIds[0] !== command.orderId) {
    throw new StatefulInputError(
      "expectedEffect.orderId",
      "must equal the M2 affected obligation",
    );
  }
  if (canonicalSerialize(expectedEffect) !== canonicalSerialize(command)) {
    throw new StatefulInputError(
      "expectedEffect",
      "must exactly equal the normalized canonical schedule command",
    );
  }
  return deepFreeze(command);
}

export function claimedExecutionReference(
  attempt: ExecutionAttemptReadModel,
): ClaimedExecutionReference {
  const input = attempt.input;
  return deepFreeze({
    admissionRecordId: input.admissionRecordId,
    promiseBasisId: input.promiseBasisId,
    acceptedOwnerDecisionId: input.acceptedOwnerDecisionId,
    grantOwnerDecisionId: input.grantOwnerDecisionId,
    grantId: input.grantId,
    expectedGrantVersion: input.expectedGrantVersion,
    grantAllowanceKey: input.grantAllowanceKey,
    grantExecutionOrdinal: attempt.result.grantExecutionOrdinal,
    selectedBundleId: input.selectedBundleId,
    selectedPlanId: input.selectedPlanId,
    expectedPortfolioVersion: input.expectedPortfolioVersion,
    expectedCapacityModelVersion: input.expectedCapacityModelVersion,
    expectedCapacityPlanVersion: input.expectedCapacityPlanVersion,
    expectedAuthorizationStateVersion: input.expectedAuthorizationStateVersion,
    expectedCalibrationFrontierDigest: input.expectedCalibrationFrontierDigest,
    effect: input.effect,
    expectedAfterState: input.expectedAfterState,
  });
}

export function resultingScheduleState(
  beforeState: FactoryScheduleState,
  executionAttemptId: string,
  command: CanonicalScheduleCommand,
): FactoryScheduleState {
  const currentVersion = parseStateVersion(beforeState.stateVersion);
  const reservations = [
    ...beforeState.reservations,
    reservationFromCommand(executionAttemptId, command),
  ].sort(compareReservations);
  return deepFreeze({
    schemaVersion: "microfactory-schedule-state/v1",
    environmentId: beforeState.environmentId,
    stateVersion: `factory-state/v${currentVersion + 1}`,
    reservations,
  });
}

export function factoryStateDigest(state: FactoryScheduleState): string {
  return stateDigest(state);
}

function requireExactLiveAttempt(
  store: FlakeBrakeStore,
  request: AuthorizedScheduleMutation,
): ExecutionAttemptReadModel {
  let attempt: ExecutionAttemptReadModel;
  try {
    attempt = store.getExecutionAttempt(request.executionAttemptId);
  } catch {
    throw new StatefulInputError(
      "executionAttemptId",
      "must reference an authoritative M2 claimed attempt",
    );
  }
  const reservation = store
    .getReservations(true)
    .find((candidate) => candidate.executionAttemptId === request.executionAttemptId);
  if (
    reservation === undefined ||
    reservation.claimState !== "claimed_nonterminal" ||
    canonicalSerialize(reservation) !==
      canonicalSerialize(attempt.result.reservation)
  ) {
    throw new StatefulInputError(
      "executionAttemptId",
      "must have the exact nonterminal M2 in-flight reservation",
    );
  }
  const expectedReference = claimedExecutionReference(attempt);
  if (
    canonicalSerialize(expectedReference) !== canonicalSerialize(request.claim)
  ) {
    throw new StatefulInputError(
      "claim",
      "does not exactly reproduce the authoritative M2 claim linkage",
    );
  }
  const allowance = store.getGrantAllowance(attempt.result.grantAllowanceKey);
  if (
    allowance.grantAllowanceKey !== request.claim.grantAllowanceKey ||
    !allowance.claimedExecutionSlots.includes(
      request.claim.grantExecutionOrdinal,
    ) ||
    attempt.result.grantExecutionOrdinal !==
      request.claim.grantExecutionOrdinal
  ) {
    throw new StatefulInputError(
      "claim.grantExecutionOrdinal",
      "does not identify the durable M2 shared-allowance slot",
    );
  }
  return attempt;
}

function requireFencedAttempt(
  store: FlakeBrakeStore,
  request: AuthorizedScheduleMutation,
  fence: ExecutionFenceReadModel,
): ExecutionAttemptReadModel {
  if (
    fence.executionAttemptId !== request.executionAttemptId ||
    fence.status !== "active" ||
    fence.executorAuthority !== "factory-change-control/v1" ||
    fence.environmentId !== request.command.environmentId ||
    fence.expectedCommandDigest !== digest(request.command)
  ) {
    throw new StatefulInputError(
      "fenceId",
      "does not exactly bind this attempt, executor, environment, and command",
    );
  }
  const attempt = requireExactLiveAttempt(store, request);
  if (
    attempt.result.reservation.reservationId !== fence.reservationId ||
    attempt.result.grantAllowanceKey !== fence.grantAllowanceKey ||
    attempt.result.grantExecutionOrdinal !== fence.grantExecutionOrdinal ||
    attempt.admissionRecordId !== fence.admissionRecordId ||
    attempt.input.promiseBasisId !== fence.promiseBasisId ||
    attempt.input.acceptedOwnerDecisionId !== fence.acceptedOwnerDecisionId ||
    attempt.input.grantOwnerDecisionId !== fence.grantOwnerDecisionId ||
    attempt.input.selectedBundleId !== fence.selectedBundleId ||
    attempt.input.selectedPlanId !== fence.selectedPlanId ||
    canonicalSerialize(normalizeEffect(attempt.input.effect)) !==
      canonicalSerialize(fence.canonicalNormalizedEffect)
  ) {
    throw new StatefulInputError(
      "fenceId",
      "does not preserve the immutable M2 attempt basis",
    );
  }
  return attempt;
}

function resultBinding(
  result: SyntheticMutationResult,
): import("./stateful-domain.js").ExecutionFenceResultBinding {
  return {
    schemaVersion: "flakebrake-execution-fence-result/v1",
    fenceId: result.fenceId,
    executionAttemptId: result.executionAttemptId,
    environmentId: result.resultingState.environmentId,
    receiptId: result.receipt.receiptId,
    factoryResultDigest: digest(result),
  };
}

function reservationFromCommand(
  executionAttemptId: string,
  command: CanonicalScheduleCommand,
): FactoryScheduleReservation {
  return {
    reservationId: stableTupleId("factory-schedule-reservation", [
      executionAttemptId,
    ]),
    orderId: command.orderId,
    productionCellId: command.productionCellId,
    start: command.start,
    end: command.end,
    quantity: command.quantity,
    status: "reserved",
    sourceExecutionAttemptId: executionAttemptId,
  };
}

function assertScheduleSlotAvailable(
  state: FactoryScheduleState,
  command: CanonicalScheduleCommand,
): void {
  if (state.environmentId !== command.environmentId) {
    throw new StatefulInputError(
      "command.environmentId",
      "does not match authoritative synthetic state",
    );
  }
  const start = Date.parse(command.start);
  const end = Date.parse(command.end);
  const overlap = state.reservations.find(
    (reservation) =>
      reservation.productionCellId === command.productionCellId &&
      Date.parse(reservation.start) < end &&
      Date.parse(reservation.end) > start,
  );
  if (overlap !== undefined) {
    throw new StatefulInputError(
      "command",
      `schedule slot overlaps ${overlap.reservationId}`,
    );
  }
}

function validateAuthorizedScheduleMutation(
  request: AuthorizedScheduleMutation,
): void {
  requireString(request.executionAttemptId, "executionAttemptId");
  requireString(request.expectedBeforeStateVersion, "expectedBeforeStateVersion");
  if (!/^sha256:[0-9a-f]{64}$/u.test(request.expectedBeforeStateDigest)) {
    throw new StatefulInputError(
      "expectedBeforeStateDigest",
      "must be a sha256 digest",
    );
  }
  requireString(request.command.orderId, "command.orderId");
  requireNonBlankIdentifier(
    request.command.environmentId,
    "command.environmentId",
  );
  requireString(request.command.productionCellId, "command.productionCellId");
  if (
    request.command.schemaVersion !== "microfactory-schedule-command/v1" ||
    request.command.commandKind !== "create_schedule_reservation"
  ) {
    throw new StatefulInputError("command", "unsupported command representation");
  }
  if (
    !Number.isSafeInteger(request.command.quantity) ||
    request.command.quantity <= 0 ||
    new Date(request.command.start).toISOString() !== request.command.start ||
    new Date(request.command.end).toISOString() !== request.command.end ||
    Date.parse(request.command.start) >= Date.parse(request.command.end)
  ) {
    throw new StatefulInputError("command", "contains invalid bounded schedule data");
  }
}

function initializeFactorySchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS factory_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      state_version INTEGER NOT NULL CHECK (state_version > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS incoming_proposals (
      proposal_id TEXT PRIMARY KEY,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS schedule_reservations (
      reservation_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      production_cell_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      status TEXT NOT NULL CHECK (status IN ('committed', 'reserved')),
      source_execution_attempt_id TEXT UNIQUE,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS schedule_reservations_time
      ON schedule_reservations(production_cell_id, start_at, end_at);

    CREATE TABLE IF NOT EXISTS execution_results (
      execution_attempt_id TEXT PRIMARY KEY,
      fence_id TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      receipt_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS mutation_events (
      event_id TEXT PRIMARY KEY,
      execution_attempt_id TEXT NOT NULL UNIQUE
        REFERENCES execution_results(execution_attempt_id),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS incoming_proposals_no_update
    BEFORE UPDATE ON incoming_proposals BEGIN
      SELECT RAISE(ABORT, 'incoming proposals are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS incoming_proposals_no_delete
    BEFORE DELETE ON incoming_proposals BEGIN
      SELECT RAISE(ABORT, 'incoming proposals are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS schedule_reservations_no_update
    BEFORE UPDATE ON schedule_reservations BEGIN
      SELECT RAISE(ABORT, 'schedule reservations are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS schedule_reservations_no_delete
    BEFORE DELETE ON schedule_reservations BEGIN
      SELECT RAISE(ABORT, 'schedule reservations are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS execution_results_no_update
    BEFORE UPDATE ON execution_results BEGIN
      SELECT RAISE(ABORT, 'execution results are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS execution_results_no_delete
    BEFORE DELETE ON execution_results BEGIN
      SELECT RAISE(ABORT, 'execution results are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS mutation_events_no_update
    BEFORE UPDATE ON mutation_events BEGIN
      SELECT RAISE(ABORT, 'mutation events are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS mutation_events_no_delete
    BEFORE DELETE ON mutation_events BEGIN
      SELECT RAISE(ABORT, 'mutation events are immutable');
    END;
  `);
}

function parseCanonicalScheduleReservation(
  value: unknown,
): FactoryScheduleReservation {
  const parsed = parseCanonicalJsonValue(value, "schedule reservation");
  if (!isPlainObject(parsed)) {
    throw new TypeError("Stored schedule reservation must be an object");
  }
  return parsed as unknown as FactoryScheduleReservation;
}

export function readAuthoritativeFactoryState(
  path: string,
): { readonly state: FactoryScheduleState; readonly stateDigest: string } {
  if (typeof path !== "string" || path.length === 0 || path === ":memory:") {
    throw new StatefulInputError(
      "authoritativeFactoryDatabasePath",
      "must identify a durable factory SQLite database",
    );
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const state = readScheduleStateFromDatabase(database);
    return deepFreeze({ state, stateDigest: stateDigest(state) });
  } finally {
    database.close();
  }
}

export function readAuthoritativeFactoryExecution(
  path: string,
  executionAttemptId: string,
): AuthoritativeFactoryExecutionEvidence | null {
  requireString(executionAttemptId, "executionAttemptId");
  if (typeof path !== "string" || path.length === 0 || path === ":memory:") {
    throw new StatefulInputError(
      "authoritativeFactoryDatabasePath",
      "must identify a durable factory SQLite database",
    );
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const row = database
      .prepare(
        `SELECT fence_id, request_json, result_json, receipt_id
           FROM execution_results WHERE execution_attempt_id = ?`,
      )
      .get(executionAttemptId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const request = parseCanonicalStoredValue<AuthorizedScheduleMutation>(
      row["request_json"],
      "factory execution request",
    );
    const result = parseCanonicalStoredValue<SyntheticMutationResult>(
      row["result_json"],
      "factory execution result",
    );
    const eventRow = database
      .prepare(
        `SELECT body_json FROM mutation_events WHERE execution_attempt_id = ?`,
      )
      .get(executionAttemptId) as Record<string, unknown> | undefined;
    if (eventRow === undefined) {
      throw new StatefulInputError(
        "mutationEvent",
        "authoritative execution result has no durable mutation event",
      );
    }
    const mutationEvent = parseCanonicalStoredValue<JsonValue>(
      eventRow["body_json"],
      "factory mutation event",
    );
    const fenceId = requireString(row["fence_id"], "fence_id");
    const receiptId = requireString(row["receipt_id"], "receipt_id");
    validateStoredFactoryExecution(
      executionAttemptId,
      fenceId,
      receiptId,
      request,
      result,
      mutationEvent,
    );
    const currentState = readScheduleStateFromDatabase(database);
    const expectedReservation = result.resultingState.reservations.find(
      (reservation) =>
        reservation.sourceExecutionAttemptId === executionAttemptId,
    );
    const currentReservation = currentState.reservations.find(
      (reservation) =>
        reservation.sourceExecutionAttemptId === executionAttemptId,
    );
    if (
      expectedReservation === undefined ||
      currentReservation === undefined ||
      canonicalSerialize(expectedReservation) !==
        canonicalSerialize(currentReservation)
    ) {
      throw new StatefulInputError(
        "currentState",
        "does not preserve the immutable attempt-specific reservation",
      );
    }
    return deepFreeze({
      environmentId: currentState.environmentId,
      currentState,
      currentStateDigest: stateDigest(currentState),
      request,
      result,
      mutationEvent,
      resultDigest: digest(result),
    });
  } finally {
    database.close();
  }
}

function readAuthoritativeFactoryExecutionFromDatabase(
  database: SqliteDatabase,
  executionAttemptId: string,
): AuthoritativeFactoryExecutionEvidence | null {
  requireString(executionAttemptId, "executionAttemptId");
  const row = database
    .prepare(
      `SELECT fence_id, request_json, result_json, receipt_id
         FROM execution_results WHERE execution_attempt_id = ?`,
    )
    .get(executionAttemptId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const request = parseCanonicalStoredValue<AuthorizedScheduleMutation>(
    row["request_json"],
    "factory execution request",
  );
  const result = parseCanonicalStoredValue<SyntheticMutationResult>(
    row["result_json"],
    "factory execution result",
  );
  const eventRow = database
    .prepare(
      `SELECT body_json FROM mutation_events WHERE execution_attempt_id = ?`,
    )
    .get(executionAttemptId) as Record<string, unknown> | undefined;
  if (eventRow === undefined) {
    throw new StatefulInputError(
      "mutationEvent",
      "authoritative execution result has no durable mutation event",
    );
  }
  const mutationEvent = parseCanonicalStoredValue<JsonValue>(
    eventRow["body_json"],
    "factory mutation event",
  );
  const fenceId = requireString(row["fence_id"], "fence_id");
  const receiptId = requireString(row["receipt_id"], "receipt_id");
  validateStoredFactoryExecution(
    executionAttemptId,
    fenceId,
    receiptId,
    request,
    result,
    mutationEvent,
  );
  const currentState = readScheduleStateFromDatabase(database);
  const expectedReservation = result.resultingState.reservations.find(
    (reservation) =>
      reservation.sourceExecutionAttemptId === executionAttemptId,
  );
  const currentReservation = currentState.reservations.find(
    (reservation) =>
      reservation.sourceExecutionAttemptId === executionAttemptId,
  );
  if (
    expectedReservation === undefined ||
    currentReservation === undefined ||
    canonicalSerialize(expectedReservation) !==
      canonicalSerialize(currentReservation)
  ) {
    throw new StatefulInputError(
      "currentState",
      "does not preserve the immutable attempt-specific reservation",
    );
  }
  return deepFreeze({
    environmentId: currentState.environmentId,
    currentState,
    currentStateDigest: stateDigest(currentState),
    request,
    result,
    mutationEvent,
    resultDigest: digest(result),
  });
}

function validateStoredFactoryExecution(
  executionAttemptId: string,
  fenceId: string,
  receiptId: string,
  request: AuthorizedScheduleMutation,
  result: SyntheticMutationResult,
  mutationEvent: JsonValue,
): void {
  if (
    result.schemaVersion !== "microfactory-mutation-result/v1" ||
    result.status !== "MUTATED_PENDING_VERIFICATION" ||
    request.executionAttemptId !== executionAttemptId ||
    result.executionAttemptId !== executionAttemptId ||
    result.fenceId !== fenceId ||
    result.receipt.executionAttemptId !== executionAttemptId ||
    result.receipt.fenceId !== fenceId ||
    result.receipt.receiptId !== receiptId ||
    result.receipt.schemaVersion !== "microfactory-mutation-receipt/v1" ||
    result.receipt.mutationStatus !== "applied" ||
    result.receipt.verificationStatus !== "pending_independent_read_back"
  ) {
    throw new StatefulInputError(
      "factoryExecution",
      "contains inconsistent attempt, fence, result, or receipt identity",
    );
  }
  const commandDigest = digest(result.canonicalCommand);
  const beforeStateDigest = stateDigest(result.beforeState);
  const resultingStateDigest = stateDigest(result.resultingState);
  const expectedReceiptId = stableTupleId("factory-mutation-receipt", [
    executionAttemptId,
    fenceId,
    commandDigest,
    beforeStateDigest,
    resultingStateDigest,
  ]);
  if (
    canonicalSerialize(request.command) !==
      canonicalSerialize(result.canonicalCommand) ||
    request.expectedBeforeStateVersion !== result.beforeState.stateVersion ||
    request.expectedBeforeStateDigest !== beforeStateDigest ||
    result.beforeState.environmentId !== result.resultingState.environmentId ||
    result.resultingState.environmentId !== result.canonicalCommand.environmentId ||
    result.receipt.commandDigest !== commandDigest ||
    result.receipt.beforeStateDigest !== beforeStateDigest ||
    result.receipt.resultingStateDigest !== resultingStateDigest ||
    receiptId !== expectedReceiptId
  ) {
    throw new StatefulInputError(
      "factoryExecution",
      "failed canonical command, state, environment, or receipt verification",
    );
  }
  const expectedEvent = {
    executionAttemptId,
    fenceId,
    canonicalCommand: result.canonicalCommand,
    beforeState: result.beforeState,
    resultingState: result.resultingState,
    receipt: result.receipt,
  };
  if (canonicalSerialize(mutationEvent) !== canonicalSerialize(expectedEvent)) {
    throw new StatefulInputError(
      "mutationEvent",
      "does not exactly reproduce the durable factory result",
    );
  }
}

function readScheduleStateFromDatabase(
  database: SqliteDatabase,
): FactoryScheduleState {
  const metadata = database
    .prepare(
      `SELECT environment_id, state_version
         FROM factory_metadata WHERE singleton = 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (metadata === undefined) throw new Error("Factory metadata is missing");
  const environmentId = requireNonBlankIdentifier(
    metadata["environment_id"],
    "environment_id",
  );
  const stateVersion = requirePositiveInteger(
    metadata["state_version"],
    "state_version",
  );
  const rows = database
    .prepare(
      `SELECT body_json FROM schedule_reservations
        ORDER BY start_at, end_at, reservation_id`,
    )
    .all() as Record<string, unknown>[];
  return {
    schemaVersion: "microfactory-schedule-state/v1",
    environmentId,
    stateVersion: `factory-state/v${stateVersion}`,
    reservations: rows.map((row) =>
      parseCanonicalScheduleReservation(row["body_json"]),
    ),
  };
}

function parseCanonicalStoredValue<T>(value: unknown, context: string): T {
  const bytes = requireString(value, `${context} bytes`);
  const parsed = JSON.parse(bytes) as unknown;
  if (canonicalSerialize(parsed) !== bytes) {
    throw new TypeError(`${context} is not canonical JSON`);
  }
  return parsed as T;
}

function parseCanonicalJsonValue(value: unknown, context: string): JsonValue {
  const bytes = requireString(value, `${context} bytes`);
  const parsed = JSON.parse(bytes) as JsonValue;
  if (canonicalSerialize(parsed) !== bytes) {
    throw new TypeError(`${context} is not canonical JSON`);
  }
  return parsed;
}

function stateDigest(state: FactoryScheduleState): string {
  return digest(state);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value), "utf8")
    .digest("hex")}`;
}

function compareReservations(
  left: FactoryScheduleReservation,
  right: FactoryScheduleReservation,
): number {
  for (const [leftValue, rightValue] of [
    [left.start, right.start],
    [left.end, right.end],
    [left.reservationId, right.reservationId],
  ] as const) {
    const comparison = compareStableStrings(leftValue, rightValue);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function parseStateVersion(value: string): number {
  const match = /^factory-state\/v([1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new TypeError("Invalid factory state version");
  return Number(match[1]);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StatefulInputError(path, "must be a non-empty string");
  }
  return value;
}

function requireNonBlankIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StatefulInputError(
      path,
      "must contain at least one non-whitespace character",
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path}: must be a positive safe integer`);
  }
  return value as number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
