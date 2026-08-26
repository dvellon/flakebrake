import { createHash } from "node:crypto";

import { canonicalSerialize, compareStableStrings } from "./canonical.js";
import type {
  AcceptedObligation,
  CalibratedDemandSnapshot,
  CalibrationFrontierProvenance,
  CalibrationHistoryRecord,
  CapacityResource,
  ProposedObligation,
  ResourceDemand,
} from "./domain.js";

type Obligation = AcceptedObligation | ProposedObligation;

export interface CalibrationComputation {
  readonly provenance: CalibrationFrontierProvenance;
  readonly digest: string;
  readonly snapshots: readonly CalibratedDemandSnapshot[];
  readonly calibratedDemand: (
    obligation: Obligation,
    baseDemand: ResourceDemand,
  ) => ResourceDemand;
}

export function computeCalibration(
  capacityModelVersion: string,
  resources: readonly CapacityResource[],
  obligations: readonly Obligation[],
  historyRecords: readonly CalibrationHistoryRecord[],
): CalibrationComputation {
  const resourceKeys = resources
    .map((resource) => resource.resourceKey)
    .sort(compareStableStrings);
  const pairs = new Map<string, { resourceKey: string; workClassKey: string }>();
  for (const obligation of obligations) {
    for (const resourceKey of resourceKeys) {
      const workClassKey = obligation.workClassByResource[resourceKey];
      if (workClassKey === undefined) {
        throw new TypeError(
          `workClassByResource.${resourceKey}: required calibration class is missing`,
        );
      }
      pairs.set(pairKey(resourceKey, workClassKey), { resourceKey, workClassKey });
    }
  }

  const entries = [...pairs.values()]
    .sort((left, right) => {
      const resourceComparison = compareStableStrings(
        left.resourceKey,
        right.resourceKey,
      );
      return resourceComparison !== 0
        ? resourceComparison
        : compareStableStrings(left.workClassKey, right.workClassKey);
    })
    .map(({ resourceKey, workClassKey }) => {
      const selectedRecords = historyRecords
        .filter(
          (record) =>
            record.resourceKey === resourceKey &&
            record.workClassKey === workClassKey,
        )
        .sort((left, right) => {
          const timeComparison = compareNumber(
            Date.parse(right.completedAt),
            Date.parse(left.completedAt),
          );
          return timeComparison !== 0
            ? timeComparison
            : compareStableStrings(left.recordId, right.recordId);
        })
        .slice(0, 10)
        .map((record) => ({
          recordId: record.recordId,
          completedAt: record.completedAt,
          actualConsumption: record.actualConsumption,
          actualConsumptionAddendumId: record.actualConsumptionAddendumId,
          outcome: record.outcome,
          outcomeAddendumId: record.outcomeAddendumId,
        }));
      return { resourceKey, workClassKey, selectedRecords };
    });

  const provenance: CalibrationFrontierProvenance = {
    capacityModelVersion,
    ruleId: "conservative-max/v1",
    digestAlgorithm: "sha256",
    serialization: "canonical-json/v1",
    entries,
  };
  const digest = `sha256:${createHash("sha256")
    .update(canonicalSerialize(provenance), "utf8")
    .digest("hex")}`;

  const maxima = new Map<string, number>();
  for (const entry of entries) {
    maxima.set(
      pairKey(entry.resourceKey, entry.workClassKey),
      entry.selectedRecords.reduce(
        (maximum, record) => Math.max(maximum, record.actualConsumption),
        0,
      ),
    );
  }

  const calibratedDemand = (
    obligation: Obligation,
    baseDemand: ResourceDemand,
  ): ResourceDemand =>
    Object.fromEntries(
      resourceKeys.map((resourceKey) => {
        const base = requiredDemand(baseDemand, resourceKey);
        const workClassKey = obligation.workClassByResource[resourceKey];
        if (workClassKey === undefined) {
          throw new TypeError(
            `workClassByResource.${resourceKey}: required calibration class is missing`,
          );
        }
        const observed = maxima.get(pairKey(resourceKey, workClassKey)) ?? 0;
        return [resourceKey, Math.max(base, observed)];
      }),
    );

  const snapshots = obligations
    .flatMap((obligation) => {
      const variants = [
        { variantId: "current", demand: obligation.resourceDemand },
        ...[...obligation.modificationOptions]
          .sort((left, right) => compareStableStrings(left.optionId, right.optionId))
          .map((option) => ({
            variantId: option.optionId,
            demand: option.resourceDemand,
          })),
      ];
      return variants.map(({ variantId, demand }) => {
        const calibrated = calibratedDemand(obligation, demand);
        return {
          obligationId: obligation.obligationId,
          variantId,
          baseDemand: resourceKeys.map((resourceKey) => ({
            resourceKey,
            value: requiredDemand(demand, resourceKey),
          })),
          calibratedDemand: resourceKeys.map((resourceKey) => ({
            resourceKey,
            value: requiredDemand(calibrated, resourceKey),
          })),
          additiveCorrections: resourceKeys.map((resourceKey) => ({
            resourceKey,
            value:
              requiredDemand(calibrated, resourceKey) -
              requiredDemand(demand, resourceKey),
          })),
        };
      });
    })
    .sort((left, right) => {
      const obligationComparison = compareStableStrings(
        left.obligationId,
        right.obligationId,
      );
      return obligationComparison !== 0
        ? obligationComparison
        : compareStableStrings(left.variantId, right.variantId);
    });

  return { provenance, digest, snapshots, calibratedDemand };
}

function pairKey(resourceKey: string, workClassKey: string): string {
  return canonicalSerialize([resourceKey, workClassKey]);
}

function requiredDemand(demand: ResourceDemand, resourceKey: string): number {
  const value = demand[resourceKey];
  if (value === undefined) throw new TypeError(`Missing demand ${resourceKey}`);
  return value;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
