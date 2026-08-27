import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { canonicalSerialize, deepFreeze } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import { stableTupleId } from "./identity.js";
import { inImmediateTransaction, parseCanonicalJson } from "./sqlite.js";

export type M4BridgeActionKind =
  | "owner_decision"
  | "consequential_effect"
  | "verification";

export interface M4MissionBinding {
  readonly missionId: string;
  readonly environmentId: string;
  readonly trueforgeAgentId: string;
  readonly trueforgeSessionId: string;
  readonly currentTurnId: string | null;
  readonly lastEventSequence: number;
  readonly m2EnvironmentIdentity: string;
  readonly factoryEnvironmentIdentity: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface M4MissionBindingInput {
  readonly missionId: string;
  readonly environmentId: string;
  readonly trueforgeAgentId: string;
  readonly trueforgeSessionId: string;
  readonly m2EnvironmentIdentity: string;
  readonly factoryEnvironmentIdentity: string;
}

export interface M4BridgeActionInput {
  readonly missionId: string;
  readonly trueforgeSessionId: string;
  readonly trueforgeTurnId: string;
  readonly trueforgeThreadId: string;
  readonly trueforgeToolCallId: string;
  readonly actionKind: M4BridgeActionKind;
  readonly toolName: string;
  readonly arguments: JsonValue;
}

export interface M4BridgeAction extends M4BridgeActionInput {
  readonly bridgeKey: string;
  readonly argumentsDigest: string;
  readonly createdAt: string;
}

export interface M4BridgeOutcome {
  readonly bridgeEventId: string;
  readonly bridgeKey: string;
  readonly status:
    | "registered"
    | "owner_decision_received"
    | "m2_applied"
    | "approval_bound"
    | "trueforge_resumed"
    | "tool_completed";
  readonly result: JsonValue;
  readonly createdAt: string;
}

export interface M4MissionSnapshot {
  readonly mission: M4MissionBinding;
  readonly bridgeActions: readonly M4BridgeAction[];
  readonly bridgeOutcomes: readonly M4BridgeOutcome[];
}

export interface M4MissionStoreOptions {
  readonly path: string;
  readonly now?: () => string;
}

/**
 * Durable FlakeBrake-specific cross-system bindings. TrueForge remains the sole
 * owner of session/turn/thread history; this store holds only stable foreign
 * keys, a resume cursor, and idempotent approval bridge facts.
 */
export class M4MissionStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;
  #closed = false;

  public constructor(options: M4MissionStoreOptions) {
    requireText(options.path, "path");
    this.#database = new DatabaseSync(options.path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (options.path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL");
    }
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS m4_missions (
        mission_id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        trueforge_agent_id TEXT NOT NULL,
        trueforge_session_id TEXT NOT NULL UNIQUE,
        current_turn_id TEXT,
        last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
        m2_environment_identity TEXT NOT NULL,
        factory_environment_identity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS m4_bridge_actions (
        bridge_key TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES m4_missions(mission_id),
        trueforge_session_id TEXT NOT NULL,
        trueforge_turn_id TEXT NOT NULL,
        trueforge_thread_id TEXT NOT NULL,
        trueforge_tool_call_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK (action_kind IN (
          'owner_decision', 'consequential_effect', 'verification'
        )),
        tool_name TEXT NOT NULL,
        arguments_digest TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (
          trueforge_session_id, trueforge_turn_id,
          trueforge_thread_id, trueforge_tool_call_id
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS m4_bridge_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        bridge_event_id TEXT NOT NULL UNIQUE,
        bridge_key TEXT NOT NULL REFERENCES m4_bridge_actions(bridge_key),
        status TEXT NOT NULL CHECK (status IN (
          'registered', 'owner_decision_received', 'm2_applied',
          'approval_bound', 'trueforge_resumed', 'tool_completed'
        )),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (bridge_key, status)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS m4_bridge_actions_immutable_update
      BEFORE UPDATE ON m4_bridge_actions BEGIN
        SELECT RAISE(ABORT, 'm4_bridge_actions rows are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS m4_bridge_actions_immutable_delete
      BEFORE DELETE ON m4_bridge_actions BEGIN
        SELECT RAISE(ABORT, 'm4_bridge_actions rows are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS m4_bridge_events_immutable_update
      BEFORE UPDATE ON m4_bridge_events BEGIN
        SELECT RAISE(ABORT, 'm4_bridge_events rows are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS m4_bridge_events_immutable_delete
      BEFORE DELETE ON m4_bridge_events BEGIN
        SELECT RAISE(ABORT, 'm4_bridge_events rows are immutable');
      END;
    `);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public bindMission(input: M4MissionBindingInput): M4MissionBinding {
    validateBinding(input);
    return inImmediateTransaction(this.#database, () => {
      const existing = this.#mission(input.missionId);
      if (existing !== null) {
        const expected = bindingMaterial(existing);
        if (canonicalSerialize(expected) !== canonicalSerialize(input)) {
          throw new Error(`Mission ${input.missionId} binding conflicts`);
        }
        return existing;
      }
      const createdAt = this.#timestamp();
      this.#database
        .prepare(
          `INSERT INTO m4_missions
             (mission_id, environment_id, trueforge_agent_id,
              trueforge_session_id, current_turn_id, last_event_sequence,
              m2_environment_identity, factory_environment_identity,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
        )
        .run(
          input.missionId,
          input.environmentId,
          input.trueforgeAgentId,
          input.trueforgeSessionId,
          input.m2EnvironmentIdentity,
          input.factoryEnvironmentIdentity,
          createdAt,
          createdAt,
        );
      return requireMission(this.#mission(input.missionId), input.missionId);
    });
  }

  public advanceCursor(
    missionId: string,
    turnId: string,
    eventSequence: number,
  ): M4MissionBinding {
    requireText(missionId, "missionId");
    requireText(turnId, "turnId");
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) {
      throw new TypeError("eventSequence must be a nonnegative safe integer");
    }
    return inImmediateTransaction(this.#database, () => {
      const current = requireMission(this.#mission(missionId), missionId);
      if (
        current.currentTurnId === turnId &&
        eventSequence < current.lastEventSequence
      ) {
        throw new Error("TrueForge event cursor cannot move backwards");
      }
      this.#database
        .prepare(
          `UPDATE m4_missions
              SET current_turn_id = ?, last_event_sequence = ?, updated_at = ?
            WHERE mission_id = ?`,
        )
        .run(turnId, eventSequence, this.#timestamp(), missionId);
      return requireMission(this.#mission(missionId), missionId);
    });
  }

  public recordBridgeAction(input: M4BridgeActionInput): M4BridgeAction {
    validateBridgeAction(input);
    const bridgeKey = bridgeIdentity(input);
    const argumentsJson = canonicalSerialize(input.arguments);
    const argumentsDigest = digest(argumentsJson);
    const action = inImmediateTransaction(this.#database, () => {
      const existing = this.#bridgeAction(bridgeKey);
      if (existing !== null) {
        const requested = {
          ...input,
          bridgeKey,
          argumentsDigest,
          createdAt: existing.createdAt,
        } as const;
        if (canonicalSerialize(existing) !== canonicalSerialize(requested)) {
          throw new Error(`TrueForge bridge identity ${bridgeKey} was reused`);
        }
        return existing;
      }
      const mission = requireMission(this.#mission(input.missionId), input.missionId);
      if (mission.trueforgeSessionId !== input.trueforgeSessionId) {
        throw new Error("Bridge action session does not match mission binding");
      }
      const createdAt = this.#timestamp();
      this.#database
        .prepare(
          `INSERT INTO m4_bridge_actions
             (bridge_key, mission_id, trueforge_session_id,
              trueforge_turn_id, trueforge_thread_id, trueforge_tool_call_id,
              action_kind, tool_name, arguments_digest, arguments_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bridgeKey,
          input.missionId,
          input.trueforgeSessionId,
          input.trueforgeTurnId,
          input.trueforgeThreadId,
          input.trueforgeToolCallId,
          input.actionKind,
          input.toolName,
          argumentsDigest,
          argumentsJson,
          createdAt,
        );
      return requireBridgeAction(this.#bridgeAction(bridgeKey), bridgeKey);
    });
    this.recordBridgeOutcome(bridgeKey, "registered", { argumentsDigest });
    return action;
  }

  public recordBridgeOutcome(
    bridgeKey: string,
    status: M4BridgeOutcome["status"],
    result: JsonValue,
  ): M4BridgeOutcome {
    requireText(bridgeKey, "bridgeKey");
    const resultJson = canonicalSerialize(result);
    return inImmediateTransaction(this.#database, () => {
      requireBridgeAction(this.#bridgeAction(bridgeKey), bridgeKey);
      const existing = this.#database
        .prepare(
          `SELECT bridge_event_id, bridge_key, status, result_json, created_at
             FROM m4_bridge_events WHERE bridge_key = ? AND status = ?`,
        )
        .get(bridgeKey, status) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        const outcome = bridgeOutcomeFromRow(existing);
        if (canonicalSerialize(outcome.result) !== resultJson) {
          throw new Error(`Bridge outcome ${bridgeKey}/${status} conflicts`);
        }
        return outcome;
      }
      const createdAt = this.#timestamp();
      const bridgeEventId = stableTupleId("m4-bridge-event", [
        bridgeKey,
        status,
        result,
      ]);
      this.#database
        .prepare(
          `INSERT INTO m4_bridge_events
             (bridge_event_id, bridge_key, status, result_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(bridgeEventId, bridgeKey, status, resultJson, createdAt);
      return {
        bridgeEventId,
        bridgeKey,
        status,
        result,
        createdAt,
      };
    });
  }

  public getSnapshot(missionId: string): M4MissionSnapshot {
    const mission = requireMission(this.#mission(missionId), missionId);
    const actionRows = this.#database
      .prepare(
        `SELECT bridge_key, mission_id, trueforge_session_id,
                trueforge_turn_id, trueforge_thread_id,
                trueforge_tool_call_id, action_kind, tool_name,
                arguments_digest, arguments_json, created_at
           FROM m4_bridge_actions WHERE mission_id = ? ORDER BY bridge_key`,
      )
      .all(missionId) as Record<string, unknown>[];
    const actions = actionRows.map(bridgeActionFromRow);
    const outcomes = actions.flatMap((action) =>
      (this.#database
        .prepare(
          `SELECT bridge_event_id, bridge_key, status, result_json, created_at
             FROM m4_bridge_events WHERE bridge_key = ? ORDER BY sequence`,
        )
        .all(action.bridgeKey) as Record<string, unknown>[]).map(
        bridgeOutcomeFromRow,
      ),
    );
    return deepFreeze({ mission, bridgeActions: actions, bridgeOutcomes: outcomes });
  }

  public getSnapshotOrNull(missionId: string): M4MissionSnapshot | null {
    return this.#mission(missionId) === null ? null : this.getSnapshot(missionId);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #mission(missionId: string): M4MissionBinding | null {
    const row = this.#database
      .prepare("SELECT * FROM m4_missions WHERE mission_id = ?")
      .get(missionId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return missionFromRow(row);
  }

  #bridgeAction(bridgeKey: string): M4BridgeAction | null {
    const row = this.#database
      .prepare("SELECT * FROM m4_bridge_actions WHERE bridge_key = ?")
      .get(bridgeKey) as Record<string, unknown> | undefined;
    return row === undefined ? null : bridgeActionFromRow(row);
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new TypeError("M4 mission timestamp must be ISO-8601");
    }
    return timestamp;
  }
}

function missionFromRow(row: Record<string, unknown>): M4MissionBinding {
  return {
    missionId: text(row["mission_id"], "mission_id"),
    environmentId: text(row["environment_id"], "environment_id"),
    trueforgeAgentId: text(row["trueforge_agent_id"], "trueforge_agent_id"),
    trueforgeSessionId: text(
      row["trueforge_session_id"],
      "trueforge_session_id",
    ),
    currentTurnId: nullableText(row["current_turn_id"], "current_turn_id"),
    lastEventSequence: integer(row["last_event_sequence"], "last_event_sequence"),
    m2EnvironmentIdentity: text(
      row["m2_environment_identity"],
      "m2_environment_identity",
    ),
    factoryEnvironmentIdentity: text(
      row["factory_environment_identity"],
      "factory_environment_identity",
    ),
    createdAt: text(row["created_at"], "created_at"),
    updatedAt: text(row["updated_at"], "updated_at"),
  };
}

function bridgeActionFromRow(row: Record<string, unknown>): M4BridgeAction {
  return {
    bridgeKey: text(row["bridge_key"], "bridge_key"),
    missionId: text(row["mission_id"], "mission_id"),
    trueforgeSessionId: text(
      row["trueforge_session_id"],
      "trueforge_session_id",
    ),
    trueforgeTurnId: text(row["trueforge_turn_id"], "trueforge_turn_id"),
    trueforgeThreadId: text(
      row["trueforge_thread_id"],
      "trueforge_thread_id",
    ),
    trueforgeToolCallId: text(
      row["trueforge_tool_call_id"],
      "trueforge_tool_call_id",
    ),
    actionKind: text(row["action_kind"], "action_kind") as M4BridgeActionKind,
    toolName: text(row["tool_name"], "tool_name"),
    argumentsDigest: text(row["arguments_digest"], "arguments_digest"),
    arguments: parseCanonicalJson<JsonValue>(
      row["arguments_json"],
      "m4 bridge arguments",
    ),
    createdAt: text(row["created_at"], "created_at"),
  };
}

function bridgeOutcomeFromRow(row: Record<string, unknown>): M4BridgeOutcome {
  return {
    bridgeEventId: text(row["bridge_event_id"], "bridge_event_id"),
    bridgeKey: text(row["bridge_key"], "bridge_key"),
    status: text(row["status"], "status") as M4BridgeOutcome["status"],
    result: parseCanonicalJson<JsonValue>(row["result_json"], "m4 bridge result"),
    createdAt: text(row["created_at"], "created_at"),
  };
}

function bindingMaterial(binding: M4MissionBinding): M4MissionBindingInput {
  return {
    missionId: binding.missionId,
    environmentId: binding.environmentId,
    trueforgeAgentId: binding.trueforgeAgentId,
    trueforgeSessionId: binding.trueforgeSessionId,
    m2EnvironmentIdentity: binding.m2EnvironmentIdentity,
    factoryEnvironmentIdentity: binding.factoryEnvironmentIdentity,
  };
}

function bridgeIdentity(input: M4BridgeActionInput): string {
  return stableTupleId("m4-bridge", [
    input.trueforgeSessionId,
    input.trueforgeTurnId,
    input.trueforgeThreadId,
    input.trueforgeToolCallId,
  ]);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateBinding(input: M4MissionBindingInput): void {
  requireText(input.missionId, "missionId");
  requireText(input.environmentId, "environmentId");
  requireText(input.trueforgeAgentId, "trueforgeAgentId");
  requireText(input.trueforgeSessionId, "trueforgeSessionId");
  requireText(input.m2EnvironmentIdentity, "m2EnvironmentIdentity");
  requireText(input.factoryEnvironmentIdentity, "factoryEnvironmentIdentity");
}

function validateBridgeAction(input: M4BridgeActionInput): void {
  requireText(input.missionId, "missionId");
  requireText(input.trueforgeSessionId, "trueforgeSessionId");
  requireText(input.trueforgeTurnId, "trueforgeTurnId");
  requireText(input.trueforgeThreadId, "trueforgeThreadId");
  requireText(input.trueforgeToolCallId, "trueforgeToolCallId");
  requireText(input.toolName, "toolName");
  canonicalSerialize(input.arguments);
}

function requireMission(
  value: M4MissionBinding | null,
  missionId: string,
): M4MissionBinding {
  if (value === null) throw new Error(`M4 mission ${missionId} not found`);
  return value;
}

function requireBridgeAction(
  value: M4BridgeAction | null,
  bridgeKey: string,
): M4BridgeAction {
  if (value === null) throw new Error(`M4 bridge action ${bridgeKey} not found`);
  return value;
}

function requireText(value: string, field: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}
