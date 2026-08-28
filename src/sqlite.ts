import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalSerialize } from "./canonical.js";

export type SqliteDatabase = DatabaseSync;
export type DatabaseInstanceKind = "m2" | "factory";

type DatabaseClassification =
  | "empty/new"
  | "current m2"
  | "current factory"
  | "recognizable legacy m2"
  | "recognizable legacy factory"
  | "foreign"
  | "ambiguous/cross-contaminated"
  | "corrupt/partial";

interface TableSignature {
  readonly name: string;
  readonly columns: readonly string[];
}

const SQLITE_MEMORY_PATH = ":memory:";
const SQLITE_MEMORY_IDENTITY_PATH = "sqlite-memory/current-connection";
const SQLITE_INITIALIZATION_BUSY_ATTEMPTS = 100;
const SQLITE_INITIALIZATION_BUSY_WAIT_MS = 10;
const SQLITE_INITIALIZATION_BUSY_WAIT = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const DATABASE_INCARNATION_OBJECTS = new Set([
  "database_incarnation",
  "database_incarnation_immutable_update",
  "database_incarnation_immutable_delete",
]);

/**
 * Versioned fingerprints for the only pre-incarnation and current schemas
 * supported by this release. They cover normalized sqlite_schema SQL plus
 * stable table, column, index, foreign-key, STRICT, and WITHOUT ROWID metadata.
 */
const SUPPORTED_SCHEMA_FINGERPRINTS = {
  factory: {
    current:
      "sha256:b221fb4683f52d06afaf0cd3598f5e432558fd1c1a12caac001cb79ad2883f61",
    legacy:
      "sha256:5a415a8585c2123f8b505191de53e621c85f1d0d1d6f7212451252f6877a1052",
  },
  m2: {
    current:
      "sha256:073643b3e726b82774613fa39e2eaa8dbe5198c4d597da8b992dd7eacdb4dea9",
    legacy:
      "sha256:98b14c1aa3ca2ff98d493f1bc9123e38813bfd43debea051b6741e46485feb97",
  },
} as const;

/** Exact pre-incarnation M2 table/column signature supplied by reviewed M2. */
const M2_LEGACY_SIGNATURE: readonly TableSignature[] = [
  {
    name: "state_versions",
    columns: [
      "singleton",
      "portfolio_version",
      "capacity_model_version",
      "capacity_plan_version",
      "authorization_state_version",
    ],
  },
  {
    name: "state_config",
    columns: [
      "singleton",
      "assumptions_json",
      "combined_decision_proofs_json",
    ],
  },
  {
    name: "portfolio_obligations",
    columns: ["obligation_id", "body_json"],
  },
  {
    name: "capacity_resources",
    columns: ["resource_key", "model_json", "plan_json"],
  },
  {
    name: "admission_records",
    columns: [
      "admission_record_id",
      "created_at",
      "decision",
      "proposal_obligation_id",
      "body_json",
    ],
  },
  {
    name: "admission_addenda",
    columns: [
      "sequence",
      "addendum_id",
      "admission_record_id",
      "created_at",
      "kind",
      "body_json",
    ],
  },
  {
    name: "owner_decisions",
    columns: ["owner_decision_id", "created_at", "body_json"],
  },
  {
    name: "grant_allowances",
    columns: ["grant_allowance_key", "created_at", "body_json"],
  },
  {
    name: "grants",
    columns: ["grant_id", "grant_allowance_key", "created_at", "body_json"],
  },
  {
    name: "authorization_events",
    columns: [
      "sequence",
      "authorization_event_id",
      "subject_kind",
      "subject_id",
      "event_kind",
      "created_at",
      "body_json",
    ],
  },
  {
    name: "denials",
    columns: ["denial_id", "created_at", "body_json"],
  },
  {
    name: "denial_exceptions",
    columns: [
      "denial_exception_id",
      "parent_denial_id",
      "grant_allowance_key",
      "created_at",
      "body_json",
    ],
  },
  {
    name: "execution_attempts",
    columns: [
      "execution_attempt_id",
      "admission_record_id",
      "created_at",
      "input_json",
      "result_json",
    ],
  },
  {
    name: "allowance_claims",
    columns: [
      "grant_allowance_key",
      "ordinal",
      "execution_attempt_id",
      "created_at",
    ],
  },
  {
    name: "inflight_reservations",
    columns: [
      "reservation_id",
      "execution_attempt_id",
      "created_at",
      "body_json",
    ],
  },
  {
    name: "reservation_events",
    columns: [
      "sequence",
      "reservation_event_id",
      "reservation_id",
      "created_at",
      "event_kind",
      "body_json",
    ],
  },
  {
    name: "execution_fences",
    columns: [
      "fence_id",
      "execution_attempt_id",
      "created_at",
      "body_json",
    ],
  },
  {
    name: "execution_fence_events",
    columns: [
      "sequence",
      "fence_event_id",
      "fence_id",
      "created_at",
      "event_kind",
      "body_json",
    ],
  },
  {
    name: "realized_effects",
    columns: [
      "realized_effect_id",
      "execution_attempt_id",
      "created_at",
      "body_json",
    ],
  },
  {
    name: "realized_consumption_facts",
    columns: [
      "realized_consumption_id",
      "execution_attempt_id",
      "created_at",
      "body_json",
    ],
  },
];

/** Exact pre-incarnation factory table/column signature supplied by M4. */
const FACTORY_LEGACY_SIGNATURE: readonly TableSignature[] = [
  {
    name: "factory_metadata",
    columns: ["singleton", "schema_version", "environment_id", "state_version"],
  },
  {
    name: "incoming_proposals",
    columns: ["proposal_id", "body_json"],
  },
  {
    name: "schedule_reservations",
    columns: [
      "reservation_id",
      "order_id",
      "production_cell_id",
      "start_at",
      "end_at",
      "quantity",
      "status",
      "source_execution_attempt_id",
      "body_json",
    ],
  },
  {
    name: "execution_results",
    columns: [
      "execution_attempt_id",
      "fence_id",
      "request_json",
      "result_json",
      "receipt_id",
      "created_at",
    ],
  },
  {
    name: "mutation_events",
    columns: ["event_id", "execution_attempt_id", "created_at", "body_json"],
  },
];

const INCARNATION_COLUMNS = [
  "singleton",
  "store_kind",
  "incarnation_id",
] as const;
const INCARNATION_TRIGGER_NAMES = [
  "database_incarnation_immutable_update",
  "database_incarnation_immutable_delete",
] as const;

const IMMUTABLE_TABLES = [
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
  "execution_fences",
  "execution_fence_events",
  "realized_effects",
  "realized_consumption_facts",
] as const;

export function openSqlite(path: string): SqliteDatabase {
  return openInitializedSqlite(path, "m2", initializeSchema);
}

interface InvocationOwnedDatabase {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

interface SqliteInitializationLifecycle {
  classification: DatabaseClassification | null;
  exclusiveLockHeld: boolean;
  originalJournalMode: string | null;
}

/** Open, initialize, and retain one SQLite handle with failure-atomic ownership. */
export function openInitializedSqlite(
  path: string,
  kind: DatabaseInstanceKind,
  initializeApplicationSchema: (database: SqliteDatabase) => void,
): SqliteDatabase {
  let ownedDatabase = isSqliteMemoryPath(path)
    ? null
    : reserveNewDatabasePath(path);
  let database: SqliteDatabase;
  try {
    database = new DatabaseSync(path);
  } catch (error: unknown) {
    if (ownedDatabase !== null) {
      cleanupUnopenedDatabaseReservation(ownedDatabase, error);
    }
    throw error;
  }
  const lifecycle: SqliteInitializationLifecycle = {
    classification: null,
    exclusiveLockHeld: false,
    originalJournalMode: null,
  };
  try {
    initializeSqliteStore(database, path, kind, initializeApplicationSchema, {
      lifecycle,
      onClassification: (classification) => {
        if (classification !== "empty/new") ownedDatabase = null;
      },
    });
    return database;
  } catch (error: unknown) {
    if (ownedDatabase !== null) {
      if (!lifecycle.exclusiveLockHeld) {
        tryAcquireOwnedDatabaseCleanupLock(database, lifecycle, error);
      }
      if (lifecycle.exclusiveLockHeld) {
        cleanupInvocationOwnedDatabaseWhileLocked(ownedDatabase, error);
      }
    }
    closeSqliteAfterInitializationFailure(database, error);
    throw error;
  }
}

/**
 * Classify read-only first, then initialize or migrate atomically through the
 * same owned handle. Wrong-kind and unrecognized databases are rejected before
 * any persistent PRAGMA or schema statement can run.
 */
export function initializeSqliteStore(
  database: SqliteDatabase,
  path: string,
  kind: DatabaseInstanceKind,
  initializeApplicationSchema: (database: SqliteDatabase) => void,
  hooks: {
    readonly beforePersistentInitialization?: () => void;
    readonly lifecycle?: SqliteInitializationLifecycle;
    readonly onClassification?: (
      classification: DatabaseClassification,
    ) => void;
  } = {},
): string {
  const lifecycle = hooks.lifecycle ?? {
    classification: null,
    exclusiveLockHeld: false,
    originalJournalMode: null,
  };
  const durable = !isSqliteMemoryPath(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    if (durable) {
      database.exec("BEGIN");
    }

    const classification = classifySqliteDatabase(database);
    lifecycle.classification = classification;
    hooks.onClassification?.(classification);
    assertCompatibleDatabaseClassification(classification, kind);
    if (durable) database.exec("COMMIT");

    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = FULL");

    hooks.beforePersistentInitialization?.();
    if (durable) {
      lifecycle.originalJournalMode = readJournalMode(database);
      if (lifecycle.originalJournalMode !== "wal") {
        establishWalJournalMode(database);
      }
    }

    let incarnationId = "";
    inImmediateTransaction(database, () => {
      if (durable) {
        const lockedClassification = classifySqliteDatabase(database);
        lifecycle.classification = lockedClassification;
        hooks.onClassification?.(lockedClassification);
        assertCompatibleDatabaseClassification(lockedClassification, kind);
      }
      initializeApplicationSchema(database);
      incarnationId = ensureDatabaseIncarnation(database, kind);
    });
    return incarnationId;
  } catch (error: unknown) {
    rollbackInitializationThroughSqlite(database, lifecycle, error);
    throw error;
  }
}

/** The exact SQLite transient-database spelling supported by this project. */
export function isSqliteMemoryPath(path: string): boolean {
  return path === SQLITE_MEMORY_PATH;
}

/**
 * Identity basis for a database that is already or about to be opened.
 * Transient databases never enter filesystem canonicalization; their durable
 * incarnation row distinguishes otherwise identical `:memory:` spellings.
 */
export function databaseIdentityPath(path: string): string {
  if (isSqliteMemoryPath(path)) return SQLITE_MEMORY_IDENTITY_PATH;
  return canonicalDatabasePath(path);
}

/** Close an owned initialization handle without replacing its primary error. */
export function closeSqliteAfterInitializationFailure(
  database: SqliteDatabase,
  primaryError: unknown,
): void {
  try {
    database.close();
  } catch (cleanupError: unknown) {
    attachInitializationCleanupDiagnostic(primaryError, cleanupError);
  }
}

function reserveNewDatabasePath(path: string): InvocationOwnedDatabase | null {
  const canonicalPath = canonicalDatabasePath(path);
  let descriptor: number;
  try {
    descriptor = openSync(canonicalPath, "wx", 0o600);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "EEXIST")) return null;
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    return {
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } finally {
    closeSync(descriptor);
  }
}

function cleanupUnopenedDatabaseReservation(
  ownership: InvocationOwnedDatabase,
  primaryError: unknown,
): void {
  try {
    const metadata = statSync(ownership.canonicalPath);
    if (
      metadata.dev !== ownership.device ||
      metadata.ino !== ownership.inode ||
      metadata.size !== 0
    ) {
      throw new Error(
        "Invocation-owned SQLite reservation changed before open failure cleanup",
      );
    }
    rmSync(ownership.canonicalPath);
  } catch (cleanupError: unknown) {
    if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
      attachInitializationCleanupDiagnostic(primaryError, cleanupError);
    }
  }
}

function tryAcquireOwnedDatabaseCleanupLock(
  database: SqliteDatabase,
  lifecycle: SqliteInitializationLifecycle,
  primaryError: unknown,
): void {
  try {
    setLockingMode(database, "exclusive");
    database.exec("BEGIN EXCLUSIVE");
    lifecycle.exclusiveLockHeld = true;
    const classification = classifySqliteDatabase(database);
    if (classification !== "empty/new") {
      throw new Error(
        `Invocation-owned SQLite reservation became ${classification} before cleanup`,
      );
    }
    database.exec("COMMIT");
  } catch (cleanupError: unknown) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        attachInitializationCleanupDiagnostic(primaryError, rollbackError);
      }
    }
    lifecycle.exclusiveLockHeld = false;
    attachInitializationCleanupDiagnostic(primaryError, cleanupError);
  }
}

function cleanupInvocationOwnedDatabaseWhileLocked(
  ownership: InvocationOwnedDatabase,
  primaryError: unknown,
): void {
  let metadata;
  try {
    metadata = statSync(ownership.canonicalPath);
  } catch (cleanupError: unknown) {
    if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
      attachInitializationCleanupDiagnostic(primaryError, cleanupError);
    }
    return;
  }
  if (
    metadata.dev !== ownership.device ||
    metadata.ino !== ownership.inode
  ) {
    attachInitializationCleanupDiagnostic(
      primaryError,
      new Error(
        "Invocation-owned SQLite path was replaced before locked cleanup",
      ),
    );
    return;
  }
  for (const artifactPath of [
    `${ownership.canonicalPath}-wal`,
    `${ownership.canonicalPath}-shm`,
    `${ownership.canonicalPath}-journal`,
    ownership.canonicalPath,
  ]) {
    try {
      rmSync(artifactPath, { force: true });
    } catch (cleanupError: unknown) {
      attachInitializationCleanupDiagnostic(primaryError, cleanupError);
    }
  }
}

function rollbackInitializationThroughSqlite(
  database: SqliteDatabase,
  lifecycle: SqliteInitializationLifecycle,
  primaryError: unknown,
): void {
  if (database.isTransaction) {
    try {
      database.exec("ROLLBACK");
    } catch (cleanupError: unknown) {
      attachInitializationCleanupDiagnostic(primaryError, cleanupError);
    }
  }
  if (
    lifecycle.originalJournalMode === null
  ) {
    return;
  }
  try {
    const currentJournalMode = readJournalMode(database);
    if (currentJournalMode !== lifecycle.originalJournalMode) {
      setLockingMode(database, "exclusive");
      database.exec("BEGIN EXCLUSIVE");
      database.exec("COMMIT");
      lifecycle.exclusiveLockHeld = true;
      setJournalMode(database, lifecycle.originalJournalMode);
    }
  } catch (cleanupError: unknown) {
    attachInitializationCleanupDiagnostic(primaryError, cleanupError);
  }
}

function setLockingMode(
  database: SqliteDatabase,
  mode: "exclusive" | "normal",
): void {
  const row = database
    .prepare(`PRAGMA locking_mode = ${mode.toUpperCase()}`)
    .get() as Record<string, unknown> | undefined;
  if (row?.["locking_mode"] !== mode) {
    throw new Error(`SQLite ${mode} locking mode could not be established`);
  }
}

function setJournalMode(database: SqliteDatabase, mode: string): void {
  if (!new Set(["delete", "persist", "truncate", "wal"]).has(mode)) {
    throw new Error(`Unsupported SQLite journal mode ${mode}`);
  }
  database.exec(`PRAGMA journal_mode = ${mode.toUpperCase()}`);
  if (readJournalMode(database) !== mode) {
    throw new Error(`SQLite ${mode} journal mode could not be restored`);
  }
}

function establishWalJournalMode(database: SqliteDatabase): void {
  for (let attempt = 1; attempt <= SQLITE_INITIALIZATION_BUSY_ATTEMPTS; attempt += 1) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      if (readJournalMode(database) !== "wal") {
        throw new Error("SQLite WAL journal mode could not be established");
      }
      return;
    } catch (error: unknown) {
      if (!isSqliteBusyError(error) || attempt === SQLITE_INITIALIZATION_BUSY_ATTEMPTS) {
        throw error;
      }
      Atomics.wait(
        SQLITE_INITIALIZATION_BUSY_WAIT,
        0,
        0,
        SQLITE_INITIALIZATION_BUSY_WAIT_MS,
      );
      if (readJournalMode(database) === "wal") return;
    }
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("errcode" in error &&
      (error as Error & { readonly errcode?: unknown }).errcode === 5) ||
      /database is (?:locked|busy)/iu.test(error.message))
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}

function readJournalMode(database: SqliteDatabase): string {
  const row = database.prepare("PRAGMA journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const mode = row?.["journal_mode"];
  if (typeof mode !== "string" || mode.length === 0) {
    throw new Error("SQLite journal mode is unreadable");
  }
  return mode.toLowerCase();
}

export function ensureDatabaseIncarnation(
  database: SqliteDatabase,
  kind: DatabaseInstanceKind,
): string {
  database.exec(`
    CREATE TABLE IF NOT EXISTS database_incarnation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_kind TEXT NOT NULL CHECK (store_kind IN ('m2', 'factory')),
      incarnation_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS database_incarnation_immutable_update
    BEFORE UPDATE ON database_incarnation BEGIN
      SELECT RAISE(ABORT, 'database incarnation is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS database_incarnation_immutable_delete
    BEFORE DELETE ON database_incarnation BEGIN
      SELECT RAISE(ABORT, 'database incarnation is immutable');
    END;
  `);
  const existing = database
    .prepare(
      "SELECT store_kind, incarnation_id FROM database_incarnation WHERE singleton = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (existing === undefined) {
    const incarnationId = `database-incarnation/${randomUUID()}`;
    database
      .prepare(
        "INSERT INTO database_incarnation (singleton, store_kind, incarnation_id) VALUES (1, ?, ?)",
      )
      .run(kind, incarnationId);
    return incarnationId;
  }
  if (existing["store_kind"] !== kind) {
    throw new Error(
      `Database instance kind ${String(existing["store_kind"])} does not match ${kind}`,
    );
  }
  if (
    typeof existing["incarnation_id"] !== "string" ||
    !existing["incarnation_id"].startsWith("database-incarnation/")
  ) {
    throw new Error("Database incarnation metadata is malformed");
  }
  return existing["incarnation_id"];
}

function classifySqliteDatabase(
  database: SqliteDatabase,
): DatabaseClassification {
  try {
    const schemaRows = database
      .prepare(
        `SELECT type, name
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Record<string, unknown>[];
    const schemaObjects = new Set(
      schemaRows.map((row) => String(row["name"])),
    );
    const tableNames = new Set(
      schemaRows
        .filter((row) => row["type"] === "table")
        .map((row) => String(row["name"])),
    );
    const hasM2Tables = signatureHasAnyTable(tableNames, M2_LEGACY_SIGNATURE);
    const hasFactoryTables = signatureHasAnyTable(
      tableNames,
      FACTORY_LEGACY_SIGNATURE,
    );
    const hasIncarnationTable = tableNames.has("database_incarnation");
    const applicationFingerprint = readSchemaFingerprint(database, false);
    const matchesM2 =
      applicationFingerprint === SUPPORTED_SCHEMA_FINGERPRINTS.m2.legacy;
    const matchesFactory =
      applicationFingerprint === SUPPORTED_SCHEMA_FINGERPRINTS.factory.legacy;

    if (hasIncarnationTable) {
      const markerKind = readValidatedIncarnationKind(database, schemaObjects);
      if (
        (hasM2Tables && hasFactoryTables) ||
        (markerKind === "m2" && hasFactoryTables) ||
        (markerKind === "factory" && hasM2Tables)
      ) {
        return "ambiguous/cross-contaminated";
      }
      const expected = SUPPORTED_SCHEMA_FINGERPRINTS[markerKind].current;
      return readSchemaFingerprint(database, true) === expected
        ? `current ${markerKind}`
        : "corrupt/partial";
    }

    if (
      INCARNATION_TRIGGER_NAMES.some((name) => schemaObjects.has(name)) ||
      (hasM2Tables && hasFactoryTables)
    ) {
      return "ambiguous/cross-contaminated";
    }
    if (matchesM2 && !hasFactoryTables) return "recognizable legacy m2";
    if (matchesFactory && !hasM2Tables) {
      return "recognizable legacy factory";
    }
    if (hasM2Tables || hasFactoryTables || hasStaleAutoincrementState(database)) {
      return "corrupt/partial";
    }
    return schemaRows.length === 0 ? "empty/new" : "foreign";
  } catch (error: unknown) {
    throw new Error("SQLite database schema is corrupt or unreadable", {
      cause: error,
    });
  }
}

function assertCompatibleDatabaseClassification(
  classification: DatabaseClassification,
  requestedKind: DatabaseInstanceKind,
): void {
  const compatible =
    classification === "empty/new" ||
    classification === `current ${requestedKind}` ||
    classification === `recognizable legacy ${requestedKind}`;
  if (compatible) return;
  throw new Error(
    `SQLite database classification ${classification} is not compatible with requested store kind ${requestedKind}`,
  );
}

function signatureHasAnyTable(
  tableNames: ReadonlySet<string>,
  signature: readonly TableSignature[],
): boolean {
  return signature.some(({ name }) => tableNames.has(name));
}

function readSchemaFingerprint(
  database: SqliteDatabase,
  includeIncarnation: boolean,
): string {
  const schemaObjects = (
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Record<string, unknown>[]
  )
    .filter(
      (row) =>
        includeIncarnation ||
        !DATABASE_INCARNATION_OBJECTS.has(String(row["name"])),
    )
    .map((row) => ({
      name: String(row["name"]),
      sql:
        typeof row["sql"] === "string"
          ? normalizeSchemaSql(row["sql"])
          : null,
      tableName: String(row["tbl_name"]),
      type: String(row["type"]),
    }));
  const tableNames = schemaObjects
    .filter((row) => row.type === "table")
    .map((row) => row.name);
  const tableList = database.prepare("PRAGMA table_list").all() as Record<
    string,
    unknown
  >[];
  const tables = tableNames.map((tableName) => {
    const table = tableList.find(
      (row) => row["schema"] === "main" && row["name"] === tableName,
    );
    if (table === undefined) {
      throw new Error(`SQLite table metadata is missing for ${tableName}`);
    }
    const indexList = readPragmaRows(database, "index_list", tableName);
    return {
      columns: readPragmaRows(database, "table_xinfo", tableName).map(
        (row) => ({
          cid: row["cid"],
          defaultValue: row["dflt_value"],
          hidden: row["hidden"],
          name: row["name"],
          notNull: row["notnull"],
          primaryKeyOrdinal: row["pk"],
          type: row["type"],
        }),
      ),
      foreignKeys: readPragmaRows(database, "foreign_key_list", tableName).map(
        (row) => ({
          from: row["from"],
          id: row["id"],
          match: row["match"],
          onDelete: row["on_delete"],
          onUpdate: row["on_update"],
          sequence: row["seq"],
          table: row["table"],
          to: row["to"],
        }),
      ),
      indexes: indexList
        .map((row) => ({
          columns: readPragmaRows(
            database,
            "index_xinfo",
            String(row["name"]),
          ).map((column) => ({
            cid: column["cid"],
            collation: column["coll"],
            descending: column["desc"],
            key: column["key"],
            name: column["name"],
            sequence: column["seqno"],
          })),
          name: row["name"],
          origin: row["origin"],
          partial: row["partial"],
          unique: row["unique"],
        }))
        .sort((left, right) =>
          String(left.name).localeCompare(String(right.name)),
        ),
      name: tableName,
      options: {
        columns: table["ncol"],
        strict: table["strict"],
        withoutRowid: table["wr"],
      },
    };
  });
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize({ objects: schemaObjects, tables }))
    .digest("hex")}`;
}

function readPragmaRows(
  database: SqliteDatabase,
  pragma: "foreign_key_list" | "index_list" | "index_xinfo" | "table_xinfo",
  objectName: string,
): Record<string, unknown>[] {
  const escaped = objectName.replaceAll('"', '""');
  return database.prepare(`PRAGMA ${pragma}("${escaped}")`).all() as Record<
    string,
    unknown
  >[];
}

function normalizeSchemaSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, " ").trim();
}

function readTableColumns(
  database: SqliteDatabase,
  tableName: string,
): readonly string[] {
  const escaped = tableName.replaceAll('"', '""');
  return (
    database.prepare(`PRAGMA table_info("${escaped}")`).all() as Record<
      string,
      unknown
    >[]
  ).map((row) => String(row["name"]));
}

function readValidatedIncarnationKind(
  database: SqliteDatabase,
  schemaObjects: ReadonlySet<string>,
): DatabaseInstanceKind {
  if (
    !stringArraysEqual(
      readTableColumns(database, "database_incarnation"),
      INCARNATION_COLUMNS,
    ) ||
    !INCARNATION_TRIGGER_NAMES.every((name) => schemaObjects.has(name))
  ) {
    throw new Error("Database incarnation metadata schema is malformed");
  }
  const rows = database
    .prepare(
      "SELECT singleton, store_kind, incarnation_id FROM database_incarnation ORDER BY singleton",
    )
    .all() as Record<string, unknown>[];
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.["singleton"] !== 1 ||
    (row["store_kind"] !== "m2" && row["store_kind"] !== "factory") ||
    typeof row["incarnation_id"] !== "string" ||
    !row["incarnation_id"].startsWith("database-incarnation/")
  ) {
    throw new Error("Database incarnation metadata is malformed");
  }
  return row["store_kind"];
}

function hasStaleAutoincrementState(database: SqliteDatabase): boolean {
  const hasSequence = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .get() as Record<string, unknown> | undefined;
  if (hasSequence === undefined) return false;
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM sqlite_sequence")
    .get() as Record<string, unknown> | undefined;
  return typeof row?.["count"] === "number" && row["count"] > 0;
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function readDatabaseInstanceIdentity(
  path: string,
  kind: DatabaseInstanceKind,
  environmentId: string,
): string {
  if (isSqliteMemoryPath(path)) {
    throw new TypeError(
      "An in-memory database has no reopenable instance identity",
    );
  }
  const canonicalPath = canonicalDatabasePath(path);
  const database = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    return databaseInstanceIdentityFromHandle(
      database,
      canonicalPath,
      kind,
      environmentId,
    );
  } finally {
    database.close();
  }
}

export function databaseInstanceIdentityFromHandle(
  database: SqliteDatabase,
  canonicalPath: string,
  kind: DatabaseInstanceKind,
  environmentId: string,
): string {
  const row = database
    .prepare(
      "SELECT store_kind, incarnation_id FROM database_incarnation WHERE singleton = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (
    row === undefined ||
    row["store_kind"] !== kind ||
    typeof row["incarnation_id"] !== "string" ||
    !row["incarnation_id"].startsWith("database-incarnation/")
  ) {
    throw new Error(`${kind} database instance identity is missing or malformed`);
  }
  const identityBasis =
    canonicalPath === SQLITE_MEMORY_IDENTITY_PATH
      ? {
          environmentId,
          incarnationId: row["incarnation_id"],
          kind,
        }
      : {
          canonicalPath,
          environmentId,
          incarnationId: row["incarnation_id"],
          kind,
        };
  return `database-instance/sha256:${createHash("sha256")
    .update(canonicalSerialize(identityBasis))
    .digest("hex")}`;
}

/** Canonical physical identity for an existing or prospective database path. */
export function canonicalDatabasePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isSqliteMemoryPath(path)
  ) {
    throw new TypeError("A durable database path must be a non-empty string");
  }
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const missing: string[] = [basename(absolute)];
  let parent = dirname(absolute);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) {
      throw new Error(`No existing parent exists for database path ${path}`);
    }
    missing.unshift(basename(parent));
    parent = next;
  }
  return join(realpathSync(parent), ...missing);
}

function attachInitializationCleanupDiagnostic(
  primaryError: unknown,
  cleanupError: unknown,
): void {
  if (
    (typeof primaryError !== "object" || primaryError === null) &&
    typeof primaryError !== "function"
  ) {
    return;
  }
  try {
    const prior = Reflect.get(primaryError, "cleanupErrors");
    const cleanupErrors = Array.isArray(prior)
      ? [...prior, cleanupError]
      : [cleanupError];
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: cleanupErrors,
      writable: false,
    });
  } catch {
    // The primary initialization failure must remain authoritative.
  }
}

export function inImmediateTransaction<T>(
  database: SqliteDatabase,
  operation: () => T,
): T {
  if (database.isTransaction) return operation();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalSerialize(value);
}

export function parseCanonicalJson<T>(value: unknown, context: string): T {
  if (typeof value !== "string") {
    throw new TypeError(`${context}: expected canonical JSON text`);
  }
  const parsed = JSON.parse(value) as unknown;
  if (canonicalSerialize(parsed) !== value) {
    throw new TypeError(`${context}: stored bytes are not canonical JSON`);
  }
  return parsed as T;
}

export function requireRow(
  row: Record<string, unknown> | undefined,
  context: string,
): Record<string, unknown> {
  if (row === undefined) throw new Error(`${context}: row not found`);
  return row;
}

function initializeSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_versions (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      portfolio_version INTEGER NOT NULL CHECK (portfolio_version > 0),
      capacity_model_version INTEGER NOT NULL CHECK (capacity_model_version > 0),
      capacity_plan_version INTEGER NOT NULL CHECK (capacity_plan_version > 0),
      authorization_state_version INTEGER NOT NULL CHECK (authorization_state_version > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS state_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      assumptions_json TEXT NOT NULL,
      combined_decision_proofs_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS portfolio_obligations (
      obligation_id TEXT PRIMARY KEY,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS capacity_resources (
      resource_key TEXT PRIMARY KEY,
      model_json TEXT NOT NULL,
      plan_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS admission_records (
      admission_record_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('ADMITTABLE', 'REPLAN', 'REJECT')),
      proposal_obligation_id TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS admission_records_created
      ON admission_records(created_at, admission_record_id);

    CREATE TABLE IF NOT EXISTS admission_addenda (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      addendum_id TEXT NOT NULL UNIQUE,
      admission_record_id TEXT NOT NULL REFERENCES admission_records(admission_record_id),
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS admission_addenda_record
      ON admission_addenda(admission_record_id, sequence);

    CREATE TABLE IF NOT EXISTS owner_decisions (
      owner_decision_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS grant_allowances (
      grant_allowance_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      grant_allowance_key TEXT NOT NULL REFERENCES grant_allowances(grant_allowance_key),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS grants_allowance ON grants(grant_allowance_key);

    CREATE TABLE IF NOT EXISTS authorization_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_event_id TEXT NOT NULL UNIQUE,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS authorization_events_subject
      ON authorization_events(subject_kind, subject_id, sequence);

    CREATE TABLE IF NOT EXISTS denials (
      denial_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS denial_exceptions (
      denial_exception_id TEXT PRIMARY KEY,
      parent_denial_id TEXT NOT NULL REFERENCES denials(denial_id),
      grant_allowance_key TEXT NOT NULL REFERENCES grant_allowances(grant_allowance_key),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS denial_exceptions_parent
      ON denial_exceptions(parent_denial_id);

    CREATE TABLE IF NOT EXISTS execution_attempts (
      execution_attempt_id TEXT PRIMARY KEY,
      admission_record_id TEXT NOT NULL REFERENCES admission_records(admission_record_id),
      created_at TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS allowance_claims (
      grant_allowance_key TEXT NOT NULL REFERENCES grant_allowances(grant_allowance_key),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      execution_attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(execution_attempt_id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (grant_allowance_key, ordinal)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS inflight_reservations (
      reservation_id TEXT PRIMARY KEY,
      execution_attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(execution_attempt_id),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reservation_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_event_id TEXT NOT NULL UNIQUE,
      reservation_id TEXT NOT NULL REFERENCES inflight_reservations(reservation_id),
      created_at TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS reservation_events_reservation
      ON reservation_events(reservation_id, sequence);

    CREATE TABLE IF NOT EXISTS execution_fences (
      fence_id TEXT PRIMARY KEY,
      execution_attempt_id TEXT NOT NULL UNIQUE
        REFERENCES execution_attempts(execution_attempt_id),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS execution_fence_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_event_id TEXT NOT NULL UNIQUE,
      fence_id TEXT NOT NULL REFERENCES execution_fences(fence_id),
      created_at TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (
        event_kind IN ('factory_result_bound', 'released_without_mutation')
      ),
      body_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS execution_fence_events_fence
      ON execution_fence_events(fence_id, sequence);

    CREATE TABLE IF NOT EXISTS realized_effects (
      realized_effect_id TEXT PRIMARY KEY,
      execution_attempt_id TEXT NOT NULL REFERENCES execution_attempts(execution_attempt_id),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS realized_consumption_facts (
      realized_consumption_id TEXT PRIMARY KEY,
      execution_attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(execution_attempt_id),
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;
  `);

  for (const table of IMMUTABLE_TABLES) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END;
    `);
  }
}
