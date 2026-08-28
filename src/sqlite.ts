import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalSerialize } from "./canonical.js";

export type SqliteDatabase = DatabaseSync;
export type DatabaseInstanceKind = "m2" | "factory";

const SQLITE_MEMORY_PATH = ":memory:";
const SQLITE_MEMORY_IDENTITY_PATH = "sqlite-memory/current-connection";

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
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    if (!isSqliteMemoryPath(path)) database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    initializeSchema(database);
    ensureDatabaseIncarnation(database, "m2");
    return database;
  } catch (error: unknown) {
    closeSqliteAfterInitializationFailure(database, error);
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
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: [cleanupError],
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
