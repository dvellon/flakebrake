import { createHash } from "node:crypto";

import { canonicalSerialize, compareStableStrings } from "./canonical.js";
import type { JsonValue } from "./domain.js";

export function stableTupleId(
  kind: string,
  fields: readonly JsonValue[],
): string {
  const digest = createHash("sha256")
    .update(canonicalSerialize([kind, ...fields]), "utf8")
    .digest("hex");
  return `${kind}/sha256:${digest}`;
}

export function exactStringSequencesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStableStrings);
}
