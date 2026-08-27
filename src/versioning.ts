import type { VersionTuple } from "./domain.js";
import type { SqliteDatabase } from "./sqlite.js";
import { requireRow } from "./sqlite.js";

export type VersionKind =
  | "portfolio"
  | "capacity_model"
  | "capacity_plan"
  | "authorization";

/**
 * The only M2 version mutation point.
 *
 * portfolio: accepted promise or explicitly approved replan commit.
 * capacity_model: material resource/estimator/schema definition replacement.
 * capacity_plan: material authorized capacity/horizon/reserve replacement.
 * authorization: semantic grant, allowance, denial, exception, or reservation transition.
 *
 * A Set makes each version advance at most once in one transaction.
 */
export function advanceVersions(
  database: SqliteDatabase,
  affected: ReadonlySet<VersionKind>,
): VersionTuple {
  if (affected.size > 0) {
    const assignments: string[] = [];
    if (affected.has("portfolio")) {
      assignments.push("portfolio_version = portfolio_version + 1");
    }
    if (affected.has("capacity_model")) {
      assignments.push("capacity_model_version = capacity_model_version + 1");
    }
    if (affected.has("capacity_plan")) {
      assignments.push("capacity_plan_version = capacity_plan_version + 1");
    }
    if (affected.has("authorization")) {
      assignments.push(
        "authorization_state_version = authorization_state_version + 1",
      );
    }
    database.prepare(`UPDATE state_versions SET ${assignments.join(", ")} WHERE singleton = 1`).run();
  }
  return readVersions(database);
}

export function readVersions(database: SqliteDatabase): VersionTuple {
  const row = requireRow(
    database
      .prepare(
        `SELECT portfolio_version, capacity_model_version,
                capacity_plan_version, authorization_state_version
           FROM state_versions WHERE singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined,
    "state_versions",
  );
  return {
    portfolioVersion: version("portfolio", row["portfolio_version"]),
    capacityModelVersion: version("capacity-model", row["capacity_model_version"]),
    capacityPlanVersion: version("capacity-plan", row["capacity_plan_version"]),
    authorizationStateVersion: version(
      "authorization",
      row["authorization_state_version"],
    ),
  };
}

function version(prefix: string, value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid ${prefix} version counter`);
  }
  return `${prefix}/v${value}`;
}
