import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
  readDatabaseInstanceIdentity,
  StatefulInputError,
  SyntheticFactoryEnvironment,
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

interface SqliteDurableSnapshot {
  readonly artifacts: Readonly<Record<string, string>>;
  readonly columns: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  readonly foreignKeys: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  readonly indexes: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
  readonly journalMode: string | null;
  readonly metadata: readonly Readonly<Record<string, unknown>>[];
  readonly rows: Readonly<Record<string, readonly string[]>>;
  readonly schema: readonly Readonly<Record<string, unknown>>[];
  readonly tables: readonly string[];
  readonly triggers: readonly Readonly<Record<string, unknown>>[];
}

function sqliteDurableSnapshot(path: string): SqliteDurableSnapshot {
  let columns: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  > = {};
  let foreignKeys: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  > = {};
  let indexes: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  > = {};
  let journalMode: string | null = null;
  let metadata: readonly Readonly<Record<string, unknown>>[] = [];
  let rows: Readonly<Record<string, readonly string[]>> = {};
  let schema: readonly Readonly<Record<string, unknown>>[] = [];
  let tables: readonly string[] = [];
  let triggers: readonly Readonly<Record<string, unknown>>[] = [];
  if (existsSync(path)) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      journalMode = String(
        (
          database.prepare("PRAGMA journal_mode").get() as
            | Record<string, unknown>
            | undefined
        )?.["journal_mode"] ?? "",
      );
      schema = (
        database
          .prepare(
            `SELECT type, name, tbl_name, sql
               FROM sqlite_master
              WHERE name NOT LIKE 'sqlite_%'
              ORDER BY type, name`,
          )
          .all() as Record<string, unknown>[]
      ).map(sortRecord);
      tables = schema
        .filter((entry) => entry["type"] === "table")
        .map((entry) => String(entry["name"]));
      columns = Object.fromEntries(
        tables.map((table) => [
          table,
          (
            database
              .prepare(`PRAGMA table_xinfo("${table.replaceAll('"', '""')}")`)
              .all() as Record<string, unknown>[]
          ).map(sortRecord),
        ]),
      );
      foreignKeys = Object.fromEntries(
        tables.map((table) => [
          table,
          (
            database
              .prepare(
                `PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`,
              )
              .all() as Record<string, unknown>[]
          ).map(sortRecord),
        ]),
      );
      indexes = Object.fromEntries(
        tables.map((table) => {
          const escapedTable = table.replaceAll('"', '""');
          const indexRows = database
            .prepare(`PRAGMA index_list("${escapedTable}")`)
            .all() as Record<string, unknown>[];
          return [
            table,
            indexRows.flatMap((indexRow) => {
              const indexName = String(indexRow["name"]);
              const escapedIndex = indexName.replaceAll('"', '""');
              const columnsForIndex = database
                .prepare(`PRAGMA index_xinfo("${escapedIndex}")`)
                .all() as Record<string, unknown>[];
              return [
                sortRecord({ kind: "index", ...indexRow }),
                ...columnsForIndex.map((row) =>
                  sortRecord({ indexName, kind: "index-column", ...row }),
                ),
              ];
            }),
          ];
        }),
      );
      triggers = schema.filter((entry) => entry["type"] === "trigger");
      rows = Object.fromEntries(
        tables.map((table) => [
          table,
          (
            database
              .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`)
              .all() as Record<string, unknown>[]
          )
            .map((row) => JSON.stringify(sortRecord(row)))
            .sort(),
        ]),
      );
      metadata = ["database_incarnation", "factory_metadata", "state_versions"]
        .filter((table) => tables.includes(table))
        .flatMap((table) =>
          (
            database
              .prepare(`SELECT * FROM "${table}"`)
              .all() as Record<string, unknown>[]
          ).map((row) => sortRecord({ table, ...row })),
        );
    } finally {
      database.close();
    }
  }
  const artifacts = Object.fromEntries(
    [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter((artifactPath) => existsSync(artifactPath))
      .map((artifactPath) => [
        artifactPath.slice(path.length) || "main",
        createHash("sha256").update(readFileSync(artifactPath)).digest("hex"),
      ]),
  );
  return {
    artifacts,
    columns,
    foreignKeys,
    indexes,
    journalMode,
    metadata,
    rows,
    schema,
    tables,
    triggers,
  };
}

function assertLogicalAndSidecarSnapshotEqual(
  actual: SqliteDurableSnapshot,
  expected: SqliteDurableSnapshot,
): void {
  const { artifacts: actualArtifacts, ...actualLogical } = actual;
  const { artifacts: expectedArtifacts, ...expectedLogical } = expected;
  assert.deepEqual(actualLogical, expectedLogical);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(actualArtifacts).filter(([name]) => name !== "main"),
    ),
    Object.fromEntries(
      Object.entries(expectedArtifacts).filter(([name]) => name !== "main"),
    ),
  );
  assert.equal("main" in actualArtifacts, "main" in expectedArtifacts);
}

function databaseHandleUsesPath(
  database: DatabaseSync,
  path: string,
): boolean {
  const row = (
    database.prepare("PRAGMA database_list").all() as Record<string, unknown>[]
  ).find((entry) => entry["name"] === "main");
  return row?.["file"] === path;
}

function sortRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function removeDatabaseIncarnation(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      DROP TRIGGER database_incarnation_immutable_update;
      DROP TRIGGER database_incarnation_immutable_delete;
      DROP TABLE database_incarnation;
    `);
  } finally {
    database.close();
  }
}

interface SchemaDefinition {
  readonly name: string;
  readonly sql: string;
  readonly type: string;
}

function copyApplicationSchemaWithTransform(
  sourcePath: string,
  targetPath: string,
  transform: (definition: SchemaDefinition) => string | null =
    (definition) => definition.sql,
): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath);
  try {
    const definitions = source
      .prepare(
        `SELECT type, name, sql
           FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'
            AND name NOT IN (
              'database_incarnation',
              'database_incarnation_immutable_update',
              'database_incarnation_immutable_delete'
            )
          ORDER BY CASE type
                     WHEN 'table' THEN 1
                     WHEN 'index' THEN 2
                     WHEN 'trigger' THEN 3
                     ELSE 4
                   END,
                   name`,
      )
      .all() as Record<string, unknown>[];
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const definition of definitions) {
        const transformed = transform({
          name: String(definition["name"]),
          sql: String(definition["sql"]),
          type: String(definition["type"]),
        });
        if (transformed !== null) target.exec(transformed);
      }
      target.exec("COMMIT");
    } catch (error: unknown) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
    source.close();
  }
}

function copyApplicationSchema(sourcePath: string, targetPath: string): void {
  copyApplicationSchemaWithTransform(sourcePath, targetPath);
}

interface LegacySchemaMutation {
  readonly extraSql?: string;
  readonly fragment?: readonly [from: string, to: string];
  readonly name: string;
  readonly objectName?: string;
  readonly omitObject?: string;
}

function createMutatedLegacySchema(
  sourcePath: string,
  targetPath: string,
  mutation: LegacySchemaMutation,
): void {
  let changed = false;
  copyApplicationSchemaWithTransform(sourcePath, targetPath, (definition) => {
    if (definition.name === mutation.omitObject) {
      changed = true;
      return null;
    }
    if (
      definition.name === mutation.objectName &&
      mutation.fragment !== undefined
    ) {
      const [from, to] = mutation.fragment;
      assert.ok(
        definition.sql.includes(from),
        `${mutation.name}: expected schema fragment was absent`,
      );
      changed = true;
      return definition.sql.replace(from, to);
    }
    return definition.sql;
  });
  if (mutation.extraSql !== undefined) {
    const database = new DatabaseSync(targetPath);
    try {
      database.exec(mutation.extraSql);
      changed = true;
    } finally {
      database.close();
    }
  }
  assert.equal(changed, true, `${mutation.name}: fixture did not change schema`);
}

function setJournalMode(path: string, mode: "DELETE" | "WAL"): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA journal_mode = ${mode}`);
  } finally {
    database.close();
  }
}

function assertInjectedWalFailureIsAtomic(
  path: string,
  construct: () => unknown,
  expectedWalAttempts = 1,
): void {
  const before = sqliteDurableSnapshot(path);
  const primary = new Error(`planned WAL activation failure for ${path}`);
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  let closeCount = 0;
  let walAttempts = 0;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) {
      walAttempts += 1;
      originalExec.call(this, sql);
      throw primary;
    }
    originalExec.call(this, sql);
  };
  DatabaseSync.prototype.close = function (): void {
    closeCount += 1;
    originalClose.call(this);
  };
  try {
    assert.throws(construct, (error: unknown) => error === primary);
    assert.equal(walAttempts, expectedWalAttempts);
    assert.equal(closeCount, 1);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
  }
  const after = sqliteDurableSnapshot(path);
  if ("main" in before.artifacts) {
    assertLogicalAndSidecarSnapshotEqual(after, before);
  } else {
    assert.deepEqual(after, before);
  }
}

interface ConcurrentInitializationFailureFixture {
  readonly construct: () => unknown;
  readonly failureMarker: string;
  readonly path: string;
  readonly readCommittedValue: (database: DatabaseSync) => number;
  readonly writeSql: string;
}

function assertConcurrentCommitSurvivesInitializationFailure(
  fixture: ConcurrentInitializationFailureFixture,
): void {
  const before = sqliteDurableSnapshot(fixture.path);
  const primary = new Error(
    `planned initialization failure before concurrent commit: ${fixture.failureMarker}`,
  );
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  let failureInjected = false;
  let initializationLockReleased = false;
  let concurrentCommitted = false;
  let committedSnapshot: SqliteDurableSnapshot | undefined;
  let peer: DatabaseSync | undefined;

  const injectedExec = function (this: DatabaseSync, sql: string): void {
    originalExec.call(this, sql);
    if (
      !failureInjected &&
      databaseHandleUsesPath(this, fixture.path) &&
      sql.includes(fixture.failureMarker)
    ) {
      failureInjected = true;
      throw primary;
    }
  };
  const injectedClose = function (this: DatabaseSync): void {
    const target = databaseHandleUsesPath(this, fixture.path);
    originalClose.call(this);
    if (!target || !failureInjected || concurrentCommitted) return;
    initializationLockReleased = true;
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
    peer = new DatabaseSync(fixture.path);
    peer.exec("PRAGMA wal_autocheckpoint = 0");
    peer.exec(`BEGIN IMMEDIATE; ${fixture.writeSql}; COMMIT;`);
    concurrentCommitted = true;
    committedSnapshot = sqliteDurableSnapshot(fixture.path);
    DatabaseSync.prototype.exec = injectedExec;
    DatabaseSync.prototype.close = injectedClose;
  };

  DatabaseSync.prototype.exec = injectedExec;
  DatabaseSync.prototype.close = injectedClose;
  try {
    assert.throws(fixture.construct, (error: unknown) => error === primary);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
  }

  try {
    assert.equal(failureInjected, true);
    assert.equal(initializationLockReleased, true);
    assert.equal(concurrentCommitted, true);
    assert.ok(peer !== undefined);
    assert.equal(
      (peer.prepare("PRAGMA quick_check").get() as Record<string, unknown>)[
        "quick_check"
      ],
      "ok",
    );
    const reader = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(fixture.readCommittedValue(reader), 2);
    } finally {
      reader.close();
    }
    const after = sqliteDurableSnapshot(fixture.path);
    assert.deepEqual(after, committedSnapshot);
    assert.notDeepEqual(after, before);
  } finally {
    peer?.close();
  }
}

const INITIALIZER_PROCESS_SOURCE = String.raw`
  const send = (message, disconnect = false) => {
    if (typeof process.send !== "function") {
      throw new Error("initializer process has no IPC channel");
    }
    process.send(message, (error) => {
      if (error) throw error;
      if (disconnect) process.disconnect();
    });
  };
  send({ kind: "ready" });
  process.once("message", async (message) => {
    if (message?.kind !== "start") return;
    send({ kind: "attempting" });
    let resource;
    try {
      if (message.storeKind === "m2") {
        const { openSqlite } = await import(message.sqliteModuleUrl);
        resource = openSqlite(message.path);
        const row = resource.prepare(
          "SELECT incarnation_id FROM database_incarnation WHERE singleton = 1",
        ).get();
        const identity = row.incarnation_id;
        resource.close();
        resource = undefined;
        send({ kind: "complete", handleState: "closed", identity }, true);
      } else if (message.storeKind === "factory") {
        const { SyntheticFactoryEnvironment } = await import(message.factoryModuleUrl);
        resource = new SyntheticFactoryEnvironment({ path: message.path });
        const identity = resource.databaseInstanceIdentity();
        resource.close();
        resource = undefined;
        send({ kind: "complete", handleState: "closed", identity }, true);
      } else {
        throw new Error("unsupported initializer store kind");
      }
    } catch (error) {
      let cleanupError;
      try {
        resource?.close();
      } catch (caught) {
        cleanupError = caught;
      }
      send({
        kind: "error",
        cleanupFailed: cleanupError !== undefined,
        message: String(error?.message ?? error),
      }, true);
    }
  });
`;

function spawnInitializerProcess(): ChildProcess {
  return spawn(
    process.execPath,
    ["--input-type=module", "--eval", INITIALIZER_PROCESS_SOURCE],
    {
      env: { NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
}

function waitForChildMessage(
  child: ChildProcess,
  expectedKind: string,
): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `initializer process exited before ${expectedKind}: ${String(code ?? signal)}`,
        ),
      );
    };
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Readonly<Record<string, unknown>>;
      if (record["kind"] === "error") {
        cleanup();
        reject(new Error(String(record["message"] ?? "initializer failed")));
      }
      if (record["kind"] === expectedKind) {
        cleanup();
        resolve(record);
      }
    };
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(
          new Error(`initializer process exited with code ${child.exitCode}`),
        );
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `initializer process exited unexpectedly: ${String(code ?? signal)}`,
          ),
        );
      }
    });
  });
}

function sendChildMessage(
  child: ChildProcess,
  message: Readonly<Record<string, unknown>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("initializer process IPC channel is closed"));
      return;
    }
    child.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function stopInitializerProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill();
  await exited;
}

function waitForWorkerMessage(
  worker: Worker,
  expectedKind: string,
): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("message", onMessage);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(
        new Error(`initializer worker exited before ${expectedKind}: ${code}`),
      );
    };
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Readonly<Record<string, unknown>>;
      if (record["kind"] === "error") {
        cleanup();
        reject(new Error(String(record["message"] ?? "initializer failed")));
      }
      if (record["kind"] === expectedKind) {
        cleanup();
        resolve(record);
      }
    };
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.on("message", onMessage);
  });
}

function waitForWorkerExit(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`initializer worker exited with code ${code}`));
    });
  });
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
    ownerSourceIdentity: "test-owner-source/owner-1",
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

describe("M2 Qodo PR #5 atomicity and database incarnation", () => {
  test("acceptance and its exact grant roll back and replay as one durable pair", () => {
    const item = tempStoreFromState(initialState());
    try {
      const admission = evaluate(item.store);
      const acceptance = acceptInput(admission);
      const fullGrant = issueInput(
        item.store.getPortfolio().versions,
        admission,
        "qodo-atomic-grant",
        "qodo-atomic-grant-decision",
        "qodo-atomic-bundle",
        scope(admission.promiseBasisId),
      );
      const {
        expectedPortfolioVersion: _expectedPortfolioVersion,
        expectedCapacityModelVersion: _expectedCapacityModelVersion,
        expectedCapacityPlanVersion: _expectedCapacityPlanVersion,
        ...grant
      } = fullGrant;
      const before = durableState(item.path);
      assert.throws(
        () =>
          item.store.acceptPromiseAndIssueGrant({
            acceptance,
            grant: {
              ...grant,
              scope: {
                ...grant.scope,
                objectiveId: "objective/qodo-injected-failure",
              },
            },
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), before);

      const committed = item.store.acceptPromiseAndIssueGrant({
        acceptance,
        grant,
      });
      assert.equal(committed.acceptance.status, "COMMITTED");
      assert.ok(committed.grant);
      assert.equal(
        item.store
          .getAdmissionRecord(admission.admissionRecordId)
          .addenda.filter((addendum) => addendum.kind === "acceptance_commit")
          .length,
        1,
      );
      assert.deepEqual(
        item.store.acceptPromiseAndIssueGrant({ acceptance, grant }),
        committed,
      );
      const after = durableState(item.path);
      assert.throws(
        () =>
          item.store.acceptPromiseAndIssueGrant({
            acceptance,
            grant: { ...grant, selectedBundleId: "qodo-conflicting-bundle" },
          }),
        StatefulInputError,
      );
      assert.deepEqual(durableState(item.path), after);
    } finally {
      dispose(item);
    }
  });

  test("database incarnation migrates once, survives restart, and rejects mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-incarnation-"));
    const path = join(directory, "m2 with spaces.sqlite");
    const uninitialized = new DatabaseSync(path);
    uninitialized.close();
    const store = createStore({ path, initialState: initialState() });
    store.close();
    try {
      const first = readDatabaseInstanceIdentity(path, "m2", "factory-1");
      const restarted = createStore({ path });
      restarted.close();
      assert.equal(
        readDatabaseInstanceIdentity(path, "m2", "factory-1"),
        first,
      );
      const database = new DatabaseSync(path);
      try {
        assert.throws(
          () =>
            database
              .prepare(
                "UPDATE database_incarnation SET incarnation_id = ? WHERE singleton = 1",
              )
              .run("database-incarnation/forged"),
          /database incarnation is immutable/u,
        );
        assert.throws(
          () =>
            database
              .prepare("DELETE FROM database_incarnation WHERE singleton = 1")
              .run(),
          /database incarnation is immutable/u,
        );
      } finally {
        database.close();
      }
      assert.equal(
        readDatabaseInstanceIdentity(path, "m2", "factory-1"),
        first,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R2.3 acceptance replay rejects a different approver without mutation", async () => {
    const item = tempStoreFromState(initialState());
    try {
      const admission = evaluate(item.store);
      const acceptance = acceptInput(admission);
      const fullGrant = issueInput(
        item.store.getPortfolio().versions,
        admission,
        "qodo-r2-grant",
        "qodo-r2-grant-decision",
        "qodo-r2-bundle",
        scope(admission.promiseBasisId),
      );
      const {
        expectedPortfolioVersion: _expectedPortfolioVersion,
        expectedCapacityModelVersion: _expectedCapacityModelVersion,
        expectedCapacityPlanVersion: _expectedCapacityPlanVersion,
        ...grant
      } = fullGrant;
      const committed = item.store.acceptPromiseAndIssueGrant({
        acceptance,
        grant,
      });
      const committedSnapshot = durableState(item.path);

      assert.throws(
        () =>
          item.store.acceptPromiseAndIssueGrant({
            acceptance: { ...acceptance, approverId: "owner-2" },
            grant,
          }),
        /approver|immutable|decision data|conflicting identity/u,
      );
      assert.deepEqual(durableState(item.path), committedSnapshot);
      assert.throws(
        () =>
          item.store.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              ownerSourceIdentity: "test-owner-source/conflicting-adapter",
            },
            grant,
          }),
        /complete immutable authorization request|conflicting identity/u,
      );
      assert.deepEqual(durableState(item.path), committedSnapshot);

      item.store.close();
      const restarted = createStore({ path: item.path, now: () => START });
      try {
        assert.deepEqual(
          restarted.acceptPromiseAndIssueGrant({ acceptance, grant }),
          committed,
        );
        assert.throws(
          () =>
            restarted.acceptPromiseAndIssueGrant({
              acceptance: { ...acceptance, approverId: "owner-after-restart" },
              grant,
            }),
          /approver|immutable|decision data|conflicting identity/u,
        );
      } finally {
        restarted.close();
      }
      assert.deepEqual(durableState(item.path), committedSnapshot);
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }

    const concurrent = tempStoreFromState(initialState());
    try {
      const admission = evaluate(concurrent.store);
      const acceptance = acceptInput(admission);
      const fullGrant = issueInput(
        concurrent.store.getPortfolio().versions,
        admission,
        "qodo-r2-concurrent-grant",
        "qodo-r2-concurrent-grant-decision",
        "qodo-r2-concurrent-bundle",
        scope(admission.promiseBasisId),
      );
      const {
        expectedPortfolioVersion: _expectedPortfolioVersion,
        expectedCapacityModelVersion: _expectedCapacityModelVersion,
        expectedCapacityPlanVersion: _expectedCapacityPlanVersion,
        ...grant
      } = fullGrant;
      const peer = createStore({ path: concurrent.path, now: () => START });
      try {
        const differentApprovers = await Promise.allSettled([
          Promise.resolve().then(() =>
            concurrent.store.acceptPromiseAndIssueGrant({ acceptance, grant }),
          ),
          Promise.resolve().then(() =>
            peer.acceptPromiseAndIssueGrant({
              acceptance: { ...acceptance, approverId: "owner-2" },
              grant,
            }),
          ),
        ]);
        assert.equal(
          differentApprovers.filter((result) => result.status === "fulfilled")
            .length,
          1,
        );
        assert.equal(
          differentApprovers.filter((result) => result.status === "rejected")
            .length,
          1,
        );
        const sameApprover = await Promise.all([
          Promise.resolve().then(() =>
            concurrent.store.acceptPromiseAndIssueGrant({ acceptance, grant }),
          ),
          Promise.resolve().then(() =>
            peer.acceptPromiseAndIssueGrant({ acceptance, grant }),
          ),
        ]);
        assert.deepEqual(sameApprover[0], sameApprover[1]);
      } finally {
        peer.close();
      }
      const finalSnapshot = durableState(concurrent.path);
      assert.equal(finalSnapshot["owner_decisions"]?.length, 2);
      assert.equal(finalSnapshot["grants"]?.length, 1);
      assert.equal(
        finalSnapshot["admission_addenda"]?.filter((row) =>
          row.includes('"kind":"acceptance_commit"'),
        ).length,
        1,
      );
    } finally {
      dispose(concurrent);
    }
  });

  test("Qodo R3.4 legacy acceptance and grant replay without rewriting history", () => {
    const item = tempStoreFromState(initialState());
    let closed = false;
    try {
      const admission = evaluate(item.store);
      const acceptance = acceptInput(admission);
      const fullGrant = issueInput(
        item.store.getPortfolio().versions,
        admission,
        "qodo-r3-legacy-grant",
        "qodo-r3-legacy-grant-decision",
        "qodo-r3-legacy-bundle",
        scope(admission.promiseBasisId),
      );
      const {
        expectedPortfolioVersion: _expectedPortfolioVersion,
        expectedCapacityModelVersion: _expectedCapacityModelVersion,
        expectedCapacityPlanVersion: _expectedCapacityPlanVersion,
        ...grant
      } = fullGrant;
      const committed = item.store.acceptPromiseAndIssueGrant({
        acceptance,
        grant,
      });
      item.store.close();
      closed = true;

      const fixture = new DatabaseSync(item.path);
      try {
        const row = fixture
          .prepare(
            "SELECT sequence, body_json FROM admission_addenda WHERE kind = 'acceptance_commit'",
          )
          .get() as Record<string, unknown>;
        const body = JSON.parse(String(row["body_json"])) as Record<
          string,
          unknown
        >;
        delete body["authorizationRequest"];
        fixture.exec("DROP TRIGGER admission_addenda_immutable_update");
        fixture
          .prepare("UPDATE admission_addenda SET body_json = ? WHERE sequence = ?")
          .run(JSON.stringify(body), Number(row["sequence"]));
        fixture.exec(`
          CREATE TRIGGER admission_addenda_immutable_update
          BEFORE UPDATE ON admission_addenda
          BEGIN
            SELECT RAISE(ABORT, 'admission_addenda rows are immutable');
          END;
        `);
      } finally {
        fixture.close();
      }

      const beforeReplay = durableState(item.path);
      const restarted = createStore({ path: item.path, now: () => START });
      try {
        assert.deepEqual(
          restarted.acceptPromiseAndIssueGrant({ acceptance, grant }),
          committed,
        );
        const assertCompatibilityConflict = (operation: () => unknown): void => {
          assert.throws(
            operation,
            /compatibility|conflict|immutable|not found|selected plan|basis|reused|decision data/u,
          );
          assert.deepEqual(durableState(item.path), beforeReplay);
        };
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: { ...acceptance, approverId: "owner-legacy-conflict" },
            grant,
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              ownerSourceIdentity: "test-owner-source/legacy-conflict",
            },
            grant,
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              admissionRecordId: "admission/legacy-conflict",
            },
            grant: {
              ...grant,
              admissionRecordId: "admission/legacy-conflict",
            },
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              ownerDecisionId: "owner-decision/legacy-conflict",
            },
            grant,
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: { ...acceptance, selectedPlanId: "plan/legacy-conflict" },
            grant: { ...grant, selectedPlanId: "plan/legacy-conflict" },
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              expectedCapacityModelVersion: "capacity-model/v999",
            },
            grant,
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance: {
              ...acceptance,
              expectedCalibrationFrontierDigest: `sha256:${"f".repeat(64)}`,
            },
            grant,
          }),
        );
        assertCompatibilityConflict(() =>
          restarted.acceptPromiseAndIssueGrant({
            acceptance,
            grant: { ...grant, selectedBundleId: "bundle/legacy-conflict" },
          }),
        );
      } finally {
        restarted.close();
      }
      assert.deepEqual(durableState(item.path), beforeReplay);
    } finally {
      if (!closed) item.store.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R3.5 exact admission basis replay covers every authoritative input", async () => {
    const exact = tempStoreFromState(initialState());
    try {
      const proposal = rush("basis-exact");
      const first = exact.store.evaluateAndRecordAdmissionOrReplay({ proposal });
      assert.equal(
        exact.store.evaluateAndRecordAdmissionOrReplay({ proposal })
          .admissionRecordId,
        first.admissionRecordId,
      );
      const peer = createStore({ path: exact.path, now: () => START });
      try {
        const concurrent = await Promise.all([
          Promise.resolve().then(() =>
            exact.store.evaluateAndRecordAdmissionOrReplay({ proposal }),
          ),
          Promise.resolve().then(() =>
            peer.evaluateAndRecordAdmissionOrReplay({ proposal }),
          ),
        ]);
        assert.equal(concurrent[0].admissionRecordId, first.admissionRecordId);
        assert.equal(concurrent[1].admissionRecordId, first.admissionRecordId);
      } finally {
        peer.close();
      }
      exact.store.close();
      const restarted = createStore({ path: exact.path, now: () => START });
      try {
        assert.equal(
          restarted.evaluateAndRecordAdmissionOrReplay({ proposal })
            .admissionRecordId,
          first.admissionRecordId,
        );
      } finally {
        restarted.close();
      }
    } finally {
      rmSync(exact.directory, { recursive: true, force: true });
    }

    const basisMutation = (
      name: string,
      mutate: (item: TempStore) => void,
    ): void => {
      const item = tempStoreFromState(initialState());
      try {
        const proposal = rush(`basis-${name}`);
        const first = item.store.evaluateAndRecordAdmissionOrReplay({ proposal });
        mutate(item);
        const fresh = item.store.evaluateAndRecordAdmissionOrReplay({ proposal });
        assert.notEqual(fresh.admissionRecordId, first.admissionRecordId, name);
        assert.equal(
          item.store.evaluateAndRecordAdmissionOrReplay({ proposal })
            .admissionRecordId,
          fresh.admissionRecordId,
          `${name} exact replay`,
        );
      } finally {
        dispose(item);
      }
    };
    basisMutation("portfolio-version", ({ store }) => {
      store.withImmediateTransaction((database) => {
        database.exec(
          "UPDATE state_versions SET portfolio_version = portfolio_version + 1 WHERE singleton = 1",
        );
      });
    });
    basisMutation("capacity-model", ({ store }) => {
      store.replaceCapacityModel({
        resources: store.getPortfolio().resources.map((resource) =>
          resource.resourceKey === AGENT
            ? { ...resource, estimatorRule: "changed-estimator/v1" }
            : resource,
        ),
      });
    });
    basisMutation("capacity-plan-value", ({ store }) => {
      store.replaceCapacityPlan({
        resources: store.getPortfolio().resources.map((resource) =>
          resource.resourceKey === AGENT
            ? { ...resource, capacity: resource.capacity + 1 }
            : resource,
        ),
        ownerDecisionId: "owner-decision/basis-capacity-plan",
        approverId: "owner-1",
      });
    });

    const reservation = tempStoreFromState(initialState());
    try {
      const authorization = acceptAndGrant(reservation.store);
      const proposal = rush("basis-reservation");
      const before = reservation.store.evaluateAndRecordAdmissionOrReplay({
        proposal,
      });
      reservation.store.claimExecution(
        claimInput(reservation.store, authorization, "attempt/basis-reservation"),
      );
      const after = reservation.store.evaluateAndRecordAdmissionOrReplay({
        proposal,
      });
      assert.notEqual(after.admissionRecordId, before.admissionRecordId);
      assert.notDeepEqual(
        after.fixedInFlightExecutionReservations,
        before.fixedInFlightExecutionReservations,
      );
    } finally {
      dispose(reservation);
    }

    const inputs = tempStoreFromState(initialState());
    try {
      const proposal = rush("basis-proposal-inputs");
      const base = inputs.store.evaluateAndRecordAdmissionOrReplay({ proposal });
      const variants: readonly [string, ProposedObligation][] = [
        [
          "effect/proposal",
          { ...proposal, requiredEffects: ["effect:changed"] },
        ],
        [
          "deterministic decision",
          {
            ...proposal,
            acceptanceDecision: {
              ...proposal.acceptanceDecision,
              objectiveId: "objective:changed",
            },
          },
        ],
        [
          "plan",
          {
            ...proposal,
            resourceDemand: {
              ...proposal.resourceDemand,
              [AGENT]: (proposal.resourceDemand[AGENT] ?? 0) + 1,
            },
          },
        ],
        [
          "bundle",
          {
            ...proposal,
            pendingOwnerDecisions: [
              {
                decisionId: "decision:changed",
                kind: "consequential_effect",
                objectiveId: "objective:changed-bundle",
                evidencePacketId: "evidence:changed-bundle",
                approverId: "owner-1",
                executionBoundaryId: "boundary:changed-bundle",
              },
            ],
          },
        ],
        ["evidence", { ...proposal, evidenceRefs: ["evidence:changed"] }],
      ];
      for (const [name, variant] of variants) {
        const fresh = inputs.store.evaluateAndRecordAdmissionOrReplay({
          proposal: variant,
        });
        assert.notEqual(fresh.admissionRecordId, base.admissionRecordId, name);
        assert.equal(
          inputs.store.evaluateAndRecordAdmissionOrReplay({ proposal: variant })
            .admissionRecordId,
          fresh.admissionRecordId,
          `${name} exact replay`,
        );
      }
    } finally {
      dispose(inputs);
    }
  });
});

describe("Qodo Round 4 SQLite memory-store compatibility", () => {
  test("constructs, operates, and idempotently closes a transient FlakeBrake store", () => {
    const store = createStore({
      path: ":memory:",
      initialState: initialState(),
      now: () => START,
    });
    assert.equal(store.getPortfolio().acceptedObligations.length, 1);
    assert.equal(evaluate(store).decision, "ADMITTABLE");
    store.close();
    store.close();
  });

  test("constructs, operates, and idempotently closes a transient factory environment", () => {
    const factory = new SyntheticFactoryEnvironment({
      path: ":memory:",
      environmentId: "factory-1",
      now: () => START,
    });
    assert.equal(factory.getScheduleState().environmentId, "factory-1");
    assert.equal(factory.getIncomingProposals().length, 1);
    factory.close();
    factory.close();
  });

  test("assigns separate memory databases distinct incarnation-based lock identities", () => {
    const left = createStore({ path: ":memory:", initialState: initialState() });
    const right = createStore({ path: ":memory:", initialState: initialState() });
    const leftFactory = new SyntheticFactoryEnvironment({ path: ":memory:" });
    const rightFactory = new SyntheticFactoryEnvironment({ path: ":memory:" });
    try {
      const leftIdentity = left.databaseInstanceIdentity("factory-1");
      assert.equal(left.databaseInstanceIdentity("factory-1"), leftIdentity);
      assert.notEqual(
        right.databaseInstanceIdentity("factory-1"),
        leftIdentity,
      );
      const leftFactoryIdentity = leftFactory.databaseInstanceIdentity();
      assert.equal(leftFactory.databaseInstanceIdentity(), leftFactoryIdentity);
      assert.notEqual(
        rightFactory.databaseInstanceIdentity(),
        leftFactoryIdentity,
      );
      assert.throws(
        () => readDatabaseInstanceIdentity(":memory:", "m2", "factory-1"),
        /no reopenable instance identity/u,
      );
    } finally {
      rightFactory.close();
      leftFactory.close();
      right.close();
      left.close();
    }
  });

  test("closes M2 and factory handles after deterministic post-open initialization failures", () => {
    for (const fixture of [
      {
        marker: "CREATE TABLE IF NOT EXISTS state_versions",
        construct: () =>
          createStore({ path: ":memory:", initialState: initialState() }),
      },
      {
        marker: "CREATE TABLE IF NOT EXISTS factory_metadata",
        construct: () => new SyntheticFactoryEnvironment({ path: ":memory:" }),
      },
    ]) {
      const primary = new Error(`planned initialization failure: ${fixture.marker}`);
      const originalExec = DatabaseSync.prototype.exec;
      const originalClose = DatabaseSync.prototype.close;
      let opened: DatabaseSync | undefined;
      let closeCount = 0;
      DatabaseSync.prototype.exec = function (sql: string): void {
        opened = this;
        if (sql.includes(fixture.marker)) throw primary;
        originalExec.call(this, sql);
      };
      DatabaseSync.prototype.close = function (): void {
        closeCount += 1;
        originalClose.call(this);
      };
      try {
        assert.throws(fixture.construct, (error: unknown) => error === primary);
        assert.equal(closeCount, 1);
        assert.throws(() => opened?.prepare("SELECT 1"), /not open|closed/u);
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        DatabaseSync.prototype.close = originalClose;
        if (closeCount === 0) opened?.close();
      }
    }
  });

  test("preserves the initialization error when deterministic cleanup also rejects", () => {
    const primary = new Error("planned primary initialization failure");
    const cleanup = new Error("planned cleanup failure");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let closeCount = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (sql.includes("CREATE TABLE IF NOT EXISTS state_versions")) {
        throw primary;
      }
      originalExec.call(this, sql);
    };
    DatabaseSync.prototype.close = function (): void {
      closeCount += 1;
      originalClose.call(this);
      throw cleanup;
    };
    try {
      assert.throws(
        () => createStore({ path: ":memory:", initialState: initialState() }),
        (error: unknown) => error === primary,
      );
      assert.equal(closeCount, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
    }
  });
});

describe("Qodo Round 5 failure-atomic SQLite store initialization", () => {
  test("Qodo R5.1 rejects an M2 database opened as factory without durable contamination", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-m2-as-factory-"));
    const path = join(directory, "m2.sqlite");
    const store = createStore({ path, initialState: initialState() });
    store.close();
    try {
      const before = sqliteDurableSnapshot(path);
      assert.throws(
        () => new SyntheticFactoryEnvironment({ path }),
        /m2.*factory|factory.*m2|store kind/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.2 rejects a factory database opened as M2 without durable contamination", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-factory-as-m2-"));
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    try {
      const before = sqliteDurableSnapshot(path);
      assert.throws(
        () => createStore({ path }),
        /factory.*m2|m2.*factory|store kind/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.3 reopens a current M2 store idempotently", () => {
    const item = tempStore();
    item.store.close();
    try {
      const before = sqliteDurableSnapshot(item.path);
      const restarted = createStore({ path: item.path });
      assert.equal(restarted.getPortfolio().acceptedObligations.length, 1);
      restarted.close();
      assert.deepEqual(sqliteDurableSnapshot(item.path), before);
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.4 reopens a current factory store idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-current-factory-"));
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    try {
      const before = sqliteDurableSnapshot(path);
      const restarted = new SyntheticFactoryEnvironment({ path });
      assert.equal(restarted.getIncomingProposals().length, 1);
      restarted.close();
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.5 creates a complete M2 schema from an empty database", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-empty-m2-"));
    const path = join(directory, "m2.sqlite");
    new DatabaseSync(path).close();
    try {
      const store = createStore({ path, initialState: initialState() });
      store.close();
      const snapshot = sqliteDurableSnapshot(path);
      assert.ok(snapshot.tables.includes("state_versions"));
      assert.deepEqual(snapshot.rows["database_incarnation"]?.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.6 creates a complete factory schema from an empty database", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-empty-factory-"));
    const path = join(directory, "factory.sqlite");
    new DatabaseSync(path).close();
    try {
      const factory = new SyntheticFactoryEnvironment({ path });
      factory.close();
      const snapshot = sqliteDurableSnapshot(path);
      assert.ok(snapshot.tables.includes("factory_metadata"));
      assert.deepEqual(snapshot.rows["database_incarnation"]?.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.7 migrates a recognized legacy M2 schema without rewriting ledger rows", () => {
    const item = tempStore();
    item.store.close();
    removeDatabaseIncarnation(item.path);
    try {
      const legacy = sqliteDurableSnapshot(item.path);
      const ledgerRows = legacy.rows;
      const restarted = createStore({ path: item.path });
      restarted.close();
      const migrated = sqliteDurableSnapshot(item.path);
      assert.equal(migrated.rows["database_incarnation"]?.length, 1);
      for (const [table, rows] of Object.entries(ledgerRows)) {
        assert.deepEqual(migrated.rows[table], rows, table);
      }
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.8 migrates a recognized legacy factory schema without rewriting application rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-legacy-factory-"));
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    removeDatabaseIncarnation(path);
    try {
      const legacy = sqliteDurableSnapshot(path);
      const restarted = new SyntheticFactoryEnvironment({ path });
      restarted.close();
      const migrated = sqliteDurableSnapshot(path);
      assert.equal(migrated.rows["database_incarnation"]?.length, 1);
      for (const [table, rows] of Object.entries(legacy.rows)) {
        assert.deepEqual(migrated.rows[table], rows, table);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.9 rejects an ambiguous mixed schema without mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-ambiguous-"));
    const m2Path = join(directory, "mixed.sqlite");
    const factoryPath = join(directory, "factory-source.sqlite");
    const store = createStore({ path: m2Path, initialState: initialState() });
    store.close();
    const factory = new SyntheticFactoryEnvironment({ path: factoryPath });
    factory.close();
    copyApplicationSchema(factoryPath, m2Path);
    try {
      const before = sqliteDurableSnapshot(m2Path);
      assert.throws(
        () => {
          const opened = createStore({ path: m2Path });
          opened.close();
        },
        /ambiguous|cross-contaminated/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(m2Path), before);
      assert.throws(
        () => {
          const opened = new SyntheticFactoryEnvironment({ path: m2Path });
          opened.close();
        },
        /ambiguous|cross-contaminated/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(m2Path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.10 rejects a foreign SQLite database without mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-foreign-"));
    const path = join(directory, "foreign.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE foreign_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO foreign_records (id, value) VALUES (1, 'foreign')").run();
    database.close();
    try {
      const before = sqliteDurableSnapshot(path);
      assert.throws(
        () => {
          const opened = createStore({ path, initialState: initialState() });
          opened.close();
        },
        /foreign/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(path), before);
      assert.throws(
        () => {
          const opened = new SyntheticFactoryEnvironment({ path });
          opened.close();
        },
        /foreign/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.11 rejects a corrupt partial known schema without mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-partial-"));
    const path = join(directory, "partial.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE state_versions (
        singleton INTEGER PRIMARY KEY,
        portfolio_version INTEGER NOT NULL,
        capacity_model_version INTEGER NOT NULL,
        capacity_plan_version INTEGER NOT NULL,
        authorization_state_version INTEGER NOT NULL
      ) STRICT
    `);
    database.close();
    try {
      const before = sqliteDurableSnapshot(path);
      assert.throws(
        () => {
          const opened = createStore({ path, initialState: initialState() });
          opened.close();
        },
        /corrupt|partial/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.12 rolls back partial M2 schema initialization and closes the handle", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-failed-m2-"));
    const path = join(directory, "m2.sqlite");
    new DatabaseSync(path).close();
    const before = sqliteDurableSnapshot(path);
    const primary = new Error("planned partial M2 schema initialization failure");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let closeCount = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      originalExec.call(this, sql);
      if (sql.includes("admission_records_immutable_update")) throw primary;
    };
    DatabaseSync.prototype.close = function (): void {
      closeCount += 1;
      originalClose.call(this);
    };
    try {
      assert.throws(
        () => createStore({ path, initialState: initialState() }),
        (error: unknown) => error === primary,
      );
      assert.equal(closeCount, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
    }
    try {
      assertLogicalAndSidecarSnapshotEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.13 rolls back partial factory schema initialization and closes the handle", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-failed-factory-"));
    const path = join(directory, "factory.sqlite");
    new DatabaseSync(path).close();
    const before = sqliteDurableSnapshot(path);
    const primary = new Error("planned partial factory schema initialization failure");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let closeCount = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      originalExec.call(this, sql);
      if (sql.includes("mutation_events_no_delete")) throw primary;
    };
    DatabaseSync.prototype.close = function (): void {
      closeCount += 1;
      originalClose.call(this);
    };
    try {
      assert.throws(
        () => new SyntheticFactoryEnvironment({ path }),
        (error: unknown) => error === primary,
      );
      assert.equal(closeCount, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
    }
    try {
      assertLogicalAndSidecarSnapshotEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R5.14 keeps M2 and factory in-memory initialization supported", () => {
    const store = createStore({ path: ":memory:", initialState: initialState() });
    const factory = new SyntheticFactoryEnvironment({ path: ":memory:" });
    try {
      assert.equal(store.getPortfolio().acceptedObligations.length, 1);
      assert.equal(factory.getIncomingProposals().length, 1);
      assert.notEqual(
        store.databaseInstanceIdentity("factory-1"),
        factory.databaseInstanceIdentity(),
      );
    } finally {
      factory.close();
      store.close();
    }
  });

  test("Qodo R5.15 preserves the primary partial-initialization error when cleanup rejects", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r5-cleanup-error-"));
    const path = join(directory, "m2.sqlite");
    new DatabaseSync(path).close();
    const before = sqliteDurableSnapshot(path);
    const primary = new Error("planned primary Round 5 initialization failure");
    const cleanup = new Error("planned Round 5 cleanup failure");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.exec = function (sql: string): void {
      originalExec.call(this, sql);
      if (sql.includes("admission_records_immutable_update")) throw primary;
    };
    DatabaseSync.prototype.close = function (): void {
      originalClose.call(this);
      throw cleanup;
    };
    try {
      assert.throws(
        () => createStore({ path, initialState: initialState() }),
        (error: unknown) => error === primary,
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
    }
    try {
      assertLogicalAndSidecarSnapshotEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Qodo Round 6 hardened legacy and WAL initialization", () => {
  test("Qodo R6.1 rejects every malformed legacy M2 schema without durable mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-malformed-m2-"));
    const sourcePath = join(directory, "valid-m2.sqlite");
    const factorySourcePath = join(directory, "valid-factory.sqlite");
    const source = createStore({ path: sourcePath, initialState: initialState() });
    source.close();
    const factorySource = new SyntheticFactoryEnvironment({
      path: factorySourcePath,
    });
    factorySource.close();
    const fixtures: readonly LegacySchemaMutation[] = [
      {
        name: "declared type",
        objectName: "portfolio_obligations",
        fragment: ["body_json TEXT NOT NULL", "body_json BLOB NOT NULL"],
      },
      {
        name: "nullability",
        objectName: "portfolio_obligations",
        fragment: ["body_json TEXT NOT NULL", "body_json TEXT"],
      },
      {
        name: "primary key",
        objectName: "portfolio_obligations",
        fragment: ["obligation_id TEXT PRIMARY KEY", "obligation_id TEXT"],
      },
      {
        name: "unique constraint",
        objectName: "admission_addenda",
        fragment: ["addendum_id TEXT NOT NULL UNIQUE", "addendum_id TEXT NOT NULL"],
      },
      {
        name: "foreign key",
        objectName: "grants",
        fragment: [
          "grant_allowance_key TEXT NOT NULL REFERENCES grant_allowances(grant_allowance_key)",
          "grant_allowance_key TEXT NOT NULL",
        ],
      },
      {
        name: "check constraint",
        objectName: "admission_records",
        fragment: [
          "decision TEXT NOT NULL CHECK (decision IN ('ADMITTABLE', 'REPLAN', 'REJECT'))",
          "decision TEXT NOT NULL",
        ],
      },
      {
        name: "strictness",
        objectName: "portfolio_obligations",
        fragment: [") STRICT", ")"],
      },
      {
        name: "required trigger",
        omitObject: "admission_records_immutable_update",
      },
      {
        name: "extra incompatible object",
        extraSql: "CREATE TABLE unexpected_m2_extension (id INTEGER PRIMARY KEY) STRICT",
      },
    ];
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const path = join(directory, `malformed-m2-${index}.sqlite`);
        createMutatedLegacySchema(sourcePath, path, fixture);
        const before = sqliteDurableSnapshot(path);
        assert.throws(
          () => {
            const opened = createStore({ path, initialState: initialState() });
            opened.close();
          },
          /corrupt|partial|foreign|schema|classification/iu,
          fixture.name,
        );
        assert.deepEqual(sqliteDurableSnapshot(path), before, fixture.name);
      }

      const mixedPath = join(directory, "malformed-m2-mixed.sqlite");
      copyApplicationSchema(sourcePath, mixedPath);
      copyApplicationSchema(factorySourcePath, mixedPath);
      const mixedBefore = sqliteDurableSnapshot(mixedPath);
      assert.throws(
        () => {
          const opened = createStore({
            path: mixedPath,
            initialState: initialState(),
          });
          opened.close();
        },
        /ambiguous|cross-contaminated/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(mixedPath), mixedBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.2 rejects every malformed legacy factory schema without durable mutation", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r6-malformed-factory-"),
    );
    const sourcePath = join(directory, "valid-factory.sqlite");
    const m2SourcePath = join(directory, "valid-m2.sqlite");
    const source = new SyntheticFactoryEnvironment({ path: sourcePath });
    source.close();
    const m2Source = createStore({
      path: m2SourcePath,
      initialState: initialState(),
    });
    m2Source.close();
    const fixtures: readonly LegacySchemaMutation[] = [
      {
        name: "declared type",
        objectName: "incoming_proposals",
        fragment: ["body_json TEXT NOT NULL", "body_json BLOB NOT NULL"],
      },
      {
        name: "nullability",
        objectName: "incoming_proposals",
        fragment: ["body_json TEXT NOT NULL", "body_json TEXT"],
      },
      {
        name: "primary key",
        objectName: "incoming_proposals",
        fragment: ["proposal_id TEXT PRIMARY KEY", "proposal_id TEXT"],
      },
      {
        name: "unique constraint",
        objectName: "schedule_reservations",
        fragment: [
          "source_execution_attempt_id TEXT UNIQUE",
          "source_execution_attempt_id TEXT",
        ],
      },
      {
        name: "foreign key",
        objectName: "mutation_events",
        fragment: [
          "execution_attempt_id TEXT NOT NULL UNIQUE\n        REFERENCES execution_results(execution_attempt_id)",
          "execution_attempt_id TEXT NOT NULL UNIQUE",
        ],
      },
      {
        name: "check constraint",
        objectName: "schedule_reservations",
        fragment: [
          "quantity INTEGER NOT NULL CHECK (quantity > 0)",
          "quantity INTEGER NOT NULL",
        ],
      },
      {
        name: "strictness",
        objectName: "incoming_proposals",
        fragment: [") STRICT", ")"],
      },
      {
        name: "required trigger",
        omitObject: "incoming_proposals_no_update",
      },
      {
        name: "extra incompatible object",
        extraSql:
          "CREATE TABLE unexpected_factory_extension (id INTEGER PRIMARY KEY) STRICT",
      },
    ];
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const path = join(directory, `malformed-factory-${index}.sqlite`);
        createMutatedLegacySchema(sourcePath, path, fixture);
        const before = sqliteDurableSnapshot(path);
        assert.throws(
          () => {
            const opened = new SyntheticFactoryEnvironment({ path });
            opened.close();
          },
          /corrupt|partial|foreign|schema|classification/iu,
          fixture.name,
        );
        assert.deepEqual(sqliteDurableSnapshot(path), before, fixture.name);
      }

      const mixedPath = join(directory, "malformed-factory-mixed.sqlite");
      copyApplicationSchema(sourcePath, mixedPath);
      copyApplicationSchema(m2SourcePath, mixedPath);
      const mixedBefore = sqliteDurableSnapshot(mixedPath);
      assert.throws(
        () => {
          const opened = new SyntheticFactoryEnvironment({ path: mixedPath });
          opened.close();
        },
        /ambiguous|cross-contaminated/iu,
      );
      assert.deepEqual(sqliteDurableSnapshot(mixedPath), mixedBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.3 WAL failure is atomic for a new M2 path", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-new-m2-"));
    const path = join(directory, "m2.sqlite");
    try {
      assertInjectedWalFailureIsAtomic(path, () =>
        createStore({ path, initialState: initialState() }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.4 WAL failure is atomic for a new factory path", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r6-wal-new-factory-"),
    );
    const path = join(directory, "factory.sqlite");
    try {
      assertInjectedWalFailureIsAtomic(
        path,
        () => new SyntheticFactoryEnvironment({ path }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const fixture of [
    {
      name: "Qodo R6.5 WAL failure is atomic for a pre-existing empty M2 target",
      prefix: "flakebrake-r6-wal-empty-m2-",
      filename: "m2.sqlite",
      construct: (path: string) =>
        createStore({ path, initialState: initialState() }),
    },
    {
      name: "Qodo R6.6 WAL failure is atomic for a pre-existing empty factory target",
      prefix: "flakebrake-r6-wal-empty-factory-",
      filename: "factory.sqlite",
      construct: (path: string) => new SyntheticFactoryEnvironment({ path }),
    },
  ]) {
    test(fixture.name, () => {
      const directory = mkdtempSync(join(tmpdir(), fixture.prefix));
      const path = join(directory, fixture.filename);
      new DatabaseSync(path).close();
      try {
        assertInjectedWalFailureIsAtomic(path, () => fixture.construct(path));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("Qodo R6.7 WAL failure cannot migrate a valid legacy M2 database", () => {
    const item = tempStore();
    item.store.close();
    removeDatabaseIncarnation(item.path);
    setJournalMode(item.path, "DELETE");
    try {
      assertInjectedWalFailureIsAtomic(item.path, () =>
        createStore({ path: item.path }),
      );
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.8 WAL failure cannot migrate a valid legacy factory database", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r6-wal-legacy-factory-"),
    );
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    removeDatabaseIncarnation(path);
    setJournalMode(path, "DELETE");
    try {
      assertInjectedWalFailureIsAtomic(
        path,
        () => new SyntheticFactoryEnvironment({ path }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.9 WAL failure leaves a current M2 database unchanged", () => {
    const item = tempStore();
    item.store.close();
    setJournalMode(item.path, "DELETE");
    try {
      assertInjectedWalFailureIsAtomic(item.path, () =>
        createStore({ path: item.path }),
      );
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.10 WAL failure leaves a current factory database unchanged", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r6-wal-current-factory-"),
    );
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    setJournalMode(path, "DELETE");
    try {
      assertInjectedWalFailureIsAtomic(
        path,
        () => new SyntheticFactoryEnvironment({ path }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.11 wrong-kind rejection occurs before WAL preparation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-kind-"));
    const path = join(directory, "m2.sqlite");
    const store = createStore({ path, initialState: initialState() });
    store.close();
    setJournalMode(path, "DELETE");
    const before = sqliteDurableSnapshot(path);
    const originalExec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) walAttempts += 1;
      originalExec.call(this, sql);
    };
    try {
      assert.throws(
        () => new SyntheticFactoryEnvironment({ path }),
        /m2.*factory|factory.*m2|store kind/iu,
      );
      assert.equal(walAttempts, 0);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.12 foreign rejection occurs before WAL preparation", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-foreign-"));
    const path = join(directory, "foreign.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE foreign_record (id INTEGER PRIMARY KEY) STRICT");
    database.close();
    const before = sqliteDurableSnapshot(path);
    const originalExec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) walAttempts += 1;
      originalExec.call(this, sql);
    };
    try {
      assert.throws(
        () => createStore({ path, initialState: initialState() }),
        /foreign/iu,
      );
      assert.equal(walAttempts, 0);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.13 schema failure after WAL preparation restores the exact logical empty target", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-schema-"));
    const path = join(directory, "m2.sqlite");
    new DatabaseSync(path).close();
    const before = sqliteDurableSnapshot(path);
    const primary = new Error("planned schema failure after WAL preparation");
    const originalExec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) walAttempts += 1;
      originalExec.call(this, sql);
      if (sql.includes("admission_records_immutable_update")) throw primary;
    };
    try {
      assert.throws(
        () => createStore({ path, initialState: initialState() }),
        (error: unknown) => error === primary,
      );
      assert.equal(walAttempts, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assertLogicalAndSidecarSnapshotEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.14 migration failure after WAL preparation restores the exact logical legacy database", () => {
    const item = tempStore();
    item.store.close();
    removeDatabaseIncarnation(item.path);
    setJournalMode(item.path, "DELETE");
    const before = sqliteDurableSnapshot(item.path);
    const primary = new Error("planned migration failure after WAL preparation");
    const originalExec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) walAttempts += 1;
      originalExec.call(this, sql);
      if (sql.includes("CREATE TABLE IF NOT EXISTS database_incarnation")) {
        throw primary;
      }
    };
    try {
      assert.throws(
        () => createStore({ path: item.path }),
        (error: unknown) => error === primary,
      );
      assert.equal(walAttempts, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assertLogicalAndSidecarSnapshotEqual(
        sqliteDurableSnapshot(item.path),
        before,
      );
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.15 cleanup failure preserves the primary WAL error", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-cleanup-"));
    const path = join(directory, "m2.sqlite");
    const before = sqliteDurableSnapshot(path);
    const primary = new Error("planned primary WAL failure");
    const cleanup = new Error("planned WAL cleanup failure");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) {
        originalExec.call(this, sql);
        throw primary;
      }
      originalExec.call(this, sql);
    };
    DatabaseSync.prototype.close = function (): void {
      originalClose.call(this);
      throw cleanup;
    };
    try {
      assert.throws(
        () => createStore({ path, initialState: initialState() }),
        (error: unknown) => error === primary,
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
    }
    try {
      assert.deepEqual(sqliteDurableSnapshot(path), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.16 successful durable initialization establishes WAL for both stores", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-r6-wal-success-"));
    const m2Path = join(directory, "m2.sqlite");
    const factoryPath = join(directory, "factory.sqlite");
    try {
      const store = createStore({ path: m2Path, initialState: initialState() });
      const factory = new SyntheticFactoryEnvironment({ path: factoryPath });
      factory.close();
      store.close();
      assert.equal(sqliteDurableSnapshot(m2Path).journalMode, "wal");
      assert.equal(sqliteDurableSnapshot(factoryPath).journalMode, "wal");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R6.17 in-memory stores remain non-WAL and operational", () => {
    const originalExec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (/PRAGMA\s+journal_mode\s*=\s*WAL/iu.test(sql)) walAttempts += 1;
      originalExec.call(this, sql);
    };
    try {
      const store = createStore({ path: ":memory:", initialState: initialState() });
      const factory = new SyntheticFactoryEnvironment({ path: ":memory:" });
      assert.equal(store.getPortfolio().acceptedObligations.length, 1);
      assert.equal(factory.getIncomingProposals().length, 1);
      factory.close();
      store.close();
      assert.equal(walAttempts, 0);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
  });
});

describe("Qodo Round 7 concurrency-safe SQLite rollback", () => {
  test("Qodo R7.1 failed M2 initialization cannot overwrite a concurrent commit", () => {
    const item = tempStore();
    item.store.close();
    try {
      assertConcurrentCommitSurvivesInitializationFailure({
        construct: () => createStore({ path: item.path }),
        failureMarker: "admission_records_immutable_update",
        path: item.path,
        readCommittedValue: (database) =>
          Number(
            (
              database
                .prepare(
                  "SELECT portfolio_version FROM state_versions WHERE singleton = 1",
                )
                .get() as Record<string, unknown>
            )["portfolio_version"],
          ),
        writeSql:
          "UPDATE state_versions SET portfolio_version = 2 WHERE singleton = 1",
      });
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.2 failed factory initialization cannot invalidate a concurrent WAL commit", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r7-concurrent-factory-"),
    );
    const path = join(directory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path });
    factory.close();
    try {
      assertConcurrentCommitSurvivesInitializationFailure({
        construct: () => new SyntheticFactoryEnvironment({ path }),
        failureMarker: "incoming_proposals_no_update",
        path,
        readCommittedValue: (database) =>
          Number(
            (
              database
                .prepare(
                  "SELECT state_version FROM factory_metadata WHERE singleton = 1",
                )
                .get() as Record<string, unknown>
            )["state_version"],
          ),
        writeSql:
          "UPDATE factory_metadata SET state_version = 2 WHERE singleton = 1",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.3 WAL preparation failures preserve later independent commits", () => {
    const m2 = tempStore();
    m2.store.close();
    const factoryDirectory = mkdtempSync(
      join(tmpdir(), "flakebrake-r7-wal-boundary-factory-"),
    );
    const factoryPath = join(factoryDirectory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path: factoryPath });
    factory.close();
    setJournalMode(m2.path, "DELETE");
    setJournalMode(factoryPath, "DELETE");
    try {
      for (const fixture of [
        {
          construct: () => createStore({ path: m2.path }),
          path: m2.path,
          readCommittedValue: (database: DatabaseSync) =>
            Number(
              (
                database
                  .prepare(
                    "SELECT portfolio_version FROM state_versions WHERE singleton = 1",
                  )
                  .get() as Record<string, unknown>
              )["portfolio_version"],
            ),
          writeSql:
            "UPDATE state_versions SET portfolio_version = 2 WHERE singleton = 1",
        },
        {
          construct: () => new SyntheticFactoryEnvironment({ path: factoryPath }),
          path: factoryPath,
          readCommittedValue: (database: DatabaseSync) =>
            Number(
              (
                database
                  .prepare(
                    "SELECT state_version FROM factory_metadata WHERE singleton = 1",
                  )
                  .get() as Record<string, unknown>
              )["state_version"],
            ),
          writeSql:
            "UPDATE factory_metadata SET state_version = 2 WHERE singleton = 1",
        },
      ]) {
        assertConcurrentCommitSurvivesInitializationFailure({
          ...fixture,
          failureMarker: "PRAGMA journal_mode = WAL",
        });
      }
    } finally {
      rmSync(factoryDirectory, { recursive: true, force: true });
      rmSync(m2.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.4 incarnation failures preserve later independent commits", () => {
    const m2 = tempStore();
    m2.store.close();
    const factoryDirectory = mkdtempSync(
      join(tmpdir(), "flakebrake-r7-incarnation-boundary-factory-"),
    );
    const factoryPath = join(factoryDirectory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path: factoryPath });
    factory.close();
    try {
      for (const fixture of [
        {
          construct: () => createStore({ path: m2.path }),
          path: m2.path,
          readCommittedValue: (database: DatabaseSync) =>
            Number(
              (
                database
                  .prepare(
                    "SELECT capacity_plan_version FROM state_versions WHERE singleton = 1",
                  )
                  .get() as Record<string, unknown>
              )["capacity_plan_version"],
            ),
          writeSql:
            "UPDATE state_versions SET capacity_plan_version = 2 WHERE singleton = 1",
        },
        {
          construct: () => new SyntheticFactoryEnvironment({ path: factoryPath }),
          path: factoryPath,
          readCommittedValue: (database: DatabaseSync) =>
            Number(
              (
                database
                  .prepare(
                    "SELECT state_version FROM factory_metadata WHERE singleton = 1",
                  )
                  .get() as Record<string, unknown>
              )["state_version"],
            ),
          writeSql:
            "UPDATE factory_metadata SET state_version = 2 WHERE singleton = 1",
        },
      ]) {
        assertConcurrentCommitSurvivesInitializationFailure({
          ...fixture,
          failureMarker: "CREATE TABLE IF NOT EXISTS database_incarnation",
        });
      }
    } finally {
      rmSync(factoryDirectory, { recursive: true, force: true });
      rmSync(m2.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.5 existing WAL and SHM state remains consistent through rollback", () => {
    const item = tempStore();
    item.store.close();
    const identity = readDatabaseInstanceIdentity(item.path, "m2", "round7");
    const peer = new DatabaseSync(item.path);
    peer.exec("PRAGMA wal_autocheckpoint = 0");
    peer.exec(
      "BEGIN IMMEDIATE; UPDATE state_versions SET portfolio_version = 2 WHERE singleton = 1; COMMIT",
    );
    assert.equal(existsSync(`${item.path}-wal`), true);
    assert.equal(existsSync(`${item.path}-shm`), true);
    const primary = new Error("planned failure with existing WAL sidecars");
    const originalExec = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string): void {
      originalExec.call(this, sql);
      if (
        !injected &&
        databaseHandleUsesPath(this, item.path) &&
        sql.includes("admission_records_immutable_update")
      ) {
        injected = true;
        throw primary;
      }
    };
    try {
      assert.throws(
        () => createStore({ path: item.path }),
        (error: unknown) => error === primary,
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assert.equal(injected, true);
      assert.equal(
        (peer.prepare("PRAGMA quick_check").get() as Record<string, unknown>)[
          "quick_check"
        ],
        "ok",
      );
      assert.equal(
        Number(
          (
            peer
              .prepare(
                "SELECT portfolio_version FROM state_versions WHERE singleton = 1",
              )
              .get() as Record<string, unknown>
          )["portfolio_version"],
        ),
        2,
      );
    } finally {
      peer.close();
    }
    try {
      const restarted = createStore({ path: item.path });
      restarted.close();
      assert.equal(
        readDatabaseInstanceIdentity(item.path, "m2", "round7"),
        identity,
      );
      const snapshot = sqliteDurableSnapshot(item.path);
      assert.equal(snapshot.journalMode, "wal");
      assert.equal(
        snapshot.rows["state_versions"]?.some((row) =>
          row.includes('"portfolio_version":2'),
        ),
        true,
      );
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.6 failed new-store initialization removes only invocation-owned files and restarts", () => {
    for (const fixture of [
      {
        construct: (path: string) =>
          createStore({ path, initialState: initialState() }),
        filename: "m2.sqlite",
        marker: "admission_records_immutable_update",
        prefix: "flakebrake-r7-new-m2-",
      },
      {
        construct: (path: string) => new SyntheticFactoryEnvironment({ path }),
        filename: "factory.sqlite",
        marker: "incoming_proposals_no_update",
        prefix: "flakebrake-r7-new-factory-",
      },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), fixture.prefix));
      const path = join(directory, fixture.filename);
      const primary = new Error(`planned new-store failure: ${fixture.filename}`);
      const originalExec = DatabaseSync.prototype.exec;
      let injected = false;
      DatabaseSync.prototype.exec = function (sql: string): void {
        originalExec.call(this, sql);
        if (
          !injected &&
          databaseHandleUsesPath(this, path) &&
          sql.includes(fixture.marker)
        ) {
          injected = true;
          throw primary;
        }
      };
      try {
        assert.throws(
          () => fixture.construct(path),
          (error: unknown) => error === primary,
        );
      } finally {
        DatabaseSync.prototype.exec = originalExec;
      }
      try {
        assert.equal(injected, true);
        for (const artifact of [
          path,
          `${path}-wal`,
          `${path}-shm`,
          `${path}-journal`,
        ]) {
          assert.equal(existsSync(artifact), false, artifact);
        }
        const restarted = fixture.construct(path) as {
          readonly close?: () => void;
        };
        restarted.close?.();
        const database = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(
            Number(
              (
                database
                  .prepare("SELECT COUNT(*) AS count FROM database_incarnation")
                  .get() as Record<string, unknown>
              )["count"],
            ),
            1,
          );
          assert.equal(
            (database.prepare("PRAGMA quick_check").get() as Record<
              string,
              unknown
            >)["quick_check"],
            "ok",
          );
        } finally {
          database.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("Qodo R7.7 failed legacy migrations remain replayable with one identity", () => {
    const m2 = tempStore();
    m2.store.close();
    removeDatabaseIncarnation(m2.path);
    setJournalMode(m2.path, "DELETE");
    const factoryDirectory = mkdtempSync(
      join(tmpdir(), "flakebrake-r7-legacy-factory-"),
    );
    const factoryPath = join(factoryDirectory, "factory.sqlite");
    const factory = new SyntheticFactoryEnvironment({ path: factoryPath });
    factory.close();
    removeDatabaseIncarnation(factoryPath);
    setJournalMode(factoryPath, "DELETE");
    try {
      for (const fixture of [
        {
          construct: () => createStore({ path: m2.path }),
          path: m2.path,
        },
        {
          construct: () => new SyntheticFactoryEnvironment({ path: factoryPath }),
          path: factoryPath,
        },
      ]) {
        const before = sqliteDurableSnapshot(fixture.path);
        const primary = new Error(`planned legacy migration failure: ${fixture.path}`);
        const originalExec = DatabaseSync.prototype.exec;
        let injected = false;
        DatabaseSync.prototype.exec = function (sql: string): void {
          originalExec.call(this, sql);
          if (
            !injected &&
            databaseHandleUsesPath(this, fixture.path) &&
            sql.includes("CREATE TABLE IF NOT EXISTS database_incarnation")
          ) {
            injected = true;
            throw primary;
          }
        };
        try {
          assert.throws(fixture.construct, (error: unknown) => error === primary);
        } finally {
          DatabaseSync.prototype.exec = originalExec;
        }
        assert.equal(injected, true);
        assertLogicalAndSidecarSnapshotEqual(
          sqliteDurableSnapshot(fixture.path),
          before,
        );
        const restarted = fixture.construct() as { readonly close?: () => void };
        restarted.close?.();
        const database = new DatabaseSync(fixture.path, { readOnly: true });
        try {
          assert.equal(
            Number(
              (
                database
                  .prepare("SELECT COUNT(*) AS count FROM database_incarnation")
                  .get() as Record<string, unknown>
              )["count"],
            ),
            1,
          );
        } finally {
          database.close();
        }
      }
    } finally {
      rmSync(factoryDirectory, { recursive: true, force: true });
      rmSync(m2.directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.8 two concurrent initializers converge on one store identity", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-r7-concurrent-initializers-"),
    );
    const path = join(directory, "m2.sqlite");
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const moduleUrl = new URL("../src/sqlite.js", import.meta.url).href;
    const workerSource = String.raw`
      const { parentPort, workerData } = require("node:worker_threads");
      parentPort.postMessage({ kind: "ready" });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      import(workerData.moduleUrl).then(({ openSqlite }) => {
        const database = openSqlite(workerData.path);
        let incarnationId;
        try {
          const row = database.prepare(
            "SELECT incarnation_id FROM database_incarnation WHERE singleton = 1",
          ).get();
          incarnationId = row.incarnation_id;
        } finally {
          database.close();
        }
        parentPort.postMessage({
          kind: "result",
          handleState: "closed",
          incarnationId,
        });
      }).catch((error) => {
        parentPort.postMessage({ kind: "error", message: String(error?.stack ?? error) });
      });
    `;
    const workers = [
      new Worker(workerSource, {
        eval: true,
        workerData: { barrier, moduleUrl, path },
      }),
      new Worker(workerSource, {
        eval: true,
        workerData: { barrier, moduleUrl, path },
      }),
    ];
    const ready = workers.map(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("message", (message: unknown) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "kind" in message &&
              message.kind === "ready"
            ) {
              resolve();
            } else {
              reject(new Error("initializer worker did not reach the barrier"));
            }
          });
        }),
    );
    try {
      await Promise.all(ready);
      const resultPromises = workers.map(
          (worker) =>
            new Promise<{ readonly handleState: string; readonly incarnationId: string }>((resolve, reject) => {
              worker.once("error", reject);
              worker.on("message", (message: unknown) => {
                if (
                  typeof message !== "object" ||
                  message === null ||
                  !("kind" in message)
                ) {
                  return;
                }
                if (message.kind === "error") {
                  reject(
                    new Error(
                      "message" in message
                        ? String(message.message)
                        : "initializer worker failed",
                    ),
                  );
                } else if (
                  message.kind === "result" &&
                  "handleState" in message &&
                  "incarnationId" in message
                ) {
                  resolve({
                    handleState: String(message.handleState),
                    incarnationId: String(message.incarnationId),
                  });
                }
              });
            }),
      );
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, workers.length);
      const results = await Promise.all(resultPromises);
      assert.equal(results[0]?.incarnationId, results[1]?.incarnationId);
      assert.deepEqual(
        results.map((result) => result.handleState),
        ["closed", "closed"],
      );
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(
          Number(
            (
              database
                .prepare("SELECT COUNT(*) AS count FROM database_incarnation")
                .get() as Record<string, unknown>
            )["count"],
          ),
          1,
        );
        assert.equal(
          (database.prepare("PRAGMA quick_check").get() as Record<
            string,
            unknown
          >)["quick_check"],
          "ok",
        );
      } finally {
        database.close();
      }
    } finally {
      await Promise.all(workers.map(async (worker) => worker.terminate()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Qodo R7.9 cleanup diagnostics preserve the primary initialization error", () => {
    const item = tempStore();
    item.store.close();
    setJournalMode(item.path, "DELETE");
    const primary = new Error("planned Round 7 initialization failure");
    const cleanup = new Error("planned Round 7 journal cleanup failure");
    const originalExec = DatabaseSync.prototype.exec;
    let primaryInjected = false;
    let cleanupInjected = false;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (
        databaseHandleUsesPath(this, item.path) &&
        /PRAGMA\s+journal_mode\s*=\s*DELETE/iu.test(sql)
      ) {
        cleanupInjected = true;
        throw cleanup;
      }
      originalExec.call(this, sql);
      if (
        !primaryInjected &&
        databaseHandleUsesPath(this, item.path) &&
        sql.includes("admission_records_immutable_update")
      ) {
        primaryInjected = true;
        throw primary;
      }
    };
    try {
      assert.throws(
        () => createStore({ path: item.path }),
        (error: unknown) => error === primary,
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    try {
      assert.equal(primaryInjected, true);
      assert.equal(cleanupInjected, true);
      assert.equal(
        (primary as Error & { readonly cleanupErrors?: readonly unknown[] })
          .cleanupErrors?.includes(cleanup),
        true,
      );
      const restarted = createStore({ path: item.path });
      restarted.close();
      assert.equal(sqliteDurableSnapshot(item.path).journalMode, "wal");
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  });
});

describe("R7.8 SQLite worker lock lifecycle", () => {
  test("ready long-lived M2 and factory handles permit independent reads", async () => {
    const workerSource = String.raw`
      const { parentPort, workerData } = require("node:worker_threads");
      let resource;
      parentPort.postMessage({ kind: "ready" });
      Atomics.wait(new Int32Array(workerData.startBarrier), 0, 0);
      (async () => {
        if (workerData.storeKind === "m2") {
          const { openSqlite } = await import(workerData.sqliteModuleUrl);
          resource = openSqlite(workerData.path);
        } else {
          const { SyntheticFactoryEnvironment } = await import(
            workerData.factoryModuleUrl
          );
          resource = new SyntheticFactoryEnvironment({ path: workerData.path });
        }
        parentPort.postMessage({ kind: "opened", handleState: "open" });
        Atomics.wait(new Int32Array(workerData.closeBarrier), 0, 0);
        resource.close();
        resource = undefined;
        parentPort.postMessage({ kind: "closed", handleState: "closed" });
      })().catch((error) => {
        try { resource?.close(); } catch {}
        parentPort.postMessage({
          kind: "error",
          message: String(error?.message ?? error),
        });
      });
    `;
    const sqliteModuleUrl = new URL("../src/sqlite.js", import.meta.url).href;
    const factoryModuleUrl = new URL(
      "../src/factory-environment.js",
      import.meta.url,
    ).href;

    for (const storeKind of ["m2", "factory"] as const) {
      const directory = mkdtempSync(
        join(tmpdir(), `flakebrake-r78-open-${storeKind}-`),
      );
      const path = join(directory, `${storeKind}.sqlite`);
      const startBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const closeBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          closeBarrier,
          factoryModuleUrl,
          path,
          sqliteModuleUrl,
          startBarrier,
          storeKind,
        },
      });
      try {
        await waitForWorkerMessage(worker, "ready");
        const openedPromise = waitForWorkerMessage(worker, "opened");
        Atomics.store(new Int32Array(startBarrier), 0, 1);
        Atomics.notify(new Int32Array(startBarrier), 0, 1);
        const opened = await openedPromise;
        assert.equal(opened["handleState"], "open");

        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(
            Number(
              (
                reader
                  .prepare("SELECT COUNT(*) AS count FROM database_incarnation")
                  .get() as Record<string, unknown>
              )["count"],
            ),
            1,
          );
          assert.equal(
            (reader.prepare("PRAGMA quick_check").get() as Record<
              string,
              unknown
            >)["quick_check"],
            "ok",
          );
        } finally {
          reader.close();
        }

        const closedPromise = waitForWorkerMessage(worker, "closed");
        const exitPromise = waitForWorkerExit(worker);
        Atomics.store(new Int32Array(closeBarrier), 0, 1);
        Atomics.notify(new Int32Array(closeBarrier), 0, 1);
        const closed = await closedPromise;
        assert.equal(closed["handleState"], "closed");
        await exitPromise;
      } finally {
        await worker.terminate();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("worker initialization failures acknowledge only after cleanup", async () => {
    const workerSource = String.raw`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const originalExec = DatabaseSync.prototype.exec;
      let injected = false;
      DatabaseSync.prototype.exec = function (sql) {
        originalExec.call(this, sql);
        if (!injected && sql.includes(workerData.failureMarker)) {
          injected = true;
          throw new Error("planned initializer worker failure");
        }
      };
      parentPort.postMessage({ kind: "ready" });
      Atomics.wait(new Int32Array(workerData.startBarrier), 0, 0);
      (async () => {
        try {
          if (workerData.storeKind === "m2") {
            const { openSqlite } = await import(workerData.sqliteModuleUrl);
            openSqlite(workerData.path);
          } else {
            const { SyntheticFactoryEnvironment } = await import(
              workerData.factoryModuleUrl
            );
            new SyntheticFactoryEnvironment({ path: workerData.path });
          }
          throw new Error("initializer failure was not injected");
        } catch (error) {
          DatabaseSync.prototype.exec = originalExec;
          parentPort.postMessage({
            kind: "failure-cleaned",
            handleState: "closed",
            injected,
            planned: String(error?.message ?? error).includes(
              "planned initializer worker failure"
            ),
          });
        }
      })().catch((error) => {
        DatabaseSync.prototype.exec = originalExec;
        parentPort.postMessage({
          kind: "error",
          message: String(error?.message ?? error),
        });
      });
    `;
    const sqliteModuleUrl = new URL("../src/sqlite.js", import.meta.url).href;
    const factoryModuleUrl = new URL(
      "../src/factory-environment.js",
      import.meta.url,
    ).href;

    for (const fixture of [
      {
        construct: (path: string) =>
          createStore({ path, initialState: initialState() }),
        failureMarker: "admission_records_immutable_update",
        storeKind: "m2",
      },
      {
        construct: (path: string) => new SyntheticFactoryEnvironment({ path }),
        failureMarker: "incoming_proposals_no_update",
        storeKind: "factory",
      },
    ] as const) {
      const directory = mkdtempSync(
        join(tmpdir(), `flakebrake-r78-error-${fixture.storeKind}-`),
      );
      const path = join(directory, `${fixture.storeKind}.sqlite`);
      const startBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          factoryModuleUrl,
          failureMarker: fixture.failureMarker,
          path,
          sqliteModuleUrl,
          startBarrier,
          storeKind: fixture.storeKind,
        },
      });
      try {
        await waitForWorkerMessage(worker, "ready");
        const cleanedPromise = waitForWorkerMessage(
          worker,
          "failure-cleaned",
        );
        const exitPromise = waitForWorkerExit(worker);
        Atomics.store(new Int32Array(startBarrier), 0, 1);
        Atomics.notify(new Int32Array(startBarrier), 0, 1);
        const cleaned = await cleanedPromise;
        assert.equal(cleaned["handleState"], "closed");
        assert.equal(cleaned["injected"], true);
        assert.equal(cleaned["planned"], true);
        for (const artifact of [
          path,
          `${path}-wal`,
          `${path}-shm`,
          `${path}-journal`,
        ]) {
          assert.equal(existsSync(artifact), false, artifact);
        }

        const restarted = fixture.construct(path);
        restarted.close();
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(
            (reader.prepare("PRAGMA quick_check").get() as Record<
              string,
              unknown
            >)["quick_check"],
            "ok",
          );
        } finally {
          reader.close();
        }
        await exitPromise;
      } finally {
        await worker.terminate();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("independent initializer processes close before completion under repeated contention", async () => {
    assert.equal(/setTimeout|sleep/iu.test(INITIALIZER_PROCESS_SOURCE), false);
    const sqliteModuleUrl = new URL("../src/sqlite.js", import.meta.url).href;
    const factoryModuleUrl = new URL(
      "../src/factory-environment.js",
      import.meta.url,
    ).href;
    const processCount = 4;
    const rounds = 4;

    for (const fixture of [
      {
        create: (path: string) =>
          createStore({ path, initialState: initialState() }),
        storeKind: "m2",
      },
      {
        create: (path: string) => new SyntheticFactoryEnvironment({ path }),
        storeKind: "factory",
      },
    ] as const) {
      const directory = mkdtempSync(
        join(tmpdir(), `flakebrake-r78-process-${fixture.storeKind}-`),
      );
      const path = join(directory, `${fixture.storeKind}.sqlite`);
      const initial = fixture.create(path);
      initial.close();
      const before = sqliteDurableSnapshot(path);
      const identities = new Set<string>();
      try {
        for (let round = 0; round < rounds; round += 1) {
          const blocker = new DatabaseSync(path);
          blocker.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
          const children = Array.from(
            { length: processCount },
            spawnInitializerProcess,
          );
          try {
            await Promise.all(
              children.map((child) => waitForChildMessage(child, "ready")),
            );
            const attempting = children.map((child) =>
              waitForChildMessage(child, "attempting"),
            );
            const completed = children.map((child) =>
              waitForChildMessage(child, "complete"),
            );
            const exited = children.map(waitForChildExit);
            await Promise.all(
              children.map((child) =>
                sendChildMessage(child, {
                  factoryModuleUrl,
                  kind: "start",
                  path,
                  sqliteModuleUrl,
                  storeKind: fixture.storeKind,
                }),
              ),
            );
            await Promise.all(attempting);
            blocker.exec("COMMIT");
            blocker.close();

            const results = await Promise.all(completed);
            for (const result of results) {
              assert.equal(result["handleState"], "closed");
              identities.add(String(result["identity"]));
            }
            const reader = new DatabaseSync(path, { readOnly: true });
            try {
              assert.equal(
                Number(
                  (
                    reader
                      .prepare(
                        "SELECT COUNT(*) AS count FROM database_incarnation",
                      )
                      .get() as Record<string, unknown>
                  )["count"],
                ),
                1,
              );
              assert.equal(
                (reader.prepare("PRAGMA quick_check").get() as Record<
                  string,
                  unknown
                >)["quick_check"],
                "ok",
              );
            } finally {
              reader.close();
            }
            await Promise.all(exited);
          } finally {
            if (blocker.isOpen) {
              if (blocker.isTransaction) blocker.exec("ROLLBACK");
              blocker.close();
            }
            await Promise.all(children.map(stopInitializerProcess));
          }
        }
        assert.equal(identities.size, 1);
        const after = sqliteDurableSnapshot(path);
        assert.deepEqual(after.schema, before.schema);
        assert.deepEqual(after.columns, before.columns);
        assert.deepEqual(after.foreignKeys, before.foreignKeys);
        assert.deepEqual(after.indexes, before.indexes);
        assert.deepEqual(after.metadata, before.metadata);
        assert.deepEqual(after.rows, before.rows);
        assert.deepEqual(after.triggers, before.triggers);
        assert.equal(after.journalMode, "wal");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
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
