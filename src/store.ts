import { createHash, randomUUID } from "node:crypto";

import {
  canonicalClone,
  canonicalSerialize,
  compareStableStrings,
  deepFreeze,
} from "./canonical.js";
import { computeCalibration } from "./calibration.js";
import type {
  AcceptedObligation,
  AdmissionEvaluationInput,
  AdmissionResult,
  CalibrationHistoryRecord,
  CapacityResource,
  CombinedDecisionProof,
  FixedCapacityReservation,
  JsonValue,
  ProposedObligation,
  ProvenanceEntry,
  ReplanCandidate,
  VersionTuple,
} from "./domain.js";
import {
  approvalScopeCovers,
  approvalScopeStrictlyContained,
  canonicalGrantAllowanceKey,
  canonicalizeApprovalScope,
  deniedScopePredicate,
  denialPredicateMatches,
  effectFingerprintIdentity,
  normalizeEffect,
  validateAuthorizationOccurrence,
  validateEffectFingerprint,
} from "./effects.js";
import { stableTupleId } from "./identity.js";
import { evaluateAdmission } from "./kernel.js";
import {
  claimedExecutionReference,
  readAuthoritativeFactoryExecution,
  readAuthoritativeFactoryState,
} from "./factory-environment.js";
import type {
  AuthoritativeFactoryExecutionEvidence,
  FactoryScheduleState,
} from "./factory-environment.js";
import {
  canonicalDatabasePath,
  canonicalJson,
  databaseInstanceIdentityFromHandle,
  inImmediateTransaction,
  openSqlite,
  parseCanonicalJson,
  requireRow,
} from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite.js";
import type {
  AcceptPromiseInput,
  AcceptPromiseAndIssueGrantInput,
  AcceptPromiseAndIssueGrantResult,
  AcceptPromiseResult,
  ActualConsumptionValue,
  AdmissionAddendum,
  AdmissionAddendumKind,
  AdmissionBasisMismatch,
  AdmissionReadModel,
  AdmissionRecordBody,
  AdmissionRequest,
  AuthorizationEvaluation,
  AuthorizationOccurrence,
  CanonicalApprovalScope,
  ClaimExecutionInput,
  CreateDenialExceptionInput,
  CreateDenialInput,
  CreateExecutionFenceInput,
  CreateStoreOptions,
  DenialConstraint,
  DenialExceptionReadModel,
  ExecutionClaimResult,
  ExecutionAttemptReadModel,
  ExecutionFenceOperationResult,
  ExecutionFenceReadModel,
  ExecutionFenceRecoveryResult,
  ExecutionFenceResultBinding,
  ExecutionTerminalInput,
  ExecutionTerminalResult,
  AuthoritativeExecutionVerificationResult,
  GrantAllowanceReadModel,
  InFlightExecutionReservation,
  IssueGrantInput,
  IssuedGrantResult,
  MaterialCapacityModelUpdate,
  MaterialCapacityPlanUpdate,
  OwnerDecisionInput,
  OwnerDecisionResult,
  PortfolioReadModel,
  RecordActualConsumptionInput,
  RecordCalibrationCorrectionInput,
  RecordOutcomeInput,
  RealizedConsumptionReservationFact,
  StatefulInitialState,
  StoredSelectedPlan,
} from "./stateful-domain.js";
import {
  AuthorizationDeniedError,
  ExecutionAttemptConflictError,
  StatefulInputError,
} from "./stateful-domain.js";
import { advanceVersions, readVersions } from "./versioning.js";

interface CapacityModelPart {
  readonly resourceKey: string;
  readonly side: CapacityResource["side"];
  readonly capacityKind: CapacityResource["capacityKind"];
  readonly unit: string;
  readonly timeUnit: CapacityResource["timeUnit"];
  readonly estimatorRule: string;
  readonly assumptions: readonly ProvenanceEntry[];
}

interface CapacityPlanPart {
  readonly resourceKey: string;
  readonly horizonStart: string;
  readonly horizonEnd: string;
  readonly capacity: number;
  readonly safetyReserve: number;
}

interface GrantAllowanceBase {
  readonly grantAllowanceKey: string;
  readonly decisionId: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly canonicalApprovedScope: CanonicalApprovalScope;
  readonly approverId: string;
  readonly maxExecutions: number;
  readonly createdAt: string;
  readonly createdAuthorizationStateVersion: string;
  readonly postDenialAuthorization: IssueGrantInput["postDenialAuthorization"];
}

interface GrantBase {
  readonly grantId: string;
  readonly grantVersion: string;
  readonly grantAllowanceKey: string;
  readonly authorizationStateVersion: string;
  readonly decisionId: string;
  readonly admissionRecordId: string;
  readonly promiseBasisId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly selectedBundleId: string;
  readonly selectedPlanId: string;
  readonly portfolioVersion: string;
  readonly capacityModelVersion: string;
  readonly capacityPlanVersion: string;
  readonly issuedAt: string;
  readonly scope: CanonicalApprovalScope;
  readonly postDenialAuthorization: IssueGrantInput["postDenialAuthorization"];
  readonly status: "live";
}

interface AdmissionBasisValues {
  readonly portfolioVersion: string;
  readonly capacityModelVersion: string;
  readonly capacityPlanVersion: string;
  readonly authorizationStateVersion: string;
  readonly calibrationFrontierDigest: string;
}

function committedAcceptanceReplay(
  admission: AdmissionReadModel,
  input: AcceptPromiseInput,
  body: JsonValue,
  ownerDecision: Record<string, unknown> | null,
): Extract<AcceptPromiseResult, { readonly status: "COMMITTED" }> {
  const record = admission.record;
  const mismatches = compareAdmissionBasis(input, {
    portfolioVersion: record.portfolioVersion,
    capacityModelVersion: record.capacityModelVersion,
    capacityPlanVersion: record.capacityPlanVersion,
    authorizationStateVersion: record.authorizationStateVersion,
    calibrationFrontierDigest: record.calibrationFrontierDigest,
  });
  if (mismatches.length > 0 || !isJsonObject(body)) {
    throw new StatefulInputError(
      "acceptance",
      "replay differs from the immutable accepted admission basis",
    );
  }
  const committedPortfolioVersion = body["committedPortfolioVersion"];
  if (typeof committedPortfolioVersion !== "string") {
    throw new Error("Acceptance commit is missing its portfolio version");
  }
  const authorizationRequest = body["authorizationRequest"];
  const expectedRequest = acceptanceAuthorizationRequest(input);
  const comparableRequest =
    authorizationRequest === undefined
      ? legacyAcceptanceAuthorizationRequest(record, body, ownerDecision)
      : authorizationRequest;
  if (
    canonicalSerialize(comparableRequest) !== canonicalSerialize(expectedRequest)
  ) {
    throw new StatefulInputError(
      "acceptance",
      "replay conflicts with the complete immutable authorization request",
    );
  }
  return deepFreeze({
    status: "COMMITTED",
    admissionRecordId: input.admissionRecordId,
    selectedPlanId: input.selectedPlanId,
    versions: {
      portfolioVersion: committedPortfolioVersion,
      capacityModelVersion: record.capacityModelVersion,
      capacityPlanVersion: record.capacityPlanVersion,
      authorizationStateVersion: record.authorizationStateVersion,
    },
  });
}

type ExecutionFenceBase = Omit<
  ExecutionFenceReadModel,
  "status" | "resultBinding"
>;

export class FlakeBrakeStore {
  readonly #database: SqliteDatabase;
  readonly #databasePath: string;
  readonly #now: () => string;
  readonly #authoritativeFactoryDatabasePath: string | null;

  public constructor(options: CreateStoreOptions) {
    if (typeof options.path !== "string" || options.path.length === 0) {
      throw new StatefulInputError("path", "must be a non-empty string");
    }
    this.#database = openSqlite(options.path);
    this.#databasePath = canonicalDatabasePath(options.path);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#authoritativeFactoryDatabasePath =
      options.authoritativeFactoryDatabasePath ?? null;
    if (
      this.#authoritativeFactoryDatabasePath !== null &&
      (this.#authoritativeFactoryDatabasePath.length === 0 ||
        this.#authoritativeFactoryDatabasePath === ":memory:")
    ) {
      this.#database.close();
      throw new StatefulInputError(
        "authoritativeFactoryDatabasePath",
        "must identify a durable factory SQLite database",
      );
    }
    const initialized = this.#database
      .prepare("SELECT 1 AS initialized FROM state_versions WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (initialized === undefined) {
      if (options.initialState === undefined) {
        this.#database.close();
        throw new StatefulInputError(
          "initialState",
          "is required when creating a new store",
        );
      }
      inImmediateTransaction(this.#database, () => {
        this.#insertInitialState(options.initialState as StatefulInitialState);
      });
    } else if (options.initialState !== undefined) {
      const current = this.getPortfolio();
      const supplied = canonicalInitialState(options.initialState);
      if (
        canonicalSerialize(current.acceptedObligations) !==
          canonicalSerialize(supplied.acceptedObligations) ||
        canonicalSerialize(current.resources) !== canonicalSerialize(supplied.resources)
      ) {
        this.#database.close();
        throw new StatefulInputError(
          "initialState",
          "cannot replace an already initialized durable store",
        );
      }
    }
  }

  public close(): void {
    this.#database.close();
  }

  public databaseInstanceIdentity(environmentId: string): string {
    return databaseInstanceIdentityFromHandle(
      this.#database,
      this.#databasePath,
      "m2",
      environmentId,
    );
  }

  /** Synchronous transaction scope used by bounded compound store operations. */
  public withImmediateTransaction<T>(operation: (database: SqliteDatabase) => T): T {
    return inImmediateTransaction(this.#database, () => operation(this.#database));
  }

  public getPortfolio(): PortfolioReadModel {
    return deepFreeze({
      versions: readVersions(this.#database),
      acceptedObligations: this.#readAcceptedObligations(),
      resources: this.#readResources(),
      activeReservations: this.#readReservations(false),
    });
  }

  public evaluateAndRecordAdmission(request: AdmissionRequest): AdmissionRecordBody {
    return inImmediateTransaction(this.#database, () => {
      const input = this.#buildAdmissionInput(request, null);
      const result = evaluateAdmission(input);
      return this.#insertAdmissionRecord(result);
    });
  }

  /** Exact-basis idempotent admission recording for replayable orchestration. */
  public evaluateAndRecordAdmissionOrReplay(
    request: AdmissionRequest,
  ): AdmissionRecordBody {
    return inImmediateTransaction(this.#database, () => {
      const input = this.#buildAdmissionInput(request, null);
      const result = evaluateAdmission(input);
      const matches = this.getAdmissionHistory().filter(
        ({ record }) =>
          canonicalSerialize(record.proposalSnapshot) ===
            canonicalSerialize(request.proposal) &&
          canonicalSerialize(record.m1Result) === canonicalSerialize(result),
      );
      if (matches.length > 1) {
        throw new StatefulInputError(
          "admissionBasis",
          "the exact authoritative admission basis has duplicate records",
        );
      }
      return matches[0]?.record ?? this.#insertAdmissionRecord(result);
    });
  }

  public evaluateCurrentAdmission(request: AdmissionRequest): {
    readonly evaluationInput: AdmissionEvaluationInput;
    readonly result: AdmissionResult;
  } {
    return inImmediateTransaction(this.#database, () => {
      const proposalAlreadyAccepted = this.#readAcceptedObligations().some(
        (obligation) =>
          obligation.obligationId === request.proposal.obligationId,
      );
      const evaluationInput = this.#buildAdmissionInput(
        request,
        null,
        proposalAlreadyAccepted,
      );
      return deepFreeze({
        evaluationInput,
        result: evaluateAdmission(evaluationInput),
      });
    });
  }

  public getAdmissionRecord(admissionRecordId: string): AdmissionReadModel {
    assertNonEmptyString(admissionRecordId, "admissionRecordId");
    const row = requireRow(
      this.#database
        .prepare(
          `SELECT body_json FROM admission_records
            WHERE admission_record_id = ?`,
        )
        .get(admissionRecordId) as Record<string, unknown> | undefined,
      `admission record ${admissionRecordId}`,
    );
    const canonicalRecordBytes = requireString(row["body_json"], "admission body");
    const record = parseCanonicalJson<AdmissionRecordBody>(
      canonicalRecordBytes,
      `admission record ${admissionRecordId}`,
    );
    return deepFreeze({
      record,
      canonicalRecordBytes,
      addenda: this.#readAdmissionAddenda(admissionRecordId),
    });
  }

  public getAdmissionHistory(): readonly AdmissionReadModel[] {
    const rows = this.#database
      .prepare(
        `SELECT admission_record_id FROM admission_records
          ORDER BY created_at, admission_record_id`,
      )
      .all() as Record<string, unknown>[];
    return deepFreeze(
      rows.map((row) =>
        this.getAdmissionRecord(
          requireString(row["admission_record_id"], "admission_record_id"),
        ),
      ),
    );
  }

  public acceptPromise(input: AcceptPromiseInput): AcceptPromiseResult {
    validateAcceptPromiseInput(input);
    return inImmediateTransaction(this.#database, () => {
      const readModel = this.getAdmissionRecord(input.admissionRecordId);
      const record = readModel.record;
      this.#validateAcceptablePlan(record, readModel.addenda, input.selectedPlanId);
      const recordBasis = {
        portfolioVersion: record.portfolioVersion,
        capacityModelVersion: record.capacityModelVersion,
        capacityPlanVersion: record.capacityPlanVersion,
        authorizationStateVersion: record.authorizationStateVersion,
        calibrationFrontierDigest: record.calibrationFrontierDigest,
      };
      const suppliedRecordMismatches = compareAdmissionBasis(input, recordBasis);
      const proposalAlreadyAccepted = this.#readAcceptedObligations().some(
        (obligation) =>
          obligation.obligationId === record.proposalSnapshot.obligationId,
      );
      const currentVersions = readVersions(this.#database);
      const currentBasis: AdmissionBasisValues = {
        ...currentVersions,
        calibrationFrontierDigest: this.#calibrationDigestForProposal(
          record.proposalSnapshot,
          proposalAlreadyAccepted,
        ),
      };
      const mismatches = uniqueMismatches([
        ...suppliedRecordMismatches,
        ...compareAdmissionBasis(input, currentBasis),
      ]);
      if (
        canonicalSerialize(this.#readM1CapacityReservations()) !==
        canonicalSerialize(record.fixedInFlightExecutionReservations)
      ) {
        mismatches.splice(0, mismatches.length, ...uniqueMismatches([
          ...mismatches,
          "authorization_state_version",
        ]));
      }
      if (mismatches.length > 0) {
        const currentInput = this.#buildAdmissionInput(
          {
            proposal: record.proposalSnapshot,
            assumptions: record.m1Result.promiseBasis.assumptions,
            combinedDecisionProofs:
              record.m1Result.promiseBasis.combinedDecisionProofs,
          },
          null,
          true,
        );
        const currentEvaluation = evaluateAdmission(currentInput);
        const staleAddendumId = this.#appendAdmissionAddendum(
          input.admissionRecordId,
          "stale_superseded",
          {
            expectedAdmissionBasis: inputBasisJson(input),
            currentAdmissionBasis: basisValuesJson(currentBasis),
            mismatches,
            selectedPlanId: input.selectedPlanId,
          },
        );
        const freshAdmissionRecord = this.#insertAdmissionRecord(currentEvaluation);
        if (proposalAlreadyAccepted) {
          this.#appendAdmissionAddendum(
            freshAdmissionRecord.admissionRecordId,
            "readmission_link",
            {
              kind: "ALREADY_ACCEPTED_NO_COMMIT",
              sourceAdmissionRecordId: input.admissionRecordId,
            },
          );
        }
        this.#appendAdmissionAddendum(
          input.admissionRecordId,
          "readmission_link",
          {
            staleAddendumId,
            freshAdmissionRecordId: freshAdmissionRecord.admissionRecordId,
          },
        );
        return deepFreeze({
          status: "STALE_READMISSION",
          staleAdmissionRecordId: input.admissionRecordId,
          freshAdmissionRecord,
          mismatches,
        });
      }

      const selectedPortfolio = materializeSelectedPortfolio(
        record,
        input.selectedPlanId,
      );
      const decisionBody = {
        kind: "ACCEPT_PROMISE",
        admissionRecordId: input.admissionRecordId,
        selectedPlanId: input.selectedPlanId,
        ownerDecisionId: input.ownerDecisionId,
        approverId: input.approverId,
        ownerSourceIdentity:
          acceptanceAuthorizationRequest(input).ownerSourceIdentity,
      } as const;
      this.#insertOwnerDecision(input.ownerDecisionId, decisionBody);
      this.#replacePortfolio(selectedPortfolio);
      const versions = advanceVersions(this.#database, new Set(["portfolio"]));
      this.#appendAdmissionAddendum(
        input.admissionRecordId,
        "owner_choice",
        decisionBody,
      );
      this.#appendAdmissionAddendum(
        input.admissionRecordId,
        "acceptance_commit",
        {
          authorizationRequest: acceptanceAuthorizationRequest(input),
          ownerDecisionId: input.ownerDecisionId,
          selectedPlanId: input.selectedPlanId,
          committedPortfolioVersion: versions.portfolioVersion,
          acceptedPortfolio: selectedPortfolio,
        },
      );
      return deepFreeze({
        status: "COMMITTED",
        admissionRecordId: input.admissionRecordId,
        selectedPlanId: input.selectedPlanId,
        versions,
      });
    });
  }

  public acceptPromiseAndIssueGrant(
    input: AcceptPromiseAndIssueGrantInput,
  ): AcceptPromiseAndIssueGrantResult {
    return inImmediateTransaction(this.#database, () => {
      const admission = this.getAdmissionRecord(
        input.acceptance.admissionRecordId,
      );
      const acceptanceCommits = admission.addenda.filter(
        (addendum) => addendum.kind === "acceptance_commit",
      );
      const exactCommit = acceptanceCommits.find((addendum) => {
        if (!isJsonObject(addendum.body)) return false;
        return (
          addendum.body["ownerDecisionId"] ===
            input.acceptance.ownerDecisionId &&
          addendum.body["selectedPlanId"] === input.acceptance.selectedPlanId
        );
      });
      if (acceptanceCommits.length > 0 && exactCommit === undefined) {
        throw new StatefulInputError(
          "acceptance",
          "conflicts with the immutable accepted promise",
        );
      }
      const acceptance =
        exactCommit === undefined
          ? this.acceptPromise(input.acceptance)
          : committedAcceptanceReplay(
              admission,
              input.acceptance,
              exactCommit.body,
              this.#ownerDecisionBody(input.acceptance.ownerDecisionId),
            );
      if (acceptance.status !== "COMMITTED") {
        return deepFreeze({ acceptance, grant: null });
      }
      const grant = this.issueGrant({
        ...input.grant,
        expectedPortfolioVersion: acceptance.versions.portfolioVersion,
        expectedCapacityModelVersion:
          acceptance.versions.capacityModelVersion,
        expectedCapacityPlanVersion: acceptance.versions.capacityPlanVersion,
      });
      return deepFreeze({
        acceptance,
        grant: { ...grant, created: true },
      });
    });
  }

  public recordOwnerDecision(input: OwnerDecisionInput): OwnerDecisionResult {
    validateOwnerDecisionInput(input);
    return inImmediateTransaction(this.#database, () => {
      const record = this.getAdmissionRecord(input.admissionRecordId);
      const decisionBody = canonicalClone(input);
      const existing = this.#insertOwnerDecision(input.ownerDecisionId, decisionBody);
      if (input.kind === "DECLINE") {
        if (!existing) {
          this.#appendAdmissionAddendum(
            input.admissionRecordId,
            "owner_choice",
            decisionBody,
          );
        }
        return deepFreeze({
          status: "DECLINED",
          ownerDecisionId: input.ownerDecisionId,
        });
      }

      this.#validatePlanIdentity(record.record, input.selectedPlanId);
      if (existing) {
        return this.#modifyDecisionReplay(input);
      }
      this.#appendAdmissionAddendum(
        input.admissionRecordId,
        "owner_choice",
        decisionBody,
      );
      const proposal = input.replacementProposal ?? record.record.proposalSnapshot;
      const freshInput = this.#buildAdmissionInput(
        {
          proposal,
          assumptions: record.record.m1Result.promiseBasis.assumptions,
          combinedDecisionProofs:
            record.record.m1Result.promiseBasis.combinedDecisionProofs,
        },
        null,
      );
      const freshAdmissionRecord = this.#insertAdmissionRecord(
        evaluateAdmission(freshInput),
      );
      if (
        input.replacementProposal === undefined &&
        planExists(freshAdmissionRecord, input.selectedPlanId)
      ) {
        this.#appendAdmissionAddendum(
          freshAdmissionRecord.admissionRecordId,
          "owner_choice",
          {
            kind: "MODIFY_SELECTION_CONFIRMED",
            ownerDecisionId: input.ownerDecisionId,
            approverId: input.approverId,
            selectedPlanId: input.selectedPlanId,
            sourceAdmissionRecordId: input.admissionRecordId,
          },
        );
      }
      this.#appendAdmissionAddendum(
        input.admissionRecordId,
        "readmission_link",
        {
          ownerDecisionId: input.ownerDecisionId,
          freshAdmissionRecordId: freshAdmissionRecord.admissionRecordId,
        },
      );
      return deepFreeze({
        status: "READMITTED",
        ownerDecisionId: input.ownerDecisionId,
        freshAdmissionRecord,
      });
    });
  }

  public replaceCapacityModel(input: MaterialCapacityModelUpdate): VersionTuple {
    const resources = canonicalResources(input.resources);
    return inImmediateTransaction(this.#database, () => {
      const current = this.#readResources();
      requireSameResourceKeys(current, resources);
      const assembledResources = resources.map((resource) => {
        const existing = current.find(
          (candidate) => candidate.resourceKey === resource.resourceKey,
        );
        if (existing === undefined) {
          throw new StatefulInputError(
            "resources",
            `missing current resource ${resource.resourceKey}`,
          );
        }
        return {
          ...resource,
          ...capacityPlanPart(existing),
        };
      });
      this.#preflightCapacityModel(assembledResources);
      let changed = false;
      for (const resource of resources) {
        const model = capacityModelPart(resource);
        const existing = current.find(
          (candidate) => candidate.resourceKey === resource.resourceKey,
        );
        if (
          existing === undefined ||
          canonicalSerialize(capacityModelPart(existing)) !== canonicalSerialize(model)
        ) {
          changed = true;
        }
        this.#database
          .prepare(
            `UPDATE capacity_resources SET model_json = ? WHERE resource_key = ?`,
          )
          .run(canonicalJson(model), resource.resourceKey);
      }
      return advanceVersions(
        this.#database,
        changed ? new Set(["capacity_model"]) : new Set(),
      );
    });
  }

  public replaceCapacityPlan(input: MaterialCapacityPlanUpdate): VersionTuple {
    assertNonEmptyString(input.ownerDecisionId, "ownerDecisionId");
    assertNonEmptyString(input.approverId, "approverId");
    const resources = canonicalResources(input.resources);
    return inImmediateTransaction(this.#database, () => {
      const current = this.#readResources();
      requireSameResourceKeys(current, resources);
      let changed = false;
      for (const resource of resources) {
        const plan = capacityPlanPart(resource);
        const existing = current.find(
          (candidate) => candidate.resourceKey === resource.resourceKey,
        );
        if (
          existing === undefined ||
          canonicalSerialize(capacityPlanPart(existing)) !== canonicalSerialize(plan)
        ) {
          changed = true;
        }
        this.#database
          .prepare(
            `UPDATE capacity_resources SET plan_json = ? WHERE resource_key = ?`,
          )
          .run(canonicalJson(plan), resource.resourceKey);
      }
      if (changed) {
        this.#insertOwnerDecision(input.ownerDecisionId, {
          kind: "APPROVE_CAPACITY_PLAN",
          ownerDecisionId: input.ownerDecisionId,
          approverId: input.approverId,
          previousCapacityPlan: current.map(capacityPlanPart),
          approvedCapacityPlan: resources.map(capacityPlanPart),
        });
      }
      return advanceVersions(
        this.#database,
        changed ? new Set(["capacity_plan"]) : new Set(),
      );
    });
  }

  public issueGrant(input: IssueGrantInput): IssuedGrantResult {
    validateIssueGrantInput(input);
    const scope = canonicalizeApprovalScope(input.scope);
    const allowanceKey = canonicalGrantAllowanceKey(
      input.ownerDecisionId,
      input.selectedBundleId,
      scope,
      scope.approverId,
    );
    return inImmediateTransaction(this.#database, () => {
      const currentVersions = readVersions(this.#database);
      requireExpectedVersions(
        currentVersions,
        input.expectedPortfolioVersion,
        input.expectedCapacityModelVersion,
        input.expectedCapacityPlanVersion,
      );
      this.#validateAcceptedGrantBasis(input, scope, currentVersions);
      if (input.postDenialAuthorization !== null) {
        const parent = this.#denialBase(
          input.postDenialAuthorization.parentDenialId,
        );
        if (
          parent === null ||
          this.#denialReadModel(parent).status !== "active"
        ) {
          throw new StatefulInputError(
            "postDenialAuthorization.parentDenialId",
            "must reference an existing active denial",
          );
        }
        if (!approvalScopeStrictlyContained(scope, parent.deniedScope)) {
          throw new StatefulInputError(
            "postDenialAuthorization",
            "must authorize a scope strictly narrower than the parent denial",
          );
        }
      }
      const createdAt = this.#timestamp();
      const existingAllowance = this.#allowanceBase(allowanceKey);
      const existingGrant = this.#grantBase(input.grantId);
      const versions =
        existingAllowance === null || existingGrant === null
          ? advanceVersions(this.#database, new Set(["authorization"]))
          : currentVersions;
      const allowanceBody: GrantAllowanceBase = {
        grantAllowanceKey: allowanceKey,
        decisionId: input.ownerDecisionId,
        admissionRecordId: input.admissionRecordId,
        promiseBasisId: input.promiseBasisId,
        acceptedOwnerDecisionId: input.acceptedOwnerDecisionId,
        selectedBundleId: input.selectedBundleId,
        selectedPlanId: input.selectedPlanId,
        canonicalApprovedScope: scope,
        approverId: scope.approverId,
        maxExecutions: scope.maxExecutions,
        createdAt: existingAllowance?.createdAt ?? createdAt,
        createdAuthorizationStateVersion:
          existingAllowance?.createdAuthorizationStateVersion ??
          versions.authorizationStateVersion,
        postDenialAuthorization: input.postDenialAuthorization,
      };
      if (existingAllowance !== null) {
        assertSameMaterialAllowance(existingAllowance, allowanceBody);
      }
      const ownerDecision = {
        kind: "APPROVE_GRANT",
        ownerDecisionId: input.ownerDecisionId,
        admissionRecordId: input.admissionRecordId,
        promiseBasisId: input.promiseBasisId,
        acceptedOwnerDecisionId: input.acceptedOwnerDecisionId,
        selectedBundleId: input.selectedBundleId,
        selectedPlanId: input.selectedPlanId,
        approverId: scope.approverId,
        approvedScope: scope,
        postDenialAuthorization: input.postDenialAuthorization,
        authorizationStateVersion:
          allowanceBody.createdAuthorizationStateVersion,
      } as const;
      this.#insertOwnerDecision(input.ownerDecisionId, ownerDecision);

      if (existingAllowance === null) {
        this.#database
          .prepare(
            `INSERT INTO grant_allowances
              (grant_allowance_key, created_at, body_json) VALUES (?, ?, ?)`,
          )
          .run(allowanceKey, createdAt, canonicalJson(allowanceBody));
      }
      const grantBody: GrantBase = {
        grantId: input.grantId,
        grantVersion: input.grantVersion,
        grantAllowanceKey: allowanceKey,
        authorizationStateVersion: versions.authorizationStateVersion,
        decisionId: input.ownerDecisionId,
        admissionRecordId: input.admissionRecordId,
        promiseBasisId: input.promiseBasisId,
        acceptedOwnerDecisionId: input.acceptedOwnerDecisionId,
        selectedBundleId: input.selectedBundleId,
        selectedPlanId: input.selectedPlanId,
        portfolioVersion: currentVersions.portfolioVersion,
        capacityModelVersion: currentVersions.capacityModelVersion,
        capacityPlanVersion: currentVersions.capacityPlanVersion,
        issuedAt: createdAt,
        scope,
        postDenialAuthorization: input.postDenialAuthorization,
        status: "live",
      };
      if (existingGrant === null) {
        this.#database
          .prepare(
            `INSERT INTO grants
              (grant_id, grant_allowance_key, created_at, body_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.grantId, allowanceKey, createdAt, canonicalJson(grantBody));
      } else {
        assertSameGrant(existingGrant, grantBody);
      }
      return deepFreeze({
        grantId: input.grantId,
        grantAllowanceKey: allowanceKey,
        created: existingAllowance === null,
        allowance: this.getGrantAllowance(allowanceKey),
        versions: readVersions(this.#database),
      });
    });
  }

  public getGrantAllowance(grantAllowanceKey: string): GrantAllowanceReadModel {
    assertNonEmptyString(grantAllowanceKey, "grantAllowanceKey");
    const base = this.#allowanceBase(grantAllowanceKey);
    if (base === null) throw new Error(`Grant allowance ${grantAllowanceKey} not found`);
    const claims = this.#database
      .prepare(
        `SELECT ordinal FROM allowance_claims
          WHERE grant_allowance_key = ? ORDER BY ordinal`,
      )
      .all(grantAllowanceKey) as Record<string, unknown>[];
    const claimedExecutionSlots = claims.map((row) =>
      requireSafeInteger(row["ordinal"], "allowance ordinal"),
    );
    const grantRows = this.#database
      .prepare(
        `SELECT grant_id FROM grants
          WHERE grant_allowance_key = ? ORDER BY grant_id`,
      )
      .all(grantAllowanceKey) as Record<string, unknown>[];
    const grantIds = grantRows.map((row) =>
      requireString(row["grant_id"], "grant_id"),
    );
    return deepFreeze({
      grantAllowanceKey,
      decisionId: base.decisionId,
      admissionRecordId: base.admissionRecordId,
      promiseBasisId: base.promiseBasisId,
      acceptedOwnerDecisionId: base.acceptedOwnerDecisionId,
      selectedBundleId: base.selectedBundleId,
      selectedPlanId: base.selectedPlanId,
      canonicalApprovedScope: base.canonicalApprovedScope,
      approverId: base.approverId,
      maxExecutions: base.maxExecutions,
      claimedExecutionSlots,
      grantIds,
      status: this.#allowanceStatus(
        base,
        claimedExecutionSlots.length,
        this.#timestamp(),
      ),
    });
  }

  public revokeGrant(grantId: string, reason: string): VersionTuple {
    assertNonEmptyString(grantId, "grantId");
    assertNonEmptyString(reason, "reason");
    return this.#recordAuthorizationTermination(
      "grant",
      grantId,
      "revoked",
      { reason },
      () => this.#grantBase(grantId) !== null,
    );
  }

  public revokeGrantAllowance(
    grantAllowanceKey: string,
    reason: string,
  ): VersionTuple {
    assertNonEmptyString(grantAllowanceKey, "grantAllowanceKey");
    assertNonEmptyString(reason, "reason");
    return this.#recordAuthorizationTermination(
      "allowance",
      grantAllowanceKey,
      "revoked",
      { reason },
      () => this.#allowanceBase(grantAllowanceKey) !== null,
    );
  }

  public expireGrantAllowance(
    grantAllowanceKey: string,
    evidenceReference: string,
  ): VersionTuple {
    assertNonEmptyString(grantAllowanceKey, "grantAllowanceKey");
    assertNonEmptyString(evidenceReference, "evidenceReference");
    return this.#recordAuthorizationTermination(
      "allowance",
      grantAllowanceKey,
      "expired",
      { evidenceReference },
      () => this.#allowanceBase(grantAllowanceKey) !== null,
    );
  }

  public createDenial(input: CreateDenialInput): DenialConstraint {
    validateCreateDenialInput(input);
    const identity = effectFingerprintIdentity(input.deniedEffectFingerprint);
    const scope = canonicalizeApprovalScope(input.deniedScope);
    if (
      scope.objectiveId !== input.objectiveId ||
      scope.approverId !== input.approverId ||
      scope.environmentId !== identity.fingerprint.environmentId
    ) {
      throw new StatefulInputError(
        "deniedScope",
        "must match the denial objective, approver, and effect environment",
      );
    }
    const predicate = deniedScopePredicate(scope, input.objectiveId);
    return inImmediateTransaction(this.#database, () => {
      const existing = this.#denialBase(input.denialId);
      if (existing !== null) {
        assertSameDenialInput(existing, input, scope, identity.digest);
        return this.#denialReadModel(existing);
      }
      const createdAt = this.#timestamp();
      const versions = advanceVersions(
        this.#database,
        new Set(["authorization"]),
      );
      const body: DenialConstraint = {
        denialId: input.denialId,
        deniedEffectFingerprint: identity.fingerprint,
        deniedEffectFingerprintDigest: identity.digest,
        deniedScope: scope,
        deniedScopePredicate: predicate,
        objectiveId: input.objectiveId,
        approverId: input.approverId,
        evidencePacketId: input.evidencePacketId,
        createdAt,
        createdAuthorizationStateVersion:
          versions.authorizationStateVersion,
        missionId: input.missionId,
        reason: input.reason,
        status: "active",
      };
      this.#database
        .prepare(
          `INSERT INTO denials (denial_id, created_at, body_json)
           VALUES (?, ?, ?)`,
        )
        .run(input.denialId, createdAt, canonicalJson(body));
      return body;
    });
  }

  public getDenials(): readonly DenialConstraint[] {
    const rows = this.#database
      .prepare("SELECT body_json FROM denials ORDER BY denial_id")
      .all() as Record<string, unknown>[];
    return deepFreeze(
      rows.map((row) =>
        this.#denialReadModel(
          parseCanonicalJson<DenialConstraint>(row["body_json"], "denial"),
        ),
      ),
    );
  }

  public createDenialException(
    input: CreateDenialExceptionInput,
  ): DenialExceptionReadModel {
    validateCreateDenialExceptionInput(input);
    return inImmediateTransaction(this.#database, () => {
      const existing = this.#denialExceptionBase(input.denialExceptionId);
      if (existing !== null) {
        assertSameDenialExceptionInput(existing, input);
        return this.#denialExceptionReadModel(existing);
      }
      const transactionTime = this.#timestamp();
      const parent = this.#denialBase(input.parentDenialId);
      if (parent === null || this.#denialReadModel(parent).status !== "active") {
        throw new StatefulInputError("parentDenialId", "must reference an active denial");
      }
      const allowance = this.#allowanceBase(input.grantAllowanceKey);
      if (allowance === null) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "must reference an existing grant allowance",
        );
      }
      const allowanceStatus = this.#allowanceStatus(
        allowance,
        this.#allowanceClaimCount(input.grantAllowanceKey),
        transactionTime,
      );
      if (allowanceStatus !== "live") {
        throw new StatefulInputError(
          "grantAllowanceKey",
          `must reference a live grant allowance; current status is ${allowanceStatus}`,
        );
      }
      if (allowance.decisionId !== input.ownerDecisionId) {
        throw new StatefulInputError(
          "ownerDecisionId",
          "must be the decision that created the exception allowance",
        );
      }
      const ownerDecision = this.#ownerDecisionBody(input.ownerDecisionId);
      const postDenial = ownerDecision?.["postDenialAuthorization"];
      if (
        ownerDecision?.["kind"] !== "APPROVE_GRANT" ||
        !isJsonObject(postDenial) ||
        postDenial["parentDenialId"] !== input.parentDenialId ||
        postDenial["changeClass"] !== "narrower_scope" ||
        allowance.postDenialAuthorization?.parentDenialId !==
          input.parentDenialId ||
        allowance.postDenialAuthorization.changeClass !== "narrower_scope" ||
        versionOrdinal(allowance.createdAuthorizationStateVersion) <=
          versionOrdinal(parent.createdAuthorizationStateVersion)
      ) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "must be durably authorized by an explicit post-denial owner re-request",
        );
      }
      const downstreamGrant = this.#database
        .prepare(
          `SELECT body_json FROM grants
            WHERE grant_allowance_key = ? ORDER BY grant_id`,
        )
        .all(input.grantAllowanceKey)
        .map((row) =>
          parseCanonicalJson<GrantBase>(
            (row as Record<string, unknown>)["body_json"],
            "grant",
          ),
        )
        .some(
          (grant) =>
            grant.decisionId === input.ownerDecisionId &&
            grant.postDenialAuthorization?.parentDenialId ===
              input.parentDenialId &&
            versionOrdinal(grant.authorizationStateVersion) >
              versionOrdinal(parent.createdAuthorizationStateVersion),
        );
      if (!downstreamGrant) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "must have a grant durably issued after the parent denial",
        );
      }
      if (
        !approvalScopeStrictlyContained(
          allowance.canonicalApprovedScope,
          parent.deniedScope,
        )
      ) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "approved scope must be a strict subset of the parent denial scope",
        );
      }
      const createdAt = transactionTime;
      const body: DenialExceptionReadModel = {
        denialExceptionId: input.denialExceptionId,
        parentDenialId: input.parentDenialId,
        ownerDecisionId: input.ownerDecisionId,
        grantAllowanceKey: input.grantAllowanceKey,
        approvedCanonicalEffectClasses: ["microfactory.schedule_reservation"],
        approvedEffectSchemaVersions:
          allowance.canonicalApprovedScope.allowedEffectSchemaVersions,
        approvedScope: allowance.canonicalApprovedScope,
        createdAt,
        status: "active",
      };
      this.#database
        .prepare(
          `INSERT INTO denial_exceptions
             (denial_exception_id, parent_denial_id, grant_allowance_key,
              created_at, body_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.denialExceptionId,
          input.parentDenialId,
          input.grantAllowanceKey,
          createdAt,
          canonicalJson(body),
        );
      advanceVersions(this.#database, new Set(["authorization"]));
      return body;
    });
  }

  public getDenialExceptions(): readonly DenialExceptionReadModel[] {
    const rows = this.#database
      .prepare("SELECT body_json FROM denial_exceptions ORDER BY denial_exception_id")
      .all() as Record<string, unknown>[];
    return deepFreeze(
      rows.map((row) =>
        this.#denialExceptionReadModel(
          parseCanonicalJson<DenialExceptionReadModel>(
            row["body_json"],
            "denial exception",
          ),
        ),
      ),
    );
  }

  public revokeDenialException(
    denialExceptionId: string,
    reason: string,
  ): VersionTuple {
    assertNonEmptyString(denialExceptionId, "denialExceptionId");
    assertNonEmptyString(reason, "reason");
    return this.#recordAuthorizationTermination(
      "denial_exception",
      denialExceptionId,
      "revoked",
      { reason },
      () => this.#denialExceptionBase(denialExceptionId) !== null,
    );
  }

  public expireDenialException(
    denialExceptionId: string,
    evidenceReference: string,
  ): VersionTuple {
    assertNonEmptyString(denialExceptionId, "denialExceptionId");
    assertNonEmptyString(evidenceReference, "evidenceReference");
    return this.#recordAuthorizationTermination(
      "denial_exception",
      denialExceptionId,
      "expired",
      { evidenceReference },
      () => this.#denialExceptionBase(denialExceptionId) !== null,
    );
  }

  public evaluateAuthorization(
    occurrenceValue: AuthorizationOccurrence,
  ): AuthorizationEvaluation {
    const occurrence = validateAuthorizationOccurrence(occurrenceValue);
    const grant = this.#grantBase(occurrence.grantId);
    if (grant === null) {
      return denyAuthorization("grant_not_found", null, "No matching grant exists");
    }
    if (this.#hasAuthorizationEvent("grant", grant.grantId, ["revoked", "expired"])) {
      return denyAuthorization("grant_not_live", null, "The grant is revoked or expired");
    }
    const allowance = this.getGrantAllowance(grant.grantAllowanceKey);
    if (allowance.status !== "live") {
      return denyAuthorization(
        allowance.status === "exhausted" ? "allowance_exhausted" : "allowance_not_live",
        null,
        `The logical allowance is ${allowance.status}`,
      );
    }
    const prospectiveOrdinal = allowance.claimedExecutionSlots.length + 1;
    if (!approvalScopeCovers(grant.scope, occurrence, prospectiveOrdinal)) {
      return denyAuthorization(
        "scope_does_not_cover",
        null,
        "The exact effect occurrence is outside the live grant scope",
      );
    }
    const effect = validateEffectFingerprint(occurrence.effect);
    for (const denial of this.getDenials()) {
      if (
        denial.status === "active" &&
        denialPredicateMatches(
          denial.deniedScopePredicate,
          effect,
          occurrence.objectiveId,
          occurrence.resourceClaims,
        ) &&
        !this.#qualifyingException(
          denial.denialId,
          grant.grantAllowanceKey,
          occurrence,
          prospectiveOrdinal,
        )
      ) {
        return denyAuthorization(
          "active_denial",
          denial.denialId,
          `Active denial ${denial.denialId} matches the canonical effect and no qualifying exception covers it`,
        );
      }
    }
    return deepFreeze({
      decision: "ALLOW",
      grantId: grant.grantId,
      grantAllowanceKey: grant.grantAllowanceKey,
      prospectiveOrdinal,
      canonicalEffect: normalizeEffect(effect),
      explanation: "live_grant_covers_effect_and_no_denial_blocks",
    });
  }

  public claimExecution(input: ClaimExecutionInput): ExecutionClaimResult {
    validateClaimExecutionInput(input);
    const canonicalInput = canonicalJson(input);
    return inImmediateTransaction(this.#database, () => {
      const prior = this.#executionAttempt(input.executionAttemptId);
      if (prior !== null) {
        if (canonicalJson(prior.input) !== canonicalInput) {
          throw new ExecutionAttemptConflictError(input.executionAttemptId);
        }
        return deepFreeze({ ...prior.result, replayed: true });
      }

      const transactionTime = this.#timestamp();
      const versions = readVersions(this.#database);
      const mismatches = compareExecutionVersions(input, versions);
      const currentDigest = this.#currentCalibrationDigest();
      if (input.expectedCalibrationFrontierDigest !== currentDigest) {
        mismatches.push("calibration_frontier_digest");
      }
      if (mismatches.length > 0) {
        throw new StatefulInputError(
          "expectedAdmissionBasis",
          `stale execution basis: ${mismatches.join(", ")}`,
        );
      }
      const admission = this.getAdmissionRecord(input.admissionRecordId);
      this.#validatePlanIdentity(admission.record, input.selectedPlanId);
      const claimedGrant = this.#grantBase(input.grantId);
      if (
        claimedGrant === null ||
        claimedGrant.grantVersion !== input.expectedGrantVersion
      ) {
        throw new StatefulInputError(
          "expectedGrantVersion",
          "does not match the current immutable grant record",
        );
      }
      const allowance = this.#allowanceBase(input.grantAllowanceKey);
      if (allowance === null) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "must identify the grant's immutable logical allowance",
        );
      }
      this.#validateClaimBasis(
        input,
        admission,
        claimedGrant,
        allowance,
        versions,
      );
      const occurrence: AuthorizationOccurrence = {
        effect: input.effect,
        objectiveId: admission.record.proposalSnapshot.objective,
        promiseBasisId: admission.record.promiseBasisId,
        resourceClaims: input.resourceCapacityClaims,
        attemptedAt: transactionTime,
        grantId: input.grantId,
      };
      const authorization = this.evaluateAuthorization(occurrence);
      if (authorization.decision === "DENY") {
        throw new AuthorizationDeniedError(authorization);
      }
      if (authorization.grantAllowanceKey !== input.grantAllowanceKey) {
        throw new StatefulInputError(
          "grantAllowanceKey",
          "does not match the grant's logical allowance",
        );
      }
      if (
        allowance.selectedBundleId !== input.selectedBundleId
      ) {
        throw new StatefulInputError(
          "selectedBundleId",
          "does not match the grant allowance's selected bundle",
        );
      }
      this.#validateClaimResources(input);
      const createdAt = transactionTime;
      const canonicalEffect = normalizeEffect(input.effect);
      const fingerprint = effectFingerprintIdentity(input.effect);
      const reservationId = stableTupleId("reservation", [
        input.executionAttemptId,
      ]);
      const reservation: InFlightExecutionReservation = {
        reservationId,
        executionAttemptId: input.executionAttemptId,
        grantAllowanceKey: input.grantAllowanceKey,
        grantId: input.grantId,
        admissionRecordId: input.admissionRecordId,
        promiseBasisId: input.promiseBasisId,
        acceptedOwnerDecisionId: input.acceptedOwnerDecisionId,
        grantOwnerDecisionId: input.grantOwnerDecisionId,
        canonicalNormalizedEffect: canonicalEffect,
        rawEffectFingerprint: fingerprint.fingerprint,
        affectedObligationIds: sortedUniqueStrings(input.affectedObligationIds),
        affectedResourceIds: sortedUniqueStrings(input.affectedResourceIds),
        resourceCapacityClaims: canonicalClone(input.resourceCapacityClaims),
        temporalClaim: canonicalClone(input.temporalClaim),
        claimAccounting: input.claimAccounting,
        selectedBundleId: input.selectedBundleId,
        selectedPlanId: input.selectedPlanId,
        expectedEffect: canonicalClone(input.expectedEffect),
        expectedAfterState: canonicalClone(input.expectedAfterState),
        createdAt,
        claimState: "claimed_nonterminal",
      };
      const preExecutionAdmissionRecordId =
        this.#assertReservationCompatibleWithM1(reservation);

      const nextVersions = advanceVersions(
        this.#database,
        new Set(["authorization"]),
      );
      const result: ExecutionClaimResult = {
        status: "CLAIMED",
        replayed: false,
        executionAttemptId: input.executionAttemptId,
        grantAllowanceKey: input.grantAllowanceKey,
        grantExecutionOrdinal: authorization.prospectiveOrdinal,
        preExecutionAdmissionRecordId,
        reservation,
        versions: nextVersions,
      };
      this.#database
        .prepare(
          `INSERT INTO execution_attempts
             (execution_attempt_id, admission_record_id, created_at,
              input_json, result_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.executionAttemptId,
          input.admissionRecordId,
          createdAt,
          canonicalInput,
          canonicalJson(result),
        );
      this.#database
        .prepare(
          `INSERT INTO allowance_claims
             (grant_allowance_key, ordinal, execution_attempt_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.grantAllowanceKey,
          authorization.prospectiveOrdinal,
          input.executionAttemptId,
          createdAt,
        );
      this.#database
        .prepare(
          `INSERT INTO inflight_reservations
             (reservation_id, execution_attempt_id, created_at, body_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          reservationId,
          input.executionAttemptId,
          createdAt,
          canonicalJson(reservation),
        );
      this.#appendAdmissionAddendum(
        input.admissionRecordId,
        "execution_attempt",
        {
          executionAttemptId: input.executionAttemptId,
          grantAllowanceKey: input.grantAllowanceKey,
          grantExecutionOrdinal: authorization.prospectiveOrdinal,
          reservationId,
        },
      );
      return deepFreeze(result);
    });
  }

  public getExecutionAttempt(
    executionAttemptId: string,
  ): ExecutionAttemptReadModel {
    assertNonEmptyString(executionAttemptId, "executionAttemptId");
    const attempt = this.#executionAttempt(executionAttemptId);
    if (attempt === null) throw new Error(`Execution attempt ${executionAttemptId} not found`);
    return deepFreeze(attempt);
  }

  public getReservations(
    includeTerminal = true,
  ): readonly InFlightExecutionReservation[] {
    return deepFreeze(this.#readReservations(includeTerminal));
  }

  public createExecutionFence(
    inputValue: CreateExecutionFenceInput,
    authoritativeFactoryState?: FactoryScheduleState,
  ): ExecutionFenceReadModel {
    const input = canonicalClone<CreateExecutionFenceInput>(inputValue);
    validateCreateExecutionFenceInput(input);
    const factoryPath =
      authoritativeFactoryState === undefined
        ? this.#requireAuthoritativeFactoryDatabasePath()
        : null;
    return inImmediateTransaction(this.#database, () => {
      const attempt = this.#executionAttempt(input.executionAttemptId);
      if (attempt === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "must reference an authoritative M2 claimed attempt",
        );
      }
      const existing = this.#executionFenceByAttempt(input.executionAttemptId);
      if (existing !== null) {
        assertFenceCreationMatches(existing, input);
        return deepFreeze(existing);
      }
      const reservation = this.#reservationReadModel(
        this.#reservationByAttempt(input.executionAttemptId),
      );
      if (reservation.claimState !== "claimed_nonterminal") {
        throw new StatefulInputError(
          "executionAttemptId",
          "must retain an exact nonterminal M2 reservation",
        );
      }
      const allowance = this.getGrantAllowance(reservation.grantAllowanceKey);
      if (
        !allowance.claimedExecutionSlots.includes(
          attempt.result.grantExecutionOrdinal,
        )
      ) {
        throw new StatefulInputError(
          "grantExecutionOrdinal",
          "must remain the claimed durable shared-allowance slot",
        );
      }
      const canonicalEffect = normalizeEffect(attempt.input.effect);
      const authorityState =
        authoritativeFactoryState ??
        readAuthoritativeFactoryState(factoryPath as string).state;
      if (
        canonicalEffect.environmentId !== input.environmentId ||
        authorityState.environmentId !== input.environmentId ||
        digestCanonical(attempt.result.reservation.expectedEffect) !==
          input.expectedCommandDigest
      ) {
        throw new StatefulInputError(
          "executionFence",
          "does not match the authoritative command or synthetic environment",
        );
      }
      const fenceId = stableTupleId("execution-fence", [
        input.executionAttemptId,
        reservation.reservationId,
        reservation.grantAllowanceKey,
        attempt.result.grantExecutionOrdinal,
        input.expectedCommandDigest,
        input.executorAuthority,
        input.environmentId,
      ]);
      const createdAt = this.#timestamp();
      const versions = advanceVersions(
        this.#database,
        new Set(["authorization"]),
      );
      const base: ExecutionFenceBase = {
        schemaVersion: "flakebrake-execution-fence/v1",
        fenceId,
        executionAttemptId: attempt.executionAttemptId,
        reservationId: reservation.reservationId,
        grantAllowanceKey: reservation.grantAllowanceKey,
        grantExecutionOrdinal: attempt.result.grantExecutionOrdinal,
        admissionRecordId: attempt.admissionRecordId,
        promiseBasisId: attempt.input.promiseBasisId,
        acceptedOwnerDecisionId: attempt.input.acceptedOwnerDecisionId,
        grantOwnerDecisionId: attempt.input.grantOwnerDecisionId,
        selectedBundleId: attempt.input.selectedBundleId,
        selectedPlanId: attempt.input.selectedPlanId,
        canonicalNormalizedEffect: canonicalEffect,
        expectedCommandDigest: input.expectedCommandDigest,
        executorAuthority: input.executorAuthority,
        environmentId: input.environmentId,
        createdAt,
        createdAuthorizationStateVersion:
          versions.authorizationStateVersion,
      };
      this.#database
        .prepare(
          `INSERT INTO execution_fences
             (fence_id, execution_attempt_id, created_at, body_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          fenceId,
          input.executionAttemptId,
          createdAt,
          canonicalJson(base),
        );
      this.#appendAdmissionAddendum(
        attempt.admissionRecordId,
        "reservation_transition",
        {
          executionAttemptId: attempt.executionAttemptId,
          reservationId: reservation.reservationId,
          fenceId,
          status: "EXECUTION_FENCED",
          authorizationStateVersion: versions.authorizationStateVersion,
        },
      );
      return deepFreeze({
        ...base,
        status: "active",
        resultBinding: null,
      });
    });
  }

  public getExecutionFence(
    executionAttemptId: string,
  ): ExecutionFenceReadModel | null {
    assertNonEmptyString(executionAttemptId, "executionAttemptId");
    return deepFreeze(this.#executionFenceByAttempt(executionAttemptId));
  }

  public runWithExecutionFence<T>(
    fenceId: string,
    operation: (
      fence: ExecutionFenceReadModel,
    ) => ExecutionFenceOperationResult<T>,
  ): T {
    assertNonEmptyString(fenceId, "fenceId");
    return inImmediateTransaction(this.#database, () => {
      const fence = this.#requireExecutionFenceById(fenceId);
      if (fence.status === "released_without_mutation") {
        throw new StatefulInputError(
          "fenceId",
          "execution fence was durably released without mutation",
        );
      }
      const reservation = this.#reservationReadModel(
        this.#reservationByAttempt(fence.executionAttemptId),
      );
      if (
        fence.status === "active" &&
        reservation.claimState !== "claimed_nonterminal"
      ) {
        throw new StatefulInputError(
          "fenceId",
          "active fence lost its fixed nonterminal reservation",
        );
      }
      const completed = operation(fence);
      validateFenceResultBinding(completed.binding, fence);
      if (fence.status === "active") {
        this.#appendExecutionFenceEvent(
          fence,
          "factory_result_bound",
          completed.binding,
        );
        const versions = advanceVersions(
          this.#database,
          new Set(["authorization"]),
        );
        this.#appendAdmissionAddendum(
          fence.admissionRecordId,
          "reservation_transition",
          {
            executionAttemptId: fence.executionAttemptId,
            reservationId: fence.reservationId,
            fenceId: fence.fenceId,
            status: "FACTORY_RESULT_BOUND",
            receiptId: completed.binding.receiptId,
            factoryResultDigest: completed.binding.factoryResultDigest,
            authorizationStateVersion: versions.authorizationStateVersion,
          },
        );
      } else if (
        canonicalSerialize(fence.resultBinding) !==
        canonicalSerialize(completed.binding)
      ) {
        throw new StatefulInputError(
          "fenceId",
          "factory replay does not match the immutable fence result",
        );
      }
      return completed.value;
    });
  }

  public recoverExecutionFence(
    executionAttemptId: string,
  ): ExecutionFenceRecoveryResult {
    assertNonEmptyString(executionAttemptId, "executionAttemptId");
    const factoryPath = this.#requireAuthoritativeFactoryDatabasePath();
    return inImmediateTransaction(this.#database, () => {
      let fence = this.#executionFenceByAttempt(executionAttemptId);
      if (fence === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "has no durable M3 execution fence",
        );
      }
      if (fence.status === "released_without_mutation") {
        return deepFreeze({
          executionAttemptId,
          fenceId: fence.fenceId,
          status: "terminal_failed_before_mutation",
          receiptId: null,
          versions: readVersions(this.#database),
        });
      }
      const evidence = readAuthoritativeFactoryExecution(
        factoryPath,
        executionAttemptId,
      );
      if (evidence !== null) {
        const binding = factoryEvidenceBinding(evidence);
        validateFenceResultBinding(binding, fence);
        if (fence.status === "active") {
          this.#appendExecutionFenceEvent(
            fence,
            "factory_result_bound",
            binding,
          );
          advanceVersions(this.#database, new Set(["authorization"]));
          fence = this.#requireExecutionFenceById(fence.fenceId);
        } else if (
          canonicalSerialize(fence.resultBinding) !== canonicalSerialize(binding)
        ) {
          throw new StatefulInputError(
            "fenceId",
            "recovery found a conflicting durable factory result",
          );
        }
        return deepFreeze({
          executionAttemptId,
          fenceId: fence.fenceId,
          status: "factory_result_bound",
          receiptId: binding.receiptId,
          versions: readVersions(this.#database),
        });
      }
      if (fence.status === "factory_result_bound") {
        throw new StatefulInputError(
          "fenceId",
          "bound fence is missing its authoritative factory result",
        );
      }
      this.#appendExecutionFenceEvent(
        fence,
        "released_without_mutation",
        {
          executionAttemptId,
          reason: "trusted recovery observed no committed factory result",
        },
      );
      advanceVersions(this.#database, new Set(["authorization"]));
      const terminal = this.#recordExecutionTerminalInTransaction(
        {
          terminalEventId: stableTupleId("execution-fence-recovery", [
            fence.fenceId,
          ]),
          executionAttemptId,
          status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
          evidenceReference: `execution-fence-recovery/${fence.fenceId}`,
        },
        fence.fenceId,
      );
      return deepFreeze({
        executionAttemptId,
        fenceId: fence.fenceId,
        status: "terminal_failed_before_mutation",
        receiptId: null,
        versions: terminal.versions,
      });
    });
  }

  public recordExecutionTerminal(
    input: ExecutionTerminalInput,
  ): ExecutionTerminalResult {
    validateExecutionTerminalInput(input);
    return inImmediateTransaction(this.#database, () =>
      this.#recordExecutionTerminalInTransaction(input, null),
    );
  }

  public verifyExecutionAuthoritatively(
    executionAttemptId: string,
  ): AuthoritativeExecutionVerificationResult {
    assertNonEmptyString(executionAttemptId, "executionAttemptId");
    const factoryPath = this.#requireAuthoritativeFactoryDatabasePath();
    return inImmediateTransaction(this.#database, () => {
      if (this.#executionAttempt(executionAttemptId) === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "must reference an authoritative M2 claimed attempt",
        );
      }
      const fence = this.#executionFenceByAttempt(executionAttemptId);
      if (fence === null || fence.status !== "factory_result_bound") {
        throw new StatefulInputError(
          "executionAttemptId",
          "must have an exact factory-result-bound execution fence",
        );
      }
      const evidence = readAuthoritativeFactoryExecution(
        factoryPath,
        executionAttemptId,
      );
      if (evidence === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "has no authoritative committed factory result",
        );
      }
      return this.verifyExecutionWithEvidence(executionAttemptId, evidence);
    });
  }

  public verifyExecutionWithEvidence(
    executionAttemptId: string,
    evidence: AuthoritativeFactoryExecutionEvidence,
  ): AuthoritativeExecutionVerificationResult {
    assertNonEmptyString(executionAttemptId, "executionAttemptId");
    return inImmediateTransaction(this.#database, () => {
      const attempt = this.#executionAttempt(executionAttemptId);
      if (attempt === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "must reference an authoritative M2 claimed attempt",
        );
      }
      const fence = this.#executionFenceByAttempt(executionAttemptId);
      if (fence === null || fence.status !== "factory_result_bound") {
        throw new StatefulInputError(
          "executionAttemptId",
          "must have an exact factory-result-bound execution fence",
        );
      }
      const binding = factoryEvidenceBinding(evidence);
      validateFenceResultBinding(binding, fence);
      if (
        canonicalSerialize(binding) !== canonicalSerialize(fence.resultBinding) ||
        evidence.environmentId !== fence.environmentId ||
        evidence.result.fenceId !== fence.fenceId ||
        evidence.request.executionAttemptId !== executionAttemptId ||
        digestCanonical(evidence.result.canonicalCommand) !==
          fence.expectedCommandDigest ||
        canonicalSerialize(evidence.result.canonicalCommand) !==
          canonicalSerialize(attempt.result.reservation.expectedEffect) ||
        canonicalSerialize(evidence.result.resultingState) !==
          canonicalSerialize(attempt.result.reservation.expectedAfterState)
      ) {
        throw new StatefulInputError(
          "authoritativeFactoryEvidence",
          "does not match the immutable M2 fence, command, or expected state",
        );
      }
      const expectedClaim = claimedExecutionReference(attempt);
      if (
        canonicalSerialize(evidence.request.claim) !==
        canonicalSerialize(expectedClaim)
      ) {
        throw new StatefulInputError(
          "authoritativeFactoryEvidence.claim",
          "does not reproduce the immutable M2 attempt basis",
        );
      }
      const actualConsumption = this.#deriveAuthoritativeActualConsumption(
        attempt,
        attempt.result.reservation,
      );
      const terminal = this.#recordExecutionTerminalInTransaction(
        {
          terminalEventId: stableTupleId("authoritative-verification", [
            executionAttemptId,
            fence.fenceId,
            binding.receiptId,
          ]),
          executionAttemptId,
          status: "VERIFIED_SUCCESS",
          receiptReference: binding.receiptId,
          observedAfterState: asJsonValue(evidence.result.resultingState),
          actualConsumption,
        },
        fence.fenceId,
      );
      return deepFreeze({
        ...terminal,
        fenceId: fence.fenceId,
        receiptId: binding.receiptId,
        actualConsumption,
      });
    });
  }

  #recordExecutionTerminalInTransaction(
    input: ExecutionTerminalInput,
    trustedFenceId: string | null,
  ): ExecutionTerminalResult {
      validateExecutionTerminalInput(input);
      const attempt = this.#executionAttempt(input.executionAttemptId);
      if (attempt === null) {
        throw new StatefulInputError(
          "executionAttemptId",
          "must reference a claimed execution attempt",
        );
      }
      const fence = this.#executionFenceByAttempt(input.executionAttemptId);
      if (fence !== null && input.status !== "UNCERTAIN_OUTCOME") {
        if (trustedFenceId !== fence.fenceId) {
          throw new StatefulInputError(
            "executionAttemptId",
            input.status === "VERIFIED_SUCCESS" || input.status === "RECONCILED"
              ? "fenced M3 execution requires authoritative factory verification"
              : "fenced M3 execution requires serialized trusted recovery",
          );
        }
        if (
          (input.status === "VERIFIED_SUCCESS" || input.status === "RECONCILED") &&
          fence.status !== "factory_result_bound"
        ) {
          throw new StatefulInputError(
            "executionAttemptId",
            "verified fenced execution requires a bound factory result",
          );
        }
        if (
          input.status === "DEFINITIVE_FAILURE_BEFORE_MUTATION" &&
          fence.status !== "released_without_mutation"
        ) {
          throw new StatefulInputError(
            "executionAttemptId",
            "failure-before-mutation requires a released no-result fence",
          );
        }
      }
      const existingEvent = this.#database
        .prepare(
          `SELECT reservation_id, body_json FROM reservation_events
            WHERE reservation_event_id = ?`,
        )
        .get(input.terminalEventId) as Record<string, unknown> | undefined;
      const reservation = this.#reservationByAttempt(input.executionAttemptId);
      if (existingEvent !== undefined) {
        const stored = parseCanonicalJson<ExecutionTerminalInput>(
          existingEvent["body_json"],
          "reservation terminal event",
        );
        if (canonicalSerialize(stored) !== canonicalSerialize(input)) {
          throw new StatefulInputError(
            "terminalEventId",
            "was reused with different terminal data",
          );
        }
        return deepFreeze({
          executionAttemptId: input.executionAttemptId,
          claimState: this.#reservationReadModel(reservation).claimState,
          replayed: true,
          versions: readVersions(this.#database),
        });
      }
      const current = this.#reservationReadModel(reservation);
      if (current.claimState !== "claimed_nonterminal") {
        throw new StatefulInputError(
          "executionAttemptId",
          `reservation is already ${current.claimState}`,
        );
      }
      if (
        input.status === "VERIFIED_SUCCESS" &&
        canonicalSerialize(input.observedAfterState) !==
          canonicalSerialize(current.expectedAfterState)
      ) {
        throw new StatefulInputError(
          "observedAfterState",
          "must canonically match the immutable expected after-state",
        );
      }
      if (
        input.status === "VERIFIED_SUCCESS" ||
        input.status === "RECONCILED"
      ) {
        this.#preflightTerminalActualConsumption(attempt, current, input);
      }

      const createdAt = this.#timestamp();
      const eventKind = terminalEventKind(input);
      let nextState: InFlightExecutionReservation["claimState"];
      switch (input.status) {
        case "VERIFIED_SUCCESS":
          nextState = "terminal_verified";
          this.#recordRealizedEffect(attempt, current, input, createdAt);
          break;
        case "DEFINITIVE_FAILURE_BEFORE_MUTATION":
          nextState = "terminal_failed_before_mutation";
          break;
        case "UNCERTAIN_OUTCOME":
          nextState = "claimed_nonterminal";
          break;
        case "RECONCILED":
          nextState = "terminal_reconciled";
          this.#recordRealizedEffect(attempt, current, input, createdAt);
          break;
        default:
          assertNever(input);
      }
      this.#database
        .prepare(
          `INSERT INTO reservation_events
             (reservation_event_id, reservation_id, created_at, event_kind, body_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.terminalEventId,
          reservation.reservationId,
          createdAt,
          eventKind,
          canonicalJson(input),
        );
      this.#appendAdmissionAddendum(
        attempt.admissionRecordId,
        "reservation_transition",
        {
          executionAttemptId: input.executionAttemptId,
          reservationId: reservation.reservationId,
          terminalEventId: input.terminalEventId,
          status: input.status,
          claimState: nextState,
        },
      );
      const versions =
        input.status === "UNCERTAIN_OUTCOME"
          ? readVersions(this.#database)
          : advanceVersions(this.#database, new Set(["authorization"]));
      return deepFreeze({
        executionAttemptId: input.executionAttemptId,
        claimState: nextState,
        replayed: false,
        versions,
      });
  }

  public recordActualConsumption(input: RecordActualConsumptionInput): void {
    validateActualConsumptionInput(input);
    inImmediateTransaction(this.#database, () => {
      this.getAdmissionRecord(input.admissionRecordId);
      this.#requireResource(input.resourceKey);
      this.#validateActualWorkClass(
        input.admissionRecordId,
        input.resourceKey,
        input.workClassKey,
      );
      const existingForPair = this.#readAdmissionAddenda(input.admissionRecordId).find(
        (addendum) =>
          addendum.kind === "actual_consumption" &&
          isJsonObject(addendum.body) &&
          addendum.body["resourceKey"] === input.resourceKey &&
          addendum.body["workClassKey"] === input.workClassKey,
      );
      if (existingForPair !== undefined) {
        if (
          existingForPair.addendumId === input.actualConsumptionFactId &&
          canonicalSerialize(existingForPair.body) ===
            canonicalSerialize(actualConsumptionBody(input))
        ) {
          return;
        }
        throw new StatefulInputError(
          "actualConsumption",
          "an initial actual already exists for this admission/resource/work class; append a correction",
        );
      }
      this.#appendAdmissionAddendumWithId(
        input.actualConsumptionFactId,
        input.admissionRecordId,
        "actual_consumption",
        actualConsumptionBody(input),
        input.observedAt,
      );
    });
  }

  public recordOutcome(input: RecordOutcomeInput): void {
    validateOutcomeInput(input);
    inImmediateTransaction(this.#database, () => {
      this.getAdmissionRecord(input.admissionRecordId);
      this.#appendAdmissionAddendumWithId(
        input.outcomeFactId,
        input.admissionRecordId,
        "outcome",
        {
          outcome: input.outcome,
          completedAt: input.completedAt,
          sourceReceipt: input.sourceReceipt,
        },
        input.completedAt,
      );
    });
  }

  public recordCalibrationCorrection(
    input: RecordCalibrationCorrectionInput,
  ): void {
    validateCorrectionInput(input);
    inImmediateTransaction(this.#database, () => {
      const addenda = this.#readAdmissionAddenda(input.admissionRecordId);
      const corrected = addenda.find(
        (addendum) =>
          addendum.addendumId === input.correctsActualConsumptionFactId &&
          addendum.kind === "actual_consumption",
      );
      if (corrected === undefined) {
        throw new StatefulInputError(
          "correctsActualConsumptionFactId",
          "must reference an actual-consumption fact on the same AdmissionRecord",
        );
      }
      this.#appendAdmissionAddendumWithId(
        input.correctionFactId,
        input.admissionRecordId,
        "calibration_correction",
        {
          correctsActualConsumptionFactId:
            input.correctsActualConsumptionFactId,
          correctedActualConsumption: input.correctedActualConsumption,
          reason: input.reason,
          sourceReceipt: input.sourceReceipt,
        },
        this.#timestamp(),
      );
    });
  }

  #insertInitialState(initialStateValue: StatefulInitialState): void {
    const initialState = canonicalInitialState(initialStateValue);
    this.#database
      .prepare(
        `INSERT INTO state_versions
           (singleton, portfolio_version, capacity_model_version,
            capacity_plan_version, authorization_state_version)
         VALUES (1, 1, 1, 1, 1)`,
      )
      .run();
    this.#database
      .prepare(
        `INSERT INTO state_config
           (singleton, assumptions_json, combined_decision_proofs_json)
         VALUES (1, ?, ?)`,
      )
      .run(
        canonicalJson(initialState.assumptions),
        canonicalJson(initialState.combinedDecisionProofs),
      );
    for (const obligation of initialState.acceptedObligations) {
      this.#database
        .prepare(
          `INSERT INTO portfolio_obligations (obligation_id, body_json)
           VALUES (?, ?)`,
        )
        .run(obligation.obligationId, canonicalJson(obligation));
    }
    for (const resource of initialState.resources) {
      this.#database
        .prepare(
          `INSERT INTO capacity_resources
             (resource_key, model_json, plan_json) VALUES (?, ?, ?)`,
        )
        .run(
          resource.resourceKey,
          canonicalJson(capacityModelPart(resource)),
          canonicalJson(capacityPlanPart(resource)),
        );
    }
  }

  #buildAdmissionInput(
    requestValue: AdmissionRequest,
    expectedFrontierDigest: string | null,
    readmissionOfAcceptedProposal = false,
  ): AdmissionEvaluationInput {
    const request = validateAdmissionRequest(requestValue);
    const config = requireRow(
      this.#database
        .prepare(
          `SELECT assumptions_json, combined_decision_proofs_json
             FROM state_config WHERE singleton = 1`,
        )
        .get() as Record<string, unknown> | undefined,
      "state_config",
    );
    const assumptions =
      request.assumptions ??
      parseCanonicalJson<readonly ProvenanceEntry[]>(
        config["assumptions_json"],
        "state assumptions",
      );
    const combinedDecisionProofs =
      request.combinedDecisionProofs ??
      parseCanonicalJson<readonly CombinedDecisionProof[]>(
        config["combined_decision_proofs_json"],
        "state decision proofs",
      );
    const acceptedObligations = this.#readAcceptedObligations();
    return {
      versions: readVersions(this.#database),
      calibration: {
        ruleId: "conservative-max/v1",
        historyRecords: this.#readCalibrationHistory(),
        expectedFrontierDigest,
      },
      resources: this.#readResources(),
      acceptedObligations: readmissionOfAcceptedProposal
        ? acceptedObligations.filter(
            (obligation) =>
              obligation.obligationId !== request.proposal.obligationId,
          )
        : acceptedObligations,
      proposal: request.proposal,
      fixedCapacityReservations: this.#readM1CapacityReservations(),
      combinedDecisionProofs,
      authorizationFacts: this.#authorizationFacts(),
      assumptions,
    };
  }

  #insertAdmissionRecord(result: AdmissionResult): AdmissionRecordBody {
    const admissionRecordId = `admission/${randomUUID()}`;
    const promiseBasisId = stableTupleId("promise-basis", [
      asJsonValue(result.promiseBasis),
    ]);
    const createdAt = this.#timestamp();
    const selectedPlan = storedSelectedPlan(result);
    const capacity = selectedCapacity(result, selectedPlan);
    const expected = result.expectedBasis;
    const record: AdmissionRecordBody = deepFreeze({
      schemaVersion: "flakebrake-admission-record/v0.1-m2",
      admissionRecordId,
      promiseBasisId,
      createdAt,
      decision: result.decision,
      portfolioVersion: result.basis.portfolioVersion,
      expectedPortfolioVersion:
        expected === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : expected.expectedPortfolioVersion,
      capacityModelVersion: result.basis.capacityModelVersion,
      expectedCapacityModelVersion:
        expected === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : expected.expectedCapacityModelVersion,
      capacityPlanVersion: result.basis.capacityPlanVersion,
      expectedCapacityPlanVersion:
        expected === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : expected.expectedCapacityPlanVersion,
      authorizationStateVersion: result.basis.authorizationStateVersion,
      expectedAuthorizationStateVersion:
        expected === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : expected.expectedAuthorizationStateVersion,
      calibrationFrontierDigest: result.basis.calibrationFrontierDigest,
      expectedCalibrationFrontierDigest:
        expected === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : expected.expectedCalibrationFrontierDigest,
      calibrationFrontierProvenance:
        result.basis.calibrationFrontierProvenance,
      fixedInFlightExecutionReservations:
        result.basis.fixedCapacityReservations,
      proposalSnapshot: result.promiseBasis.proposal,
      candidatePlans: result.promiseBasis.candidatePlans,
      selectedPlan,
      capacityBefore: capacity.capacityBefore,
      predictedConsumption: capacity.predictedConsumption,
      capacityAfter: capacity.capacityAfter,
      protectedObligationSlack: capacity.protectedObligationSlack,
      bindingResourceFacts: capacity.bindingOrLimitingResources,
      ownerChoice: "PENDING_OWNER_CHOICE",
      actualConsumption: "NOT_YET_KNOWN",
      outcome: "NOT_YET_KNOWN",
      additiveCorrections: "NOT_YET_KNOWN",
      m1Result: result,
    });
    this.#database
      .prepare(
        `INSERT INTO admission_records
           (admission_record_id, created_at, decision,
            proposal_obligation_id, body_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        admissionRecordId,
        createdAt,
        result.decision,
        result.promiseBasis.proposal.obligationId,
        canonicalJson(record),
      );
    return record;
  }

  #readAcceptedObligations(): readonly AcceptedObligation[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json FROM portfolio_obligations ORDER BY obligation_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) =>
      parseCanonicalJson<AcceptedObligation>(row["body_json"], "obligation"),
    );
  }

  #readResources(): readonly CapacityResource[] {
    const rows = this.#database
      .prepare(
        `SELECT model_json, plan_json FROM capacity_resources ORDER BY resource_key`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      ...parseCanonicalJson<CapacityModelPart>(row["model_json"], "capacity model"),
      ...parseCanonicalJson<CapacityPlanPart>(row["plan_json"], "capacity plan"),
    }));
  }

  #preflightCapacityModel(resources: readonly CapacityResource[]): void {
    const schedulable = resources.find((resource) => resource.timeUnit !== null);
    if (schedulable === undefined || schedulable.timeUnit === null) {
      throw new StatefulInputError(
        "resources",
        "M1 requires a declared schedulable resource",
      );
    }
    const zeroDemand = Object.fromEntries(
      resources.map((resource) => [resource.resourceKey, 0]),
    );
    const workClasses = Object.fromEntries(
      resources.map((resource) => [resource.resourceKey, "m2-model-preflight"]),
    );
    const probe: ProposedObligation = {
      obligationId: "m2-capacity-model-preflight",
      beneficiary: "m2-capacity-model-preflight",
      objective: "Validate the complete replacement model through M1",
      serviceLevel: { units: 0 },
      protected: false,
      criticality: "best_effort",
      minimumService: { units: 0 },
      modificationPolicy: { modifiableFields: {} },
      modificationOptions: [],
      resourceDemand: zeroDemand,
      workClassByResource: workClasses,
      schedulingConstraint: {
        kind: "horizon",
        start: schedulable.horizonStart,
        end: schedulable.horizonEnd,
        resourceKey: schedulable.resourceKey,
        timeUnit: schedulable.timeUnit,
      },
      pendingOwnerDecisions: [],
      assumptions: [],
      evidenceRefs: [],
      requiredEffects: [],
      status: "proposed",
      acceptanceDecision: {
        objectiveId: "m2-capacity-model-preflight",
        evidencePacketId: "m2-capacity-model-preflight",
        approverId: "m2-store",
        executionBoundaryId: "m2-capacity-model-preflight",
      },
    };
    evaluateAdmission({
      versions: readVersions(this.#database),
      calibration: {
        ruleId: "conservative-max/v1",
        historyRecords: this.#readCalibrationHistory(),
        expectedFrontierDigest: null,
      },
      resources,
      acceptedObligations: this.#readAcceptedObligations(),
      proposal: probe,
      fixedCapacityReservations: this.#readM1CapacityReservations(resources),
      combinedDecisionProofs: [],
      authorizationFacts: this.#authorizationFacts(),
      assumptions: [],
    });
  }

  #replacePortfolio(obligations: readonly AcceptedObligation[]): void {
    const ids = obligations.map((obligation) => obligation.obligationId);
    assertUniqueStrings(ids, "portfolio obligation IDs");
    const currentIds = this.#database
      .prepare("SELECT obligation_id FROM portfolio_obligations")
      .all() as Record<string, unknown>[];
    const retained = new Set(ids);
    for (const row of currentIds) {
      const id = requireString(row["obligation_id"], "obligation_id");
      if (!retained.has(id)) {
        this.#database
          .prepare("DELETE FROM portfolio_obligations WHERE obligation_id = ?")
          .run(id);
      }
    }
    for (const obligation of obligations) {
      this.#database
        .prepare(
          `INSERT INTO portfolio_obligations (obligation_id, body_json)
           VALUES (?, ?)
           ON CONFLICT(obligation_id) DO UPDATE SET body_json = excluded.body_json`,
        )
        .run(obligation.obligationId, canonicalJson(obligation));
    }
  }

  #readAdmissionAddenda(admissionRecordId: string): readonly AdmissionAddendum[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, addendum_id, admission_record_id, created_at,
                kind, body_json
           FROM admission_addenda
          WHERE admission_record_id = ? ORDER BY sequence`,
      )
      .all(admissionRecordId) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: requireSafeInteger(row["sequence"], "addendum sequence"),
      addendumId: requireString(row["addendum_id"], "addendum_id"),
      admissionRecordId: requireString(
        row["admission_record_id"],
        "admission_record_id",
      ),
      createdAt: requireString(row["created_at"], "created_at"),
      kind: requireString(row["kind"], "addendum kind") as AdmissionAddendumKind,
      body: parseCanonicalJson<JsonValue>(row["body_json"], "addendum body"),
    }));
  }

  #appendAdmissionAddendum(
    admissionRecordId: string,
    kind: AdmissionAddendumKind,
    body: unknown,
  ): string {
    const addendumId = `addendum/${randomUUID()}`;
    this.#appendAdmissionAddendumWithId(
      addendumId,
      admissionRecordId,
      kind,
      body,
      this.#timestamp(),
    );
    return addendumId;
  }

  #appendAdmissionAddendumWithId(
    addendumId: string,
    admissionRecordId: string,
    kind: AdmissionAddendumKind,
    body: unknown,
    createdAt: string,
  ): void {
    assertNonEmptyString(addendumId, "addendumId");
    assertCanonicalTimestamp(createdAt, "addendum.createdAt");
    const existing = this.#database
      .prepare(
        `SELECT admission_record_id, kind, body_json, created_at
           FROM admission_addenda WHERE addendum_id = ?`,
      )
      .get(addendumId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing["admission_record_id"] === admissionRecordId &&
        existing["kind"] === kind &&
        existing["created_at"] === createdAt &&
        existing["body_json"] === canonicalJson(body)
      ) {
        return;
      }
      throw new StatefulInputError(
        "addendumId",
        "was reused with different immutable fact data",
      );
    }
    this.#database
      .prepare(
        `INSERT INTO admission_addenda
           (addendum_id, admission_record_id, created_at, kind, body_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(addendumId, admissionRecordId, createdAt, kind, canonicalJson(body));
  }

  #insertOwnerDecision(ownerDecisionId: string, body: unknown): boolean {
    const existing = this.#database
      .prepare(
        `SELECT body_json FROM owner_decisions WHERE owner_decision_id = ?`,
      )
      .get(ownerDecisionId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (existing["body_json"] !== canonicalJson(body)) {
        throw new StatefulInputError(
          "ownerDecisionId",
          "was reused with different decision data",
        );
      }
      return true;
    }
    this.#database
      .prepare(
        `INSERT INTO owner_decisions (owner_decision_id, created_at, body_json)
         VALUES (?, ?, ?)`,
      )
      .run(ownerDecisionId, this.#timestamp(), canonicalJson(body));
    return false;
  }

  #modifyDecisionReplay(
    input: Extract<OwnerDecisionInput, { readonly kind: "MODIFY" }>,
  ): OwnerDecisionResult {
    const matchingLinks = this.#readAdmissionAddenda(
      input.admissionRecordId,
    ).filter(
      (addendum) =>
        addendum.kind === "readmission_link" &&
        isJsonObject(addendum.body) &&
        addendum.body["ownerDecisionId"] === input.ownerDecisionId,
    );
    if (matchingLinks.length !== 1) {
      throw new StatefulInputError(
        "ownerDecisionId",
        "durable MODIFY decision must have exactly one readmission result",
      );
    }
    const body = matchingLinks[0]?.body;
    if (!isJsonObject(body)) {
      throw new StatefulInputError(
        "ownerDecisionId",
        "durable MODIFY decision has a malformed readmission result",
      );
    }
    const freshAdmissionRecordId = requireString(
      body["freshAdmissionRecordId"],
      "readmissionLink.freshAdmissionRecordId",
    );
    return deepFreeze({
      status: "READMITTED",
      ownerDecisionId: input.ownerDecisionId,
      freshAdmissionRecord:
        this.getAdmissionRecord(freshAdmissionRecordId).record,
    });
  }

  #validateAcceptablePlan(
    record: AdmissionRecordBody,
    addenda: readonly AdmissionAddendum[],
    selectedPlanId: string,
  ): void {
    if (
      addenda.some(
        (addendum) =>
          addendum.kind === "readmission_link" &&
          isJsonObject(addendum.body) &&
          addendum.body["kind"] === "ALREADY_ACCEPTED_NO_COMMIT",
      )
    ) {
      throw new StatefulInputError(
        "admissionRecordId",
        "the proposal was already committed by the winning acceptor",
      );
    }
    this.#validatePlanIdentity(record, selectedPlanId);
    if (record.decision === "ADMITTABLE") return;
    if (record.decision !== "REPLAN") {
      throw new StatefulInputError(
        "admissionRecordId",
        "REJECT records cannot be accepted",
      );
    }
    const selected = addenda.some(
      (addendum) =>
        addendum.kind === "owner_choice" &&
        isJsonObject(addendum.body) &&
        addendum.body["kind"] === "MODIFY_SELECTION_CONFIRMED" &&
        addendum.body["selectedPlanId"] === selectedPlanId,
    );
    if (!selected) {
      throw new StatefulInputError(
        "selectedPlanId",
        "a REPLAN candidate requires an additive owner MODIFY selection",
      );
    }
  }

  #validatePlanIdentity(record: AdmissionRecordBody, selectedPlanId: string): void {
    if (!planExists(record, selectedPlanId)) {
      throw new StatefulInputError(
        "selectedPlanId",
        "does not identify a selected/candidate plan in the AdmissionRecord",
      );
    }
    if (record.decision === "REPLAN") {
      const candidate = record.candidatePlans.find(
        (item) => item.candidatePlanId === selectedPlanId,
      );
      if (candidate?.feasible !== true) {
        throw new StatefulInputError(
          "selectedPlanId",
          "must identify a feasible REPLAN candidate",
        );
      }
    }
  }

  #validateAcceptedGrantBasis(
    input: IssueGrantInput,
    scope: CanonicalApprovalScope,
    currentVersions: VersionTuple,
  ): void {
    const admission = this.getAdmissionRecord(input.admissionRecordId);
    const record = admission.record;
    const recomputedPromiseBasisId = stableTupleId("promise-basis", [
      asJsonValue(record.m1Result.promiseBasis),
    ]);
    if (
      record.promiseBasisId !== recomputedPromiseBasisId ||
      input.promiseBasisId !== record.promiseBasisId ||
      scope.promiseBasisId !== record.promiseBasisId
    ) {
      throw new StatefulInputError(
        "promiseBasisId",
        "must identify the immutable Promise Basis in the accepted AdmissionRecord",
      );
    }
    if (scope.objectiveId !== record.proposalSnapshot.objective) {
      throw new StatefulInputError(
        "scope.objectiveId",
        "must match the accepted proposal objective",
      );
    }
    this.#validatePlanIdentity(record, input.selectedPlanId);
    const commit = admission.addenda.find(
      (addendum) =>
        addendum.kind === "acceptance_commit" &&
        isJsonObject(addendum.body) &&
        addendum.body["selectedPlanId"] === input.selectedPlanId &&
        addendum.body["ownerDecisionId"] === input.acceptedOwnerDecisionId,
    );
    if (commit === undefined || !isJsonObject(commit.body)) {
      throw new StatefulInputError(
        "acceptedOwnerDecisionId",
        "must identify the durable owner decision that accepted this exact plan",
      );
    }
    if (
      commit.body["committedPortfolioVersion"] !==
        currentVersions.portfolioVersion ||
      record.capacityModelVersion !== currentVersions.capacityModelVersion ||
      record.capacityPlanVersion !== currentVersions.capacityPlanVersion
    ) {
      throw new StatefulInputError(
        "admissionRecordId",
        "accepted admission basis is no longer current for grant issuance",
      );
    }
    const ownerDecision = this.#ownerDecisionBody(
      input.acceptedOwnerDecisionId,
    );
    if (
      ownerDecision === null ||
      ownerDecision["kind"] !== "ACCEPT_PROMISE" ||
      ownerDecision["admissionRecordId"] !== input.admissionRecordId ||
      ownerDecision["selectedPlanId"] !== input.selectedPlanId ||
      ownerDecision["approverId"] !== scope.approverId
    ) {
      throw new StatefulInputError(
        "acceptedOwnerDecisionId",
        "does not match the authoritative accepted AdmissionRecord and plan",
      );
    }
  }

  #ownerDecisionBody(ownerDecisionId: string): Record<string, unknown> | null {
    const row = this.#database
      .prepare(
        "SELECT body_json FROM owner_decisions WHERE owner_decision_id = ?",
      )
      .get(ownerDecisionId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const body = parseCanonicalJson<unknown>(
      row["body_json"],
      "owner decision",
    );
    return isJsonObject(body) ? body : null;
  }

  #validateClaimBasis(
    input: ClaimExecutionInput,
    admission: AdmissionReadModel,
    grant: GrantBase,
    allowance: GrantAllowanceBase,
    currentVersions: VersionTuple,
  ): void {
    const record = admission.record;
    const recomputedPromiseBasisId = stableTupleId("promise-basis", [
      asJsonValue(record.m1Result.promiseBasis),
    ]);
    const linked =
      record.promiseBasisId === recomputedPromiseBasisId &&
      input.promiseBasisId === record.promiseBasisId &&
      grant.admissionRecordId === input.admissionRecordId &&
      allowance.admissionRecordId === input.admissionRecordId &&
      grant.promiseBasisId === input.promiseBasisId &&
      allowance.promiseBasisId === input.promiseBasisId &&
      grant.scope.promiseBasisId === input.promiseBasisId &&
      allowance.canonicalApprovedScope.promiseBasisId === input.promiseBasisId &&
      grant.acceptedOwnerDecisionId === input.acceptedOwnerDecisionId &&
      allowance.acceptedOwnerDecisionId === input.acceptedOwnerDecisionId &&
      grant.decisionId === input.grantOwnerDecisionId &&
      allowance.decisionId === input.grantOwnerDecisionId &&
      grant.selectedPlanId === input.selectedPlanId &&
      allowance.selectedPlanId === input.selectedPlanId &&
      grant.selectedBundleId === input.selectedBundleId &&
      allowance.selectedBundleId === input.selectedBundleId &&
      grant.grantAllowanceKey === input.grantAllowanceKey &&
      canonicalSerialize(grant.scope) ===
        canonicalSerialize(allowance.canonicalApprovedScope) &&
      grant.scope.objectiveId === record.proposalSnapshot.objective &&
      grant.portfolioVersion === currentVersions.portfolioVersion &&
      grant.capacityModelVersion === currentVersions.capacityModelVersion &&
      grant.capacityPlanVersion === currentVersions.capacityPlanVersion;
    if (!linked) {
      throw new StatefulInputError(
        "executionBasis",
        "grant, allowance, admission, Promise Basis, decisions, plan, and bundle must form one immutable linked basis",
      );
    }
    const commit = admission.addenda.find(
      (addendum) =>
        addendum.kind === "acceptance_commit" &&
        isJsonObject(addendum.body) &&
        addendum.body["ownerDecisionId"] ===
          input.acceptedOwnerDecisionId &&
        addendum.body["selectedPlanId"] === input.selectedPlanId &&
        addendum.body["committedPortfolioVersion"] ===
          grant.portfolioVersion,
    );
    const acceptedDecision = this.#ownerDecisionBody(
      input.acceptedOwnerDecisionId,
    );
    const grantDecision = this.#ownerDecisionBody(input.grantOwnerDecisionId);
    if (
      commit === undefined ||
      acceptedDecision?.["kind"] !== "ACCEPT_PROMISE" ||
      acceptedDecision["admissionRecordId"] !== input.admissionRecordId ||
      acceptedDecision["selectedPlanId"] !== input.selectedPlanId ||
      grantDecision?.["kind"] !== "APPROVE_GRANT" ||
      grantDecision["admissionRecordId"] !== input.admissionRecordId ||
      grantDecision["promiseBasisId"] !== input.promiseBasisId ||
      grantDecision["acceptedOwnerDecisionId"] !==
        input.acceptedOwnerDecisionId ||
      grantDecision["selectedPlanId"] !== input.selectedPlanId ||
      grantDecision["selectedBundleId"] !== input.selectedBundleId
    ) {
      throw new StatefulInputError(
        "executionBasis",
        "durable acceptance and grant decisions do not match the claimed basis",
      );
    }
  }

  #readCalibrationHistory(): readonly CalibrationHistoryRecord[] {
    const recordRows = this.#database
      .prepare(
        `SELECT admission_record_id FROM admission_records
          ORDER BY admission_record_id`,
      )
      .all() as Record<string, unknown>[];
    const history: CalibrationHistoryRecord[] = [];
    for (const row of recordRows) {
      const admissionRecordId = requireString(
        row["admission_record_id"],
        "admission_record_id",
      );
      const addenda = this.#readAdmissionAddenda(admissionRecordId);
      const outcomes = addenda.filter(
        (addendum) => addendum.kind === "outcome" && isJsonObject(addendum.body),
      );
      const latestOutcome = outcomes.at(-1);
      if (
        latestOutcome === undefined ||
        !isJsonObject(latestOutcome.body) ||
        latestOutcome.body["outcome"] !== "completed"
      ) {
        continue;
      }
      const completedAt = requireString(
        latestOutcome.body["completedAt"],
        "outcome.completedAt",
      );
      for (const actual of addenda.filter(
        (addendum) =>
          addendum.kind === "actual_consumption" && isJsonObject(addendum.body),
      )) {
        if (!isJsonObject(actual.body)) continue;
        const correction = addenda
          .filter(
            (addendum) =>
              addendum.kind === "calibration_correction" &&
              isJsonObject(addendum.body) &&
              addendum.body["correctsActualConsumptionFactId"] ===
                actual.addendumId,
          )
          .at(-1);
        const correctionBody =
          correction !== undefined && isJsonObject(correction.body)
            ? correction.body
            : null;
        const actualConsumption =
          correctionBody === null
            ? requireNonNegativeSafeInteger(
                actual.body["actualConsumption"],
                "actualConsumption",
              )
            : requireNonNegativeSafeInteger(
                correctionBody["correctedActualConsumption"],
                "correctedActualConsumption",
              );
        history.push({
          recordId: stableTupleId("calibration-record", [
            admissionRecordId,
            actual.addendumId,
          ]),
          completedAt,
          resourceKey: requireString(actual.body["resourceKey"], "resourceKey"),
          workClassKey: requireString(
            actual.body["workClassKey"],
            "workClassKey",
          ),
          actualConsumption,
          actualConsumptionAddendumId:
            correction?.addendumId ?? actual.addendumId,
          outcome: "completed",
          outcomeAddendumId: latestOutcome.addendumId,
        });
      }
    }
    return history.sort((left, right) =>
      compareStableStrings(left.recordId, right.recordId),
    );
  }

  #currentCalibrationDigest(): string {
    const resources = this.#readResources();
    const obligations = this.#readAcceptedObligations();
    return computeCalibration(
      readVersions(this.#database).capacityModelVersion,
      resources,
      obligations,
      this.#readCalibrationHistory(),
    ).digest;
  }

  #calibrationDigestForProposal(
    proposal: ProposedObligation,
    proposalAlreadyAccepted: boolean,
  ): string {
    const resources = this.#readResources();
    const accepted = this.#readAcceptedObligations().filter(
      (obligation) =>
        !proposalAlreadyAccepted ||
        obligation.obligationId !== proposal.obligationId,
    );
    return computeCalibration(
      readVersions(this.#database).capacityModelVersion,
      resources,
      [...accepted, proposal],
      this.#readCalibrationHistory(),
    ).digest;
  }

  #readReservations(
    includeTerminal: boolean,
  ): InFlightExecutionReservation[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json FROM inflight_reservations ORDER BY reservation_id`,
      )
      .all() as Record<string, unknown>[];
    const reservations = rows.map((row) =>
      this.#reservationReadModel(
        parseCanonicalJson<InFlightExecutionReservation>(
          row["body_json"],
          "in-flight reservation",
        ),
      ),
    );
    return includeTerminal
      ? reservations
      : reservations.filter(
          (reservation) => reservation.claimState === "claimed_nonterminal",
        );
  }

  #readM1CapacityReservations(
    resources: readonly CapacityResource[] = this.#readResources(),
  ): FixedCapacityReservation[] {
    return [
      ...this.#readReservations(false).map(reservationToM1),
      ...this.#readRealizedCapacityReservations(resources),
    ].sort((left, right) =>
      compareStableStrings(left.reservationId, right.reservationId),
    );
  }

  #readRealizedCapacityReservations(
    resources: readonly CapacityResource[],
  ): FixedCapacityReservation[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json FROM realized_consumption_facts
          ORDER BY realized_consumption_id`,
      )
      .all() as Record<string, unknown>[];
    const projected: FixedCapacityReservation[] = [];
    for (const row of rows) {
      const fact = parseCanonicalJson<RealizedConsumptionReservationFact>(
        row["body_json"],
        "realized consumption fact",
      );
      if (
        fact.schemaVersion !== "flakebrake-realized-consumption/v0.1-m2" ||
        fact.claimAccounting !== "additional"
      ) {
        throw new StatefulInputError(
          "realizedConsumption",
          "stored realized consumption has an unsupported contract",
        );
      }
      const horizons = new Map(
        fact.applicableResourceHorizons.map((horizon) => [
          horizon.resourceKey,
          horizon,
        ]),
      );
      const correctedClaims = { ...fact.resourceClaims };
      const addenda = this.#readAdmissionAddenda(fact.admissionRecordId);
      for (const coordinate of fact.actualConsumptionCoordinates) {
        const actual = addenda.find(
          (addendum) =>
            addendum.addendumId === coordinate.actualConsumptionFactId &&
            addendum.kind === "actual_consumption" &&
            isJsonObject(addendum.body),
        );
        if (actual === undefined || !isJsonObject(actual.body)) {
          throw new StatefulInputError(
            "realizedConsumption.actualConsumptionCoordinates",
            "must reference the immutable actual-consumption fact",
          );
        }
        const correction = addenda
          .filter(
            (addendum) =>
              addendum.kind === "calibration_correction" &&
              isJsonObject(addendum.body) &&
              addendum.body["correctsActualConsumptionFactId"] ===
                coordinate.actualConsumptionFactId,
          )
          .at(-1);
        if (correction !== undefined && isJsonObject(correction.body)) {
          const current = requireNonNegativeSafeInteger(
            correctedClaims[coordinate.resourceKey],
            "realizedConsumption.resourceClaims",
          );
          const original = requireNonNegativeSafeInteger(
            actual.body["actualConsumption"],
            "actualConsumption",
          );
          const corrected = requireNonNegativeSafeInteger(
            correction.body["correctedActualConsumption"],
            "correctedActualConsumption",
          );
          const total = current - original + corrected;
          if (!Number.isSafeInteger(total) || total < 0) {
            throw new StatefulInputError(
              "realizedConsumption.resourceClaims",
              "corrected resource consumption must be a nonnegative safe integer",
            );
          }
          correctedClaims[coordinate.resourceKey] = total;
        }
      }
      const resourceClaims = Object.fromEntries(
        resources.map((resource) => {
          const horizon = horizons.get(resource.resourceKey);
          const value = correctedClaims[resource.resourceKey];
          if (horizon === undefined || value === undefined) {
            throw new StatefulInputError(
              "realizedConsumption.resourceClaims",
              "must preserve every authoritative capacity dimension",
            );
          }
          return [
            resource.resourceKey,
            windowsOverlap(
              horizon.start,
              horizon.end,
              resource.horizonStart,
              resource.horizonEnd,
            )
              ? value
              : 0,
          ];
        }),
      ) as Record<string, number>;
      let temporalClaim = fact.temporalClaim;
      if (temporalClaim !== null) {
        const resource = resources.find(
          (candidate) => candidate.resourceKey === temporalClaim?.resourceKey,
        );
        const timedValue = resourceClaims[temporalClaim.resourceKey] ?? 0;
        if (
          resource === undefined ||
          resource.timeUnit !== temporalClaim.timeUnit ||
          timedValue === 0 ||
          !windowsOverlap(
            temporalClaim.start,
            temporalClaim.end,
            resource.horizonStart,
            resource.horizonEnd,
          )
        ) {
          if (resource !== undefined) resourceClaims[resource.resourceKey] = 0;
          temporalClaim = null;
        } else {
          temporalClaim = {
            ...temporalClaim,
            start: laterTimestamp(
              temporalClaim.start,
              resource.horizonStart,
            ),
            end: earlierTimestamp(
              temporalClaim.end,
              resource.horizonEnd,
            ),
            requiredDuration: timedValue,
          };
        }
      }
      if (Object.values(resourceClaims).every((value) => value === 0)) continue;
      projected.push({
        reservationId: stableTupleId("realized-reservation", [
          fact.realizedConsumptionId,
        ]),
        executionAttemptId: fact.executionAttemptId,
        authorizationIdentity: fact.authorizationIdentity,
        lockedOperationId: fact.lockedOperationId,
        affectedObligationIds: fact.affectedObligationIds,
        resourceClaims,
        temporalClaim,
        expectedPostcondition: fact.expectedPostcondition,
        claimAccounting: "additional",
      });
    }
    return projected;
  }

  #reservationByAttempt(
    executionAttemptId: string,
  ): InFlightExecutionReservation {
    const row = requireRow(
      this.#database
        .prepare(
          `SELECT body_json FROM inflight_reservations
            WHERE execution_attempt_id = ?`,
        )
        .get(executionAttemptId) as Record<string, unknown> | undefined,
      `reservation for ${executionAttemptId}`,
    );
    return parseCanonicalJson<InFlightExecutionReservation>(
      row["body_json"],
      "in-flight reservation",
    );
  }

  #reservationReadModel(
    base: InFlightExecutionReservation,
  ): InFlightExecutionReservation {
    const rows = this.#database
      .prepare(
        `SELECT event_kind FROM reservation_events
          WHERE reservation_id = ? ORDER BY sequence`,
      )
      .all(base.reservationId) as Record<string, unknown>[];
    let claimState: InFlightExecutionReservation["claimState"] =
      "claimed_nonterminal";
    for (const row of rows) {
      const kind = requireString(row["event_kind"], "reservation event kind");
      if (kind === "terminal_verified") claimState = "terminal_verified";
      if (kind === "terminal_failed_before_mutation") {
        claimState = "terminal_failed_before_mutation";
      }
      if (kind === "terminal_reconciled") claimState = "terminal_reconciled";
    }
    return deepFreeze({ ...base, claimState });
  }

  #executionAttempt(executionAttemptId: string): ExecutionAttemptReadModel | null {
    const row = this.#database
      .prepare(
        `SELECT admission_record_id, created_at, input_json, result_json
           FROM execution_attempts WHERE execution_attempt_id = ?`,
      )
      .get(executionAttemptId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      executionAttemptId,
      admissionRecordId: requireString(
        row["admission_record_id"],
        "admission_record_id",
      ),
      createdAt: requireString(row["created_at"], "created_at"),
      input: parseCanonicalJson<ClaimExecutionInput>(
        row["input_json"],
        "execution attempt input",
      ),
      result: parseCanonicalJson<ExecutionClaimResult>(
        row["result_json"],
        "execution attempt result",
      ),
    };
  }

  #executionFenceByAttempt(
    executionAttemptId: string,
  ): ExecutionFenceReadModel | null {
    const row = this.#database
      .prepare(
        `SELECT body_json FROM execution_fences
          WHERE execution_attempt_id = ?`,
      )
      .get(executionAttemptId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return this.#executionFenceReadModel(
      parseCanonicalJson<ExecutionFenceBase>(
        row["body_json"],
        "execution fence",
      ),
    );
  }

  #requireExecutionFenceById(fenceId: string): ExecutionFenceReadModel {
    const row = requireRow(
      this.#database
        .prepare("SELECT body_json FROM execution_fences WHERE fence_id = ?")
        .get(fenceId) as Record<string, unknown> | undefined,
      `execution fence ${fenceId}`,
    );
    return this.#executionFenceReadModel(
      parseCanonicalJson<ExecutionFenceBase>(
        row["body_json"],
        "execution fence",
      ),
    );
  }

  #executionFenceReadModel(
    base: ExecutionFenceBase,
  ): ExecutionFenceReadModel {
    const rows = this.#database
      .prepare(
        `SELECT event_kind, body_json FROM execution_fence_events
          WHERE fence_id = ? ORDER BY sequence`,
      )
      .all(base.fenceId) as Record<string, unknown>[];
    let status: ExecutionFenceReadModel["status"] = "active";
    let resultBinding: ExecutionFenceResultBinding | null = null;
    for (const row of rows) {
      const eventKind = requireString(row["event_kind"], "fence event kind");
      if (eventKind === "factory_result_bound") {
        if (status !== "active" || resultBinding !== null) {
          throw new StatefulInputError(
            "executionFence",
            "contains an invalid repeated result-binding transition",
          );
        }
        resultBinding = parseCanonicalJson<ExecutionFenceResultBinding>(
          row["body_json"],
          "execution fence result binding",
        );
        status = "factory_result_bound";
      } else if (eventKind === "released_without_mutation") {
        if (status !== "active") {
          throw new StatefulInputError(
            "executionFence",
            "contains an invalid release transition",
          );
        }
        parseCanonicalJson<JsonValue>(
          row["body_json"],
          "execution fence release",
        );
        status = "released_without_mutation";
      } else {
        throw new StatefulInputError(
          "executionFence",
          `contains unsupported event ${eventKind}`,
        );
      }
    }
    return deepFreeze({ ...base, status, resultBinding });
  }

  #appendExecutionFenceEvent(
    fence: ExecutionFenceReadModel,
    eventKind: "factory_result_bound" | "released_without_mutation",
    body: JsonValue | ExecutionFenceResultBinding,
  ): void {
    const createdAt = this.#timestamp();
    const eventId = stableTupleId("execution-fence-event", [
      fence.fenceId,
      eventKind,
      asJsonValue(body),
    ]);
    this.#database
      .prepare(
        `INSERT INTO execution_fence_events
           (fence_event_id, fence_id, created_at, event_kind, body_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        fence.fenceId,
        createdAt,
        eventKind,
        canonicalJson(body),
      );
  }

  #deriveAuthoritativeActualConsumption(
    attempt: ExecutionAttemptReadModel,
    reservation: InFlightExecutionReservation,
  ): readonly import("./stateful-domain.js").ActualConsumptionValue[] {
    if (attempt.input.affectedObligationIds.length !== 1) {
      throw new StatefulInputError(
        "affectedObligationIds",
        "authoritative factory verification requires exactly one order",
      );
    }
    const admission = this.getAdmissionRecord(attempt.admissionRecordId).record;
    const obligationId = attempt.input.affectedObligationIds[0] as string;
    const obligation = [
      ...admission.m1Result.promiseBasis.acceptedPortfolio,
      admission.proposalSnapshot,
    ].find((candidate) => candidate.obligationId === obligationId);
    if (obligation === undefined) {
      throw new StatefulInputError(
        "affectedObligationIds",
        "does not identify an obligation in the immutable Promise Basis",
      );
    }
    const actuals = Object.entries(reservation.resourceCapacityClaims)
      .filter(([, value]) => value > 0)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([resourceKey, value]) => {
        const workClassKey = obligation.workClassByResource[resourceKey];
        if (workClassKey === undefined) {
          throw new StatefulInputError(
            "resourceCapacityClaims",
            `has no immutable work class for ${resourceKey}`,
          );
        }
        return { resourceKey, workClassKey, value };
      });
    return deepFreeze(actuals);
  }

  #requireAuthoritativeFactoryDatabasePath(): string {
    if (this.#authoritativeFactoryDatabasePath === null) {
      throw new StatefulInputError(
        "authoritativeFactoryDatabasePath",
        "is required for M3 fenced execution and verification",
      );
    }
    return this.#authoritativeFactoryDatabasePath;
  }

  #assertReservationCompatibleWithM1(
    reservation: InFlightExecutionReservation,
  ): string {
    const resources = this.#readResources();
    const schedulable = resources.find((resource) => resource.timeUnit !== null);
    if (schedulable === undefined || schedulable.timeUnit === null) {
      throw new StatefulInputError(
        "resources",
        "M1 requires a schedulable resource for portfolio recomputation",
      );
    }
    const zeroDemand = Object.fromEntries(
      resources.map((resource) => [resource.resourceKey, 0]),
    );
    const workClasses = Object.fromEntries(
      resources.map((resource) => [resource.resourceKey, "m2-claim-probe"]),
    );
    const probeId = `m2-claim-probe/${reservation.executionAttemptId}`;
    const probe: ProposedObligation = {
      obligationId: probeId,
      beneficiary: "m2-authorization-recomputation",
      objective: "Validate current fixed reservations through M1",
      serviceLevel: { units: 0 },
      protected: false,
      criticality: "best_effort",
      minimumService: { units: 0 },
      modificationPolicy: { modifiableFields: {} },
      modificationOptions: [],
      resourceDemand: zeroDemand,
      workClassByResource: workClasses,
      schedulingConstraint: {
        kind: "horizon",
        start: schedulable.horizonStart,
        end: schedulable.horizonEnd,
        resourceKey: schedulable.resourceKey,
        timeUnit: schedulable.timeUnit,
      },
      pendingOwnerDecisions: [],
      assumptions: [],
      evidenceRefs: [],
      requiredEffects: [],
      status: "proposed",
      acceptanceDecision: {
        objectiveId: probeId,
        evidencePacketId: probeId,
        approverId: "m2-store",
        executionBoundaryId: probeId,
      },
    };
    const fixed = [
      ...this.#readM1CapacityReservations(resources),
      reservationToM1(reservation),
    ];
    const result = evaluateAdmission({
      versions: readVersions(this.#database),
      calibration: {
        ruleId: "conservative-max/v1",
        historyRecords: this.#readCalibrationHistory(),
        expectedFrontierDigest: null,
      },
      resources,
      acceptedObligations: this.#readAcceptedObligations(),
      proposal: probe,
      fixedCapacityReservations: fixed,
      combinedDecisionProofs: [],
      authorizationFacts: this.#authorizationFacts(),
      assumptions: [],
    });
    const overCapacity = result.directPlan.capacityBefore.some(
      (amount) => amount.value < 0,
    );
    const invalidAcceptedSchedule = result.directPlan.temporalSlack.some(
      (slack) => slack.obligationId !== probeId && slack.status === "violated",
    );
    if (overCapacity || invalidAcceptedSchedule) {
      throw new StatefulInputError(
        "resourceCapacityClaims",
        "the selected bundle is not admission-feasible with the claimed reservation",
      );
    }
    const preExecutionRecord = this.#insertAdmissionRecord(result);
    this.#appendAdmissionAddendum(
      preExecutionRecord.admissionRecordId,
      "execution_attempt",
      {
        kind: "PRE_EXECUTION_RECOMPUTATION",
        executionAttemptId: reservation.executionAttemptId,
        selectedPlanId: reservation.selectedPlanId,
        selectedBundleId: reservation.selectedBundleId,
      },
    );
    return preExecutionRecord.admissionRecordId;
  }

  #validateClaimResources(input: ClaimExecutionInput): void {
    const resources = this.#readResources();
    const resourceKeys = resources.map((resource) => resource.resourceKey);
    if (
      canonicalSerialize(Object.keys(input.resourceCapacityClaims).sort(compareStableStrings)) !==
      canonicalSerialize([...resourceKeys].sort(compareStableStrings))
    ) {
      throw new StatefulInputError(
        "resourceCapacityClaims",
        "must contain every current capacity resource exactly once",
      );
    }
    for (const [resourceKey, value] of Object.entries(
      input.resourceCapacityClaims,
    )) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new StatefulInputError(
          `resourceCapacityClaims.${resourceKey}`,
          "must be a nonnegative safe integer",
        );
      }
    }
    const affectedResourceIds = sortedUniqueStrings(input.affectedResourceIds);
    const resourcesWithClaims = Object.entries(input.resourceCapacityClaims)
      .filter(([, value]) => value > 0)
      .map(([key]) => key)
      .sort(compareStableStrings);
    if (
      canonicalSerialize(affectedResourceIds) !==
      canonicalSerialize(resourcesWithClaims)
    ) {
      throw new StatefulInputError(
        "affectedResourceIds",
        "must identify exactly the resources with nonzero claims",
      );
    }
    const acceptedIds = new Set(
      this.#readAcceptedObligations().map((obligation) => obligation.obligationId),
    );
    if (
      input.affectedObligationIds.length === 0 ||
      input.affectedObligationIds.some((id) => !acceptedIds.has(id))
    ) {
      throw new StatefulInputError(
        "affectedObligationIds",
        "must contain only current accepted obligations and must not be empty",
      );
    }
  }

  #allowanceBase(grantAllowanceKey: string): GrantAllowanceBase | null {
    const row = this.#database
      .prepare(
        `SELECT body_json FROM grant_allowances WHERE grant_allowance_key = ?`,
      )
      .get(grantAllowanceKey) as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : parseCanonicalJson<GrantAllowanceBase>(
          row["body_json"],
          "grant allowance",
        );
  }

  #grantBase(grantId: string): GrantBase | null {
    const row = this.#database
      .prepare("SELECT body_json FROM grants WHERE grant_id = ?")
      .get(grantId) as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : parseCanonicalJson<GrantBase>(row["body_json"], "grant");
  }

  #allowanceStatus(
    base: GrantAllowanceBase,
    claimedCount: number,
    evaluatedAt: string,
  ): GrantAllowanceReadModel["status"] {
    if (this.#hasAuthorizationEvent("allowance", base.grantAllowanceKey, ["revoked"])) {
      return "revoked";
    }
    if (
      this.#hasAuthorizationEvent("allowance", base.grantAllowanceKey, ["expired"])
    ) {
      return "expired";
    }
    if (claimedCount >= base.maxExecutions) {
      return "exhausted";
    }
    return Date.parse(evaluatedAt) >
      Date.parse(base.canonicalApprovedScope.validUntil)
      ? "expired"
      : "live";
  }

  #allowanceClaimCount(grantAllowanceKey: string): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS claimed_count FROM allowance_claims
          WHERE grant_allowance_key = ?`,
      )
      .get(grantAllowanceKey) as Record<string, unknown> | undefined;
    return requireNonNegativeSafeInteger(
      requireRow(row, "grant allowance claim count")["claimed_count"],
      "claimed_count",
    );
  }

  #hasAuthorizationEvent(
    subjectKind: string,
    subjectId: string,
    eventKinds: readonly string[],
  ): boolean {
    if (eventKinds.length === 0) return false;
    const placeholders = eventKinds.map(() => "?").join(", ");
    const row = this.#database
      .prepare(
        `SELECT 1 AS found FROM authorization_events
          WHERE subject_kind = ? AND subject_id = ?
            AND event_kind IN (${placeholders}) LIMIT 1`,
      )
      .get(subjectKind, subjectId, ...eventKinds) as
      | Record<string, unknown>
      | undefined;
    return row !== undefined;
  }

  #recordAuthorizationTermination(
    subjectKind: string,
    subjectId: string,
    eventKind: string,
    body: JsonValue,
    exists: () => boolean,
  ): VersionTuple {
    return inImmediateTransaction(this.#database, () => {
      if (!exists()) {
        throw new StatefulInputError(
          "subjectId",
          `unknown ${subjectKind} ${subjectId}`,
        );
      }
      if (this.#hasAuthorizationEvent(subjectKind, subjectId, [eventKind])) {
        return readVersions(this.#database);
      }
      this.#database
        .prepare(
          `INSERT INTO authorization_events
             (authorization_event_id, subject_kind, subject_id,
              event_kind, created_at, body_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `authorization-event/${randomUUID()}`,
          subjectKind,
          subjectId,
          eventKind,
          this.#timestamp(),
          canonicalJson(body),
        );
      return advanceVersions(this.#database, new Set(["authorization"]));
    });
  }

  #denialBase(denialId: string): DenialConstraint | null {
    const row = this.#database
      .prepare("SELECT body_json FROM denials WHERE denial_id = ?")
      .get(denialId) as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : parseCanonicalJson<DenialConstraint>(row["body_json"], "denial");
  }

  #denialReadModel(base: DenialConstraint): DenialConstraint {
    let status: DenialConstraint["status"] = "active";
    if (this.#hasAuthorizationEvent("denial", base.denialId, ["superseded"])) {
      status = "superseded";
    } else if (
      this.#hasAuthorizationEvent("denial", base.denialId, ["mission_closed"])
    ) {
      status = "mission_closed";
    }
    return deepFreeze({ ...base, status });
  }

  #denialExceptionBase(
    denialExceptionId: string,
  ): DenialExceptionReadModel | null {
    const row = this.#database
      .prepare(
        `SELECT body_json FROM denial_exceptions WHERE denial_exception_id = ?`,
      )
      .get(denialExceptionId) as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : parseCanonicalJson<DenialExceptionReadModel>(
          row["body_json"],
          "denial exception",
        );
  }

  #denialExceptionReadModel(
    base: DenialExceptionReadModel,
  ): DenialExceptionReadModel {
    let status: DenialExceptionReadModel["status"] = "active";
    for (const candidate of [
      "revoked",
      "expired",
      "mission_closed",
    ] as const) {
      if (
        this.#hasAuthorizationEvent(
          "denial_exception",
          base.denialExceptionId,
          [candidate],
        )
      ) {
        status = candidate;
        break;
      }
    }
    if (status === "active") {
      const allowanceStatus = this.getGrantAllowance(
        base.grantAllowanceKey,
      ).status;
      if (allowanceStatus !== "live") status = allowanceStatus;
    }
    return deepFreeze({ ...base, status });
  }

  #qualifyingException(
    parentDenialId: string,
    grantAllowanceKey: string,
    occurrence: AuthorizationOccurrence,
    ordinal: number,
  ): boolean {
    return this.getDenialExceptions().some(
      (exception) =>
        exception.status === "active" &&
        exception.parentDenialId === parentDenialId &&
        exception.grantAllowanceKey === grantAllowanceKey &&
        exception.approvedCanonicalEffectClasses.includes(
          "microfactory.schedule_reservation",
        ) &&
        exception.approvedEffectSchemaVersions.includes(
          occurrence.effect.effectSchemaVersion,
        ) &&
        approvalScopeCovers(exception.approvedScope, occurrence, ordinal),
    );
  }

  #authorizationFacts(): readonly ProvenanceEntry[] {
    const grantRows = this.#database
      .prepare("SELECT body_json FROM grants ORDER BY grant_id")
      .all() as Record<string, unknown>[];
    const allowances = this.#database
      .prepare(
        `SELECT grant_allowance_key FROM grant_allowances ORDER BY grant_allowance_key`,
      )
      .all() as Record<string, unknown>[];
    const snapshot = {
          authorizationStateVersion:
            readVersions(this.#database).authorizationStateVersion,
          allowances: allowances.map((row) => {
            const key = requireString(
              row["grant_allowance_key"],
              "grant_allowance_key",
            );
            const allowance = this.getGrantAllowance(key);
            return {
              grantAllowanceKey: key,
              decisionId: allowance.decisionId,
              selectedBundleId: allowance.selectedBundleId,
              canonicalApprovedScope: allowance.canonicalApprovedScope,
              status: allowance.status,
              claimedExecutionSlots: allowance.claimedExecutionSlots,
            };
          }),
          grants: grantRows.map((row) => {
            const grant = parseCanonicalJson<GrantBase>(
              row["body_json"],
              "grant",
            );
            return {
              ...grant,
              status: this.#hasAuthorizationEvent(
                "grant",
                grant.grantId,
                ["revoked", "expired"],
              )
                ? "revoked"
                : "live",
            };
          }),
          denials: this.getDenials(),
          denialExceptions: this.getDenialExceptions(),
          activeReservationIds: this.#readReservations(false).map(
            (reservation) => reservation.reservationId,
          ),
        };
    return [
      {
        key: "authorization_snapshot",
        source: "m2-sqlite-ledger",
        value: asJsonValue(snapshot),
      },
    ];
  }

  #recordRealizedEffect(
    attempt: ExecutionAttemptReadModel,
    reservation: InFlightExecutionReservation,
    input: Extract<
      ExecutionTerminalInput,
      { readonly status: "VERIFIED_SUCCESS" | "RECONCILED" }
    >,
    createdAt: string,
  ): void {
    const realizedEffectId = stableTupleId("realized-effect", [
      input.terminalEventId,
    ]);
    this.#database
      .prepare(
        `INSERT INTO realized_effects
           (realized_effect_id, execution_attempt_id, created_at, body_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        realizedEffectId,
        attempt.executionAttemptId,
        createdAt,
        canonicalJson({
          realizedEffectId,
          executionAttemptId: attempt.executionAttemptId,
          canonicalNormalizedEffect: reservation.canonicalNormalizedEffect,
          receiptReference: input.receiptReference,
          authoritativeState:
            input.status === "VERIFIED_SUCCESS"
              ? input.observedAfterState
              : input.authoritativeState,
          actualConsumption: input.actualConsumption,
        }),
      );
    if (reservation.claimAccounting === "additional") {
      this.#recordRealizedConsumptionFact(
        reservation,
        input,
        createdAt,
      );
    }
    for (const actual of input.actualConsumption) {
      this.#requireResource(actual.resourceKey);
      this.#validateActualWorkClass(
        attempt.admissionRecordId,
        actual.resourceKey,
        actual.workClassKey,
      );
      this.#appendAdmissionAddendumWithId(
        stableTupleId("actual-consumption", [
          input.terminalEventId,
          actual.resourceKey,
          actual.workClassKey,
        ]),
        attempt.admissionRecordId,
        "actual_consumption",
        {
          resourceKey: actual.resourceKey,
          workClassKey: actual.workClassKey,
          actualConsumption: actual.value,
          observedAt: createdAt,
          sourceReceipt: input.receiptReference,
        },
        createdAt,
      );
    }
    this.#appendAdmissionAddendumWithId(
      stableTupleId("outcome", [input.terminalEventId]),
      attempt.admissionRecordId,
      "outcome",
      {
        outcome: "completed",
        completedAt: createdAt,
        sourceReceipt: input.receiptReference,
      },
      createdAt,
    );
    this.#appendAdmissionAddendum(
      attempt.admissionRecordId,
      "receipt_reference",
      {
        executionAttemptId: attempt.executionAttemptId,
        receiptReference: input.receiptReference,
        realizedEffectId,
      },
    );
  }

  #preflightTerminalActualConsumption(
    attempt: ExecutionAttemptReadModel,
    reservation: InFlightExecutionReservation,
    input: Extract<
      ExecutionTerminalInput,
      { readonly status: "VERIFIED_SUCCESS" | "RECONCILED" }
    >,
  ): void {
    const resources = this.#readResources();
    for (const actual of input.actualConsumption) {
      this.#requireResource(actual.resourceKey);
      this.#validateActualWorkClass(
        attempt.admissionRecordId,
        actual.resourceKey,
        actual.workClassKey,
      );
    }
    for (const [resourceKey, actualValue] of aggregateActualConsumption(
      input.actualConsumption,
    )) {
      const resource = resources.find(
        (candidate) => candidate.resourceKey === resourceKey,
      );
      if (resource === undefined) {
        throw new StatefulInputError(
          "actualConsumption.resourceKey",
          `unknown resource ${resourceKey}`,
        );
      }
      if (
        reservation.claimAccounting === "additional" &&
        actualValue > 0 &&
        resource.timeUnit !== null &&
        (reservation.temporalClaim === null ||
          reservation.temporalClaim.resourceKey !== resourceKey ||
          reservation.temporalClaim.timeUnit !== resource.timeUnit)
      ) {
        throw new StatefulInputError(
          "actualConsumption",
          "time-compatible realized consumption requires the immutable temporal claim",
        );
      }
      if (
        reservation.claimAccounting === "additional" &&
        actualValue > 0 &&
        resource.timeUnit !== null &&
        reservation.temporalClaim !== null
      ) {
        const unitMilliseconds =
          resource.timeUnit === "minutes" ? 60_000 : 3_600_000;
        const windowDuration =
          (Date.parse(reservation.temporalClaim.end) -
            Date.parse(reservation.temporalClaim.start)) /
          unitMilliseconds;
        if (
          !Number.isSafeInteger(windowDuration) ||
          actualValue > windowDuration
        ) {
          throw new StatefulInputError(
            "actualConsumption",
            "realized timed consumption cannot exceed its immutable temporal window",
          );
        }
      }
    }
  }

  #recordRealizedConsumptionFact(
    reservation: InFlightExecutionReservation,
    input: Extract<
      ExecutionTerminalInput,
      { readonly status: "VERIFIED_SUCCESS" | "RECONCILED" }
    >,
    createdAt: string,
  ): void {
    const resources = this.#readResources();
    const resourceClaims = Object.fromEntries(
      resources.map((resource) => [resource.resourceKey, 0]),
    ) as Record<string, number>;
    for (const [resourceKey, actualValue] of aggregateActualConsumption(
      input.actualConsumption,
    )) {
      if (!Object.hasOwn(resourceClaims, resourceKey)) {
        throw new StatefulInputError(
          "actualConsumption.resourceKey",
          `unknown resource ${resourceKey}`,
        );
      }
      resourceClaims[resourceKey] = actualValue;
    }
    let temporalClaim = null as InFlightExecutionReservation["temporalClaim"];
    for (const resource of resources) {
      const actual = resourceClaims[resource.resourceKey];
      if (actual === undefined) {
        throw new StatefulInputError(
          "actualConsumption",
          "could not assemble the complete realized resource vector",
        );
      }
      if (resource.timeUnit !== null && actual > 0) {
        if (
          reservation.temporalClaim === null ||
          reservation.temporalClaim.resourceKey !== resource.resourceKey ||
          reservation.temporalClaim.timeUnit !== resource.timeUnit
        ) {
          throw new StatefulInputError(
            "actualConsumption",
            "time-compatible realized consumption requires the immutable temporal claim",
          );
        }
        temporalClaim = {
          ...reservation.temporalClaim,
          requiredDuration: actual,
        };
      }
    }
    const realizedConsumptionId = stableTupleId("realized-consumption", [
      input.terminalEventId,
    ]);
    const fact: RealizedConsumptionReservationFact = {
      schemaVersion: "flakebrake-realized-consumption/v0.1-m2",
      realizedConsumptionId,
      sourceTerminalEventId: input.terminalEventId,
      sourceReservationId: reservation.reservationId,
      executionAttemptId: reservation.executionAttemptId,
      admissionRecordId: reservation.admissionRecordId,
      authorizationIdentity: reservationAuthorizationIdentity(reservation),
      lockedOperationId: effectFingerprintIdentity(
        reservation.rawEffectFingerprint,
      ).digest,
      affectedObligationIds: reservation.affectedObligationIds,
      resourceClaims,
      actualConsumptionCoordinates: input.actualConsumption.map((actual) => ({
        resourceKey: actual.resourceKey,
        workClassKey: actual.workClassKey,
        actualConsumptionFactId: stableTupleId("actual-consumption", [
          input.terminalEventId,
          actual.resourceKey,
          actual.workClassKey,
        ]),
      })),
      temporalClaim,
      expectedPostcondition: reservation.expectedAfterState,
      claimAccounting: "additional",
      applicableResourceHorizons: resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        start: resource.horizonStart,
        end: resource.horizonEnd,
      })),
      recordedAt: createdAt,
    };
    this.#database
      .prepare(
        `INSERT INTO realized_consumption_facts
           (realized_consumption_id, execution_attempt_id, created_at, body_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        realizedConsumptionId,
        reservation.executionAttemptId,
        createdAt,
        canonicalJson(fact),
      );
  }

  #requireResource(resourceKey: string): void {
    const row = this.#database
      .prepare(
        `SELECT 1 AS found FROM capacity_resources WHERE resource_key = ?`,
      )
      .get(resourceKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new StatefulInputError("resourceKey", `unknown resource ${resourceKey}`);
    }
  }

  #validateActualWorkClass(
    admissionRecordId: string,
    resourceKey: string,
    workClassKey: string,
  ): void {
    const record = this.getAdmissionRecord(admissionRecordId).record;
    const obligations = [
      ...record.m1Result.promiseBasis.acceptedPortfolio,
      record.proposalSnapshot,
    ];
    const declared = obligations.some(
      (obligation) =>
        obligation.workClassByResource[resourceKey] === workClassKey,
    );
    if (!declared) {
      throw new StatefulInputError(
        "workClassKey",
        "must be an authoritative work class from the referenced AdmissionRecord",
      );
    }
  }

  #timestamp(): string {
    const value = this.#now();
    assertCanonicalTimestamp(value, "now()");
    return value;
  }
}

export function createStore(options: CreateStoreOptions): FlakeBrakeStore {
  return new FlakeBrakeStore(options);
}

function canonicalInitialState(value: StatefulInitialState): StatefulInitialState {
  const state = canonicalClone<StatefulInitialState>(value);
  if (!Array.isArray(state.resources) || state.resources.length === 0) {
    throw new StatefulInputError("initialState.resources", "must not be empty");
  }
  if (!Array.isArray(state.acceptedObligations)) {
    throw new StatefulInputError(
      "initialState.acceptedObligations",
      "must be an array",
    );
  }
  const resources = canonicalResources(state.resources);
  const acceptedObligations = [...state.acceptedObligations]
    .map((obligation, index) => {
      if (obligation.status !== "accepted") {
        throw new StatefulInputError(
          `initialState.acceptedObligations.${index}.status`,
          "must be accepted",
        );
      }
      assertNonEmptyString(
        obligation.obligationId,
        `initialState.acceptedObligations.${index}.obligationId`,
      );
      return canonicalClone<AcceptedObligation>(obligation);
    })
    .sort((left, right) =>
      compareStableStrings(left.obligationId, right.obligationId),
    );
  assertUniqueStrings(
    acceptedObligations.map((obligation) => obligation.obligationId),
    "initial obligation IDs",
  );
  if (!Array.isArray(state.assumptions)) {
    throw new StatefulInputError("initialState.assumptions", "must be an array");
  }
  if (!Array.isArray(state.combinedDecisionProofs)) {
    throw new StatefulInputError(
      "initialState.combinedDecisionProofs",
      "must be an array",
    );
  }
  return deepFreeze({
    acceptedObligations,
    resources,
    assumptions: canonicalClone(state.assumptions),
    combinedDecisionProofs: canonicalClone(state.combinedDecisionProofs),
  });
}

function canonicalResources(
  values: readonly CapacityResource[],
): readonly CapacityResource[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new StatefulInputError("resources", "must be a nonempty array");
  }
  const resources = values
    .map((resource, index) => {
      assertNonEmptyString(resource.resourceKey, `resources.${index}.resourceKey`);
      if (!["human", "agent", "operational"].includes(resource.side)) {
        throw new StatefulInputError(`resources.${index}.side`, "unsupported side");
      }
      if (!["generic", "meaningful_decisions"].includes(resource.capacityKind)) {
        throw new StatefulInputError(
          `resources.${index}.capacityKind`,
          "unsupported capacity kind",
        );
      }
      assertNonEmptyString(resource.unit, `resources.${index}.unit`);
      if (
        resource.timeUnit !== null &&
        resource.timeUnit !== "minutes" &&
        resource.timeUnit !== "hours"
      ) {
        throw new StatefulInputError(
          `resources.${index}.timeUnit`,
          "unsupported time unit",
        );
      }
      if (
        !Number.isFinite(Date.parse(resource.horizonStart)) ||
        !Number.isFinite(Date.parse(resource.horizonEnd)) ||
        Date.parse(resource.horizonStart) >= Date.parse(resource.horizonEnd)
      ) {
        throw new StatefulInputError(
          `resources.${index}.horizon`,
          "must be a valid increasing ISO time window",
        );
      }
      requireNonNegativeSafeInteger(
        resource.capacity,
        `resources.${index}.capacity`,
      );
      requireNonNegativeSafeInteger(
        resource.safetyReserve,
        `resources.${index}.safetyReserve`,
      );
      if (resource.safetyReserve > resource.capacity) {
        throw new StatefulInputError(
          `resources.${index}.safetyReserve`,
          "must not exceed declared capacity",
        );
      }
      assertNonEmptyString(
        resource.estimatorRule,
        `resources.${index}.estimatorRule`,
      );
      if (!Array.isArray(resource.assumptions)) {
        throw new StatefulInputError(
          `resources.${index}.assumptions`,
          "must be an array",
        );
      }
      return canonicalClone<CapacityResource>(resource);
    })
    .sort((left, right) =>
      compareStableStrings(left.resourceKey, right.resourceKey),
    );
  assertUniqueStrings(
    resources.map((resource) => resource.resourceKey),
    "resource keys",
  );
  return resources;
}

function capacityModelPart(resource: CapacityResource): CapacityModelPart {
  return {
    resourceKey: resource.resourceKey,
    side: resource.side,
    capacityKind: resource.capacityKind,
    unit: resource.unit,
    timeUnit: resource.timeUnit,
    estimatorRule: resource.estimatorRule,
    assumptions: resource.assumptions,
  };
}

function capacityPlanPart(resource: CapacityResource): CapacityPlanPart {
  return {
    resourceKey: resource.resourceKey,
    horizonStart: resource.horizonStart,
    horizonEnd: resource.horizonEnd,
    capacity: resource.capacity,
    safetyReserve: resource.safetyReserve,
  };
}

function requireSameResourceKeys(
  current: readonly CapacityResource[],
  replacement: readonly CapacityResource[],
): void {
  if (
    canonicalSerialize(current.map((resource) => resource.resourceKey)) !==
    canonicalSerialize(replacement.map((resource) => resource.resourceKey))
  ) {
    throw new StatefulInputError(
      "resources",
      "M2 material replacements must preserve the current bounded resource-key set",
    );
  }
}

function validateAdmissionRequest(value: AdmissionRequest): AdmissionRequest {
  const request = canonicalClone<AdmissionRequest>(value);
  if (request.proposal.status !== "proposed") {
    throw new StatefulInputError("proposal.status", "must be proposed");
  }
  assertNonEmptyString(request.proposal.obligationId, "proposal.obligationId");
  if (
    request.assumptions !== undefined &&
    !Array.isArray(request.assumptions)
  ) {
    throw new StatefulInputError("assumptions", "must be an array");
  }
  if (
    request.combinedDecisionProofs !== undefined &&
    !Array.isArray(request.combinedDecisionProofs)
  ) {
    throw new StatefulInputError("combinedDecisionProofs", "must be an array");
  }
  return request;
}

function storedSelectedPlan(result: AdmissionResult): StoredSelectedPlan {
  if (result.decision === "ADMITTABLE") {
    const selectedPlanId = result.promiseBasis.selectedPlanIds[0];
    if (selectedPlanId === undefined) throw new Error("M1 omitted direct selected plan");
    return { kind: "selected", selectedPlanId };
  }
  if (result.decision === "REPLAN") {
    if (result.recommendedCandidate !== null) {
      return {
        kind: "selected",
        selectedPlanId: result.recommendedCandidate.candidatePlanId,
      };
    }
    return {
      kind: "owner_choice_required",
      candidatePlanIds: result.candidates.map(
        (candidate) => candidate.candidatePlanId,
      ),
    };
  }
  return { kind: "no_feasible_plan" };
}

function selectedCapacity(
  result: AdmissionResult,
  selectedPlan: StoredSelectedPlan,
): AdmissionResult["directPlan"] {
  if (result.decision !== "REPLAN" || selectedPlan.kind !== "selected") {
    return result.directPlan;
  }
  return (
    result.candidates.find(
      (candidate) => candidate.candidatePlanId === selectedPlan.selectedPlanId,
    )?.capacity ?? result.directPlan
  );
}

function compareAdmissionBasis(
  expected: AcceptPromiseInput,
  current: AdmissionBasisValues,
): AdmissionBasisMismatch[] {
  const mismatches: AdmissionBasisMismatch[] = [];
  if (expected.expectedPortfolioVersion !== current.portfolioVersion) {
    mismatches.push("portfolio_version");
  }
  if (expected.expectedCapacityModelVersion !== current.capacityModelVersion) {
    mismatches.push("capacity_model_version");
  }
  if (expected.expectedCapacityPlanVersion !== current.capacityPlanVersion) {
    mismatches.push("capacity_plan_version");
  }
  if (
    expected.expectedAuthorizationStateVersion !==
    current.authorizationStateVersion
  ) {
    mismatches.push("authorization_state_version");
  }
  if (
    expected.expectedCalibrationFrontierDigest !==
    current.calibrationFrontierDigest
  ) {
    mismatches.push("calibration_frontier_digest");
  }
  return mismatches;
}

function uniqueMismatches(
  values: readonly AdmissionBasisMismatch[],
): AdmissionBasisMismatch[] {
  const order: readonly AdmissionBasisMismatch[] = [
    "portfolio_version",
    "capacity_model_version",
    "capacity_plan_version",
    "authorization_state_version",
    "calibration_frontier_digest",
  ];
  const present = new Set(values);
  return order.filter((value) => present.has(value));
}

function acceptanceAuthorizationRequest(
  input: AcceptPromiseInput,
): AcceptPromiseInput & { readonly ownerSourceIdentity: string } {
  return canonicalClone({
    ...input,
    ownerSourceIdentity:
      input.ownerSourceIdentity ??
      `owner-source/legacy-approver/${input.approverId}`,
  });
}

function legacyAcceptanceAuthorizationRequest(
  record: AdmissionRecordBody,
  acceptanceCommit: { readonly [key: string]: JsonValue },
  ownerDecision: Record<string, unknown> | null,
): AcceptPromiseInput & { readonly ownerSourceIdentity: string } {
  if (
    ownerDecision === null ||
    ownerDecision["kind"] !== "ACCEPT_PROMISE" ||
    ownerDecision["admissionRecordId"] !== record.admissionRecordId ||
    ownerDecision["ownerDecisionId"] !== acceptanceCommit["ownerDecisionId"] ||
    ownerDecision["selectedPlanId"] !== acceptanceCommit["selectedPlanId"] ||
    typeof ownerDecision["approverId"] !== "string" ||
    typeof ownerDecision["ownerSourceIdentity"] !== "string"
  ) {
    throw new StatefulInputError(
      "acceptanceCompatibility",
      "legacy acceptance lacks provable immutable approver or owner-source identity",
    );
  }
  return canonicalClone({
    admissionRecordId: record.admissionRecordId,
    selectedPlanId: ownerDecision["selectedPlanId"] as string,
    ownerDecisionId: ownerDecision["ownerDecisionId"] as string,
    approverId: ownerDecision["approverId"],
    ownerSourceIdentity: ownerDecision["ownerSourceIdentity"],
    expectedPortfolioVersion: record.portfolioVersion,
    expectedCapacityModelVersion: record.capacityModelVersion,
    expectedCapacityPlanVersion: record.capacityPlanVersion,
    expectedAuthorizationStateVersion: record.authorizationStateVersion,
    expectedCalibrationFrontierDigest: record.calibrationFrontierDigest,
  });
}

function compareExecutionVersions(
  expected: ClaimExecutionInput,
  current: VersionTuple,
): AdmissionBasisMismatch[] {
  const mismatches: AdmissionBasisMismatch[] = [];
  if (expected.expectedPortfolioVersion !== current.portfolioVersion) {
    mismatches.push("portfolio_version");
  }
  if (expected.expectedCapacityModelVersion !== current.capacityModelVersion) {
    mismatches.push("capacity_model_version");
  }
  if (expected.expectedCapacityPlanVersion !== current.capacityPlanVersion) {
    mismatches.push("capacity_plan_version");
  }
  if (
    expected.expectedAuthorizationStateVersion !==
    current.authorizationStateVersion
  ) {
    mismatches.push("authorization_state_version");
  }
  return mismatches;
}

function inputBasisJson(input: AcceptPromiseInput): JsonValue {
  return {
    portfolioVersion: input.expectedPortfolioVersion,
    capacityModelVersion: input.expectedCapacityModelVersion,
    capacityPlanVersion: input.expectedCapacityPlanVersion,
    authorizationStateVersion: input.expectedAuthorizationStateVersion,
    calibrationFrontierDigest: input.expectedCalibrationFrontierDigest,
  };
}

function basisValuesJson(result: AdmissionBasisValues): JsonValue {
  return {
    portfolioVersion: result.portfolioVersion,
    capacityModelVersion: result.capacityModelVersion,
    capacityPlanVersion: result.capacityPlanVersion,
    authorizationStateVersion: result.authorizationStateVersion,
    calibrationFrontierDigest: result.calibrationFrontierDigest,
  };
}

function planExists(record: AdmissionRecordBody, selectedPlanId: string): boolean {
  if (record.decision === "ADMITTABLE") {
    return record.m1Result.promiseBasis.selectedPlanIds.includes(selectedPlanId);
  }
  return record.candidatePlans.some(
    (candidate) => candidate.candidatePlanId === selectedPlanId,
  );
}

function materializeSelectedPortfolio(
  record: AdmissionRecordBody,
  selectedPlanId: string,
): readonly AcceptedObligation[] {
  const accepted = record.m1Result.promiseBasis.acceptedPortfolio;
  const proposal = record.proposalSnapshot;
  let selectedCandidate: ReplanCandidate | null = null;
  if (record.decision === "REPLAN") {
    selectedCandidate =
      record.candidatePlans.find(
        (candidate) => candidate.candidatePlanId === selectedPlanId,
      ) ?? null;
    if (selectedCandidate === null || !selectedCandidate.feasible) {
      throw new StatefulInputError("selectedPlanId", "candidate is not feasible");
    }
  }
  const changes = selectedCandidate?.affectedObligations ?? [];
  const materializedAccepted = accepted.map((obligation) => {
    const change = changes.find(
      (candidate) =>
        candidate.obligationId === obligation.obligationId &&
        candidate.obligationStatus === "accepted",
    );
    return change === undefined
      ? obligation
      : applyModificationOption(obligation, change.optionId);
  });
  const proposalChange = changes.find(
    (candidate) =>
      candidate.obligationId === proposal.obligationId &&
      candidate.obligationStatus === "proposed",
  );
  const finalProposal =
    proposalChange === undefined
      ? proposal
      : applyModificationOption(proposal, proposalChange.optionId);
  return deepFreeze(
    [...materializedAccepted, proposedToAccepted(finalProposal)].sort(
      (left, right) =>
        compareStableStrings(left.obligationId, right.obligationId),
    ),
  );
}

function applyModificationOption<T extends AcceptedObligation | ProposedObligation>(
  obligation: T,
  optionId: string,
): T {
  const option = obligation.modificationOptions.find(
    (candidate) => candidate.optionId === optionId,
  );
  if (option === undefined) {
    throw new StatefulInputError(
      "selectedPlanId",
      `missing source modification option ${optionId}`,
    );
  }
  return canonicalClone<T>({
    ...obligation,
    serviceLevel: { ...obligation.serviceLevel, ...option.changes },
    resourceDemand: option.resourceDemand,
  });
}

function proposedToAccepted(proposal: ProposedObligation): AcceptedObligation {
  const { acceptanceDecision: _acceptanceDecision, ...core } = proposal;
  void _acceptanceDecision;
  return canonicalClone<AcceptedObligation>({ ...core, status: "accepted" });
}

function reservationToM1(
  reservation: InFlightExecutionReservation,
): FixedCapacityReservation {
  return {
    reservationId: reservation.reservationId,
    executionAttemptId: reservation.executionAttemptId,
    authorizationIdentity: reservationAuthorizationIdentity(reservation),
    lockedOperationId: effectFingerprintIdentity(
      reservation.rawEffectFingerprint,
    ).digest,
    affectedObligationIds: reservation.affectedObligationIds,
    resourceClaims: reservation.resourceCapacityClaims,
    temporalClaim: reservation.temporalClaim,
    expectedPostcondition: reservation.expectedAfterState,
    claimAccounting: reservation.claimAccounting,
  };
}

function reservationAuthorizationIdentity(
  reservation: InFlightExecutionReservation,
): string {
  return stableTupleId("reservation-authorization", [
    reservation.grantId,
    reservation.grantAllowanceKey,
    reservation.admissionRecordId,
    reservation.promiseBasisId,
    reservation.acceptedOwnerDecisionId,
    reservation.grantOwnerDecisionId,
    reservation.selectedPlanId,
    reservation.selectedBundleId,
  ]);
}

function validateAcceptPromiseInput(input: AcceptPromiseInput): void {
  for (const [path, value] of Object.entries(input)) {
    assertNonEmptyString(value, path);
  }
  assertSha256Digest(
    input.expectedCalibrationFrontierDigest,
    "expectedCalibrationFrontierDigest",
  );
}

function validateOwnerDecisionInput(input: OwnerDecisionInput): void {
  canonicalSerialize(input);
  for (const [path, value] of [
    ["admissionRecordId", input.admissionRecordId],
    ["ownerDecisionId", input.ownerDecisionId],
    ["approverId", input.approverId],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  if (input.kind === "DECLINE") {
    assertNonEmptyString(input.reason, "reason");
  } else {
    assertNonEmptyString(input.selectedPlanId, "selectedPlanId");
    if (
      input.replacementProposal !== undefined &&
      input.replacementProposal.status !== "proposed"
    ) {
      throw new StatefulInputError(
        "replacementProposal.status",
        "must be proposed",
      );
    }
  }
}

function validateIssueGrantInput(input: IssueGrantInput): void {
  canonicalSerialize(input);
  for (const [path, value] of [
    ["grantId", input.grantId],
    ["grantVersion", input.grantVersion],
    ["admissionRecordId", input.admissionRecordId],
    ["promiseBasisId", input.promiseBasisId],
    ["acceptedOwnerDecisionId", input.acceptedOwnerDecisionId],
    ["ownerDecisionId", input.ownerDecisionId],
    ["selectedBundleId", input.selectedBundleId],
    ["selectedPlanId", input.selectedPlanId],
    ["expectedPortfolioVersion", input.expectedPortfolioVersion],
    ["expectedCapacityModelVersion", input.expectedCapacityModelVersion],
    ["expectedCapacityPlanVersion", input.expectedCapacityPlanVersion],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  if (input.postDenialAuthorization !== null) {
    assertNonEmptyString(
      input.postDenialAuthorization.parentDenialId,
      "postDenialAuthorization.parentDenialId",
    );
    if (input.postDenialAuthorization.changeClass !== "narrower_scope") {
      throw new StatefulInputError(
        "postDenialAuthorization.changeClass",
        "must be narrower_scope",
      );
    }
  }
  canonicalizeApprovalScope(input.scope);
}

function requireExpectedVersions(
  current: VersionTuple,
  portfolio: string,
  capacityModel: string,
  capacityPlan: string,
): void {
  if (
    current.portfolioVersion !== portfolio ||
    current.capacityModelVersion !== capacityModel ||
    current.capacityPlanVersion !== capacityPlan
  ) {
    throw new StatefulInputError(
      "expectedVersions",
      "grant issuance basis is stale",
    );
  }
}

function assertSameMaterialAllowance(
  existing: GrantAllowanceBase,
  requested: GrantAllowanceBase,
): void {
  const existingMaterial = {
    grantAllowanceKey: existing.grantAllowanceKey,
    decisionId: existing.decisionId,
    admissionRecordId: existing.admissionRecordId,
    promiseBasisId: existing.promiseBasisId,
    acceptedOwnerDecisionId: existing.acceptedOwnerDecisionId,
    selectedBundleId: existing.selectedBundleId,
    selectedPlanId: existing.selectedPlanId,
    canonicalApprovedScope: existing.canonicalApprovedScope,
    approverId: existing.approverId,
    maxExecutions: existing.maxExecutions,
    postDenialAuthorization: existing.postDenialAuthorization,
  };
  const requestedMaterial = {
    grantAllowanceKey: requested.grantAllowanceKey,
    decisionId: requested.decisionId,
    admissionRecordId: requested.admissionRecordId,
    promiseBasisId: requested.promiseBasisId,
    acceptedOwnerDecisionId: requested.acceptedOwnerDecisionId,
    selectedBundleId: requested.selectedBundleId,
    selectedPlanId: requested.selectedPlanId,
    canonicalApprovedScope: requested.canonicalApprovedScope,
    approverId: requested.approverId,
    maxExecutions: requested.maxExecutions,
    postDenialAuthorization: requested.postDenialAuthorization,
  };
  if (canonicalSerialize(existingMaterial) !== canonicalSerialize(requestedMaterial)) {
    throw new StatefulInputError(
      "grantAllowanceKey",
      "resolved to conflicting immutable allowance data",
    );
  }
}

function assertSameGrant(existing: GrantBase, requested: GrantBase): void {
  const material = (grant: GrantBase) => ({
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantAllowanceKey: grant.grantAllowanceKey,
    decisionId: grant.decisionId,
    admissionRecordId: grant.admissionRecordId,
    promiseBasisId: grant.promiseBasisId,
    acceptedOwnerDecisionId: grant.acceptedOwnerDecisionId,
    selectedBundleId: grant.selectedBundleId,
    selectedPlanId: grant.selectedPlanId,
    portfolioVersion: grant.portfolioVersion,
    capacityModelVersion: grant.capacityModelVersion,
    capacityPlanVersion: grant.capacityPlanVersion,
    scope: grant.scope,
    postDenialAuthorization: grant.postDenialAuthorization,
    status: grant.status,
  });
  if (canonicalSerialize(material(existing)) !== canonicalSerialize(material(requested))) {
    throw new StatefulInputError("grantId", "was reused with different grant data");
  }
}

function validateCreateDenialInput(input: CreateDenialInput): void {
  canonicalSerialize(input);
  for (const [path, value] of [
    ["denialId", input.denialId],
    ["objectiveId", input.objectiveId],
    ["approverId", input.approverId],
    ["evidencePacketId", input.evidencePacketId],
    ["missionId", input.missionId],
    ["reason", input.reason],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  validateEffectFingerprint(input.deniedEffectFingerprint);
  canonicalizeApprovalScope(input.deniedScope);
}

function assertSameDenialInput(
  existing: DenialConstraint,
  input: CreateDenialInput,
  scope: CanonicalApprovalScope,
  digest: string,
): void {
  const existingMaterial = {
    denialId: existing.denialId,
    deniedEffectFingerprint: existing.deniedEffectFingerprint,
    deniedEffectFingerprintDigest: existing.deniedEffectFingerprintDigest,
    deniedScope: existing.deniedScope,
    objectiveId: existing.objectiveId,
    approverId: existing.approverId,
    evidencePacketId: existing.evidencePacketId,
    missionId: existing.missionId,
    reason: existing.reason,
  };
  const requestedMaterial = {
    denialId: input.denialId,
    deniedEffectFingerprint: input.deniedEffectFingerprint,
    deniedEffectFingerprintDigest: digest,
    deniedScope: scope,
    objectiveId: input.objectiveId,
    approverId: input.approverId,
    evidencePacketId: input.evidencePacketId,
    missionId: input.missionId,
    reason: input.reason,
  };
  if (canonicalSerialize(existingMaterial) !== canonicalSerialize(requestedMaterial)) {
    throw new StatefulInputError("denialId", "was reused with different denial data");
  }
}

function validateCreateDenialExceptionInput(
  input: CreateDenialExceptionInput,
): void {
  canonicalSerialize(input);
  for (const [path, value] of Object.entries(input)) {
    assertNonEmptyString(value, path);
  }
}

function assertSameDenialExceptionInput(
  existing: DenialExceptionReadModel,
  input: CreateDenialExceptionInput,
): void {
  if (
    existing.denialExceptionId !== input.denialExceptionId ||
    existing.parentDenialId !== input.parentDenialId ||
    existing.ownerDecisionId !== input.ownerDecisionId ||
    existing.grantAllowanceKey !== input.grantAllowanceKey
  ) {
    throw new StatefulInputError(
      "denialExceptionId",
      "was reused with different exception data",
    );
  }
}

function denyAuthorization(
  reason: Extract<AuthorizationEvaluation, { decision: "DENY" }>["reason"],
  denialId: string | null,
  explanation: string,
): AuthorizationEvaluation {
  return deepFreeze({ decision: "DENY", reason, denialId, explanation });
}

function validateClaimExecutionInput(input: ClaimExecutionInput): void {
  canonicalSerialize(input);
  for (const [path, value] of [
    ["executionAttemptId", input.executionAttemptId],
    ["admissionRecordId", input.admissionRecordId],
    ["promiseBasisId", input.promiseBasisId],
    ["acceptedOwnerDecisionId", input.acceptedOwnerDecisionId],
    ["grantOwnerDecisionId", input.grantOwnerDecisionId],
    ["grantId", input.grantId],
    ["expectedGrantVersion", input.expectedGrantVersion],
    ["grantAllowanceKey", input.grantAllowanceKey],
    ["selectedBundleId", input.selectedBundleId],
    ["selectedPlanId", input.selectedPlanId],
    ["expectedPortfolioVersion", input.expectedPortfolioVersion],
    ["expectedCapacityModelVersion", input.expectedCapacityModelVersion],
    ["expectedCapacityPlanVersion", input.expectedCapacityPlanVersion],
    ["expectedAuthorizationStateVersion", input.expectedAuthorizationStateVersion],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  assertSha256Digest(
    input.expectedCalibrationFrontierDigest,
    "expectedCalibrationFrontierDigest",
  );
  assertCanonicalTimestamp(input.attemptedAt, "attemptedAt");
  validateEffectFingerprint(input.effect);
  if (input.affectedObligationIds.length === 0) {
    throw new StatefulInputError("affectedObligationIds", "must not be empty");
  }
  assertUniqueStrings(input.affectedObligationIds, "affectedObligationIds");
  assertUniqueStrings(input.affectedResourceIds, "affectedResourceIds");
  if (
    input.claimAccounting !== "additional" &&
    input.claimAccounting !== "already_in_portfolio"
  ) {
    throw new StatefulInputError("claimAccounting", "unsupported accounting mode");
  }
}

function terminalEventKind(input: ExecutionTerminalInput): string {
  switch (input.status) {
    case "VERIFIED_SUCCESS":
      return "terminal_verified";
    case "DEFINITIVE_FAILURE_BEFORE_MUTATION":
      return "terminal_failed_before_mutation";
    case "UNCERTAIN_OUTCOME":
      return "uncertain_outcome";
    case "RECONCILED":
      return "terminal_reconciled";
    default:
      return assertNever(input);
  }
}

function validateCreateExecutionFenceInput(
  input: CreateExecutionFenceInput,
): void {
  const value = exactObject(input, "executionFence");
  requireExactObjectKeys(
    value,
    [
      "executionAttemptId",
      "expectedCommandDigest",
      "executorAuthority",
      "environmentId",
    ],
    "executionFence",
  );
  assertNonEmptyString(input.executionAttemptId, "executionAttemptId");
  assertSha256Digest(input.expectedCommandDigest, "expectedCommandDigest");
  if (input.executorAuthority !== "factory-change-control/v1") {
    throw new StatefulInputError(
      "executorAuthority",
      "must identify the bounded factory change-control executor",
    );
  }
  assertNonEmptyString(input.environmentId, "environmentId");
}

function assertFenceCreationMatches(
  fence: ExecutionFenceReadModel,
  input: CreateExecutionFenceInput,
): void {
  if (
    fence.executionAttemptId !== input.executionAttemptId ||
    fence.expectedCommandDigest !== input.expectedCommandDigest ||
    fence.executorAuthority !== input.executorAuthority ||
    fence.environmentId !== input.environmentId
  ) {
    throw new StatefulInputError(
      "executionAttemptId",
      "execution fence identity was reused with different authority or command data",
    );
  }
}

function validateFenceResultBinding(
  binding: ExecutionFenceResultBinding,
  fence: ExecutionFenceReadModel,
): void {
  const value = exactObject(binding, "executionFenceResultBinding");
  requireExactObjectKeys(
    value,
    [
      "schemaVersion",
      "fenceId",
      "executionAttemptId",
      "environmentId",
      "receiptId",
      "factoryResultDigest",
    ],
    "executionFenceResultBinding",
  );
  if (
    binding.schemaVersion !== "flakebrake-execution-fence-result/v1" ||
    binding.fenceId !== fence.fenceId ||
    binding.executionAttemptId !== fence.executionAttemptId ||
    binding.environmentId !== fence.environmentId ||
    !binding.receiptId.startsWith("factory-mutation-receipt/sha256:")
  ) {
    throw new StatefulInputError(
      "executionFenceResultBinding",
      "does not match the immutable execution fence identity",
    );
  }
  assertSha256Digest(binding.factoryResultDigest, "factoryResultDigest");
}

function factoryEvidenceBinding(
  evidence: AuthoritativeFactoryExecutionEvidence,
): ExecutionFenceResultBinding {
  return {
    schemaVersion: "flakebrake-execution-fence-result/v1",
    fenceId: evidence.result.fenceId,
    executionAttemptId: evidence.result.executionAttemptId,
    environmentId: evidence.environmentId,
    receiptId: evidence.result.receipt.receiptId,
    factoryResultDigest: evidence.resultDigest,
  };
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value), "utf8")
    .digest("hex")}`;
}

function validateExecutionTerminalInput(input: ExecutionTerminalInput): void {
  canonicalSerialize(input);
  const value = exactObject(input, "executionTerminal");
  assertNonEmptyString(value["terminalEventId"], "terminalEventId");
  assertNonEmptyString(value["executionAttemptId"], "executionAttemptId");
  const status = executionTerminalStatus(value["status"]);
  switch (status) {
    case "VERIFIED_SUCCESS":
      requireExactObjectKeys(
        value,
        [
          "terminalEventId",
          "executionAttemptId",
          "status",
          "receiptReference",
          "observedAfterState",
          "actualConsumption",
        ],
        "executionTerminal",
      );
      assertNonEmptyString(value["receiptReference"], "receiptReference");
      canonicalSerialize(value["observedAfterState"]);
      validateActualConsumptionValues(value["actualConsumption"]);
      return;
    case "DEFINITIVE_FAILURE_BEFORE_MUTATION":
      requireExactObjectKeys(
        value,
        [
          "terminalEventId",
          "executionAttemptId",
          "status",
          "evidenceReference",
        ],
        "executionTerminal",
      );
      assertNonEmptyString(value["evidenceReference"], "evidenceReference");
      return;
    case "UNCERTAIN_OUTCOME":
      requireExactObjectKeys(
        value,
        [
          "terminalEventId",
          "executionAttemptId",
          "status",
          "evidenceReference",
          "observedState",
        ],
        "executionTerminal",
      );
      assertNonEmptyString(value["evidenceReference"], "evidenceReference");
      canonicalSerialize(value["observedState"]);
      return;
    case "RECONCILED":
      requireExactObjectKeys(
        value,
        [
          "terminalEventId",
          "executionAttemptId",
          "status",
          "receiptReference",
          "authoritativeState",
          "actualConsumption",
        ],
        "executionTerminal",
      );
      assertNonEmptyString(value["receiptReference"], "receiptReference");
      canonicalSerialize(value["authoritativeState"]);
      validateActualConsumptionValues(value["actualConsumption"]);
      return;
    default:
      assertNever(status);
  }
}

function validateActualConsumptionValues(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new StatefulInputError("actualConsumption", "must be an array");
  }
  const coordinates: string[] = [];
  value.forEach((entry, index) => {
    validateActualConsumptionValue(entry, index);
    const actual = entry as Record<string, unknown>;
    coordinates.push(
      stableTupleId("actual-consumption-coordinate", [
        actual["resourceKey"] as string,
        actual["workClassKey"] as string,
      ]),
    );
  });
  assertUniqueStrings(
    coordinates,
    "actualConsumption.resourceKey/workClassKey",
  );
}

function aggregateActualConsumption(
  values: readonly ActualConsumptionValue[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const value of values) {
    const total = (totals.get(value.resourceKey) ?? 0) + value.value;
    if (!Number.isSafeInteger(total)) {
      throw new StatefulInputError(
        "actualConsumption",
        "aggregate resource consumption must be a safe integer",
      );
    }
    totals.set(value.resourceKey, total);
  }
  return totals;
}

function validateActualConsumptionValue(value: unknown, index: number): void {
  const entry = exactObject(value, `actualConsumption.${index}`);
  requireExactObjectKeys(
    entry,
    ["resourceKey", "workClassKey", "value"],
    `actualConsumption.${index}`,
  );
  assertNonEmptyString(
    entry["resourceKey"],
    `actualConsumption.${index}.resourceKey`,
  );
  assertNonEmptyString(
    entry["workClassKey"],
    `actualConsumption.${index}.workClassKey`,
  );
  requireNonNegativeSafeInteger(
    entry["value"],
    `actualConsumption.${index}.value`,
  );
}

function actualConsumptionBody(input: RecordActualConsumptionInput): JsonValue {
  return {
    resourceKey: input.resourceKey,
    workClassKey: input.workClassKey,
    actualConsumption: input.value,
    observedAt: input.observedAt,
    sourceReceipt: input.sourceReceipt,
  };
}

function validateActualConsumptionInput(input: RecordActualConsumptionInput): void {
  canonicalSerialize(input);
  assertNonEmptyString(
    input.actualConsumptionFactId,
    "actualConsumptionFactId",
  );
  assertNonEmptyString(input.admissionRecordId, "admissionRecordId");
  assertNonEmptyString(input.resourceKey, "resourceKey");
  assertNonEmptyString(input.workClassKey, "workClassKey");
  assertNonEmptyString(input.sourceReceipt, "sourceReceipt");
  assertCanonicalTimestamp(input.observedAt, "observedAt");
  requireNonNegativeSafeInteger(input.value, "value");
}

function validateOutcomeInput(input: RecordOutcomeInput): void {
  canonicalSerialize(input);
  assertNonEmptyString(input.outcomeFactId, "outcomeFactId");
  assertNonEmptyString(input.admissionRecordId, "admissionRecordId");
  assertNonEmptyString(input.sourceReceipt, "sourceReceipt");
  assertCanonicalTimestamp(input.completedAt, "completedAt");
  if (!["completed", "failed", "uncertain"].includes(input.outcome)) {
    throw new StatefulInputError("outcome", "unsupported outcome");
  }
}

function validateCorrectionInput(input: RecordCalibrationCorrectionInput): void {
  canonicalSerialize(input);
  for (const [path, value] of [
    ["correctionFactId", input.correctionFactId],
    ["admissionRecordId", input.admissionRecordId],
    [
      "correctsActualConsumptionFactId",
      input.correctsActualConsumptionFactId,
    ],
    ["reason", input.reason],
    ["sourceReceipt", input.sourceReceipt],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  requireNonNegativeSafeInteger(
    input.correctedActualConsumption,
    "correctedActualConsumption",
  );
}

function assertCanonicalTimestamp(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new StatefulInputError(path, "must be a canonical ISO-8601 timestamp");
  }
}

function executionTerminalStatus(
  value: unknown,
): ExecutionTerminalInput["status"] {
  switch (value) {
    case "VERIFIED_SUCCESS":
    case "DEFINITIVE_FAILURE_BEFORE_MUTATION":
    case "UNCERTAIN_OUTCOME":
    case "RECONCILED":
      return value;
    default:
      throw new StatefulInputError(
        "status",
        "must be a legal execution terminal status",
      );
  }
}

function exactObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new StatefulInputError(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function requireExactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      throw new StatefulInputError(`${path}.${key}`, "required field is missing");
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new StatefulInputError(`${path}.${key}`, "unknown field");
    }
  }
}

function versionOrdinal(value: string): number {
  const match = /^authorization\/v([1-9][0-9]*)$/u.exec(value);
  if (match === null) {
    throw new StatefulInputError(
      "authorizationStateVersion",
      "must be a canonical authorization version",
    );
  }
  const ordinal = Number(match[1]);
  if (!Number.isSafeInteger(ordinal)) {
    throw new StatefulInputError(
      "authorizationStateVersion",
      "is outside the supported deterministic range",
    );
  }
  return ordinal;
}

function windowsOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  return Date.parse(leftStart) < Date.parse(rightEnd) &&
    Date.parse(rightStart) < Date.parse(leftEnd);
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function earlierTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function assertSha256Digest(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new StatefulInputError(path, "must be a sha256 digest");
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StatefulInputError(path, "must be a non-empty string");
  }
}

function requireString(value: unknown, path: string): string {
  assertNonEmptyString(value, path);
  return value;
}

function requireSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${path}: expected a safe integer`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  const result = requireSafeInteger(value, path);
  if (result < 0) {
    throw new StatefulInputError(path, "must be nonnegative");
  }
  return result;
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  values.forEach((value, index) => assertNonEmptyString(value, `values.${index}`));
  assertUniqueStrings(values, "values");
  return [...values].sort(compareStableStrings);
}

function assertUniqueStrings(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new StatefulInputError(path, "must be unique");
  }
}

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new StatefulInputError(
    "discriminant",
    `unhandled discriminated union member ${canonicalSerialize(value)}`,
  );
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalSerialize(value)) as JsonValue;
}
