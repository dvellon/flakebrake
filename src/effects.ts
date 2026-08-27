import { createHash } from "node:crypto";

import {
  canonicalClone,
  canonicalSerialize,
  compareStableStrings,
  deepFreeze,
} from "./canonical.js";
import type { JsonPrimitive, ResourceDemand } from "./domain.js";
import type {
  ApprovalScope,
  AuthorizationOccurrence,
  CanonicalApprovalScope,
  CanonicalNormalizedEffect,
  DeniedScopePredicate,
  EffectFingerprint,
  EffectSchemaVersion,
  TypedConstraint,
} from "./stateful-domain.js";
import { StatefulInputError } from "./stateful-domain.js";

const EFFECT_SCHEMA_VERSIONS: readonly EffectSchemaVersion[] = [
  "microfactory-effect/v1",
  "microfactory-effect/v2",
];
const MATERIAL_PARAMETER_KEYS = ["end", "quantity", "start"] as const;

export interface FingerprintIdentity {
  readonly fingerprint: EffectFingerprint;
  readonly canonicalBytes: string;
  readonly digest: string;
}

export function normalizeEffect(value: unknown): CanonicalNormalizedEffect {
  const effect = validateEffectFingerprint(value);
  return deepFreeze({
    canonicalEffectClass: "microfactory.schedule_reservation",
    environmentId: effect.environmentId,
    canonicalTargetType: "production_cell",
    canonicalTargetId: effect.targetId,
    canonicalOperation: "reserve",
    materialParameters: canonicalClone(effect.materialParameters),
  });
}

export function effectFingerprintIdentity(value: unknown): FingerprintIdentity {
  const fingerprint = validateEffectFingerprint(value);
  const canonicalBytes = canonicalSerialize(fingerprint);
  return deepFreeze({
    fingerprint,
    canonicalBytes,
    digest: `sha256:${createHash("sha256").update(canonicalBytes, "utf8").digest("hex")}`,
  });
}

export function canonicalizeApprovalScope(value: unknown): CanonicalApprovalScope {
  const scope = validateApprovalScope(value);
  const result: ApprovalScope = {
    ...scope,
    allowedEffectSchemaVersions: sortedUnique(
      scope.allowedEffectSchemaVersions,
      "scope.allowedEffectSchemaVersions",
    ),
    allowedEffectTypes: sortedUnique(
      scope.allowedEffectTypes,
      "scope.allowedEffectTypes",
    ),
    allowedTargetTypes: sortedUnique(
      scope.allowedTargetTypes,
      "scope.allowedTargetTypes",
    ),
    allowedTargetIds: sortedUnique(
      scope.allowedTargetIds,
      "scope.allowedTargetIds",
    ),
    allowedOperations: sortedUnique(
      scope.allowedOperations,
      "scope.allowedOperations",
    ),
    materialParameterConstraints: canonicalConstraintRecord(
      scope.materialParameterConstraints,
      "scope.materialParameterConstraints",
      MATERIAL_PARAMETER_KEYS,
    ),
    resourceConstraints: canonicalConstraintRecord(
      scope.resourceConstraints,
      "scope.resourceConstraints",
    ),
  };
  return deepFreeze(canonicalClone<CanonicalApprovalScope>(result));
}

export function canonicalGrantAllowanceKey(
  decisionId: string,
  selectedBundleId: string,
  scope: CanonicalApprovalScope,
  approverId: string,
): string {
  for (const [path, value] of [
    ["decisionId", decisionId],
    ["selectedBundleId", selectedBundleId],
    ["approverId", approverId],
  ] as const) {
    assertNonEmptyString(value, path);
  }
  const bytes = canonicalSerialize([
    decisionId,
    selectedBundleId,
    scope,
    approverId,
  ]);
  return `grant-allowance/sha256:${createHash("sha256")
    .update(bytes, "utf8")
    .digest("hex")}`;
}

export function approvalScopeCovers(
  scopeValue: unknown,
  occurrenceValue: unknown,
  ordinal: number,
): boolean {
  try {
    const scope = canonicalizeApprovalScope(scopeValue);
    const occurrence = validateAuthorizationOccurrence(occurrenceValue);
    const effect = validateEffectFingerprint(occurrence.effect);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) return false;
    if (
      scope.environmentId !== effect.environmentId ||
      scope.objectiveId !== occurrence.objectiveId ||
      scope.promiseBasisId !== occurrence.promiseBasisId ||
      !scope.allowedEffectSchemaVersions.includes(effect.effectSchemaVersion) ||
      !scope.allowedEffectTypes.includes(effect.effectType) ||
      !scope.allowedTargetTypes.includes(effect.targetType) ||
      !scope.allowedTargetIds.includes(effect.targetId) ||
      !scope.allowedOperations.includes(effect.operation) ||
      Date.parse(occurrence.attemptedAt) < Date.parse(scope.validFrom) ||
      Date.parse(occurrence.attemptedAt) > Date.parse(scope.validUntil) ||
      ordinal > scope.maxExecutions
    ) {
      return false;
    }
    if (
      !recordSatisfiesConstraints(
        effect.materialParameters,
        scope.materialParameterConstraints,
      )
    ) {
      return false;
    }
    return recordSatisfiesConstraints(
      occurrence.resourceClaims,
      scope.resourceConstraints,
    );
  } catch {
    return false;
  }
}

export function approvalScopeContained(
  narrowerValue: unknown,
  broaderValue: unknown,
): boolean {
  try {
    const narrower = canonicalizeApprovalScope(narrowerValue);
    const broader = canonicalizeApprovalScope(broaderValue);
    return (
      narrower.scopeSchemaVersion === broader.scopeSchemaVersion &&
      narrower.environmentId === broader.environmentId &&
      narrower.objectiveId === broader.objectiveId &&
      narrower.promiseBasisId === broader.promiseBasisId &&
      narrower.approverId === broader.approverId &&
      isSubset(narrower.allowedEffectSchemaVersions, broader.allowedEffectSchemaVersions) &&
      isSubset(narrower.allowedEffectTypes, broader.allowedEffectTypes) &&
      isSubset(narrower.allowedTargetTypes, broader.allowedTargetTypes) &&
      isSubset(narrower.allowedTargetIds, broader.allowedTargetIds) &&
      isSubset(narrower.allowedOperations, broader.allowedOperations) &&
      constraintRecordContained(
        narrower.materialParameterConstraints,
        broader.materialParameterConstraints,
      ) &&
      constraintRecordContained(
        narrower.resourceConstraints,
        broader.resourceConstraints,
      ) &&
      Date.parse(narrower.validFrom) >= Date.parse(broader.validFrom) &&
      Date.parse(narrower.validUntil) <= Date.parse(broader.validUntil) &&
      narrower.maxExecutions <= broader.maxExecutions
    );
  } catch {
    return false;
  }
}

export function approvalScopeStrictlyContained(
  narrowerValue: unknown,
  broaderValue: unknown,
): boolean {
  if (!approvalScopeContained(narrowerValue, broaderValue)) return false;
  const narrower = canonicalizeApprovalScope(narrowerValue);
  const broader = canonicalizeApprovalScope(broaderValue);
  return canonicalSerialize(narrower) !== canonicalSerialize(broader);
}

export function deniedScopePredicate(
  scopeValue: unknown,
  objectiveId: string,
): DeniedScopePredicate {
  assertNonEmptyString(objectiveId, "objectiveId");
  const scope = canonicalizeApprovalScope(scopeValue);
  if (scope.objectiveId !== objectiveId) {
    throw new StatefulInputError(
      "objectiveId",
      "must equal deniedScope.objectiveId",
    );
  }
  return deepFreeze({
    scopeSchemaVersion: "microfactory-denied-scope/v1",
    environmentId: scope.environmentId,
    allowedCanonicalEffectClasses: ["microfactory.schedule_reservation"],
    allowedCanonicalTargetTypes: ["production_cell"],
    allowedTargetIds: scope.allowedTargetIds,
    allowedCanonicalOperations: ["reserve"],
    materialParameterConstraints: scope.materialParameterConstraints,
    resourceConstraints: scope.resourceConstraints,
    objectiveId,
  });
}

export function denialPredicateMatches(
  predicateValue: unknown,
  effectValue: unknown,
  objectiveId: string,
  resourceClaims: ResourceDemand,
): boolean {
  const predicate = validateDeniedScopePredicate(predicateValue);
  const effect = normalizeEffect(effectValue);
  return (
    predicate.environmentId === effect.environmentId &&
    predicate.objectiveId === objectiveId &&
    predicate.allowedCanonicalEffectClasses.includes(effect.canonicalEffectClass) &&
    predicate.allowedCanonicalTargetTypes.includes(effect.canonicalTargetType) &&
    predicate.allowedTargetIds.includes(effect.canonicalTargetId) &&
    predicate.allowedCanonicalOperations.includes(effect.canonicalOperation) &&
    recordSatisfiesConstraints(
      effect.materialParameters,
      predicate.materialParameterConstraints,
    ) &&
    recordSatisfiesConstraints(resourceClaims, predicate.resourceConstraints)
  );
}

export function validateEffectFingerprint(value: unknown): EffectFingerprint {
  const effect = plainObject(value, "effect");
  requireExactKeys(
    effect,
    [
      "effectSchemaVersion",
      "environmentId",
      "effectType",
      "targetType",
      "targetId",
      "operation",
      "materialParameters",
    ],
    "effect",
  );
  if (!EFFECT_SCHEMA_VERSIONS.includes(effect["effectSchemaVersion"] as EffectSchemaVersion)) {
    throw new StatefulInputError("effect.effectSchemaVersion", "unsupported schema version");
  }
  for (const key of ["environmentId", "targetId"] as const) {
    assertNonEmptyString(effect[key], `effect.${key}`);
  }
  if (effect["effectType"] !== "schedule_reservation") {
    throw new StatefulInputError("effect.effectType", "unsupported effect type");
  }
  if (effect["targetType"] !== "production_cell") {
    throw new StatefulInputError("effect.targetType", "unsupported target type");
  }
  if (effect["operation"] !== "reserve") {
    throw new StatefulInputError("effect.operation", "unsupported operation");
  }
  const parameters = plainObject(effect["materialParameters"], "effect.materialParameters");
  requireExactKeys(parameters, MATERIAL_PARAMETER_KEYS, "effect.materialParameters");
  assertPositiveSafeInteger(parameters["quantity"], "effect.materialParameters.quantity");
  assertIsoTimestamp(parameters["start"], "effect.materialParameters.start");
  assertIsoTimestamp(parameters["end"], "effect.materialParameters.end");
  if (Date.parse(parameters["start"] as string) >= Date.parse(parameters["end"] as string)) {
    throw new StatefulInputError(
      "effect.materialParameters",
      "start must precede end",
    );
  }
  return deepFreeze(canonicalClone<EffectFingerprint>(effect));
}

export function validateAuthorizationOccurrence(
  value: unknown,
): AuthorizationOccurrence {
  const occurrence = plainObject(value, "occurrence");
  requireExactKeys(
    occurrence,
    [
      "effect",
      "objectiveId",
      "promiseBasisId",
      "resourceClaims",
      "attemptedAt",
      "grantId",
    ],
    "occurrence",
  );
  validateEffectFingerprint(occurrence["effect"]);
  for (const key of ["objectiveId", "promiseBasisId", "grantId"] as const) {
    assertNonEmptyString(occurrence[key], `occurrence.${key}`);
  }
  validateResourceDemand(occurrence["resourceClaims"], "occurrence.resourceClaims");
  assertIsoTimestamp(occurrence["attemptedAt"], "occurrence.attemptedAt");
  return deepFreeze(canonicalClone<AuthorizationOccurrence>(occurrence));
}

function validateApprovalScope(value: unknown): ApprovalScope {
  const scope = plainObject(value, "scope");
  requireExactKeys(
    scope,
    [
      "scopeSchemaVersion",
      "environmentId",
      "allowedEffectSchemaVersions",
      "allowedEffectTypes",
      "allowedTargetTypes",
      "allowedTargetIds",
      "allowedOperations",
      "materialParameterConstraints",
      "resourceConstraints",
      "objectiveId",
      "promiseBasisId",
      "approverId",
      "validFrom",
      "validUntil",
      "maxExecutions",
    ],
    "scope",
  );
  if (scope["scopeSchemaVersion"] !== "microfactory-approval-scope/v1") {
    throw new StatefulInputError("scope.scopeSchemaVersion", "unsupported scope schema");
  }
  for (const key of ["environmentId", "objectiveId", "promiseBasisId", "approverId"] as const) {
    assertNonEmptyString(scope[key], `scope.${key}`);
  }
  validateEnumArray(
    scope["allowedEffectSchemaVersions"],
    EFFECT_SCHEMA_VERSIONS,
    "scope.allowedEffectSchemaVersions",
  );
  validateEnumArray(
    scope["allowedEffectTypes"],
    ["schedule_reservation"],
    "scope.allowedEffectTypes",
  );
  validateEnumArray(
    scope["allowedTargetTypes"],
    ["production_cell"],
    "scope.allowedTargetTypes",
  );
  validateStringArray(scope["allowedTargetIds"], "scope.allowedTargetIds");
  validateEnumArray(scope["allowedOperations"], ["reserve"], "scope.allowedOperations");
  canonicalConstraintRecord(
    scope["materialParameterConstraints"],
    "scope.materialParameterConstraints",
    MATERIAL_PARAMETER_KEYS,
  );
  canonicalConstraintRecord(scope["resourceConstraints"], "scope.resourceConstraints");
  assertIsoTimestamp(scope["validFrom"], "scope.validFrom");
  assertIsoTimestamp(scope["validUntil"], "scope.validUntil");
  if (Date.parse(scope["validFrom"] as string) > Date.parse(scope["validUntil"] as string)) {
    throw new StatefulInputError("scope", "validFrom must not follow validUntil");
  }
  assertPositiveSafeInteger(scope["maxExecutions"], "scope.maxExecutions");
  return canonicalClone<ApprovalScope>(scope);
}

function validateDeniedScopePredicate(value: unknown): DeniedScopePredicate {
  const predicate = plainObject(value, "deniedScopePredicate");
  requireExactKeys(
    predicate,
    [
      "scopeSchemaVersion",
      "environmentId",
      "allowedCanonicalEffectClasses",
      "allowedCanonicalTargetTypes",
      "allowedTargetIds",
      "allowedCanonicalOperations",
      "materialParameterConstraints",
      "resourceConstraints",
      "objectiveId",
    ],
    "deniedScopePredicate",
  );
  if (predicate["scopeSchemaVersion"] !== "microfactory-denied-scope/v1") {
    throw new StatefulInputError("deniedScopePredicate.scopeSchemaVersion", "unsupported schema");
  }
  validateEnumArray(
    predicate["allowedCanonicalEffectClasses"],
    ["microfactory.schedule_reservation"],
    "deniedScopePredicate.allowedCanonicalEffectClasses",
  );
  validateEnumArray(
    predicate["allowedCanonicalTargetTypes"],
    ["production_cell"],
    "deniedScopePredicate.allowedCanonicalTargetTypes",
  );
  validateStringArray(predicate["allowedTargetIds"], "deniedScopePredicate.allowedTargetIds");
  validateEnumArray(
    predicate["allowedCanonicalOperations"],
    ["reserve"],
    "deniedScopePredicate.allowedCanonicalOperations",
  );
  canonicalConstraintRecord(
    predicate["materialParameterConstraints"],
    "deniedScopePredicate.materialParameterConstraints",
    MATERIAL_PARAMETER_KEYS,
  );
  canonicalConstraintRecord(
    predicate["resourceConstraints"],
    "deniedScopePredicate.resourceConstraints",
  );
  assertNonEmptyString(predicate["environmentId"], "deniedScopePredicate.environmentId");
  assertNonEmptyString(predicate["objectiveId"], "deniedScopePredicate.objectiveId");
  return canonicalClone<DeniedScopePredicate>(predicate);
}

function canonicalConstraintRecord(
  value: unknown,
  path: string,
  exactKeys?: readonly string[],
): Readonly<Record<string, TypedConstraint>> {
  const record = plainObject(value, path);
  const keys = Object.keys(record).sort(compareStableStrings);
  if (keys.length === 0) {
    throw new StatefulInputError(path, "must contain at least one explicit constraint");
  }
  if (
    exactKeys !== undefined &&
    canonicalSerialize(keys) !== canonicalSerialize([...exactKeys].sort(compareStableStrings))
  ) {
    throw new StatefulInputError(path, `must constrain exactly ${exactKeys.join(", ")}`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, canonicalConstraint(record[key], `${path}.${key}`)]),
  );
}

function canonicalConstraint(value: unknown, path: string): TypedConstraint {
  const constraint = plainObject(value, path);
  if (constraint["kind"] === "equals") {
    requireExactKeys(constraint, ["kind", "value"], path);
    validatePrimitive(constraint["value"], `${path}.value`);
    return canonicalClone<TypedConstraint>(constraint);
  }
  if (constraint["kind"] === "set") {
    requireExactKeys(constraint, ["kind", "values"], path);
    const values = arrayValue(constraint["values"], `${path}.values`);
    if (values.length === 0) throw new StatefulInputError(`${path}.values`, "must not be empty");
    values.forEach((item, index) => validatePrimitive(item, `${path}.values.${index}`));
    return {
      kind: "set",
      values: sortedUnique(values as JsonPrimitive[], `${path}.values`, canonicalSerialize),
    };
  }
  if (constraint["kind"] === "range") {
    requireExactKeys(constraint, ["kind", "minimum", "maximum"], path);
    assertFiniteNumber(constraint["minimum"], `${path}.minimum`);
    assertFiniteNumber(constraint["maximum"], `${path}.maximum`);
    if ((constraint["minimum"] as number) > (constraint["maximum"] as number)) {
      throw new StatefulInputError(path, "minimum must not exceed maximum");
    }
    return canonicalClone<TypedConstraint>(constraint);
  }
  throw new StatefulInputError(`${path}.kind`, "unsupported typed constraint");
}

function recordSatisfiesConstraints(
  values: Readonly<Record<string, JsonPrimitive | number>>,
  constraints: Readonly<Record<string, TypedConstraint>>,
): boolean {
  const valueKeys = Object.keys(values).sort(compareStableStrings);
  const constraintKeys = Object.keys(constraints).sort(compareStableStrings);
  if (canonicalSerialize(valueKeys) !== canonicalSerialize(constraintKeys)) return false;
  return valueKeys.every((key) => {
    const constraint = constraints[key];
    return constraint !== undefined && constraintContainsValue(constraint, values[key]);
  });
}

function constraintContainsValue(
  constraint: TypedConstraint,
  value: JsonPrimitive | undefined,
): boolean {
  if (value === undefined) return false;
  if (constraint.kind === "equals") {
    return canonicalSerialize(value) === canonicalSerialize(constraint.value);
  }
  if (constraint.kind === "set") {
    return constraint.values.some(
      (candidate) => canonicalSerialize(candidate) === canonicalSerialize(value),
    );
  }
  return typeof value === "number" && value >= constraint.minimum && value <= constraint.maximum;
}

function constraintRecordContained(
  narrower: Readonly<Record<string, TypedConstraint>>,
  broader: Readonly<Record<string, TypedConstraint>>,
): boolean {
  const narrowerKeys = Object.keys(narrower).sort(compareStableStrings);
  const broaderKeys = Object.keys(broader).sort(compareStableStrings);
  if (canonicalSerialize(narrowerKeys) !== canonicalSerialize(broaderKeys)) return false;
  return narrowerKeys.every((key) => {
    const left = narrower[key];
    const right = broader[key];
    return left !== undefined && right !== undefined && constraintContained(left, right);
  });
}

function constraintContained(narrower: TypedConstraint, broader: TypedConstraint): boolean {
  const narrowerValues = finiteConstraintValues(narrower);
  if (narrowerValues !== null) {
    return narrowerValues.every((value) => constraintContainsValue(broader, value));
  }
  if (narrower.kind !== "range" || broader.kind !== "range") return false;
  return narrower.minimum >= broader.minimum && narrower.maximum <= broader.maximum;
}

function finiteConstraintValues(constraint: TypedConstraint): readonly JsonPrimitive[] | null {
  if (constraint.kind === "equals") return [constraint.value];
  if (constraint.kind === "set") return constraint.values;
  return null;
}

function validateResourceDemand(value: unknown, path: string): ResourceDemand {
  const demand = plainObject(value, path);
  const keys = Object.keys(demand);
  if (keys.length === 0) throw new StatefulInputError(path, "must contain resource claims");
  for (const key of keys) {
    assertNonEmptyString(key, `${path}.resourceKey`);
    assertNonNegativeSafeInteger(demand[key], `${path}.${key}`);
  }
  return canonicalClone<ResourceDemand>(demand);
}

function validateStringArray(value: unknown, path: string): readonly string[] {
  const items = arrayValue(value, path);
  if (items.length === 0) throw new StatefulInputError(path, "must not be empty");
  items.forEach((item, index) => assertNonEmptyString(item, `${path}.${index}`));
  return sortedUnique(items as string[], path);
}

function validateEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): readonly T[] {
  const items = arrayValue(value, path);
  if (items.length === 0) throw new StatefulInputError(path, "must not be empty");
  items.forEach((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new StatefulInputError(`${path}.${index}`, "unsupported value");
    }
  });
  return sortedUnique(items as T[], path);
}

function sortedUnique<T extends string | JsonPrimitive>(
  values: readonly T[],
  path: string,
  key: (value: T) => string = (value) => String(value),
): T[] {
  const keyed = values.map((value) => ({ value, key: key(value) }));
  keyed.sort((left, right) => compareStableStrings(left.key, right.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1]?.key === keyed[index]?.key) {
      throw new StatefulInputError(path, "values must be unique");
    }
  }
  return keyed.map((item) => item.value);
}

function isSubset<T>(narrower: readonly T[], broader: readonly T[]): boolean {
  return narrower.every((value) => broader.includes(value));
}

function validatePrimitive(value: unknown, path: string): asserts value is JsonPrimitive {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    throw new StatefulInputError(path, "must be a canonical JSON primitive");
  }
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulInputError(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StatefulInputError(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new StatefulInputError(path, "must be an array");
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actualKeys = Object.keys(value).sort(compareStableStrings);
  const expectedKeys = [...expected].sort(compareStableStrings);
  if (canonicalSerialize(actualKeys) !== canonicalSerialize(expectedKeys)) {
    throw new StatefulInputError(
      path,
      `must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StatefulInputError(path, "must be a non-empty string");
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StatefulInputError(path, "must be a finite number");
  }
}

function assertPositiveSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new StatefulInputError(path, "must be a positive safe integer");
  }
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StatefulInputError(path, "must be a nonnegative safe integer");
  }
}

function assertIsoTimestamp(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new StatefulInputError(path, "must be a canonical ISO-8601 timestamp");
  }
}
