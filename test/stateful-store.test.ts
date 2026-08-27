import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { Worker } from "node:worker_threads";

import {
  AdmissionInputError,
  AuthorizationDeniedError,
  createStore,
  ExecutionAttemptConflictError,
  rational,
  StatefulInputError,
} from "../src/index.js";
import type {
  AcceptPromiseInput,
  AcceptedObligation,
  AdmissionRecordBody,
  ApprovalScope,
  CapacityResource,
  ClaimExecutionInput,
  DecisionSemantics,
  EffectFingerprint,
  ExecutionTerminalInput,
  FlakeBrakeStore,
  IssueGrantInput,
  ModificationOption,
  OwnerDecisionInput,
  ProposedObligation,
  ResourceDemand,
  SchedulingConstraint,
  StatefulInitialState,
  VersionTuple,
} from "../src/index.js";

const AGENT = "agent_work_units";
const HUMAN = "human_review_decisions";
const PRODUCTION = "production_cell_minutes";
const START = "2026-08-26T00:00:00.000Z";
const FIVE_MINUTES = "2026-08-26T00:05:00.000Z";
const END = "2026-08-26T01:00:00.000Z";
const HORIZON_END = "2026-08-27T00:00:00.000Z";

interface DemandValues {
  readonly agent: number;
  readonly human: number;
  readonly production: number;
}

interface ObligationOptions {
  readonly id: string;
  readonly status: "accepted" | "proposed";
  readonly criticality?: "protected" | "important" | "best_effort";
  readonly values?: DemandValues;
  readonly workClassPrefix?: string;
  readonly modificationOptions?: readonly ModificationOption[];
}

interface TempStore {
  readonly directory: string;
  readonly path: string;
  readonly store: FlakeBrakeStore;
}

function demand(values: DemandValues): ResourceDemand {
  return {
    [AGENT]: values.agent,
    [HUMAN]: values.human,
    [PRODUCTION]: values.production,
  };
}

function semantics(id: string): DecisionSemantics {
  return {
    objectiveId: `objective:${id}`,
    evidencePacketId: `evidence:${id}`,
    approverId: "owner-1",
    executionBoundaryId: `boundary:${id}`,
  };
}

function schedule(): SchedulingConstraint {
  return {
    kind: "deadline",
    start: START,
    end: END,
    resourceKey: PRODUCTION,
    timeUnit: "minutes",
  };
}

function reduceOption(id: string): ModificationOption {
  return {
    optionId: id,
    changes: { quantity: 5 },
    resourceDemand: demand({ agent: 1, human: 0, production: 10 }),
    addedCapacityCost: null,
    decisionSemantics: semantics(`modify:${id}`),
    reservationCompatibilityProofs: [],
    assumptions: [{ key: "option", source: "m2-test", value: id }],
  };
}

function obligationCore(options: ObligationOptions) {
  const criticality = options.criticality ?? "important";
  const values = options.values ?? { agent: 3, human: 0, production: 20 };
  const prefix = options.workClassPrefix ?? options.id;
  return {
    obligationId: options.id,
    beneficiary: `${options.id}-beneficiary`,
    objective: `${options.id}-objective`,
    serviceLevel: { quantity: 10 },
    protected: criticality === "protected",
    criticality,
    minimumService: { quantity: 5 },
    modificationPolicy: {
      modifiableFields: {
        quantity: {
          allowedBounds: { minimum: 5, maximum: 10 },
          utilityRule: {
            ruleId: "linear-quantity/v1",
            kind: "linear" as const,
            slope: rational(1),
            intercept: rational(0),
          },
          dimensionWeight: rational(1),
        },
      },
    },
    modificationOptions: options.modificationOptions ?? [],
    resourceDemand: demand(values),
    workClassByResource: {
      [AGENT]: `${prefix}:agent`,
      [HUMAN]: `${prefix}:human`,
      [PRODUCTION]: `${prefix}:production`,
    },
    schedulingConstraint: schedule(),
    pendingOwnerDecisions: [],
    assumptions: [{ key: "fixture", source: "m2-test", value: true }],
    evidenceRefs: [`evidence:${options.id}`],
    requiredEffects: [`effect:${options.id}`],
  };
}

function accepted(options: Omit<ObligationOptions, "status">): AcceptedObligation {
  return { ...obligationCore({ ...options, status: "accepted" }), status: "accepted" };
}

function proposed(options: Omit<ObligationOptions, "status">): ProposedObligation {
  return {
    ...obligationCore({ ...options, status: "proposed" }),
    status: "proposed",
    acceptanceDecision: semantics(`accept:${options.id}`),
  };
}

function resource(
  resourceKey: string,
  side: CapacityResource["side"],
  capacityKind: CapacityResource["capacityKind"],
  unit: string,
  capacity: number,
  timeUnit: CapacityResource["timeUnit"] = null,
): CapacityResource {
  return {
    resourceKey,
    side,
    capacityKind,
    unit,
    timeUnit,
    horizonStart: START,
    horizonEnd: HORIZON_END,
    capacity,
    safetyReserve: 0,
    estimatorRule: "declared-and-calibrated-demand/v1",
    assumptions: [{ key: "source", source: "owner", value: "m2-test" }],
  };
}

function resources(agentCapacity = 15): readonly CapacityResource[] {
  return [
    resource(AGENT, "agent", "generic", "work_units", agentCapacity),
    resource(
      HUMAN,
      "human",
      "meaningful_decisions",
      "meaningful_decisions",
      20,
    ),
    resource(
      PRODUCTION,
      "operational",
      "generic",
      "production_minutes",
      100,
      "minutes",
    ),
  ];
}

function initialState(agentCapacity = 15): StatefulInitialState {
  return {
    acceptedObligations: [
      accepted({
        id: "protected-order",
        criticality: "protected",
        values: { agent: 2, human: 0, production: 10 },
      }),
    ],
    resources: resources(agentCapacity),
    assumptions: [{ key: "state", source: "m2-test", value: "bounded" }],
    combinedDecisionProofs: [],
  };
}

function tempStore(agentCapacity = 15): TempStore {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m2-"));
  const path = join(directory, "state.sqlite");
  return {
    directory,
    path,
    store: createStore({
      path,
      initialState: initialState(agentCapacity),
      now: () => START,
    }),
  };
}

function tempStoreFromState(
  state: StatefulInitialState,
  now: () => string = () => START,
): TempStore {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m2-"));
  const path = join(directory, "state.sqlite");
  return {
    directory,
    path,
    store: createStore({ path, initialState: state, now }),
  };
}

function durableState(path: string): Readonly<Record<string, readonly string[]>> {
  const database = new DatabaseSync(path);
  const tables = [
    "state_versions",
    "state_config",
    "portfolio_obligations",
    "capacity_resources",
    "admission_records",
    "admission_addenda",
    "owner_decisions",
    "grant_allowances",
    "grants",
    "authorization_events",
    "denials",
    "denial_exceptions",
    "execution_attempts",
    "allowance_claims",
    "inflight_reservations",
    "reservation_events",
    "realized_effects",
    "realized_consumption_facts",
  ] as const;
  try {
    return Object.fromEntries(
      tables.map((table) => {
        const rows = database.prepare(`SELECT * FROM ${table}`).all() as Record<
          string,
          unknown
        >[];
        return [
          table,
          rows
            .map((row) =>
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(row).sort(([left], [right]) =>
                    left.localeCompare(right),
                  ),
                ),
              ),
            )
            .sort(),
        ];
      }),
    );
  } finally {
    database.close();
  }
}

function recordOwnerDecisionInWorker(
  path: string,
  input: OwnerDecisionInput,
): Promise<unknown> {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        void (async () => {
          let store;
          try {
            const flakebrake = await import(workerData.moduleUrl);
            store = flakebrake.createStore({
              path: workerData.path,
              now: () => workerData.now,
            });
            const result = store.recordOwnerDecision(workerData.input);
            store.close();
            store = undefined;
            parentPort.postMessage({ ok: true, result });
          } catch (error) {
            store?.close();
            parentPort.postMessage({
              ok: false,
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      `,
      {
        eval: true,
        workerData: { input, moduleUrl, now: START, path },
      },
    );
    worker.once("message", (message: unknown) => {
      settled = true;
      if (
        typeof message === "object" &&
        message !== null &&
        "ok" in message &&
        message.ok === true &&
        "result" in message
      ) {
        resolve(message.result);
        return;
      }
      reject(
        new Error(
          `owner-decision worker failed: ${JSON.stringify(message)}`,
        ),
      );
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`owner-decision worker exited with code ${code}`));
      }
    });
  });
}

function thrownIdentity(operation: () => unknown): string {
  try {
    operation();
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
    return `${error.name}:${error.message}`;
  }
  assert.fail("operation did not throw");
}

function dispose(...stores: readonly TempStore[]): void {
  for (const item of stores) {
    try {
      item.store.close();
    } catch {
      // A test may already have closed the store to exercise restart.
    }
    rmSync(item.directory, { recursive: true, force: true });
  }
}

function rush(id = "rush-order", prefix = id): ProposedObligation {
  return proposed({
    id,
    workClassPrefix: prefix,
    modificationOptions: [reduceOption(`reduce:${id}`)],
  });
}

function evaluate(store: FlakeBrakeStore, proposal = rush()): AdmissionRecordBody {
  const record = store.evaluateAndRecordAdmission({ proposal });
  assert.equal(record.decision, "ADMITTABLE");
  return record;
}

function selectedPlanId(record: AdmissionRecordBody): string {
  assert.equal(record.selectedPlan.kind, "selected");
  if (record.selectedPlan.kind !== "selected") throw new Error("selected plan missing");
  return record.selectedPlan.selectedPlanId;
}

function acceptInput(
  record: AdmissionRecordBody,
  ownerDecisionId = `accept:${record.admissionRecordId}`,
): AcceptPromiseInput {
  return {
    admissionRecordId: record.admissionRecordId,
    selectedPlanId: selectedPlanId(record),
    ownerDecisionId,
    approverId: "owner-1",
    expectedPortfolioVersion: record.portfolioVersion,
    expectedCapacityModelVersion: record.capacityModelVersion,
    expectedCapacityPlanVersion: record.capacityPlanVersion,
    expectedAuthorizationStateVersion: record.authorizationStateVersion,
    expectedCalibrationFrontierDigest: record.calibrationFrontierDigest,
  };
}

function effect(
  quantity: number,
  effectSchemaVersion: EffectFingerprint["effectSchemaVersion"] =
    "microfactory-effect/v1",
): EffectFingerprint {
  return {
    effectSchemaVersion,
    environmentId: "factory-1",
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: "cell-1",
    operation: "reserve",
    materialParameters: { quantity, start: START, end: FIVE_MINUTES },
  };
}

function scope(
  promiseBasisId: string,
  maximumQuantity = 100,
  maxExecutions = 1,
  validUntil = HORIZON_END,
  maximumAgentClaim = 3,
  maximumProductionClaim = 20,
): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: "factory-1",
    allowedEffectSchemaVersions: [
      "microfactory-effect/v1",
      "microfactory-effect/v2",
    ],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: ["cell-1"],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "range", minimum: 1, maximum: maximumQuantity },
      start: { kind: "equals", value: START },
      end: { kind: "equals", value: FIVE_MINUTES },
    },
    resourceConstraints: {
      [AGENT]: { kind: "range", minimum: 0, maximum: maximumAgentClaim },
      [HUMAN]: { kind: "equals", value: 0 },
      [PRODUCTION]: {
        kind: "range",
        minimum: 0,
        maximum: maximumProductionClaim,
      },
    },
    objectiveId: "rush-order-objective",
    promiseBasisId,
    approverId: "owner-1",
    validFrom: START,
    validUntil,
    maxExecutions,
  };
}

function issueInput(
  versions: VersionTuple,
  admission: AdmissionRecordBody,
  grantId: string,
  ownerDecisionId: string,
  selectedBundleId: string,
  approvedScope: ApprovalScope,
  postDenialAuthorization: IssueGrantInput["postDenialAuthorization"] = null,
): IssueGrantInput {
  return {
    grantId,
    grantVersion: "grant/v1",
    admissionRecordId: admission.admissionRecordId,
    promiseBasisId: admission.promiseBasisId,
    acceptedOwnerDecisionId: `accept:${admission.admissionRecordId}`,
    ownerDecisionId,
    selectedBundleId,
    selectedPlanId: selectedPlanId(admission),
    scope: approvedScope,
    postDenialAuthorization,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
  };
}

interface AcceptedGrantFixture {
  readonly admission: AdmissionRecordBody;
  readonly grantId: string;
  readonly grantAllowanceKey: string;
  readonly selectedBundleId: string;
  readonly acceptedOwnerDecisionId: string;
  readonly grantOwnerDecisionId: string;
}

function acceptAndGrant(store: FlakeBrakeStore): AcceptedGrantFixture {
  const admission = evaluate(store);
  const acceptedResult = store.acceptPromise(acceptInput(admission));
  assert.equal(acceptedResult.status, "COMMITTED");
  const versions = store.getPortfolio().versions;
  const grantId = "grant-1";
  const issued = store.issueGrant(
    issueInput(
      versions,
      admission,
      grantId,
      "grant-decision-1",
      "bundle-1",
      scope(admission.promiseBasisId),
    ),
  );
  return {
    admission,
    grantId,
    grantAllowanceKey: issued.grantAllowanceKey,
    selectedBundleId: "bundle-1",
    acceptedOwnerDecisionId: `accept:${admission.admissionRecordId}`,
    grantOwnerDecisionId: "grant-decision-1",
  };
}

function claimInput(
  store: FlakeBrakeStore,
  fixture: AcceptedGrantFixture,
  executionAttemptId: string,
  attemptedEffect = effect(5),
): ClaimExecutionInput {
  const versions = store.getPortfolio().versions;
  return {
    executionAttemptId,
    admissionRecordId: fixture.admission.admissionRecordId,
    promiseBasisId: fixture.admission.promiseBasisId,
    acceptedOwnerDecisionId: fixture.acceptedOwnerDecisionId,
    grantOwnerDecisionId: fixture.grantOwnerDecisionId,
    grantId: fixture.grantId,
    expectedGrantVersion: "grant/v1",
    grantAllowanceKey: fixture.grantAllowanceKey,
    effect: attemptedEffect,
    affectedObligationIds: ["rush-order"],
    affectedResourceIds: [AGENT, PRODUCTION],
    resourceCapacityClaims: demand({ agent: 1, human: 0, production: 5 }),
    temporalClaim: {
      resourceKey: PRODUCTION,
      start: START,
      end: FIVE_MINUTES,
      requiredDuration: 5,
      timeUnit: "minutes",
    },
    claimAccounting: "already_in_portfolio",
    selectedBundleId: fixture.selectedBundleId,
    selectedPlanId: selectedPlanId(fixture.admission),
    expectedEffect: { quantity: 5 },
    expectedAfterState: { reservation: "created" },
    attemptedAt: START,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
    expectedAuthorizationStateVersion: versions.authorizationStateVersion,
    expectedCalibrationFrontierDigest:
      fixture.admission.calibrationFrontierDigest,
  };
}

describe("M2 acceptance compare-and-swap A-F", () => {
  test("A. two acceptors on one ADMITTABLE basis commit exactly once", () => {
    const item = tempStore();
    const second = createStore({ path: item.path });
    try {
      const record = evaluate(item.store);
      assert.equal(item.store.acceptPromise(acceptInput(record)).status, "COMMITTED");
      const stale = second.acceptPromise(acceptInput(record, "accept-second"));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.throws(() =>
          second.acceptPromise(
            acceptInput(stale.freshAdmissionRecord, "accept-third"),
          ),
        );
      }
      assert.equal(item.store.getPortfolio().versions.portfolioVersion, "portfolio/v2");
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 2);
    } finally {
      second.close();
      dispose(item);
    }
  });

  test("B. stale portfolio_version alone blocks acceptance", () => {
    const item = tempStore();
    try {
      const record = evaluate(item.store);
      assert.equal(item.store.acceptPromise(acceptInput(record)).status, "COMMITTED");
      const stale = item.store.acceptPromise(acceptInput(record, "accept-again"));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.deepEqual(stale.mismatches, ["portfolio_version"]);
      }
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 2);
    } finally {
      dispose(item);
    }
  });

  test("C. stale capacity_model_version blocks acceptance", () => {
    const item = tempStore();
    try {
      const record = evaluate(item.store);
      const changed = item.store.getPortfolio().resources.map((candidate) =>
        candidate.resourceKey === AGENT
          ? { ...candidate, estimatorRule: "declared-and-calibrated-demand/v2" }
          : candidate,
      );
      item.store.replaceCapacityModel({ resources: changed });
      const stale = item.store.acceptPromise(acceptInput(record));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.ok(stale.mismatches.includes("capacity_model_version"));
      }
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
    } finally {
      dispose(item);
    }
  });

  test("D. stale capacity_plan_version blocks acceptance", () => {
    const item = tempStore();
    try {
      const record = evaluate(item.store);
      const changed = item.store.getPortfolio().resources.map((candidate) =>
        candidate.resourceKey === AGENT
          ? { ...candidate, capacity: candidate.capacity + 1 }
          : candidate,
      );
      item.store.replaceCapacityPlan({
        resources: changed,
        ownerDecisionId: "capacity-plan-decision",
        approverId: "owner-1",
      });
      const stale = item.store.acceptPromise(acceptInput(record));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.ok(stale.mismatches.includes("capacity_plan_version"));
      }
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
    } finally {
      dispose(item);
    }
  });

  test("E. stale authorization_state_version blocks acceptance", () => {
    const item = tempStore();
    try {
      const record = evaluate(item.store);
      item.store.createDenial({
        denialId: "staling-denial",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(record.promiseBasisId),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "staling-evidence",
        missionId: "staling-mission",
        reason: "Advance authorization state",
      });
      const stale = item.store.acceptPromise(acceptInput(record));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.ok(stale.mismatches.includes("authorization_state_version"));
      }
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
    } finally {
      dispose(item);
    }
  });

  test("F. changed calibration frontier blocks acceptance and raises readmission estimate", () => {
    const item = tempStore(15);
    try {
      const comparable = item.store.evaluateAndRecordAdmission({
        proposal: rush("comparable-attempt", "comparable"),
      });
      const queued = item.store.evaluateAndRecordAdmission({
        proposal: rush("queued-order", "comparable"),
      });
      assert.equal(queued.decision, "ADMITTABLE");
      item.store.recordActualConsumption({
        actualConsumptionFactId: "actual-high-agent",
        admissionRecordId: comparable.admissionRecordId,
        resourceKey: AGENT,
        workClassKey: "comparable:agent",
        value: 20,
        observedAt: START,
        sourceReceipt: "receipt-high",
      });
      item.store.recordOutcome({
        outcomeFactId: "outcome-high-agent",
        admissionRecordId: comparable.admissionRecordId,
        outcome: "completed",
        completedAt: FIVE_MINUTES,
        sourceReceipt: "receipt-high",
      });
      const stale = item.store.acceptPromise(acceptInput(queued));
      assert.equal(stale.status, "STALE_READMISSION");
      if (stale.status === "STALE_READMISSION") {
        assert.deepEqual(stale.mismatches, ["calibration_frontier_digest"]);
        const agentPrediction = stale.freshAdmissionRecord.predictedConsumption.find(
          (entry) => entry.resourceKey === AGENT,
        );
        assert.equal(agentPrediction?.value, 20);
      }
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
    } finally {
      dispose(item);
    }
  });
});

describe("M2 authorization, claims, and reservations G-O", () => {
  test("G. duplicate grant issuance shares one cumulative allowance", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const before = item.store.getPortfolio().versions.authorizationStateVersion;
      const duplicate = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          fixture.admission,
          "grant-duplicate-row",
          "grant-decision-1",
          "bundle-1",
          scope(fixture.admission.promiseBasisId),
        ),
      );
      assert.equal(duplicate.grantAllowanceKey, fixture.grantAllowanceKey);
      assert.equal(duplicate.allowance.maxExecutions, 1);
      assert.deepEqual(duplicate.allowance.grantIds, [
        "grant-1",
        "grant-duplicate-row",
      ]);
      assert.notEqual(
        item.store.getPortfolio().versions.authorizationStateVersion,
        before,
      );
    } finally {
      dispose(item);
    }
  });

  test("H. two distinct attempts can claim only one slot", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const first = item.store.claimExecution(
        claimInput(item.store, fixture, "attempt-one"),
      );
      assert.equal(first.grantExecutionOrdinal, 1);
      assert.throws(
        () =>
          item.store.claimExecution(
            claimInput(item.store, fixture, "attempt-two"),
          ),
        AuthorizationDeniedError,
      );
      assert.deepEqual(
        item.store.getGrantAllowance(fixture.grantAllowanceKey)
          .claimedExecutionSlots,
        [1],
      );
    } finally {
      dispose(item);
    }
  });

  test("I. retrying one execution_attempt_id consumes no second slot", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const input = claimInput(item.store, fixture, "attempt-retry");
      const first = item.store.claimExecution(input);
      const retry = item.store.claimExecution(input);
      assert.equal(first.replayed, false);
      assert.equal(retry.replayed, true);
      assert.equal(retry.grantExecutionOrdinal, 1);
      assert.deepEqual(
        item.store.getGrantAllowance(fixture.grantAllowanceKey)
          .claimedExecutionSlots,
        [1],
      );
    } finally {
      dispose(item);
    }
  });

  test("J. conflicting execution_attempt_id reuse fails closed", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const input = claimInput(item.store, fixture, "attempt-conflict");
      item.store.claimExecution(input);
      assert.throws(
        () =>
          item.store.claimExecution({
            ...input,
            effect: effect(6),
          }),
        ExecutionAttemptConflictError,
      );
      assert.deepEqual(
        item.store.getGrantAllowance(fixture.grantAllowanceKey)
          .claimedExecutionSlots,
        [1],
      );
    } finally {
      dispose(item);
    }
  });

  test("K. active denial blocks an otherwise covering grant", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "denial-broad",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(fixture.admission.promiseBasisId, 100),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "denial-evidence",
        missionId: "mission-1",
        reason: "Owner denied broad production reservation",
      });
      const occurrence = {
        effect: effect(5),
        objectiveId: "rush-order-objective",
        promiseBasisId: fixture.admission.promiseBasisId,
        resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
        attemptedAt: START,
        grantId: fixture.grantId,
      } as const;
      const authorization = item.store.evaluateAuthorization(occurrence);
      assert.equal(authorization.decision, "DENY");
      if (authorization.decision === "DENY") {
        assert.equal(authorization.reason, "active_denial");
      }
      assert.throws(
        () =>
          item.store.claimExecution(
            claimInput(item.store, fixture, "attempt-denied"),
          ),
        AuthorizationDeniedError,
      );
      assert.deepEqual(
        item.store.getGrantAllowance(fixture.grantAllowanceKey)
          .claimedExecutionSlots,
        [],
      );
    } finally {
      dispose(item);
    }
  });

  test("L. [1,10] exception preserves [11,100] parent denial across schema versions", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "denial-parent",
        deniedEffectFingerprint: effect(50, "microfactory-effect/v1"),
        deniedScope: scope(fixture.admission.promiseBasisId, 100, 2),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "denial-evidence",
        missionId: "mission-1",
        reason: "Deny quantities one through one hundred",
      });
      const exceptionGrant = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          fixture.admission,
          "grant-exception",
          "grant-decision-exception",
          "bundle-exception",
          scope(fixture.admission.promiseBasisId, 10),
          {
            parentDenialId: "denial-parent",
            changeClass: "narrower_scope",
          },
        ),
      );
      item.store.createDenialException({
        denialExceptionId: "exception-1-10",
        parentDenialId: "denial-parent",
        ownerDecisionId: "grant-decision-exception",
        grantAllowanceKey: exceptionGrant.grantAllowanceKey,
      });
      const quantityFive = item.store.evaluateAuthorization({
        effect: effect(5, "microfactory-effect/v2"),
        objectiveId: "rush-order-objective",
        promiseBasisId: fixture.admission.promiseBasisId,
        resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
        attemptedAt: START,
        grantId: "grant-exception",
      });
      assert.equal(quantityFive.decision, "ALLOW");
      const quantityNinety = item.store.evaluateAuthorization({
        effect: effect(90, "microfactory-effect/v2"),
        objectiveId: "rush-order-objective",
        promiseBasisId: fixture.admission.promiseBasisId,
        resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
        attemptedAt: START,
        grantId: fixture.grantId,
      });
      assert.equal(quantityNinety.decision, "DENY");
      if (quantityNinety.decision === "DENY") {
        assert.equal(quantityNinety.reason, "active_denial");
      }
      item.store.revokeDenialException(
        "exception-1-10",
        "Exception withdrawn",
      );
      assert.equal(item.store.getDenials()[0]?.status, "active");
      assert.equal(
        item.store.evaluateAuthorization({
          effect: effect(5),
          objectiveId: "rush-order-objective",
          promiseBasisId: fixture.admission.promiseBasisId,
          resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
          attemptedAt: START,
          grantId: fixture.grantId,
        }).decision,
        "DENY",
      );
    } finally {
      dispose(item);
    }
  });

  test("M. claimed reservation is injected into every subsequent M1 admission", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution(
        claimInput(item.store, fixture, "attempt-reserved"),
      );
      const later = item.store.evaluateAndRecordAdmission({
        proposal: proposed({
          id: "later-order",
          values: { agent: 1, human: 0, production: 5 },
        }),
      });
      assert.deepEqual(
        later.fixedInFlightExecutionReservations.map(
          (reservation) => reservation.reservationId,
        ),
        [claim.reservation.reservationId],
      );
      assert.deepEqual(
        later.m1Result.promiseBasis.fixedCapacityReservations,
        later.fixedInFlightExecutionReservations,
      );
    } finally {
      dispose(item);
    }
  });

  test("N. M1 rejects replan modification incompatible with claimed reservation", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.claimExecution(
        claimInput(item.store, fixture, "attempt-lock-replan"),
      );
      const overloaded = item.store.evaluateAndRecordAdmission({
        proposal: proposed({
          id: "overloaded-order",
          values: { agent: 20, human: 0, production: 80 },
        }),
      });
      assert.notEqual(overloaded.decision, "ADMITTABLE");
      if (overloaded.m1Result.decision !== "ADMITTABLE") {
        const rejected = overloaded.m1Result.strategyFamilies.flatMap(
          (family) => family.rejectedOptions,
        );
        assert.ok(
          rejected.some(
            (option) =>
              option.obligationId === "rush-order" &&
              option.code === "fixed_reservation_conflict",
          ),
        );
      }
    } finally {
      dispose(item);
    }
  });

  test("O. definitive pre-mutation failure durably releases reservation", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution(
        claimInput(item.store, fixture, "attempt-release"),
      );
      const before = item.store.getPortfolio().versions.authorizationStateVersion;
      const terminal = item.store.recordExecutionTerminal({
        terminalEventId: "terminal-release",
        executionAttemptId: claim.executionAttemptId,
        status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
        evidenceReference: "evidence:no-mutation",
      });
      assert.equal(terminal.claimState, "terminal_failed_before_mutation");
      assert.notEqual(terminal.versions.authorizationStateVersion, before);
      assert.equal(item.store.getPortfolio().activeReservations.length, 0);
      assert.equal(
        item.store.getReservations()[0]?.claimState,
        "terminal_failed_before_mutation",
      );
    } finally {
      dispose(item);
    }
  });
});

describe("M2 restart and immutable history P", () => {
  test("P. restart preserves portfolio, ledger, denials, allowances, attempts, and reservations", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "restart-denial",
        deniedEffectFingerprint: effect(90),
        deniedScope: scope(fixture.admission.promiseBasisId, 100),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "restart-evidence",
        missionId: "restart-mission",
        reason: "Persist denial",
      });
      const exceptionGrant = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          fixture.admission,
          "restart-exception-grant",
          "restart-exception-decision",
          "restart-exception-bundle",
          scope(fixture.admission.promiseBasisId, 10),
          {
            parentDenialId: "restart-denial",
            changeClass: "narrower_scope",
          },
        ),
      );
      item.store.createDenialException({
        denialExceptionId: "restart-exception",
        parentDenialId: "restart-denial",
        ownerDecisionId: "restart-exception-decision",
        grantAllowanceKey: exceptionGrant.grantAllowanceKey,
      });
      const exceptionFixture: AcceptedGrantFixture = {
        ...fixture,
        grantId: "restart-exception-grant",
        grantAllowanceKey: exceptionGrant.grantAllowanceKey,
        selectedBundleId: "restart-exception-bundle",
        grantOwnerDecisionId: "restart-exception-decision",
      };
      item.store.claimExecution(
        claimInput(item.store, exceptionFixture, "restart-attempt"),
      );
      const before = item.store.getPortfolio();
      const bytes = item.store.getAdmissionRecord(
        fixture.admission.admissionRecordId,
      ).canonicalRecordBytes;
      item.store.close();
      reopened = createStore({ path: item.path });
      assert.deepEqual(reopened.getPortfolio(), before);
      assert.equal(
        reopened.getAdmissionRecord(fixture.admission.admissionRecordId)
          .canonicalRecordBytes,
        bytes,
      );
      assert.equal(reopened.getDenials()[0]?.status, "active");
      assert.equal(reopened.getDenialExceptions()[0]?.status, "exhausted");
      assert.deepEqual(
        reopened.getGrantAllowance(exceptionGrant.grantAllowanceKey)
          .claimedExecutionSlots,
        [1],
      );
      assert.equal(
        reopened.getExecutionAttempt("restart-attempt").result.status,
        "CLAIMED",
      );
      assert.equal(reopened.getPortfolio().activeReservations.length, 1);
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("immutable AdmissionRecord bytes coexist with additive choices, actuals, outcomes, and corrections", () => {
    const item = tempStore();
    try {
      const record = evaluate(item.store);
      const before = item.store.getAdmissionRecord(record.admissionRecordId)
        .canonicalRecordBytes;
      item.store.recordOwnerDecision({
        kind: "DECLINE",
        admissionRecordId: record.admissionRecordId,
        ownerDecisionId: "decline-ledger",
        approverId: "owner-1",
        reason: "Test additive decline",
      });
      item.store.recordActualConsumption({
        actualConsumptionFactId: "actual-ledger",
        admissionRecordId: record.admissionRecordId,
        resourceKey: AGENT,
        workClassKey: "rush-order:agent",
        value: 7,
        observedAt: START,
        sourceReceipt: "receipt-ledger",
      });
      item.store.recordOutcome({
        outcomeFactId: "outcome-ledger",
        admissionRecordId: record.admissionRecordId,
        outcome: "completed",
        completedAt: FIVE_MINUTES,
        sourceReceipt: "receipt-ledger",
      });
      item.store.recordCalibrationCorrection({
        correctionFactId: "correction-ledger",
        admissionRecordId: record.admissionRecordId,
        correctsActualConsumptionFactId: "actual-ledger",
        correctedActualConsumption: 8,
        reason: "Correct meter reading",
        sourceReceipt: "receipt-correction",
      });
      const read = item.store.getAdmissionRecord(record.admissionRecordId);
      assert.equal(read.canonicalRecordBytes, before);
      assert.equal(read.record.actualConsumption, "NOT_YET_KNOWN");
      assert.deepEqual(
        read.addenda.map((addendum) => addendum.kind),
        [
          "owner_choice",
          "actual_consumption",
          "outcome",
          "calibration_correction",
        ],
      );
      item.store.close();
      const raw = new DatabaseSync(item.path);
      assert.throws(() =>
        raw
          .prepare(
            `UPDATE admission_records SET body_json = '{}' WHERE admission_record_id = ?`,
          )
          .run(record.admissionRecordId),
      );
      assert.throws(() =>
        raw
          .prepare(
            `UPDATE admission_addenda SET body_json = '{}' WHERE admission_record_id = ?`,
          )
          .run(record.admissionRecordId),
      );
      raw.close();
      const reopened = createStore({ path: item.path });
      assert.equal(
        reopened.getAdmissionRecord(record.admissionRecordId).canonicalRecordBytes,
        before,
      );
      reopened.close();
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });
});

describe("M2 owner-selected replan and terminal facts", () => {
  test("owner MODIFY readmits and only ACCEPT_PROMISE commits the selected REPLAN", () => {
    const item = tempStore(4);
    try {
      const replan = item.store.evaluateAndRecordAdmission({ proposal: rush() });
      assert.equal(replan.decision, "REPLAN");
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
      const candidate = replan.candidatePlans.find(
        (value) =>
          value.feasible &&
          value.affectedObligations.some(
            (change) => change.obligationId === "rush-order",
          ),
      );
      assert.ok(candidate);
      const modified = item.store.recordOwnerDecision({
        kind: "MODIFY",
        admissionRecordId: replan.admissionRecordId,
        ownerDecisionId: "modify-replan",
        approverId: "owner-1",
        selectedPlanId: candidate.candidatePlanId,
      });
      assert.equal(modified.status, "READMITTED");
      assert.equal(item.store.getPortfolio().acceptedObligations.length, 1);
      if (modified.status !== "READMITTED") throw new Error("readmission missing");
      const commit = item.store.acceptPromise({
        ...acceptInput(modified.freshAdmissionRecord, "accept-modified-replan"),
        selectedPlanId: candidate.candidatePlanId,
      });
      assert.equal(commit.status, "COMMITTED");
      const acceptedRush = item.store
        .getPortfolio()
        .acceptedObligations.find(
          (obligation) => obligation.obligationId === "rush-order",
        );
      assert.equal(acceptedRush?.serviceLevel["quantity"], 5);
      assert.equal(acceptedRush?.resourceDemand[AGENT], 1);
    } finally {
      dispose(item);
    }
  });

  test("uncertain execution stays reserved; verified terminal records realized facts before release", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution(
        claimInput(item.store, fixture, "attempt-terminal-facts"),
      );
      const versionAfterClaim = item.store.getPortfolio().versions;
      const uncertain = item.store.recordExecutionTerminal({
        terminalEventId: "terminal-uncertain",
        executionAttemptId: claim.executionAttemptId,
        status: "UNCERTAIN_OUTCOME",
        evidenceReference: "evidence:readback-unavailable",
        observedState: { status: "unknown" },
      });
      assert.equal(uncertain.claimState, "claimed_nonterminal");
      assert.equal(item.store.getPortfolio().activeReservations.length, 1);
      assert.deepEqual(uncertain.versions, versionAfterClaim);
      const verified = item.store.recordExecutionTerminal({
        terminalEventId: "terminal-verified",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:verified",
        observedAfterState: { reservation: "created" },
        actualConsumption: [
          { resourceKey: AGENT, workClassKey: "rush-order:agent", value: 4 },
        ],
      });
      assert.equal(verified.claimState, "terminal_verified");
      assert.equal(item.store.getPortfolio().activeReservations.length, 0);
      const addenda = item.store.getAdmissionRecord(
        fixture.admission.admissionRecordId,
      ).addenda;
      assert.ok(addenda.some((addendum) => addendum.kind === "actual_consumption"));
      assert.ok(addenda.some((addendum) => addendum.kind === "outcome"));
      assert.ok(addenda.some((addendum) => addendum.kind === "receipt_reference"));
      assert.notEqual(
        verified.versions.authorizationStateVersion,
        versionAfterClaim.authorizationStateVersion,
      );
    } finally {
      dispose(item);
    }
  });
});

describe("M2 final independent-audit correctness regressions", () => {
  test("1. claims require one immutable grant/admission/decision/plan/bundle basis before mutation and after restart", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(item.store);
      const admissionB = evaluate(
        item.store,
        rush("basis-b", "basis-b"),
      );
      const correct = claimInput(item.store, fixture, "basis-correct");
      const substitutions: readonly ClaimExecutionInput[] = [
        {
          ...correct,
          executionAttemptId: "basis-wrong-record",
          admissionRecordId: admissionB.admissionRecordId,
        },
        {
          ...correct,
          executionAttemptId: "basis-wrong-plan",
          selectedPlanId: selectedPlanId(admissionB),
        },
        {
          ...correct,
          executionAttemptId: "basis-wrong-bundle",
          selectedBundleId: "bundle-from-b",
        },
        {
          ...correct,
          executionAttemptId: "basis-wrong-accepted-decision",
          acceptedOwnerDecisionId: "accept:basis-b",
        },
        {
          ...correct,
          executionAttemptId: "basis-wrong-grant-decision",
          grantOwnerDecisionId: "grant-decision-from-b",
        },
        {
          ...correct,
          executionAttemptId: "basis-wrong-promise-basis",
          promiseBasisId: admissionB.promiseBasisId,
        },
      ];
      for (const substitution of substitutions) {
        const before = durableState(item.path);
        assert.throws(
          () => item.store.claimExecution(substitution),
          StatefulInputError,
        );
        assert.deepEqual(durableState(item.path), before);
      }

      const restartInput = substitutions[0];
      assert.ok(restartInput);
      const beforeRestartMessage = thrownIdentity(() =>
        item.store.claimExecution(restartInput),
      );
      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      const before = durableState(item.path);
      assert.equal(
        thrownIdentity(() => reopened?.claimExecution(restartInput)),
        beforeRestartMessage,
      );
      assert.deepEqual(durableState(item.path), before);
      assert.equal(reopened.claimExecution(correct).status, "CLAIMED");
      assert.deepEqual(
        reopened.getGrantAllowance(fixture.grantAllowanceKey)
          .claimedExecutionSlots,
        [1],
      );
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("2A-C. pre-denial allowances cannot become exceptions; a post-denial re-request can", () => {
    const item = tempStore();
    try {
      const admission = evaluate(item.store);
      assert.equal(item.store.acceptPromise(acceptInput(admission)).status, "COMMITTED");
      const oldGrant = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          admission,
          "pre-denial-grant",
          "pre-denial-decision",
          "pre-denial-bundle",
          scope(admission.promiseBasisId, 10, 2),
        ),
      );
      item.store.createDenial({
        denialId: "post-grant-parent-denial",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(admission.promiseBasisId, 100, 10),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "post-grant-denial-evidence",
        missionId: "post-grant-mission",
        reason: "Parent denial must remain residual",
      });
      const before = durableState(item.path);
      assert.throws(
        () =>
          item.store.createDenialException({
            denialExceptionId: "invalid-old-grant-exception",
            parentDenialId: "post-grant-parent-denial",
            ownerDecisionId: "pre-denial-decision",
            grantAllowanceKey: oldGrant.grantAllowanceKey,
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);

      const postGrant = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          admission,
          "post-denial-grant",
          "post-denial-decision",
          "post-denial-bundle",
          scope(admission.promiseBasisId, 10, 2),
          {
            parentDenialId: "post-grant-parent-denial",
            changeClass: "narrower_scope",
          },
        ),
      );
      item.store.createDenialException({
        denialExceptionId: "valid-post-denial-exception",
        parentDenialId: "post-grant-parent-denial",
        ownerDecisionId: "post-denial-decision",
        grantAllowanceKey: postGrant.grantAllowanceKey,
      });
      assert.equal(
        item.store.evaluateAuthorization({
          effect: effect(5),
          objectiveId: "rush-order-objective",
          promiseBasisId: admission.promiseBasisId,
          resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
          attemptedAt: START,
          grantId: "post-denial-grant",
        }).decision,
        "ALLOW",
      );
      assert.equal(
        item.store.evaluateAuthorization({
          effect: effect(90),
          objectiveId: "rush-order-objective",
          promiseBasisId: admission.promiseBasisId,
          resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
          attemptedAt: START,
          grantId: "post-denial-grant",
        }).decision,
        "DENY",
      );
      assert.equal(item.store.getDenials()[0]?.status, "active");
    } finally {
      dispose(item);
    }
  });

  test("2D. revocation, expiry, exhaustion, and restart preserve the parent denial", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "residual-parent",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(fixture.admission.promiseBasisId, 100, 10),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "residual-evidence",
        missionId: "residual-mission",
        reason: "Exercise exception terminal states",
      });
      const makeException = (suffix: string, maxExecutions: number) => {
        const grant = item.store.issueGrant(
          issueInput(
            item.store.getPortfolio().versions,
            fixture.admission,
            `residual-grant-${suffix}`,
            `residual-decision-${suffix}`,
            `residual-bundle-${suffix}`,
            scope(fixture.admission.promiseBasisId, 10, maxExecutions),
            {
              parentDenialId: "residual-parent",
              changeClass: "narrower_scope",
            },
          ),
        );
        item.store.createDenialException({
          denialExceptionId: `residual-exception-${suffix}`,
          parentDenialId: "residual-parent",
          ownerDecisionId: `residual-decision-${suffix}`,
          grantAllowanceKey: grant.grantAllowanceKey,
        });
        return grant;
      };
      makeException("revoked", 1);
      item.store.revokeDenialException(
        "residual-exception-revoked",
        "revoked for regression",
      );
      makeException("expired", 1);
      item.store.expireDenialException(
        "residual-exception-expired",
        "expired for regression",
      );
      const exhausted = makeException("exhausted", 1);
      const exhaustedFixture: AcceptedGrantFixture = {
        ...fixture,
        grantId: "residual-grant-exhausted",
        grantAllowanceKey: exhausted.grantAllowanceKey,
        selectedBundleId: "residual-bundle-exhausted",
        grantOwnerDecisionId: "residual-decision-exhausted",
      };
      item.store.claimExecution(
        claimInput(item.store, exhaustedFixture, "residual-attempt"),
      );
      assert.equal(item.store.getDenials()[0]?.status, "active");
      assert.deepEqual(
        item.store.getDenialExceptions().map((value) => value.status).sort(),
        ["exhausted", "expired", "revoked"],
      );
      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      assert.equal(reopened.getDenials()[0]?.status, "active");
      assert.deepEqual(
        reopened.getDenialExceptions().map((value) => value.status).sort(),
        ["exhausted", "expired", "revoked"],
      );
      assert.equal(
        reopened.evaluateAuthorization({
          effect: effect(90),
          objectiveId: "rush-order-objective",
          promiseBasisId: fixture.admission.promiseBasisId,
          resourceClaims: demand({ agent: 1, human: 0, production: 5 }),
          attemptedAt: START,
          grantId: fixture.grantId,
        }).decision,
        "DENY",
      );
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("3. verified success requires canonical read-back equality and survives restart", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution({
        ...claimInput(item.store, fixture, "readback-attempt"),
        expectedAfterState: {
          reservation: "created",
          details: { a: 1, b: 2 },
        },
      });
      const mismatch = {
        terminalEventId: "readback-mismatch",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:mismatch",
        observedAfterState: { reservation: "missing" },
        actualConsumption: [
          { resourceKey: AGENT, workClassKey: "rush-order:agent", value: 1 },
        ],
      } as const;
      const before = durableState(item.path);
      assert.throws(
        () => item.store.recordExecutionTerminal(mismatch),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);
      const later = item.store.evaluateAndRecordAdmission({
        proposal: proposed({
          id: "readback-later",
          values: { agent: 1, human: 0, production: 1 },
        }),
      });
      assert.equal(
        later.fixedInFlightExecutionReservations.filter(
          (reservation) => reservation.executionAttemptId === claim.executionAttemptId,
        ).length,
        1,
      );
      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      const restartBefore = durableState(item.path);
      assert.throws(
        () =>
          reopened?.recordExecutionTerminal({
            ...mismatch,
            terminalEventId: "readback-mismatch-after-restart",
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), restartBefore);
      const success = reopened.recordExecutionTerminal({
        terminalEventId: "readback-match",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:match",
        observedAfterState: {
          details: { b: 2, a: 1 },
          reservation: "created",
        },
        actualConsumption: [
          { resourceKey: AGENT, workClassKey: "rush-order:agent", value: 1 },
        ],
      });
      assert.equal(success.claimState, "terminal_verified");
      assert.equal(reopened.getPortfolio().activeReservations.length, 0);
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });
});

describe("M2 final audit accounting, time, model, and terminal boundaries", () => {
  test("4A-E. realized additional consumption replaces the overlay exactly once until its horizon ends", () => {
    const capacityResources = resources(100).map((candidate) =>
      candidate.resourceKey === AGENT
        ? { ...candidate, capacity: 100, safetyReserve: 40 }
        : { ...candidate, capacity: 100 },
    );
    const item = tempStoreFromState({
      acceptedObligations: [
        accepted({
          id: "base-load",
          values: { agent: 10, human: 0, production: 0 },
        }),
      ],
      resources: capacityResources,
      assumptions: [],
      combinedDecisionProofs: [],
    });
    let reopened: FlakeBrakeStore | null = null;
    try {
      const admission = evaluate(
        item.store,
        proposed({
          id: "rush-order",
          values: { agent: 40, human: 0, production: 0 },
          modificationOptions: [],
        }),
      );
      assert.equal(item.store.acceptPromise(acceptInput(admission)).status, "COMMITTED");
      const issued = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          admission,
          "realized-grant",
          "realized-grant-decision",
          "realized-bundle",
          scope(admission.promiseBasisId, 100, 1, HORIZON_END, 10, 0),
        ),
      );
      const fixture: AcceptedGrantFixture = {
        admission,
        grantId: "realized-grant",
        grantAllowanceKey: issued.grantAllowanceKey,
        selectedBundleId: "realized-bundle",
        acceptedOwnerDecisionId: `accept:${admission.admissionRecordId}`,
        grantOwnerDecisionId: "realized-grant-decision",
      };
      const claim = item.store.claimExecution({
        ...claimInput(item.store, fixture, "realized-attempt"),
        affectedResourceIds: [AGENT],
        resourceCapacityClaims: demand({
          agent: 10,
          human: 0,
          production: 0,
        }),
        temporalClaim: null,
        claimAccounting: "additional",
      });
      const laterProposal = proposed({
        id: "later-five",
        values: { agent: 5, human: 0, production: 0 },
        modificationOptions: [],
      });
      const beforeTerminal = item.store.evaluateAndRecordAdmission({
        proposal: laterProposal,
      });
      assert.equal(beforeTerminal.decision, "REJECT");
      assert.equal(
        beforeTerminal.fixedInFlightExecutionReservations.filter(
          (reservation) => reservation.executionAttemptId === claim.executionAttemptId,
        ).length,
        1,
      );

      const terminalInput = {
        terminalEventId: "realized-terminal",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:realized",
        observedAfterState: { reservation: "created" },
        actualConsumption: [
          { resourceKey: AGENT, workClassKey: "rush-order:agent", value: 10 },
        ],
      } as const;
      assert.equal(
        item.store.recordExecutionTerminal(terminalInput).claimState,
        "terminal_verified",
      );
      assert.equal(
        item.store.recordExecutionTerminal(terminalInput).replayed,
        true,
      );
      const afterTerminal = item.store.evaluateAndRecordAdmission({
        proposal: laterProposal,
      });
      assert.equal(afterTerminal.decision, "REJECT");
      const realizedReservations = afterTerminal.fixedInFlightExecutionReservations.filter(
        (reservation) => reservation.executionAttemptId === claim.executionAttemptId,
      );
      assert.equal(realizedReservations.length, 1);
      assert.equal(realizedReservations[0]?.resourceClaims[AGENT], 10);
      assert.equal(
        durableState(item.path)["realized_consumption_facts"]?.length,
        1,
      );

      const actualAddendum = item.store
        .getAdmissionRecord(admission.admissionRecordId)
        .addenda.find(
          (addendum) =>
            addendum.kind === "actual_consumption" &&
            typeof addendum.body === "object" &&
            addendum.body !== null &&
            !Array.isArray(addendum.body) &&
            (addendum.body as Readonly<Record<string, unknown>>)[
              "resourceKey"
            ] === AGENT,
        );
      assert.ok(actualAddendum);
      assert.throws(() =>
        item.store.recordActualConsumption({
          actualConsumptionFactId: "duplicate-realized-actual",
          admissionRecordId: admission.admissionRecordId,
          resourceKey: AGENT,
          workClassKey: "rush-order:agent",
          value: 10,
          observedAt: START,
          sourceReceipt: "receipt:duplicate",
        }),
      );
      item.store.recordCalibrationCorrection({
        correctionFactId: "realized-calibration-correction",
        admissionRecordId: admission.admissionRecordId,
        correctsActualConsumptionFactId: actualAddendum.addendumId,
        correctedActualConsumption: 9,
        reason: "Correct calibration evidence without rewriting capacity facts",
        sourceReceipt: "receipt:correction",
      });
      const afterCorrection = item.store.evaluateAndRecordAdmission({
        proposal: laterProposal,
      });
      assert.equal(afterCorrection.decision, "REJECT");
      assert.equal(
        afterCorrection.fixedInFlightExecutionReservations[0]?.resourceClaims[AGENT],
        9,
      );
      const beforeRestartBytes = JSON.stringify(afterCorrection.m1Result);
      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      const afterRestart = reopened.evaluateAndRecordAdmission({
        proposal: laterProposal,
      });
      assert.equal(afterRestart.decision, "REJECT");
      assert.equal(JSON.stringify(afterRestart.m1Result), beforeRestartBytes);

      const shiftedAgentHorizon = reopened.getPortfolio().resources.map(
        (candidate) =>
          candidate.resourceKey === AGENT
            ? {
                ...candidate,
                horizonStart: "2026-08-27T00:00:00.000Z",
                horizonEnd: "2026-08-28T00:00:00.000Z",
              }
            : candidate,
      );
      reopened.replaceCapacityPlan({
        resources: shiftedAgentHorizon,
        ownerDecisionId: "shift-agent-horizon",
        approverId: "owner-1",
      });
      const outOfHorizon = reopened.evaluateAndRecordAdmission({
        proposal: laterProposal,
      });
      assert.equal(outOfHorizon.decision, "ADMITTABLE");
      assert.equal(
        outOfHorizon.fixedInFlightExecutionReservations.length,
        0,
      );
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("4F. already-in-portfolio terminal claims never materialize another capacity copy", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution(
        claimInput(item.store, fixture, "represented-terminal-attempt"),
      );
      item.store.recordExecutionTerminal({
        terminalEventId: "represented-terminal",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:represented",
        observedAfterState: { reservation: "created" },
        actualConsumption: [
          { resourceKey: AGENT, workClassKey: "rush-order:agent", value: 1 },
        ],
      });
      assert.equal(
        durableState(item.path)["realized_consumption_facts"]?.length,
        0,
      );
      const later = item.store.evaluateAndRecordAdmission({
        proposal: proposed({
          id: "represented-later",
          values: { agent: 1, human: 0, production: 1 },
        }),
      });
      assert.equal(later.fixedInFlightExecutionReservations.length, 0);
    } finally {
      dispose(item);
    }
  });

  test("5A-D. claim authorization uses one authoritative transaction time and cannot be backdated", () => {
    const afterExpiry = "2026-08-28T00:00:00.000Z";
    let clock = START;
    const expired = tempStoreFromState(initialState(), () => clock);
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(expired.store);
      clock = afterExpiry;
      const backdated = claimInput(
        expired.store,
        fixture,
        "backdated-expired-attempt",
      );
      const before = durableState(expired.path);
      assert.throws(
        () => expired.store.claimExecution(backdated),
        AuthorizationDeniedError,
      );
      assert.deepEqual(durableState(expired.path), before);
      expired.store.close();
      reopened = createStore({ path: expired.path, now: () => afterExpiry });
      const restartBefore = durableState(expired.path);
      assert.throws(
        () => reopened?.claimExecution(backdated),
        AuthorizationDeniedError,
      );
      assert.deepEqual(durableState(expired.path), restartBefore);
    } finally {
      reopened?.close();
      rmSync(expired.directory, { recursive: true, force: true });
    }

    clock = START;
    const boundary = tempStoreFromState(initialState(), () => clock);
    try {
      const admission = evaluate(boundary.store);
      assert.equal(
        boundary.store.acceptPromise(acceptInput(admission)).status,
        "COMMITTED",
      );
      const issued = boundary.store.issueGrant(
        issueInput(
          boundary.store.getPortfolio().versions,
          admission,
          "clock-grant",
          "clock-grant-decision",
          "clock-bundle",
          scope(admission.promiseBasisId, 100, 2),
        ),
      );
      const fixture: AcceptedGrantFixture = {
        admission,
        grantId: "clock-grant",
        grantAllowanceKey: issued.grantAllowanceKey,
        selectedBundleId: "clock-bundle",
        acceptedOwnerDecisionId: `accept:${admission.admissionRecordId}`,
        grantOwnerDecisionId: "clock-grant-decision",
      };
      assert.equal(
        boundary.store.claimExecution(
          claimInput(boundary.store, fixture, "before-expiry-attempt"),
        ).status,
        "CLAIMED",
      );
      clock = afterExpiry;
      const afterBoundary = claimInput(
        boundary.store,
        fixture,
        "after-expiry-attempt",
      );
      const before = durableState(boundary.path);
      assert.throws(
        () => boundary.store.claimExecution(afterBoundary),
        AuthorizationDeniedError,
      );
      assert.deepEqual(durableState(boundary.path), before);
    } finally {
      dispose(boundary);
    }
  });

  test("6A-E. capacity-model replacement is preflighted by the complete M1 validator", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const original = item.store.getPortfolio();
      const malformed = original.resources.map((candidate) =>
        candidate.resourceKey === HUMAN
          ? { ...candidate, capacityKind: "generic" }
          : candidate,
      ) as readonly CapacityResource[];
      const before = durableState(item.path);
      assert.throws(
        () => item.store.replaceCapacityModel({ resources: malformed }),
        AdmissionInputError,
      );
      assert.deepEqual(durableState(item.path), before);
      assert.equal(
        item.store.getPortfolio().versions.capacityModelVersion,
        original.versions.capacityModelVersion,
      );
      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      assert.deepEqual(reopened.getPortfolio().resources, original.resources);
      assert.equal(
        reopened.evaluateAndRecordAdmission({ proposal: rush("model-still-valid") })
          .decision,
        "ADMITTABLE",
      );
      const valid = reopened.getPortfolio().resources.map((candidate) =>
        candidate.resourceKey === HUMAN
          ? { ...candidate, estimatorRule: "declared-and-calibrated-demand/v2" }
          : candidate,
      );
      const updated = reopened.replaceCapacityModel({ resources: valid });
      assert.equal(updated.capacityModelVersion, "capacity-model/v2");
      assert.equal(
        reopened.replaceCapacityModel({ resources: valid }).capacityModelVersion,
        "capacity-model/v2",
      );
    } finally {
      reopened?.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("7A-D. terminal discriminants and status payloads are exhaustive, exact, and restart-stable", () => {
    const unknown = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(unknown.store);
      const claim = unknown.store.claimExecution(
        claimInput(unknown.store, fixture, "unknown-status-attempt"),
      );
      const invalid = {
        terminalEventId: "unknown-status-event",
        executionAttemptId: claim.executionAttemptId,
        status: "NOT_A_TERMINAL_STATUS",
        evidenceReference: "evidence:invalid",
      } as unknown as ExecutionTerminalInput;
      const before = durableState(unknown.path);
      const message = thrownIdentity(() =>
        unknown.store.recordExecutionTerminal(invalid),
      );
      assert.deepEqual(durableState(unknown.path), before);
      unknown.store.close();
      reopened = createStore({ path: unknown.path, now: () => START });
      assert.equal(
        thrownIdentity(() => reopened?.recordExecutionTerminal(invalid)),
        message,
      );
      assert.deepEqual(durableState(unknown.path), before);
    } finally {
      reopened?.close();
      rmSync(unknown.directory, { recursive: true, force: true });
    }

    const malformedCases: readonly Record<string, unknown>[] = [
      {
        terminalEventId: "malformed-verified",
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:verified",
        actualConsumption: [],
      },
      {
        terminalEventId: "malformed-failure",
        status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
        evidenceReference: "evidence:failure",
        observedState: { incompatible: true },
      },
      {
        terminalEventId: "malformed-uncertain",
        status: "UNCERTAIN_OUTCOME",
        evidenceReference: "evidence:uncertain",
      },
      {
        terminalEventId: "malformed-reconciled",
        status: "RECONCILED",
        receiptReference: "receipt:reconciled",
        authoritativeState: { reconciled: true },
      },
    ];
    for (const [index, malformed] of malformedCases.entries()) {
      const item = tempStore();
      try {
        const fixture = acceptAndGrant(item.store);
        const claim = item.store.claimExecution(
          claimInput(item.store, fixture, `malformed-attempt-${index}`),
        );
        const input = {
          ...malformed,
          executionAttemptId: claim.executionAttemptId,
        } as unknown as ExecutionTerminalInput;
        const before = durableState(item.path);
        assert.throws(() => item.store.recordExecutionTerminal(input));
        assert.deepEqual(durableState(item.path), before);
      } finally {
        dispose(item);
      }
    }

    const legalStatuses = [
      "VERIFIED_SUCCESS",
      "DEFINITIVE_FAILURE_BEFORE_MUTATION",
      "UNCERTAIN_OUTCOME",
      "RECONCILED",
    ] as const;
    for (const status of legalStatuses) {
      const item = tempStore();
      try {
        const fixture = acceptAndGrant(item.store);
        const claim = item.store.claimExecution(
          claimInput(item.store, fixture, `legal-${status}`),
        );
        const common = {
          terminalEventId: `legal-event-${status}`,
          executionAttemptId: claim.executionAttemptId,
        };
        let input: ExecutionTerminalInput;
        switch (status) {
          case "VERIFIED_SUCCESS":
            input = {
              ...common,
              status,
              receiptReference: "receipt:verified",
              observedAfterState: { reservation: "created" },
              actualConsumption: [],
            };
            break;
          case "DEFINITIVE_FAILURE_BEFORE_MUTATION":
            input = {
              ...common,
              status,
              evidenceReference: "evidence:failure",
            };
            break;
          case "UNCERTAIN_OUTCOME":
            input = {
              ...common,
              status,
              evidenceReference: "evidence:uncertain",
              observedState: { status: "unknown" },
            };
            break;
          case "RECONCILED":
            input = {
              ...common,
              status,
              receiptReference: "receipt:reconciled",
              authoritativeState: { reservation: "reconciled" },
              actualConsumption: [],
            };
            break;
        }
        const result = item.store.recordExecutionTerminal(input);
        assert.equal(
          result.claimState === "claimed_nonterminal",
          status === "UNCERTAIN_OUTCOME",
        );
        assert.equal(
          item.store.getPortfolio().activeReservations.length,
          status === "UNCERTAIN_OUTCOME" ? 1 : 0,
        );
      } finally {
        dispose(item);
      }
    }
  });
});

describe("M2 Qodo PR #3 regressions", () => {
  test("identical MODIFY replay returns the original readmission with zero mutation", () => {
    const item = tempStore(4);
    let reopened: FlakeBrakeStore | null = null;
    try {
      const replan = item.store.evaluateAndRecordAdmission({ proposal: rush() });
      assert.equal(replan.decision, "REPLAN");
      const candidate = replan.candidatePlans.find(
        (value) =>
          value.feasible &&
          value.affectedObligations.some(
            (change) => change.obligationId === "rush-order",
          ),
      );
      assert.ok(candidate);
      const input = {
        kind: "MODIFY",
        admissionRecordId: replan.admissionRecordId,
        ownerDecisionId: "qodo-modify-replay",
        approverId: "owner-1",
        selectedPlanId: candidate.candidatePlanId,
      } as const;
      const first = item.store.recordOwnerDecision(input);
      assert.equal(first.status, "READMITTED");
      const beforeReplay = durableState(item.path);
      const replay = item.store.recordOwnerDecision(input);
      assert.deepEqual(replay, first);
      assert.deepEqual(durableState(item.path), beforeReplay);
      assert.throws(
        () =>
          item.store.recordOwnerDecision({
            ...input,
            approverId: "different-owner",
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), beforeReplay);

      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      const restartBefore = durableState(item.path);
      assert.deepEqual(reopened.recordOwnerDecision(input), first);
      assert.deepEqual(durableState(item.path), restartBefore);
    } finally {
      reopened?.close();
      dispose(item);
    }
  });

  test("concurrent identical MODIFY retries converge on one durable successor", async () => {
    const item = tempStore(4);
    let reopened: FlakeBrakeStore | null = null;
    try {
      const replan = item.store.evaluateAndRecordAdmission({ proposal: rush() });
      assert.equal(replan.decision, "REPLAN");
      const candidate = replan.candidatePlans.find(
        (value) =>
          value.feasible &&
          value.affectedObligations.some(
            (change) => change.obligationId === "rush-order",
          ),
      );
      assert.ok(candidate);
      const input: OwnerDecisionInput = {
        kind: "MODIFY",
        admissionRecordId: replan.admissionRecordId,
        ownerDecisionId: "qodo-concurrent-modify",
        approverId: "owner-1",
        selectedPlanId: candidate.candidatePlanId,
      };
      item.store.close();
      const [left, right] = await Promise.all([
        recordOwnerDecisionInWorker(item.path, input),
        recordOwnerDecisionInWorker(item.path, input),
      ]);
      assert.deepEqual(left, right);

      reopened = createStore({ path: item.path, now: () => START });
      const afterConcurrent = durableState(item.path);
      assert.equal(afterConcurrent["owner_decisions"]?.length, 1);
      assert.equal(afterConcurrent["admission_records"]?.length, 2);
      assert.deepEqual(reopened.recordOwnerDecision(input), left);
      assert.deepEqual(durableState(item.path), afterConcurrent);
    } finally {
      reopened?.close();
      dispose(item);
    }
  });

  test("terminal actuals preserve two work classes for one resource", () => {
    const item = tempStore();
    let reopened: FlakeBrakeStore | null = null;
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution({
        ...claimInput(item.store, fixture, "qodo-work-class-attempt"),
        affectedResourceIds: [AGENT],
        resourceCapacityClaims: demand({ agent: 3, human: 0, production: 0 }),
        temporalClaim: null,
        claimAccounting: "additional",
      });
      const input: ExecutionTerminalInput = {
        terminalEventId: "qodo-work-class-terminal",
        executionAttemptId: claim.executionAttemptId,
        status: "VERIFIED_SUCCESS",
        receiptReference: "receipt:qodo-work-class",
        observedAfterState: { reservation: "created" },
        actualConsumption: [
          {
            resourceKey: AGENT,
            workClassKey: "protected-order:agent",
            value: 1,
          },
          {
            resourceKey: AGENT,
            workClassKey: "rush-order:agent",
            value: 2,
          },
        ],
      };
      const result = item.store.recordExecutionTerminal(input);
      assert.equal(result.claimState, "terminal_verified");
      assert.equal(
        item.store
          .getAdmissionRecord(fixture.admission.admissionRecordId)
          .addenda.filter((addendum) => addendum.kind === "actual_consumption")
          .length,
        2,
      );
      const database = new DatabaseSync(item.path);
      try {
        const row = database
          .prepare(
            `SELECT body_json FROM realized_consumption_facts
              WHERE execution_attempt_id = ?`,
          )
          .get(claim.executionAttemptId) as Record<string, unknown>;
        const fact = JSON.parse(String(row["body_json"])) as {
          readonly actualConsumptionCoordinates: readonly unknown[];
          readonly resourceClaims: Readonly<Record<string, number>>;
        };
        assert.equal(fact.actualConsumptionCoordinates.length, 2);
        assert.equal(fact.resourceClaims[AGENT], 3);
      } finally {
        database.close();
      }
      const beforeReplay = durableState(item.path);
      assert.deepEqual(item.store.recordExecutionTerminal(input), {
        ...result,
        replayed: true,
      });
      assert.deepEqual(durableState(item.path), beforeReplay);

      item.store.close();
      reopened = createStore({ path: item.path, now: () => START });
      const restartBefore = durableState(item.path);
      assert.deepEqual(reopened.recordExecutionTerminal(input), {
        ...result,
        replayed: true,
      });
      assert.deepEqual(durableState(item.path), restartBefore);

      const actuals = reopened
        .getAdmissionRecord(fixture.admission.admissionRecordId)
        .addenda.filter(
          (addendum) =>
            addendum.kind === "actual_consumption" &&
            typeof addendum.body === "object" &&
            addendum.body !== null &&
            !Array.isArray(addendum.body) &&
            (addendum.body as Readonly<Record<string, unknown>>)[
              "workClassKey"
            ] === "protected-order:agent",
        );
      assert.equal(actuals.length, 1);
      reopened.recordCalibrationCorrection({
        correctionFactId: "qodo-work-class-correction",
        admissionRecordId: fixture.admission.admissionRecordId,
        correctsActualConsumptionFactId: actuals[0]?.addendumId ?? "",
        correctedActualConsumption: 4,
        reason: "Exercise per-coordinate correction accounting",
        sourceReceipt: "receipt:qodo-work-class-correction",
      });
      const later = reopened.evaluateAndRecordAdmission({
        proposal: rush("qodo-later-order"),
      });
      const realized = later.fixedInFlightExecutionReservations.find(
        (reservation) =>
          reservation.executionAttemptId === claim.executionAttemptId,
      );
      assert.ok(realized);
      assert.equal(realized.resourceClaims[AGENT], 6);
    } finally {
      reopened?.close();
      dispose(item);
    }
  });

  test("duplicate resource/work-class consumption remains fail-closed", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      const claim = item.store.claimExecution({
        ...claimInput(item.store, fixture, "qodo-duplicate-coordinate-attempt"),
        affectedResourceIds: [AGENT],
        resourceCapacityClaims: demand({ agent: 3, human: 0, production: 0 }),
        temporalClaim: null,
        claimAccounting: "additional",
      });
      const before = durableState(item.path);
      assert.throws(
        () =>
          item.store.recordExecutionTerminal({
            terminalEventId: "qodo-duplicate-coordinate-terminal",
            executionAttemptId: claim.executionAttemptId,
            status: "VERIFIED_SUCCESS",
            receiptReference: "receipt:qodo-duplicate-coordinate",
            observedAfterState: { reservation: "created" },
            actualConsumption: [
              {
                resourceKey: AGENT,
                workClassKey: "rush-order:agent",
                value: 1,
              },
              {
                resourceKey: AGENT,
                workClassKey: "rush-order:agent",
                value: 2,
              },
            ],
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);
    } finally {
      dispose(item);
    }
  });

  test("revoked grant allowance cannot receive an active denial exception", () => {
    const item = tempStore();
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "qodo-revoked-parent",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(fixture.admission.promiseBasisId, 100, 10),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "qodo-revoked-evidence",
        missionId: "qodo-revoked-mission",
        reason: "Exercise revoked allowance exception rejection",
      });
      const issued = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          fixture.admission,
          "qodo-revoked-grant",
          "qodo-revoked-decision",
          "qodo-revoked-bundle",
          scope(fixture.admission.promiseBasisId, 10, 2),
          {
            parentDenialId: "qodo-revoked-parent",
            changeClass: "narrower_scope",
          },
        ),
      );
      item.store.revokeGrantAllowance(
        issued.grantAllowanceKey,
        "revoked before exception creation",
      );
      assert.equal(
        item.store.getGrantAllowance(issued.grantAllowanceKey).status,
        "revoked",
      );
      const before = durableState(item.path);
      assert.throws(
        () =>
          item.store.createDenialException({
            denialExceptionId: "qodo-revoked-exception",
            parentDenialId: "qodo-revoked-parent",
            ownerDecisionId: "qodo-revoked-decision",
            grantAllowanceKey: issued.grantAllowanceKey,
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);
    } finally {
      dispose(item);
    }
  });

  test("scope-expired allowance is rejected at authoritative transaction time", () => {
    let clock = START;
    const item = tempStoreFromState(initialState(), () => clock);
    try {
      const fixture = acceptAndGrant(item.store);
      item.store.createDenial({
        denialId: "qodo-expired-parent",
        deniedEffectFingerprint: effect(50),
        deniedScope: scope(fixture.admission.promiseBasisId, 100, 10),
        objectiveId: "rush-order-objective",
        approverId: "owner-1",
        evidencePacketId: "qodo-expired-evidence",
        missionId: "qodo-expired-mission",
        reason: "Exercise authoritative-time allowance expiry",
      });
      const issued = item.store.issueGrant(
        issueInput(
          item.store.getPortfolio().versions,
          fixture.admission,
          "qodo-expired-grant",
          "qodo-expired-decision",
          "qodo-expired-bundle",
          scope(fixture.admission.promiseBasisId, 10, 2, FIVE_MINUTES),
          {
            parentDenialId: "qodo-expired-parent",
            changeClass: "narrower_scope",
          },
        ),
      );
      clock = END;
      assert.equal(
        item.store.getGrantAllowance(issued.grantAllowanceKey).status,
        "expired",
      );
      const before = durableState(item.path);
      assert.throws(
        () =>
          item.store.createDenialException({
            denialExceptionId: "qodo-expired-exception",
            parentDenialId: "qodo-expired-parent",
            ownerDecisionId: "qodo-expired-decision",
            grantAllowanceKey: issued.grantAllowanceKey,
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);
    } finally {
      dispose(item);
    }
  });
});
