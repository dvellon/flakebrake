import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { canonicalSerialize } from "../src/canonical.js";
import type {
  AdmissionEvaluationInput,
  AdmissionRecordBody,
  ApprovalScope,
  AuthorizedScheduleMutation,
  CanonicalScheduleCommand,
  ClaimExecutionInput,
  EffectFingerprint,
  FactoryScheduleState,
  JsonValue,
  RunningFactoryMcpCluster,
} from "../src/index.js";
import {
  AuthorizationDeniedError,
  FACTORY_MCP_SERVICE_NAMES,
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  HERO_OWNER_ID,
  HERO_PRODUCTION_CELL_ID,
  HERO_RESOURCE_KEYS,
  FlakeBrakeStore,
  SyntheticFactoryEnvironment,
  claimedExecutionReference,
  commandFromAttempt,
  createFactoryMcpService,
  createHeroEvaluationInput,
  createHeroInitialState,
  createHeroProposal,
  createStore,
  evaluateAdmission,
  factoryStateDigest,
  parseJsonRejectingDuplicateKeys,
  resultingScheduleState,
  serveFactoryMcpStdio,
  startFactoryMcpCluster,
} from "../src/index.js";
import { StrictJsonLineInput } from "../src/mcp-stdio-guard.js";

interface TempDatabases {
  readonly directory: string;
  readonly m2Path: string;
  readonly factoryPath: string;
}

interface ClaimedMutationFixture extends TempDatabases {
  readonly initialAdmission: AdmissionRecordBody;
  readonly acceptedAdmission: AdmissionRecordBody;
  readonly denialBlocked: boolean;
  readonly firstRequest: AuthorizedScheduleMutation;
  readonly secondRequest: AuthorizedScheduleMutation;
}

const FIRST_START = "2026-08-26T09:10:00.000Z";
const FIRST_END = "2026-08-26T09:40:00.000Z";
const SECOND_START = "2026-08-26T09:40:00.000Z";
const SECOND_END = "2026-08-26T10:00:00.000Z";

function tempDatabases(): TempDatabases {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m3-"));
  return {
    directory,
    m2Path: join(directory, "m2.sqlite"),
    factoryPath: join(directory, "factory.sqlite"),
  };
}

function initializeReadFixture(): TempDatabases {
  const fixture = tempDatabases();
  const store = createStore({
    path: fixture.m2Path,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_START,
  });
  const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
  store.close();
  factory.close();
  return fixture;
}

function removeFixture(fixture: TempDatabases): void {
  rmSync(fixture.directory, { recursive: true, force: true });
}

function amount(
  amounts: readonly { readonly resourceKey: string; readonly value: number }[],
  resourceKey: string,
): number {
  const entry = amounts.find((candidate) => candidate.resourceKey === resourceKey);
  assert.ok(entry, `missing ${resourceKey}`);
  return entry.value;
}

function resultObject(result: CallToolResult): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  const parsed = JSON.parse(first.text) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function call(
  cluster: RunningFactoryMcpCluster,
  serviceName: (typeof FACTORY_MCP_SERVICE_NAMES)[number],
  toolName: string,
  arguments_: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const connection = cluster.services.get(serviceName);
  assert.ok(connection, `missing MCP connection ${serviceName}`);
  return (await connection.client.callTool({
    name: toolName,
    arguments: arguments_,
  })) as CallToolResult;
}

function mutationArguments(
  request: AuthorizedScheduleMutation,
): Record<string, unknown> {
  return {
    execution_attempt_id: request.executionAttemptId,
    claim: request.claim,
    expected_before_state_version: request.expectedBeforeStateVersion,
    expected_before_state_digest: request.expectedBeforeStateDigest,
    schedule_command: {
      schema_version: request.command.schemaVersion,
      command_kind: request.command.commandKind,
      environment_id: request.command.environmentId,
      order_id: request.command.orderId,
      production_cell_id: request.command.productionCellId,
      quantity: request.command.quantity,
      start: request.command.start,
      end: request.command.end,
    },
  };
}

function alternateMutationArguments(
  request: AuthorizedScheduleMutation,
): Record<string, unknown> {
  return {
    execution_attempt_id: request.executionAttemptId,
    claim: request.claim,
    expected_before_state_version: request.expectedBeforeStateVersion,
    expected_before_state_digest: request.expectedBeforeStateDigest,
    schedule_change: {
      schema_version: "microfactory-schedule-change/v1",
      operation: "reserve_cell",
      environment_id: request.command.environmentId,
      order_id: request.command.orderId,
      cell_id: request.command.productionCellId,
      quantity: request.command.quantity,
      starts_at: request.command.start,
      ends_at: request.command.end,
    },
  };
}

function canonicalCommand(
  orderId: string,
  start: string,
  end: string,
  quantity = 10,
): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: HERO_ENVIRONMENT_ID,
    orderId,
    productionCellId: HERO_PRODUCTION_CELL_ID,
    quantity,
    start,
    end,
  };
}

function effect(
  start: string,
  end: string,
  quantity = 10,
  schemaVersion: EffectFingerprint["effectSchemaVersion"] =
    "microfactory-effect/v1",
): EffectFingerprint {
  return {
    effectSchemaVersion: schemaVersion,
    environmentId: HERO_ENVIRONMENT_ID,
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: HERO_PRODUCTION_CELL_ID,
    operation: "reserve",
    materialParameters: { quantity, start, end },
  };
}

function scope(promiseBasisId: string): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: HERO_ENVIRONMENT_ID,
    allowedEffectSchemaVersions: [
      "microfactory-effect/v1",
      "microfactory-effect/v2",
    ],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: [HERO_PRODUCTION_CELL_ID],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "range", minimum: 1, maximum: 10 },
      start: { kind: "set", values: [FIRST_START, SECOND_START] },
      end: { kind: "set", values: [FIRST_END, SECOND_END] },
    },
    resourceConstraints: {
      [HERO_RESOURCE_KEYS.agent]: { kind: "range", minimum: 0, maximum: 6 },
      [HERO_RESOURCE_KEYS.human]: { kind: "equals", value: 0 },
      [HERO_RESOURCE_KEYS.production]: {
        kind: "range",
        minimum: 0,
        maximum: 30,
      },
    },
    objectiveId: createHeroProposal().objective,
    promiseBasisId,
    approverId: HERO_OWNER_ID,
    validFrom: HERO_HORIZON_START,
    validUntil: HERO_HORIZON_END,
    maxExecutions: 3,
  };
}

function denialScope(promiseBasisId: string): ApprovalScope {
  return {
    ...scope(promiseBasisId),
    materialParameterConstraints: {
      ...scope(promiseBasisId).materialParameterConstraints,
      quantity: { kind: "range", minimum: 1, maximum: 9 },
    },
  };
}

function selectedPlan(record: AdmissionRecordBody): string {
  const candidate = record.candidatePlans.find(
    (value) =>
      value.feasible &&
      value.affectedObligations.some(
        (change) => change.optionId === "best-effort-order/reduce-to-8",
      ),
  );
  assert.ok(candidate);
  return candidate.candidatePlanId;
}

function acceptHero(store: FlakeBrakeStore): {
  readonly initial: AdmissionRecordBody;
  readonly accepted: AdmissionRecordBody;
  readonly selectedPlanId: string;
} {
  const initial = store.evaluateAndRecordAdmission({
    proposal: createHeroProposal(),
  });
  assert.equal(initial.decision, "REPLAN");
  const selectedPlanId = selectedPlan(initial);
  const modified = store.recordOwnerDecision({
    kind: "MODIFY",
    admissionRecordId: initial.admissionRecordId,
    ownerDecisionId: "owner-decision/select-hero-replan",
    approverId: HERO_OWNER_ID,
    selectedPlanId,
  });
  assert.equal(modified.status, "READMITTED");
  if (modified.status !== "READMITTED") throw new Error("readmission missing");
  const accepted = modified.freshAdmissionRecord;
  const committed = store.acceptPromise({
    admissionRecordId: accepted.admissionRecordId,
    selectedPlanId,
    ownerDecisionId: "owner-decision/accept-hero-promise",
    approverId: HERO_OWNER_ID,
    expectedPortfolioVersion: accepted.portfolioVersion,
    expectedCapacityModelVersion: accepted.capacityModelVersion,
    expectedCapacityPlanVersion: accepted.capacityPlanVersion,
    expectedAuthorizationStateVersion: accepted.authorizationStateVersion,
    expectedCalibrationFrontierDigest: accepted.calibrationFrontierDigest,
  });
  assert.equal(committed.status, "COMMITTED");
  return { initial, accepted, selectedPlanId };
}

function claimInput(
  store: FlakeBrakeStore,
  accepted: AdmissionRecordBody,
  selectedPlanId: string,
  grantAllowanceKey: string,
  executionAttemptId: string,
  attemptedEffect: EffectFingerprint,
  orderId: string,
  expectedAfterState: FactoryScheduleState,
  resourceClaims: { readonly agent: number; readonly production: number },
): ClaimExecutionInput {
  const versions = store.getPortfolio().versions;
  const command = canonicalCommand(
    orderId,
    attemptedEffect.materialParameters.start,
    attemptedEffect.materialParameters.end,
    attemptedEffect.materialParameters.quantity,
  );
  return {
    executionAttemptId,
    admissionRecordId: accepted.admissionRecordId,
    promiseBasisId: accepted.promiseBasisId,
    acceptedOwnerDecisionId: "owner-decision/accept-hero-promise",
    grantOwnerDecisionId: "owner-decision/approve-hero-execution",
    grantId: "grant/hero-execution/v1",
    expectedGrantVersion: "grant/v1",
    grantAllowanceKey,
    effect: attemptedEffect,
    affectedObligationIds: [orderId],
    affectedResourceIds: [
      HERO_RESOURCE_KEYS.agent,
      HERO_RESOURCE_KEYS.production,
    ],
    resourceCapacityClaims: {
      [HERO_RESOURCE_KEYS.agent]: resourceClaims.agent,
      [HERO_RESOURCE_KEYS.human]: 0,
      [HERO_RESOURCE_KEYS.production]: resourceClaims.production,
    },
    temporalClaim: {
      resourceKey: HERO_RESOURCE_KEYS.production,
      start: attemptedEffect.materialParameters.start,
      end: attemptedEffect.materialParameters.end,
      requiredDuration: resourceClaims.production,
      timeUnit: "minutes",
    },
    claimAccounting: "already_in_portfolio",
    selectedBundleId: "bundle/hero-execution",
    selectedPlanId,
    expectedEffect: command as unknown as JsonValue,
    expectedAfterState: expectedAfterState as unknown as JsonValue,
    attemptedAt: HERO_HORIZON_START,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
    expectedAuthorizationStateVersion: versions.authorizationStateVersion,
    expectedCalibrationFrontierDigest: accepted.calibrationFrontierDigest,
  };
}

function prepareClaimedFixture(
  options: { readonly competingCas?: boolean } = {},
): ClaimedMutationFixture {
  const fixture = tempDatabases();
  const store = createStore({
    path: fixture.m2Path,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_START,
  });
  const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
  const { initial, accepted, selectedPlanId } = acceptHero(store);
  const versions = store.getPortfolio().versions;
  const grant = store.issueGrant({
    grantId: "grant/hero-execution/v1",
    grantVersion: "grant/v1",
    admissionRecordId: accepted.admissionRecordId,
    promiseBasisId: accepted.promiseBasisId,
    acceptedOwnerDecisionId: "owner-decision/accept-hero-promise",
    ownerDecisionId: "owner-decision/approve-hero-execution",
    selectedBundleId: "bundle/hero-execution",
    selectedPlanId,
    scope: scope(accepted.promiseBasisId),
    postDenialAuthorization: null,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
  });
  store.createDenial({
    denialId: "denial/quantity-below-10",
    deniedEffectFingerprint: effect(FIRST_START, FIRST_END, 5),
    deniedScope: denialScope(accepted.promiseBasisId),
    objectiveId: createHeroProposal().objective,
    approverId: HERO_OWNER_ID,
    evidencePacketId: "evidence/denial/quantity-below-10",
    missionId: "mission/hero-m3",
    reason: "Only the full approved quantity may reserve this slot",
  });

  const before = factory.getScheduleState();
  const command1 = canonicalCommand(
    createHeroProposal().obligationId,
    FIRST_START,
    FIRST_END,
  );
  const after1 = resultingScheduleState(before, "attempt/hero-1", command1);
  const deniedInput = claimInput(
    store,
    accepted,
    selectedPlanId,
    grant.grantAllowanceKey,
    "attempt/denied-alternate",
    effect(FIRST_START, FIRST_END, 5, "microfactory-effect/v2"),
    createHeroProposal().obligationId,
    after1,
    { agent: 1, production: 30 },
  );
  let denialBlocked = false;
  try {
    store.claimExecution(deniedInput);
  } catch (error: unknown) {
    assert.ok(error instanceof AuthorizationDeniedError);
    denialBlocked = true;
  }

  const firstClaim = store.claimExecution(
    claimInput(
      store,
      accepted,
      selectedPlanId,
      grant.grantAllowanceKey,
      "attempt/hero-1",
      effect(FIRST_START, FIRST_END),
      createHeroProposal().obligationId,
      after1,
      { agent: 6, production: 30 },
    ),
  );
  const command2 = canonicalCommand(
    "order/important-drive",
    SECOND_START,
    SECOND_END,
  );
  const secondBefore = options.competingCas === true ? before : after1;
  const after2 = resultingScheduleState(
    secondBefore,
    "attempt/hero-2",
    command2,
  );
  store.claimExecution(
    claimInput(
      store,
      accepted,
      selectedPlanId,
      grant.grantAllowanceKey,
      "attempt/hero-2",
      effect(SECOND_START, SECOND_END),
      "order/important-drive",
      after2,
      { agent: 1, production: 20 },
    ),
  );

  const firstAttempt = store.getExecutionAttempt(firstClaim.executionAttemptId);
  const secondAttempt = store.getExecutionAttempt("attempt/hero-2");
  const firstRequest: AuthorizedScheduleMutation = {
    executionAttemptId: firstAttempt.executionAttemptId,
    claim: claimedExecutionReference(firstAttempt),
    command: commandFromAttempt(firstAttempt),
    expectedBeforeStateVersion: before.stateVersion,
    expectedBeforeStateDigest: factoryStateDigest(before),
  };
  const secondRequest: AuthorizedScheduleMutation = {
    executionAttemptId: secondAttempt.executionAttemptId,
    claim: claimedExecutionReference(secondAttempt),
    command: commandFromAttempt(secondAttempt),
    expectedBeforeStateVersion: secondBefore.stateVersion,
    expectedBeforeStateDigest: factoryStateDigest(secondBefore),
  };
  store.close();
  factory.close();
  return {
    ...fixture,
    initialAdmission: initial,
    acceptedAdmission: accepted,
    denialBlocked,
    firstRequest,
    secondRequest,
  };
}

function durableFactorySnapshot(path: string): string {
  const database = new DatabaseSync(path);
  const tables = [
    "factory_metadata",
    "incoming_proposals",
    "schedule_reservations",
    "execution_results",
    "mutation_events",
  ] as const;
  try {
    return canonicalSerialize(
      Object.fromEntries(
        tables.map((table) => [
          table,
          (database.prepare(`SELECT * FROM ${table}`).all() as Record<
            string,
            unknown
          >[])
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).sort(([left], [right]) =>
                  compareStrings(left, right),
                ),
              ),
            )
            .sort((left, right) =>
              compareStrings(canonicalSerialize(left), canonicalSerialize(right)),
            ),
        ]),
      ),
    );
  } finally {
    database.close();
  }
}

function durableDatabaseSnapshot(path: string): string {
  const database = new DatabaseSync(path);
  try {
    const tables = (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' ORDER BY name`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => String(row["name"]));
    return canonicalSerialize(
      Object.fromEntries(
        tables.map((table) => [
          table,
          (database.prepare(`SELECT * FROM "${table}"`).all() as Record<
            string,
            unknown
          >[])
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).sort(([left], [right]) =>
                  compareStrings(left, right),
                ),
              ),
            )
            .sort((left, right) =>
              compareStrings(canonicalSerialize(left), canonicalSerialize(right)),
            ),
        ]),
      ),
    );
  } finally {
    database.close();
  }
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value), "utf8")
    .digest("hex")}`;
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  output: { value: string },
  predicate: (value: string) => boolean,
): Promise<void> {
  if (predicate(output.value)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for raw MCP output: ${output.value}`));
    }, 5_000);
    const onData = (): void => {
      if (!predicate(output.value)) return;
      cleanup();
      resolve();
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`raw MCP process exited early: ${output.value}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("raw MCP process did not close after rejected frame"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function verifyInIndependentProcess(
  fixture: ClaimedMutationFixture,
  executionAttemptId: string,
): Promise<Record<string, unknown>> {
  const script = [
    "import { createStore } from './dist/src/index.js';",
    "const store = createStore({ path: process.argv[1], authoritativeFactoryDatabasePath: process.argv[2], now: () => '2026-08-26T12:00:00.000Z' });",
    "try { process.stdout.write(JSON.stringify(store.verifyExecutionAuthoritatively(process.argv[3]))); } finally { store.close(); }",
  ].join(" ");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      fixture.m2Path,
      fixture.factoryPath,
      executionAttemptId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end();
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`authoritative verifier child exited ${String(code)}`));
        return;
      }
      resolve(JSON.parse(output) as Record<string, unknown>);
    });
  });
}

async function rejectRawFrameWithoutMutation(
  fixture: ClaimedMutationFixture,
  frame: string,
  mode: "whole" | "fragmented" | "batched" = "whole",
): Promise<void> {
  const beforeFactory = durableDatabaseSnapshot(fixture.factoryPath);
  const beforeM2 = durableDatabaseSnapshot(fixture.m2Path);
  const child = spawn(
    process.execPath,
    [
      "dist/src/mcp-cli.js",
      "--service",
      "factory-change-control",
      "--factory-db",
      fixture.factoryPath,
      "--m2-db",
      fixture.m2Path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const output = { value: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.value += chunk.toString("utf8");
  });
  child.stderr.resume();
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "flakebrake-raw-audit", version: "1" },
    },
  });
  try {
    child.stdin.write(`${initialize}\n`);
    await waitForOutput(child, output, (value) => value.includes('"id":1'));
    const initialized =
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
    if (mode === "fragmented") {
      child.stdin.write(initialized);
      const split = Math.floor(frame.length / 2);
      child.stdin.write(frame.slice(0, split));
      child.stdin.write(`${frame.slice(split)}\n`);
    } else if (mode === "batched") {
      child.stdin.write(`${initialized}${frame}\n`);
    } else {
      child.stdin.write(initialized);
      child.stdin.write(`${frame}\n`);
    }
    await waitForOutput(child, output, (value) => value.includes('"code":-32700'));
    await waitForExit(child);
    assert.equal(durableDatabaseSnapshot(fixture.factoryPath), beforeFactory);
    assert.equal(durableDatabaseSnapshot(fixture.m2Path), beforeM2);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

async function runStrictJsonGuard(
  chunks: readonly Buffer[],
): Promise<{ readonly output: Buffer; readonly rejections: readonly Error[] }> {
  const output: Buffer[] = [];
  const rejections: Error[] = [];
  const guard = new StrictJsonLineInput({
    onRejected: (error) => rejections.push(error),
  });
  guard.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  for (const chunk of chunks) guard.write(chunk);
  const finished = new Promise<void>((resolve, reject) => {
    guard.once("finish", resolve);
    guard.once("error", reject);
  });
  guard.end();
  await finished;
  return { output: Buffer.concat(output), rejections };
}

async function rejectRawBytesWithoutMutation(
  fixture: ClaimedMutationFixture,
  bytes: Buffer,
): Promise<string> {
  const beforeFactory = durableDatabaseSnapshot(fixture.factoryPath);
  const beforeM2 = durableDatabaseSnapshot(fixture.m2Path);
  const child = spawn(
    process.execPath,
    [
      "dist/src/mcp-cli.js",
      "--service",
      "factory-change-control",
      "--factory-db",
      fixture.factoryPath,
      "--m2-db",
      fixture.m2Path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const output = { value: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.value += chunk.toString("utf8");
  });
  child.stderr.resume();
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "flakebrake-byte-audit", version: "1" },
    },
  });
  try {
    child.stdin.write(`${initialize}\n`);
    await waitForOutput(child, output, (value) => value.includes('"id":1'));
    child.stdin.write(
      Buffer.concat([
        Buffer.from(
          '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
        ),
        bytes,
      ]),
    );
    await waitForOutput(child, output, (value) => value.includes('"code":-32700'));
    await waitForExit(child);
    assert.equal(durableDatabaseSnapshot(fixture.factoryPath), beforeFactory);
    assert.equal(durableDatabaseSnapshot(fixture.m2Path), beforeM2);
    return output.value;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

describe("M3 genuine MCP lifecycle and deterministic hero", () => {
  let fixture: TempDatabases;
  let cluster: RunningFactoryMcpCluster;

  before(async () => {
    fixture = initializeReadFixture();
    cluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
  });

  after(async () => {
    await cluster.close();
    removeFixture(fixture);
  });

  test("1. all four distinct stdio MCP services initialize and respond", async () => {
    assert.equal(cluster.transport, "stdio");
    assert.deepEqual([...cluster.services.keys()], FACTORY_MCP_SERVICE_NAMES);
    for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
      const connection = cluster.services.get(serviceName);
      assert.ok(connection);
      assert.equal(connection.client.getServerVersion()?.name, serviceName);
      await connection.client.ping();
    }
  });

  test("2. exposed tools carry exact read/write annotations", async () => {
    const expected = new Map([
      ["factory-orders", ["read_incoming_proposals", "read_orders"]],
      ["factory-capacity", ["read_actual_consumption", "read_capacity_plan"]],
      ["factory-simulator", ["evaluate_candidate_schedules", "evaluate_hero_fixture"]],
      ["factory-change-control", ["create_schedule_reservation", "read_schedule_state", "submit_schedule_change"]],
    ]);
    for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
      const connection = cluster.services.get(serviceName);
      assert.ok(connection);
      const listed = await connection.client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        expected.get(serviceName),
      );
      for (const tool of listed.tools) {
        const consequential =
          tool.name === "create_schedule_reservation" ||
          tool.name === "submit_schedule_change";
        assert.deepEqual(tool.annotations, {
          destructiveHint: consequential,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: !consequential,
        });
        assert.equal(tool.inputSchema["additionalProperties"], false);
      }
    }
  });

  test("3. orders read returns exact immutable seeded portfolio version", async () => {
    const output = resultObject(await call(cluster, "factory-orders", "read_orders"));
    assert.equal(output["portfolioVersion"], "portfolio/v1");
    const orders = output["orders"] as Record<string, unknown>[];
    assert.deepEqual(
      orders.map((order) => order["obligationId"]),
      [
        "order/best-effort-display",
        "order/important-drive",
        "order/protected-medical",
      ],
    );
    assert.equal(
      (orders.find((order) => order["protected"] === true)?.[
        "schedulingCommitment"
      ] as Record<string, unknown>)["reservationId"],
      "schedule/protected-medical/v1",
    );
  });

  test("4. capacity read returns exact immutable model and plan", async () => {
    const output = resultObject(
      await call(cluster, "factory-capacity", "read_capacity_plan"),
    );
    assert.equal(output["capacityModelVersion"], "capacity-model/v1");
    assert.equal(output["capacityPlanVersion"], "capacity-plan/v1");
    const resources = output["resources"] as Record<string, unknown>[];
    assert.deepEqual(
      resources.map((resource) => [resource["resourceKey"], resource["capacity"]]),
      [
        [HERO_RESOURCE_KEYS.agent, 12],
        [HERO_RESOURCE_KEYS.human, 4],
        [HERO_RESOURCE_KEYS.production, 110],
      ],
    );
  });

  test("5. direct hero admission exceeds both human and agent capacity and returns REPLAN", async () => {
    const output = resultObject(
      await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
    );
    const result = output["result"] as ReturnType<typeof evaluateAdmission>;
    assert.equal(result.decision, "REPLAN");
    assert.equal(amount(result.directPlan.capacityAfter, HERO_RESOURCE_KEYS.agent), -2);
    assert.equal(amount(result.directPlan.capacityAfter, HERO_RESOURCE_KEYS.human), -1);
    assert.equal(
      amount(result.directPlan.capacityAfter, HERO_RESOURCE_KEYS.production),
      10,
    );
  });

  test("6. both strategy families exist and the exact lexicographic winner is stable", () => {
    const result = evaluateAdmission(createHeroEvaluationInput());
    assert.equal(result.decision, "REPLAN");
    assert.deepEqual(
      result.strategyFamilies.map((family) => [family.strategy, family.status]),
      [
        ["modify_proposal", "available"],
        ["modify_existing", "available"],
      ],
    );
    assert.equal(
      result.recommendedCandidate?.candidatePlanId,
      "replan-plan/sha256:68fe99d3402893002930fa143b1089629e4722215d1624af5924d628430aafe2",
    );
    assert.equal(result.recommendedCandidate?.strategy, "modify_existing");
  });

  test("7. production becomes binding in the proposal-modification candidate", () => {
    const result = evaluateAdmission(createHeroEvaluationInput());
    assert.equal(result.decision, "REPLAN");
    const proposalCandidate = result.candidates.find(
      (candidate) => candidate.strategy === "modify_proposal",
    );
    assert.ok(proposalCandidate);
    assert.equal(
      amount(proposalCandidate.capacity.capacityAfter, HERO_RESOURCE_KEYS.production),
      0,
    );
    assert.deepEqual(proposalCandidate.capacity.bindingOrLimitingResources, {
      kind: "binding",
      resourceKeys: [
        HERO_RESOURCE_KEYS.human,
        HERO_RESOURCE_KEYS.production,
      ],
    });
  });

  test("8. protected accepted work is byte-identical and every modification remains above its floor", () => {
    const input = createHeroEvaluationInput();
    const protectedBefore = input.acceptedObligations.find(
      (order) => order.protected,
    );
    assert.ok(protectedBefore);
    const beforeBytes = canonicalSerialize(protectedBefore);
    const result = evaluateAdmission(input);
    assert.equal(result.decision, "REPLAN");
    for (const candidate of result.candidates) {
      assert.equal(
        candidate.affectedObligations.some(
          (change) => change.obligationId === protectedBefore.obligationId,
        ),
        false,
      );
      for (const change of candidate.affectedObligations) {
        const original = [...input.acceptedObligations, input.proposal].find(
          (order) => order.obligationId === change.obligationId,
        );
        assert.ok(original);
        for (const value of change.proposedServiceLevel) {
          assert.ok(value.value >= (original.minimumService[value.field] ?? Infinity));
        }
      }
    }
    assert.equal(canonicalSerialize(protectedBefore), beforeBytes);
  });

  test("9. simulation is deterministic with stable evidence and zero external mutation", async () => {
    const beforeState = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    const arguments_ = {
      evaluation_input: createHeroEvaluationInput() as unknown as Record<
        string,
        unknown
      >,
    };
    const first = resultObject(
      await call(
        cluster,
        "factory-simulator",
        "evaluate_candidate_schedules",
        arguments_,
      ),
    );
    const second = resultObject(
      await call(
        cluster,
        "factory-simulator",
        "evaluate_candidate_schedules",
        arguments_,
      ),
    );
    assert.equal(canonicalSerialize(first), canonicalSerialize(second));
    assert.match(String(first["evidenceReceiptId"]), /^simulation-evidence\/sha256:[0-9a-f]{64}$/u);
    assert.equal(first["mutationCount"], 0);
    assert.equal(
      canonicalSerialize(
        resultObject(
          await call(cluster, "factory-change-control", "read_schedule_state"),
        ),
      ),
      canonicalSerialize(beforeState),
    );
  });

  test("10. malformed and unknown MCP input representations fail closed", async () => {
    const unknown = await call(cluster, "factory-orders", "read_orders", {
      unknown: true,
    });
    assert.equal(unknown.isError, true);
    const malformed = await call(
      cluster,
      "factory-simulator",
      "evaluate_candidate_schedules",
      { evaluation_input: { unexpected: true } },
    );
    assert.equal(malformed.isError, true);
  });
});

describe("M3 controlled mutation, replay, denial, restart, and read-back", () => {
  let fixture: ClaimedMutationFixture;
  let cluster: RunningFactoryMcpCluster;

  before(async () => {
    fixture = prepareClaimedFixture();
    cluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
  });

  after(async () => {
    await cluster.close();
    removeFixture(fixture);
  });

  test("11. a consequential call without an exact M2 claim is rejected with zero mutation", async () => {
    const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
    const request = {
      ...fixture.firstRequest,
      executionAttemptId: "attempt/not-claimed",
    };
    const result = await call(
      cluster,
      "factory-change-control",
      "create_schedule_reservation",
      mutationArguments(request),
    );
    assert.equal(result.isError, true);
    assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot);
  });

  test("12. wrong admission, decisions, plan, bundle, or allowance each leave a complete durable snapshot unchanged", async () => {
    const fields = [
      "admissionRecordId",
      "acceptedOwnerDecisionId",
      "grantOwnerDecisionId",
      "selectedPlanId",
      "selectedBundleId",
      "grantAllowanceKey",
    ] as const;
    for (const field of fields) {
      const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
      const request: AuthorizedScheduleMutation = {
        ...fixture.firstRequest,
        claim: { ...fixture.firstRequest.claim, [field]: `wrong/${field}` },
      };
      const result = await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(request),
      );
      assert.equal(result.isError, true, field);
      assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot, field);
    }
  });

  test("13. wrong effect, versions, allowance ordinal, or expected state each fail with zero mutation", async () => {
    const variants: AuthorizedScheduleMutation[] = [
      {
        ...fixture.firstRequest,
        claim: {
          ...fixture.firstRequest.claim,
          effect: effect(FIRST_START, FIRST_END, 9),
        },
      },
      {
        ...fixture.firstRequest,
        claim: {
          ...fixture.firstRequest.claim,
          expectedPortfolioVersion: "portfolio/v999",
        },
      },
      {
        ...fixture.firstRequest,
        claim: {
          ...fixture.firstRequest.claim,
          expectedAuthorizationStateVersion: "authorization/v999",
        },
      },
      {
        ...fixture.firstRequest,
        claim: {
          ...fixture.firstRequest.claim,
          grantExecutionOrdinal: 999,
        },
      },
      {
        ...fixture.firstRequest,
        claim: {
          ...fixture.firstRequest.claim,
          expectedAfterState: {
            ...(fixture.firstRequest.claim.expectedAfterState as unknown as FactoryScheduleState),
            stateVersion: "factory-state/v999",
          },
        },
      },
    ];
    for (const variant of variants) {
      const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
      const result = await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(variant),
      );
      assert.equal(result.isError, true);
      assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot);
    }
  });

  test("14. an active canonical denial survives the alternate schema and renamed MCP tool", async () => {
    assert.equal(fixture.denialBlocked, true);
    const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
    const denied: AuthorizedScheduleMutation = {
      ...fixture.firstRequest,
      executionAttemptId: "attempt/denied-alternate",
      command: {
        ...fixture.firstRequest.command,
        quantity: 5,
      },
      claim: {
        ...fixture.firstRequest.claim,
        effect: effect(
          FIRST_START,
          FIRST_END,
          5,
          "microfactory-effect/v2",
        ),
      },
    };
    const result = await call(
      cluster,
      "factory-change-control",
      "submit_schedule_change",
      alternateMutationArguments(denied),
    );
    assert.equal(result.isError, true);
    assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot);
  });

  test("15. stale synthetic before-state compare-and-swap fails with zero mutation", async () => {
    const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
    const stale = {
      ...fixture.firstRequest,
      expectedBeforeStateVersion: "factory-state/v999",
    };
    const result = await call(
      cluster,
      "factory-change-control",
      "create_schedule_reservation",
      mutationArguments(stale),
    );
    assert.equal(result.isError, true);
    assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot);
  });

  test("16. a valid approved and claimed attempt produces exactly one synthetic write without claiming VERIFIED", async () => {
    const result = resultObject(
      await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(fixture.firstRequest),
      ),
    );
    assert.equal(result["replayed"], false);
    const mutation = result["result"] as Record<string, unknown>;
    assert.equal(mutation["status"], "MUTATED_PENDING_VERIFICATION");
    const receipt = mutation["receipt"] as Record<string, unknown>;
    assert.equal(receipt["verificationStatus"], "pending_independent_read_back");
    const read = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    assert.equal(read["controlledWriteCount"], 1);
  });

  test("17. identical retry through the alternate adapter returns the original result and receipt without a second write", async () => {
    const first = resultObject(
      await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(fixture.firstRequest),
      ),
    );
    const replay = resultObject(
      await call(
        cluster,
        "factory-change-control",
        "submit_schedule_change",
        alternateMutationArguments(fixture.firstRequest),
      ),
    );
    assert.equal(replay["replayed"], true);
    assert.equal(
      canonicalSerialize(replay["result"]),
      canonicalSerialize(first["result"]),
    );
    const read = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    assert.equal(read["controlledWriteCount"], 1);
  });

  test("18. conflicting execution_attempt_id reuse fails closed", async () => {
    const beforeSnapshot = durableFactorySnapshot(fixture.factoryPath);
    const conflicting = {
      ...fixture.firstRequest,
      command: { ...fixture.firstRequest.command, quantity: 9 },
    };
    const result = await call(
      cluster,
      "factory-change-control",
      "create_schedule_reservation",
      mutationArguments(conflicting),
    );
    assert.equal(result.isError, true);
    assert.equal(durableFactorySnapshot(fixture.factoryPath), beforeSnapshot);
  });

  test("19. restart preserves synthetic state and recorded execution results", async () => {
    const beforeRestart = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    await cluster.close();
    cluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    const afterRestart = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    assert.equal(canonicalSerialize(afterRestart), canonicalSerialize(beforeRestart));
    const replay = resultObject(
      await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(fixture.firstRequest),
      ),
    );
    assert.equal(replay["replayed"], true);
    assert.equal(afterRestart["controlledWriteCount"], 1);
  });

  test("20. authoritative MCP read-back match permits M2 verified success and actual consumption is exactly once", async () => {
    const read = resultObject(
      await call(cluster, "factory-change-control", "read_schedule_state"),
    );
    assert.equal(
      canonicalSerialize(read["state"]),
      canonicalSerialize(fixture.firstRequest.claim.expectedAfterState),
    );
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    const first = store.verifyExecutionAuthoritatively(
      fixture.firstRequest.executionAttemptId,
    );
    const replay = store.verifyExecutionAuthoritatively(
      fixture.firstRequest.executionAttemptId,
    );
    assert.equal(first.claimState, "terminal_verified");
    assert.equal(replay.replayed, true);
    const actuals = store
      .getAdmissionRecord(fixture.acceptedAdmission.admissionRecordId)
      .addenda.filter((addendum) => addendum.kind === "actual_consumption");
    assert.equal(actuals.length, 2);
    store.close();
    const capacityRead = resultObject(
      await call(cluster, "factory-capacity", "read_actual_consumption"),
    );
    assert.equal((capacityRead["facts"] as unknown[]).length, 2);
  });

  test("21. read-back mismatch cannot produce verified success and preserves the M2 reservation", async () => {
    resultObject(
      await call(
        cluster,
        "factory-change-control",
        "create_schedule_reservation",
        mutationArguments(fixture.secondRequest),
      ),
    );
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    assert.throws(
      () =>
        store.recordExecutionTerminal({
          terminalEventId: "terminal/hero-2/invalid",
          executionAttemptId: fixture.secondRequest.executionAttemptId,
          status: "VERIFIED_SUCCESS",
          receiptReference: "factory-mutation-receipt/hero-2",
          observedAfterState: { mismatch: true },
          actualConsumption: [],
        }),
      /requires authoritative factory verification/u,
    );
    const reservation = store
      .getReservations(true)
      .find(
        (candidate) =>
          candidate.executionAttemptId === fixture.secondRequest.executionAttemptId,
      );
    assert.equal(reservation?.claimState, "claimed_nonterminal");
    store.close();
  });

  test("22. temporary databases leave no SQLite artifacts in the repository worktree", () => {
    const repositoryEntries = readdirSync(process.cwd(), { recursive: true });
    const artifacts = repositoryEntries.filter(
      (entry) =>
        typeof entry === "string" &&
        /\.(?:sqlite|sqlite-shm|sqlite-wal)$/u.test(entry),
    );
    assert.deepEqual(artifacts, []);
  });
});

describe("M3 audit fixes: execution fencing and authoritative verification", () => {
  test("23. terminal failure winning before fence creation leaves zero factory writes", () => {
    const fixture = prepareClaimedFixture();
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
    try {
      const terminal = store.recordExecutionTerminal({
        terminalEventId: "terminal/fence-race/pre-fence",
        executionAttemptId: fixture.firstRequest.executionAttemptId,
        status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
        evidenceReference: "audit/interposition/pre-fence",
      });
      assert.equal(terminal.claimState, "terminal_failed_before_mutation");
      assert.throws(
        () => factory.executeAuthorizedScheduleMutation(store, fixture.firstRequest),
        /nonterminal M2 in-flight reservation/u,
      );
      assert.equal(factory.getMutationCount(), 0);
    } finally {
      factory.close();
      store.close();
      removeFixture(fixture);
    }
  });

  test("24. active fence rejects failure-before-mutation and permits one factory result", () => {
    const fixture = prepareClaimedFixture();
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
    try {
      const fence = store.createExecutionFence({
        executionAttemptId: fixture.firstRequest.executionAttemptId,
        expectedCommandDigest: canonicalDigest(fixture.firstRequest.command),
        executorAuthority: "factory-change-control/v1",
        environmentId: HERO_ENVIRONMENT_ID,
      });
      assert.equal(fence.status, "active");
      assert.throws(
        () =>
          store.recordExecutionTerminal({
            terminalEventId: "terminal/fence-race/after-validation",
            executionAttemptId: fixture.firstRequest.executionAttemptId,
            status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
            evidenceReference: "audit/interposition/after-validation",
          }),
        /serialized trusted recovery/u,
      );
      const response = factory.executeAuthorizedScheduleMutation(
        store,
        fixture.firstRequest,
      );
      assert.equal(response.replayed, false);
      assert.equal(response.result.fenceId, fence.fenceId);
      assert.equal(factory.getMutationCount(), 1);
      assert.equal(
        store.getExecutionFence(fixture.firstRequest.executionAttemptId)?.status,
        "factory_result_bound",
      );
      assert.equal(
        store
          .getReservations(true)
          .find(
            (reservation) =>
              reservation.executionAttemptId ===
              fixture.firstRequest.executionAttemptId,
          )?.claimState,
        "claimed_nonterminal",
      );
    } finally {
      factory.close();
      store.close();
      removeFixture(fixture);
    }
  });

  test("25. serialized recovery distinguishes no-result and committed-result fences", () => {
    const noResultFixture = prepareClaimedFixture();
    const noResultStore = createStore({
      path: noResultFixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: noResultFixture.factoryPath,
    });
    const noResultFactory = new SyntheticFactoryEnvironment({
      path: noResultFixture.factoryPath,
    });
    try {
      noResultStore.createExecutionFence({
        executionAttemptId: noResultFixture.firstRequest.executionAttemptId,
        expectedCommandDigest: canonicalDigest(noResultFixture.firstRequest.command),
        executorAuthority: "factory-change-control/v1",
        environmentId: HERO_ENVIRONMENT_ID,
      });
      const recovered = noResultStore.recoverExecutionFence(
        noResultFixture.firstRequest.executionAttemptId,
      );
      assert.equal(recovered.status, "terminal_failed_before_mutation");
      assert.equal(noResultFactory.getMutationCount(), 0);
      assert.throws(
        () =>
          noResultFactory.executeAuthorizedScheduleMutation(
            noResultStore,
            noResultFixture.firstRequest,
          ),
        /released without mutation|nonterminal/u,
      );
    } finally {
      noResultFactory.close();
      noResultStore.close();
      removeFixture(noResultFixture);
    }

    const committedFixture = prepareClaimedFixture();
    const committedStore = createStore({
      path: committedFixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: committedFixture.factoryPath,
    });
    const committedFactory = new SyntheticFactoryEnvironment({
      path: committedFixture.factoryPath,
    });
    try {
      const mutation = committedFactory.executeAuthorizedScheduleMutation(
        committedStore,
        committedFixture.firstRequest,
      );
      const recovered = committedStore.recoverExecutionFence(
        committedFixture.firstRequest.executionAttemptId,
      );
      assert.equal(recovered.status, "factory_result_bound");
      assert.equal(recovered.receiptId, mutation.result.receipt.receiptId);
      assert.equal(committedFactory.getMutationCount(), 1);
    } finally {
      committedFactory.close();
      committedStore.close();
      removeFixture(committedFixture);
    }
  });

  test("26. forged observations, receipts, and caller actuals cannot verify", async () => {
    const fixture = prepareClaimedFixture();
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
    try {
      const mutation = factory.executeAuthorizedScheduleMutation(
        store,
        fixture.firstRequest,
      );
      const before = durableDatabaseSnapshot(fixture.m2Path);
      for (const [terminalEventId, receiptReference, actualValue] of [
        ["terminal/forged/copied", "forged/nonexistent", 6],
        ["terminal/forged/inflated", mutation.result.receipt.receiptId, 999],
        ["terminal/forged/reduced", mutation.result.receipt.receiptId, 0],
      ] as const) {
        assert.throws(
          () =>
            store.recordExecutionTerminal({
              terminalEventId,
              executionAttemptId: fixture.firstRequest.executionAttemptId,
              status: "VERIFIED_SUCCESS",
              receiptReference,
              observedAfterState:
                fixture.firstRequest.claim.expectedAfterState,
              actualConsumption: [
                {
                  resourceKey: HERO_RESOURCE_KEYS.agent,
                  workClassKey: "rush-order/agent-planning",
                  value: actualValue,
                },
              ],
            }),
          /requires authoritative factory verification/u,
        );
        assert.equal(durableDatabaseSnapshot(fixture.m2Path), before);
      }
      const concurrent = await Promise.all([
        verifyInIndependentProcess(
          fixture,
          fixture.firstRequest.executionAttemptId,
        ),
        verifyInIndependentProcess(
          fixture,
          fixture.firstRequest.executionAttemptId,
        ),
      ]);
      assert.deepEqual(
        concurrent.map((result) => result["replayed"]).sort(),
        [false, true],
      );
      const verified = store.verifyExecutionAuthoritatively(
        fixture.firstRequest.executionAttemptId,
      );
      assert.deepEqual(
        verified.actualConsumption.map((actual) => [
          actual.resourceKey,
          actual.value,
        ]),
        [
          [HERO_RESOURCE_KEYS.agent, 6],
          [HERO_RESOURCE_KEYS.production, 30],
        ],
      );
      const replay = store.verifyExecutionAuthoritatively(
        fixture.firstRequest.executionAttemptId,
      );
      assert.equal(replay.replayed, true);
      assert.equal(
        store
          .getAdmissionRecord(fixture.acceptedAdmission.admissionRecordId)
          .addenda.filter((addendum) => addendum.kind === "actual_consumption")
          .length,
        2,
      );
    } finally {
      factory.close();
      store.close();
      removeFixture(fixture);
    }
  });

  test("27. authoritative verification survives restart and rejects wrong environment", () => {
    const fixture = prepareClaimedFixture();
    let store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: fixture.factoryPath,
    });
    const factory = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
    try {
      factory.executeAuthorizedScheduleMutation(store, fixture.firstRequest);
      store.close();
      store = createStore({
        path: fixture.m2Path,
        now: () => HERO_HORIZON_END,
        authoritativeFactoryDatabasePath: fixture.factoryPath,
      });
      assert.equal(
        store.verifyExecutionAuthoritatively(
          fixture.firstRequest.executionAttemptId,
        ).claimState,
        "terminal_verified",
      );
      store.close();
      const corrupt = new DatabaseSync(fixture.factoryPath);
      corrupt
        .prepare(
          "UPDATE factory_metadata SET environment_id = 'other-environment' WHERE singleton = 1",
        )
        .run();
      corrupt.close();
      store = createStore({
        path: fixture.m2Path,
        now: () => HERO_HORIZON_END,
        authoritativeFactoryDatabasePath: fixture.factoryPath,
      });
      assert.throws(
        () =>
          store.verifyExecutionAuthoritatively(
            fixture.firstRequest.executionAttemptId,
          ),
        /executionFenceResultBinding|environment|currentState/u,
      );
    } finally {
      factory.close();
      store.close();
      removeFixture(fixture);
    }
  });

  test("31. missing, cross-attempt, and wrong-fence factory evidence stays nonterminal", () => {
    const missingFixture = prepareClaimedFixture();
    const missingStore = createStore({
      path: missingFixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: missingFixture.factoryPath,
    });
    try {
      assert.throws(
        () =>
          missingStore.verifyExecutionAuthoritatively(
            missingFixture.firstRequest.executionAttemptId,
          ),
        /result-bound execution fence/u,
      );
      assert.equal(
        missingStore
          .getReservations(true)
          .find(
            (reservation) =>
              reservation.executionAttemptId ===
              missingFixture.firstRequest.executionAttemptId,
          )?.claimState,
        "claimed_nonterminal",
      );
    } finally {
      missingStore.close();
      removeFixture(missingFixture);
    }

    const corruptFixture = prepareClaimedFixture();
    const corruptStore = createStore({
      path: corruptFixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: corruptFixture.factoryPath,
    });
    const corruptFactory = new SyntheticFactoryEnvironment({
      path: corruptFixture.factoryPath,
    });
    try {
      const first = corruptFactory.executeAuthorizedScheduleMutation(
        corruptStore,
        corruptFixture.firstRequest,
      );
      const second = corruptFactory.executeAuthorizedScheduleMutation(
        corruptStore,
        corruptFixture.secondRequest,
      );
      corruptFactory.close();
      const database = new DatabaseSync(corruptFixture.factoryPath);
      database.exec("DROP TRIGGER execution_results_no_update");
      const firstRow = database
        .prepare(
          "SELECT result_json FROM execution_results WHERE execution_attempt_id = ?",
        )
        .get(corruptFixture.firstRequest.executionAttemptId) as Record<
        string,
        unknown
      >;
      const crossed = JSON.parse(String(firstRow["result_json"])) as Record<
        string,
        unknown
      >;
      (crossed["receipt"] as Record<string, unknown>)["receiptId"] =
        second.result.receipt.receiptId;
      database
        .prepare(
          `UPDATE execution_results SET result_json = ?
            WHERE execution_attempt_id = ?`,
        )
        .run(
          canonicalSerialize(crossed),
          corruptFixture.firstRequest.executionAttemptId,
        );
      database.close();
      const beforeM2 = durableDatabaseSnapshot(corruptFixture.m2Path);
      assert.throws(
        () =>
          corruptStore.verifyExecutionAuthoritatively(
            corruptFixture.firstRequest.executionAttemptId,
          ),
        /inconsistent attempt, fence, result, or receipt identity/u,
      );
      assert.equal(durableDatabaseSnapshot(corruptFixture.m2Path), beforeM2);
      assert.equal(
        corruptStore
          .getReservations(true)
          .find(
            (reservation) =>
              reservation.executionAttemptId ===
              corruptFixture.firstRequest.executionAttemptId,
          )?.claimState,
        "claimed_nonterminal",
      );
      assert.notEqual(first.result.receipt.receiptId, second.result.receipt.receiptId);
    } finally {
      try {
        corruptFactory.close();
      } catch {
        // The corruption branch closes the environment before direct SQLite edits.
      }
      corruptStore.close();
      removeFixture(corruptFixture);
    }
  });
});

describe("M3 audit fix: authoritative current-state simulation", () => {
  test("28. v1 and accepted v2 simulations use coherent complete current bases", async () => {
    const fixture = initializeReadFixture();
    const cluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    try {
      const virgin = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.equal(virgin["basisStatus"], "COHERENT");
      const virginReceipt = String(virgin["evidenceReceiptId"]);
      const store = createStore({
        path: fixture.m2Path,
        now: () => HERO_HORIZON_START,
      });
      const accepted = acceptHero(store);
      const orders = resultObject(
        await call(cluster, "factory-orders", "read_orders"),
      );
      assert.equal(orders["portfolioVersion"], "portfolio/v2");
      const bestEffort = (orders["orders"] as Record<string, unknown>[]).find(
        (order) => order["obligationId"] === "order/best-effort-display",
      );
      assert.deepEqual(bestEffort?.["serviceLevel"], { quantity: 8 });
      assert.deepEqual(bestEffort?.["minimumService"], { quantity: 5 });
      assert.ok(Array.isArray(bestEffort?.["modificationOptions"]));
      assert.ok(bestEffort?.["workClassByResource"]);
      assert.ok(Array.isArray(bestEffort?.["schedulingCommitments"]));

      const current = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.equal(current["basisStatus"], "COHERENT");
      assert.notEqual(current["evidenceReceiptId"], virginReceipt);
      const evidenceBasis = current["evidenceBasis"] as Record<string, unknown>;
      const evaluationInput = evidenceBasis[
        "evaluationInput"
      ] as AdmissionEvaluationInput;
      assert.equal(evaluationInput.versions.portfolioVersion, "portfolio/v2");
      const evaluatedBestEffort = evaluationInput.acceptedObligations.find(
        (order) => order.obligationId === "order/best-effort-display",
      );
      assert.deepEqual(evaluatedBestEffort?.serviceLevel, { quantity: 8 });
      assert.deepEqual(evaluatedBestEffort?.resourceDemand, {
        [HERO_RESOURCE_KEYS.agent]: 1,
        [HERO_RESOURCE_KEYS.human]: 0,
        [HERO_RESOURCE_KEYS.production]: 20,
      });
      assert.ok(evaluatedBestEffort?.workClassByResource);
      const result = current["result"] as ReturnType<typeof evaluateAdmission>;
      assert.equal(result.decision, "ADMITTABLE");

      store.createDenial({
        denialId: "denial/simulator-basis-change",
        deniedEffectFingerprint: effect(FIRST_START, FIRST_END, 5),
        deniedScope: denialScope(accepted.accepted.promiseBasisId),
        objectiveId: createHeroProposal().objective,
        approverId: HERO_OWNER_ID,
        evidencePacketId: "evidence/simulator-basis-change",
        missionId: "mission/simulator-basis-change",
        reason: "Exercise authoritative simulation authorization basis",
      });
      const authorizationChanged = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.notEqual(
        authorizationChanged["evidenceReceiptId"],
        current["evidenceReceiptId"],
      );

      store.recordActualConsumption({
        actualConsumptionFactId: "actual/simulator-basis-change",
        admissionRecordId: accepted.accepted.admissionRecordId,
        resourceKey: HERO_RESOURCE_KEYS.agent,
        workClassKey: "rush-order/agent-planning",
        value: 7,
        observedAt: HERO_HORIZON_END,
        sourceReceipt: "diagnostic/authoritative-actual",
      });
      store.recordOutcome({
        outcomeFactId: "outcome/simulator-basis-change",
        admissionRecordId: accepted.accepted.admissionRecordId,
        outcome: "completed",
        completedAt: HERO_HORIZON_END,
        sourceReceipt: "diagnostic/authoritative-actual",
      });
      const actualChanged = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.notEqual(
        actualChanged["evidenceReceiptId"],
        authorizationChanged["evidenceReceiptId"],
      );

      const resources = store.getPortfolio().resources.map((resource) =>
        resource.resourceKey === HERO_RESOURCE_KEYS.production
          ? { ...resource, capacity: resource.capacity + 1 }
          : resource,
      );
      store.replaceCapacityPlan({
        resources,
        ownerDecisionId: "owner-decision/simulator-capacity-plan",
        approverId: HERO_OWNER_ID,
      });
      const capacityChanged = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.notEqual(
        capacityChanged["evidenceReceiptId"],
        actualChanged["evidenceReceiptId"],
      );
      const stableReplay = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      assert.equal(
        stableReplay["evidenceReceiptId"],
        capacityChanged["evidenceReceiptId"],
      );
      store.close();
    } finally {
      await cluster.close();
      removeFixture(fixture);
    }
  });

  test("32. active-reservation and authorization transitions change the simulation basis", async () => {
    const fixture = prepareClaimedFixture();
    const cluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    const store = createStore({
      path: fixture.m2Path,
      now: () => HERO_HORIZON_END,
    });
    try {
      const beforeCall = await call(
        cluster,
        "factory-simulator",
        "evaluate_hero_fixture",
      );
      assert.equal(beforeCall.isError, undefined, canonicalSerialize(beforeCall));
      const before = resultObject(beforeCall);
      const beforeInput = (
        before["evidenceBasis"] as Record<string, unknown>
      )["evaluationInput"] as AdmissionEvaluationInput;
      assert.equal(beforeInput.fixedCapacityReservations.length, 2);
      store.recordExecutionTerminal({
        terminalEventId: "terminal/simulator-release/hero-2",
        executionAttemptId: fixture.secondRequest.executionAttemptId,
        status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
        evidenceReference: "audit/simulator-reservation-transition",
      });
      const after = resultObject(
        await call(cluster, "factory-simulator", "evaluate_hero_fixture"),
      );
      const afterInput = (
        after["evidenceBasis"] as Record<string, unknown>
      )["evaluationInput"] as AdmissionEvaluationInput;
      assert.equal(afterInput.fixedCapacityReservations.length, 1);
      assert.notEqual(
        afterInput.versions.authorizationStateVersion,
        beforeInput.versions.authorizationStateVersion,
      );
      assert.notEqual(after["evidenceReceiptId"], before["evidenceReceiptId"]);
      const result = after["result"] as ReturnType<typeof evaluateAdmission>;
      assert.equal(
        result.basis.authorizationStateVersion,
        afterInput.versions.authorizationStateVersion,
      );
      assert.equal(
        result.basis.portfolioVersion,
        afterInput.versions.portfolioVersion,
      );
    } finally {
      store.close();
      await cluster.close();
      removeFixture(fixture);
    }
  });
});

describe("M3 audit fix: duplicate-key rejection before SDK parsing", () => {
  test("29. strict parser detects decoded duplicates at every nesting level", () => {
    assert.deepEqual(
      parseJsonRejectingDuplicateKeys(
        '{"array":[{"escaped\\u005fkey":1}],"unicode":"\\u263a"}',
      ),
      Object.assign(Object.create(null), {
        array: [Object.assign(Object.create(null), { escaped_key: 1 })],
        unicode: "☺",
      }),
    );
    for (const value of [
      '{"key":1,"key":2}',
      '{"outer":{"key":1,"key":2}}',
      '{"array":[{"key":1,"\\u006bey":2}]}',
    ]) {
      assert.throws(() => parseJsonRejectingDuplicateKeys(value), /Duplicate/u);
    }
  });

  test("30. raw duplicate envelope, params, arguments, identities, and nested fields cause zero mutation", async () => {
    const fixture = prepareClaimedFixture();
    try {
      const validFrame = JSON.stringify({
        jsonrpc: "2.0",
        id: 70,
        method: "tools/call",
        params: {
          name: "create_schedule_reservation",
          arguments: mutationArguments(fixture.firstRequest),
        },
      });
      const cases: readonly {
        readonly label: string;
        readonly frame: string;
        readonly mode?: "whole" | "fragmented" | "batched";
      }[] = [
        {
          label: "envelope escaped equivalent",
          frame: validFrame.replace(
            '{"jsonrpc":"2.0"',
            '{"jsonrpc":"1.0","json\\u0072pc":"2.0"',
          ),
        },
        {
          label: "params",
          frame: validFrame.replace(
            '"params":{"name":"create_schedule_reservation"',
            '"params":{"name":"wrong","name":"create_schedule_reservation"',
          ),
        },
        {
          label: "tool arguments",
          frame: validFrame.replace(
            '"arguments":{"execution_attempt_id"',
            '"arguments":{"claim":{},"execution_attempt_id"',
          ).replace('"claim":{', '"claim":{},"claim":{'),
        },
        {
          label: "attempt invalid then valid fragmented",
          frame: validFrame.replace(
            '"execution_attempt_id":"attempt/hero-1"',
            '"execution_attempt_id":"wrong","execution\\u005fattempt_id":"attempt/hero-1"',
          ),
          mode: "fragmented",
        },
        {
          label: "attempt valid then invalid batched",
          frame: validFrame.replace(
            '"execution_attempt_id":"attempt/hero-1"',
            '"execution_attempt_id":"attempt/hero-1","execution\\u005fattempt_id":"wrong"',
          ),
          mode: "batched",
        },
        {
          label: "nested effect",
          frame: validFrame.replace(
            '"effect":{"effectSchemaVersion"',
            '"effect":{"environmentId":"wrong","effectSchemaVersion"',
          ).replace(
            '"environmentId":"microfactory-hero/v1","effectType"',
            '"environmentId":"microfactory-hero/v1","environmentId":"wrong","effectType"',
          ),
        },
        {
          label: "nested expected state",
          frame: validFrame.replace(
            '"expectedAfterState":{',
            '"expectedAfterState":{"stateVersion":"factory-state/v999",',
          ),
        },
        {
          label: "nested material parameters",
          frame: validFrame.replace(
            '"materialParameters":{',
            '"materialParameters":{"quantity":999,',
          ),
        },
      ];
      for (const item of cases) {
        assert.throws(
          () => parseJsonRejectingDuplicateKeys(item.frame),
          /Duplicate/u,
          item.label,
        );
        await rejectRawFrameWithoutMutation(
          fixture,
          item.frame,
          item.mode ?? "whole",
        );
      }
    } finally {
      removeFixture(fixture);
    }
  });
});

describe("M3 audit fix: cross-process exactly-once replay", () => {
  test("33. independent service processes converge concurrent adapter calls", async () => {
    const fixture = prepareClaimedFixture();
    const firstCluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    const secondCluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    try {
      const [firstCall, secondCall] = await Promise.all([
        call(
          firstCluster,
          "factory-change-control",
          "create_schedule_reservation",
          mutationArguments(fixture.firstRequest),
        ),
        call(
          secondCluster,
          "factory-change-control",
          "submit_schedule_change",
          alternateMutationArguments(fixture.firstRequest),
        ),
      ]);
      assert.equal(
        firstCall.isError,
        undefined,
        JSON.stringify(firstCall.content),
      );
      assert.equal(
        secondCall.isError,
        undefined,
        JSON.stringify(secondCall.content),
      );
      const first = resultObject(firstCall);
      const second = resultObject(secondCall);
      assert.deepEqual(
        [first["replayed"], second["replayed"]].sort(),
        [false, true],
      );
      assert.equal(
        canonicalSerialize(first["result"]),
        canonicalSerialize(second["result"]),
      );
      const state = resultObject(
        await call(
          firstCluster,
          "factory-change-control",
          "read_schedule_state",
        ),
      );
      assert.equal(state["controlledWriteCount"], 1);
      const conflicting = await call(
        secondCluster,
        "factory-change-control",
        "submit_schedule_change",
        alternateMutationArguments({
          ...fixture.firstRequest,
          command: { ...fixture.firstRequest.command, quantity: 9 },
        }),
      );
      assert.equal(conflicting.isError, true);
      assert.equal(
        resultObject(
          await call(
            firstCluster,
            "factory-change-control",
            "read_schedule_state",
          ),
        )["controlledWriteCount"],
        1,
      );
    } finally {
      await Promise.allSettled([firstCluster.close(), secondCluster.close()]);
      removeFixture(fixture);
    }
  });

  test("34. competing attempts cannot both cross one factory CAS state", async () => {
    const fixture = prepareClaimedFixture({ competingCas: true });
    const firstCluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    const secondCluster = await startFactoryMcpCluster({
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    try {
      const results = await Promise.all([
        call(
          firstCluster,
          "factory-change-control",
          "create_schedule_reservation",
          mutationArguments(fixture.firstRequest),
        ),
        call(
          secondCluster,
          "factory-change-control",
          "submit_schedule_change",
          alternateMutationArguments(fixture.secondRequest),
        ),
      ]);
      assert.equal(results.filter((result) => result.isError === true).length, 1);
      assert.equal(results.filter((result) => result.isError !== true).length, 1);
      const state = resultObject(
        await call(
          firstCluster,
          "factory-change-control",
          "read_schedule_state",
        ),
      );
      assert.equal(state["controlledWriteCount"], 1);
      const store = createStore({
        path: fixture.m2Path,
        now: () => HERO_HORIZON_END,
        authoritativeFactoryDatabasePath: fixture.factoryPath,
      });
      const loser = results[0]?.isError === true
        ? fixture.firstRequest.executionAttemptId
        : fixture.secondRequest.executionAttemptId;
      const loserFence = store.getExecutionFence(loser);
      if (loserFence === null) {
        const terminal = store.recordExecutionTerminal({
          terminalEventId: `terminal/cas-loser/${loser}`,
          executionAttemptId: loser,
          status: "DEFINITIVE_FAILURE_BEFORE_MUTATION",
          evidenceReference: "factory-cas-preflight-rejection",
        });
        assert.equal(terminal.claimState, "terminal_failed_before_mutation");
      } else {
        const recovery = store.recoverExecutionFence(loser);
        assert.equal(recovery.status, "terminal_failed_before_mutation");
      }
      assert.equal(
        store
          .getReservations(true)
          .find((reservation) => reservation.executionAttemptId === loser)
          ?.claimState,
        "terminal_failed_before_mutation",
      );
      store.close();
    } finally {
      await Promise.allSettled([firstCluster.close(), secondCluster.close()]);
      removeFixture(fixture);
    }
  });
});

describe("M3 Qodo PR #4 regressions", () => {
  test("35. rejected server connection rolls back every startup resource", async () => {
    const fixture = initializeReadFixture();
    const serverPrototype = McpServer.prototype as unknown as {
      connect: (transport: unknown) => Promise<void>;
    };
    const originalConnect = serverPrototype.connect;
    const originalFactoryClose = SyntheticFactoryEnvironment.prototype.close;
    const originalStoreClose = FlakeBrakeStore.prototype.close;
    const startupFailure = new Error("injected MCP transport startup failure");
    let factoryCloseCount = 0;
    let storeCloseCount = 0;
    let rejection: unknown;
    const originalSigint = new Set(process.listeners("SIGINT"));
    const originalSigterm = new Set(process.listeners("SIGTERM"));
    const originalEnd = new Set(process.stdin.listeners("end"));
    const initialTimeoutCount = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    let observedFactoryCloseCount = -1;
    let observedStoreCloseCount = -1;
    let observedSigintCount = -1;
    let observedSigtermCount = -1;
    let observedEndCount = -1;
    let observedTimeoutCount = -1;
    serverPrototype.connect = async () => {
      throw startupFailure;
    };
    SyntheticFactoryEnvironment.prototype.close = function closeFactory(): void {
      factoryCloseCount += 1;
      originalFactoryClose.call(this);
    };
    FlakeBrakeStore.prototype.close = function closeStore(): void {
      storeCloseCount += 1;
      originalStoreClose.call(this);
    };
    try {
      try {
        await serveFactoryMcpStdio("factory-orders", {
          factoryDatabasePath: fixture.factoryPath,
          m2DatabasePath: fixture.m2Path,
        });
      } catch (error: unknown) {
        rejection = error;
      }
      observedFactoryCloseCount = factoryCloseCount;
      observedStoreCloseCount = storeCloseCount;
      observedSigintCount = process.listeners("SIGINT").length;
      observedSigtermCount = process.listeners("SIGTERM").length;
      observedEndCount = process.stdin.listeners("end").length;
      observedTimeoutCount = process
        .getActiveResourcesInfo()
        .filter((resource) => resource === "Timeout").length;
    } finally {
      serverPrototype.connect = originalConnect;
      const addedSigterm = process
        .listeners("SIGTERM")
        .filter((listener) => !originalSigterm.has(listener));
      for (const listener of addedSigterm) {
        Reflect.apply(listener, process, ["SIGTERM"]);
      }
      await waitForImmediate();
      await waitForImmediate();
      for (const listener of process.listeners("SIGINT")) {
        if (!originalSigint.has(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!originalSigterm.has(listener)) process.removeListener("SIGTERM", listener);
      }
      for (const listener of process.stdin.listeners("end")) {
        if (!originalEnd.has(listener)) {
          process.stdin.removeListener("end", listener as () => void);
        }
      }
      const clean = createFactoryMcpService("factory-orders", {
        factoryDatabasePath: fixture.factoryPath,
        m2DatabasePath: fixture.m2Path,
      });
      await clean.close();
      SyntheticFactoryEnvironment.prototype.close = originalFactoryClose;
      FlakeBrakeStore.prototype.close = originalStoreClose;
      removeFixture(fixture);
    }
    assert.equal(rejection, startupFailure);
    assert.equal(observedFactoryCloseCount, 1);
    assert.equal(observedStoreCloseCount, 1);
    assert.equal(observedSigintCount, originalSigint.size);
    assert.equal(observedSigtermCount, originalSigterm.size);
    assert.equal(observedEndCount, originalEnd.size);
    assert.ok(observedTimeoutCount <= initialTimeoutCount);
  });

  test("36. M2 construction failure closes the acquired factory", () => {
    const fixture = tempDatabases();
    const originalFactoryClose = SyntheticFactoryEnvironment.prototype.close;
    let factoryCloseCount = 0;
    let startupError: unknown;
    let rollbackCloseCount = -1;
    SyntheticFactoryEnvironment.prototype.close = function closeFactory(): void {
      factoryCloseCount += 1;
      originalFactoryClose.call(this);
    };
    try {
      try {
        createFactoryMcpService("factory-orders", {
          factoryDatabasePath: fixture.factoryPath,
          m2DatabasePath: fixture.m2Path,
        });
      } catch (error: unknown) {
        startupError = error;
      }
      rollbackCloseCount = factoryCloseCount;
      const reopened = new SyntheticFactoryEnvironment({ path: fixture.factoryPath });
      reopened.close();
    } finally {
      SyntheticFactoryEnvironment.prototype.close = originalFactoryClose;
      removeFixture(fixture);
    }
    assert.match(String(startupError), /initialState/u);
    assert.equal(rollbackCloseCount, 1);
    assert.equal(factoryCloseCount, 2);
  });

  test("37. partial close failure retains retry ownership and closes databases", async () => {
    const fixture = initializeReadFixture();
    const originalFactoryClose = SyntheticFactoryEnvironment.prototype.close;
    const originalStoreClose = FlakeBrakeStore.prototype.close;
    let factoryCloseCount = 0;
    let storeCloseCount = 0;
    SyntheticFactoryEnvironment.prototype.close = function closeFactory(): void {
      factoryCloseCount += 1;
      originalFactoryClose.call(this);
    };
    FlakeBrakeStore.prototype.close = function closeStore(): void {
      storeCloseCount += 1;
      originalStoreClose.call(this);
    };
    const running = createFactoryMcpService("factory-orders", {
      factoryDatabasePath: fixture.factoryPath,
      m2DatabasePath: fixture.m2Path,
    });
    const originalServerClose = running.server.close.bind(running.server);
    const closeFailure = new Error("injected server close failure");
    let serverCloseAttempts = 0;
    running.server.close = async () => {
      serverCloseAttempts += 1;
      if (serverCloseAttempts === 1) throw closeFailure;
      await originalServerClose();
    };
    let firstError: unknown;
    let firstFactoryCloseCount = -1;
    let firstStoreCloseCount = -1;
    try {
      try {
        await running.close();
      } catch (error: unknown) {
        firstError = error;
      }
      firstFactoryCloseCount = factoryCloseCount;
      firstStoreCloseCount = storeCloseCount;
      await running.close();
      await running.close();
    } finally {
      SyntheticFactoryEnvironment.prototype.close = originalFactoryClose;
      FlakeBrakeStore.prototype.close = originalStoreClose;
      removeFixture(fixture);
    }
    assert.equal(firstError, closeFailure);
    assert.equal(firstFactoryCloseCount, 1);
    assert.equal(firstStoreCloseCount, 1);
    assert.equal(serverCloseAttempts, 2);
    assert.equal(factoryCloseCount, 1);
    assert.equal(storeCloseCount, 1);
  });

  test("38. blank environment identities fail before durable mutation", () => {
    const constructionResults: {
      readonly environmentId: string;
      readonly error: unknown;
      readonly before: string;
      readonly after: string;
    }[] = [];
    for (const environmentId of ["", "   "]) {
      const fixture = tempDatabases();
      const before = canonicalSerialize(readdirSync(fixture.directory).sort());
      let environment: SyntheticFactoryEnvironment | undefined;
      let error: unknown;
      try {
        environment = new SyntheticFactoryEnvironment({
          path: fixture.factoryPath,
          environmentId,
        });
      } catch (caught: unknown) {
        error = caught;
      } finally {
        environment?.close();
      }
      const after = canonicalSerialize(readdirSync(fixture.directory).sort());
      constructionResults.push({ environmentId, error, before, after });
      removeFixture(fixture);
    }

    const mutationFixture = prepareClaimedFixture();
    const store = createStore({
      path: mutationFixture.m2Path,
      now: () => HERO_HORIZON_END,
      authoritativeFactoryDatabasePath: mutationFixture.factoryPath,
    });
    const factory = new SyntheticFactoryEnvironment({
      path: mutationFixture.factoryPath,
    });
    const beforeFactory = durableDatabaseSnapshot(mutationFixture.factoryPath);
    const beforeM2 = durableDatabaseSnapshot(mutationFixture.m2Path);
    let mutationError: unknown;
    try {
      factory.executeAuthorizedScheduleMutation(store, {
        ...mutationFixture.firstRequest,
        command: {
          ...mutationFixture.firstRequest.command,
          environmentId: "   ",
        },
      });
    } catch (error: unknown) {
      mutationError = error;
    } finally {
      factory.close();
      store.close();
    }
    const afterFactory = durableDatabaseSnapshot(mutationFixture.factoryPath);
    const afterM2 = durableDatabaseSnapshot(mutationFixture.m2Path);
    removeFixture(mutationFixture);

    for (const result of constructionResults) {
      assert.match(
        String(result.error),
        /environmentId.*non-whitespace/u,
        JSON.stringify(result.environmentId),
      );
      assert.equal(result.after, result.before, JSON.stringify(result.environmentId));
    }
    assert.match(String(mutationError), /command\.environmentId.*non-whitespace/u);
    assert.equal(afterFactory, beforeFactory);
    assert.equal(afterM2, beforeM2);
  });

  test("39. malformed UTF-8 is rejected before MCP parsing or mutation", async () => {
    const prefix = Buffer.from('{"value":"');
    const suffix = Buffer.from('"}\n');
    const malformedContinuation = await runStrictJsonGuard([
      Buffer.concat([prefix, Buffer.from([0x80]), suffix]),
    ]);
    const truncatedMultibyte = await runStrictJsonGuard([
      Buffer.concat([prefix, Buffer.from([0xe2, 0x82]), suffix]),
    ]);
    const euroFrame = Buffer.from('{"value":"€"}\n');
    const euroStart = euroFrame.indexOf(0xe2);
    const validFragmented = await runStrictJsonGuard([
      euroFrame.subarray(0, euroStart + 1),
      euroFrame.subarray(euroStart + 1, euroStart + 2),
      euroFrame.subarray(euroStart + 2),
    ]);

    const fixture = prepareClaimedFixture();
    try {
      const consequentialFrame = Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 91,
          method: "tools/call",
          params: {
            name: "create_schedule_reservation",
            arguments: mutationArguments(fixture.firstRequest),
          },
        })}\n`,
      );
      const malformedThenConsequential = Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":90,"method":"ping","bad":"'),
        Buffer.from([0x80]),
        Buffer.from('"}\n'),
        consequentialFrame,
      ]);
      const output = await rejectRawBytesWithoutMutation(
        fixture,
        malformedThenConsequential,
      );
      assert.match(output, /"code":-32700/u);
    } finally {
      removeFixture(fixture);
    }

    assert.equal(malformedContinuation.output.length, 0);
    assert.match(String(malformedContinuation.rejections[0]), /UTF-8/u);
    assert.equal(truncatedMultibyte.output.length, 0);
    assert.match(String(truncatedMultibyte.rejections[0]), /UTF-8/u);
    assert.equal(validFragmented.rejections.length, 0);
    assert.deepEqual(validFragmented.output, euroFrame);
  });

  test("40. frame bounds apply per raw newline-delimited frame", async () => {
    const maximumFrameBytes = 10 * 1024 * 1024;
    const exactPrefix = Buffer.from('{"payload":"');
    const exactSuffix = Buffer.from('"}');
    const exactFrame = Buffer.concat([
      exactPrefix,
      Buffer.alloc(
        maximumFrameBytes - exactPrefix.length - exactSuffix.length,
        0x61,
      ),
      exactSuffix,
    ]);
    const exactBoundary = await runStrictJsonGuard([
      Buffer.concat([exactFrame, Buffer.from("\n")]),
    ]);

    const firstFrame = Buffer.from('{"small":true}\n');
    const oversizedFrame = Buffer.alloc(maximumFrameBytes + 1, 0x20);
    const followingFrame = Buffer.from('{"following":true}\n');
    const validBatch = await runStrictJsonGuard([
      Buffer.concat([firstFrame, followingFrame]),
    ]);
    const batched = await runStrictJsonGuard([
      Buffer.concat([
        firstFrame,
        oversizedFrame,
        Buffer.from("\n"),
        followingFrame,
      ]),
    ]);
    const unterminated = await runStrictJsonGuard([
      Buffer.alloc(maximumFrameBytes, 0x20),
      Buffer.from(" "),
    ]);

    const fixture = prepareClaimedFixture();
    try {
      const validConsequential = Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 93,
          method: "tools/call",
          params: {
            name: "create_schedule_reservation",
            arguments: mutationArguments(fixture.firstRequest),
          },
        })}\n`,
      );
      const output = await rejectRawBytesWithoutMutation(
        fixture,
        Buffer.concat([
          Buffer.alloc(maximumFrameBytes + 1, 0x20),
          Buffer.from("\n"),
          validConsequential,
        ]),
      );
      assert.match(output, /"code":-32700/u);
    } finally {
      removeFixture(fixture);
    }

    assert.equal(exactBoundary.rejections.length, 0);
    assert.deepEqual(exactBoundary.output, Buffer.concat([exactFrame, Buffer.from("\n")]));
    assert.equal(validBatch.rejections.length, 0);
    assert.deepEqual(validBatch.output, Buffer.concat([firstFrame, followingFrame]));
    assert.equal(batched.rejections.length, 1);
    assert.match(String(batched.rejections[0]), /exceeds 10 MiB/u);
    assert.deepEqual(batched.output, firstFrame);
    assert.equal(unterminated.rejections.length, 1);
    assert.match(String(unterminated.rejections[0]), /exceeds 10 MiB/u);
    assert.equal(unterminated.output.length, 0);
  });
});
