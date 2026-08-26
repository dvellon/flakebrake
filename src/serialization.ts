import { canonicalSerialize } from "./canonical.js";
import type {
  AdmissionEvaluationInput,
  CalibrationFrontierEntry,
  CalibrationHistoryRecord,
  PromiseBasis,
} from "./domain.js";
import { evaluateAdmission } from "./kernel.js";

export function serializeAdmissionResult(result: unknown): string {
  const serialized = canonicalSerialize(result);
  const parsed = JSON.parse(serialized) as unknown;
  const promiseBasis = requirePromiseBasis(parsed);
  const reproduced = evaluateAdmission(inputFromPromiseBasis(promiseBasis));
  const reproducedSerialized = canonicalSerialize(reproduced);
  if (serialized !== reproducedSerialized) {
    throw new TypeError(
      "AdmissionResult does not exactly match deterministic recomputation from its Promise Basis",
    );
  }
  return serialized;
}

function inputFromPromiseBasis(
  promiseBasis: PromiseBasis,
): AdmissionEvaluationInput {
  return {
    versions: promiseBasis.versions,
    calibration: {
      ruleId: promiseBasis.calibrationFrontierProvenance.ruleId,
      historyRecords: calibrationHistory(
        promiseBasis.calibrationFrontierProvenance.entries,
      ),
      expectedFrontierDigest: promiseBasis.calibrationFrontierDigest,
    },
    resources: promiseBasis.resources,
    acceptedObligations: promiseBasis.acceptedPortfolio,
    proposal: promiseBasis.proposal,
    fixedCapacityReservations: promiseBasis.fixedCapacityReservations,
    combinedDecisionProofs: promiseBasis.combinedDecisionProofs,
    authorizationFacts: promiseBasis.authorizationFacts,
    assumptions: promiseBasis.assumptions,
  };
}

function calibrationHistory(
  entries: readonly CalibrationFrontierEntry[],
): readonly CalibrationHistoryRecord[] {
  return entries.flatMap((entry) =>
    entry.selectedRecords.map((record) => ({
      recordId: record.recordId,
      completedAt: record.completedAt,
      resourceKey: entry.resourceKey,
      workClassKey: entry.workClassKey,
      actualConsumption: record.actualConsumption,
      actualConsumptionAddendumId: record.actualConsumptionAddendumId,
      outcome: record.outcome,
      outcomeAddendumId: record.outcomeAddendumId,
    })),
  );
}

function requirePromiseBasis(value: unknown): PromiseBasis {
  const result = requirePlainObject(value, "$result");
  const promiseBasis = requirePlainObject(
    result["promiseBasis"],
    "$result.promiseBasis",
  );
  return promiseBasis as unknown as PromiseBasis;
}

function requirePlainObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path}: must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path}: must be a plain object`);
  }
  return value as Record<string, unknown>;
}
