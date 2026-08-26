import { compareStableStrings } from "./canonical.js";

export type PartialPreference =
  | "left_preferred"
  | "right_preferred"
  | "equivalent"
  | "incomparable";

export class PreferenceCycleError extends TypeError {
  public constructor() {
    super("The semantic candidate preference relation contains a cycle");
    this.name = "PreferenceCycleError";
  }
}

export function nondominatedFrontierLayers<T>(
  input: readonly T[],
  compare: (left: T, right: T) => PartialPreference,
  stableId: (value: T) => string,
): readonly (readonly T[])[] {
  const items = [...input];
  const ids = items.map(stableId);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Candidate stable IDs must be unique");
  }

  const preferredOver = items.map(() => new Set<number>());
  const incoming = items.map(() => 0);
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex];
    if (left === undefined) throw new Error(`Missing candidate ${leftIndex}`);
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < items.length;
      rightIndex += 1
    ) {
      const right = items[rightIndex];
      if (right === undefined) throw new Error(`Missing candidate ${rightIndex}`);
      const relation = compare(left, right);
      if (relation === "left_preferred") {
        preferredOver[leftIndex]?.add(rightIndex);
        incoming[rightIndex] = (incoming[rightIndex] ?? 0) + 1;
      } else if (relation === "right_preferred") {
        preferredOver[rightIndex]?.add(leftIndex);
        incoming[leftIndex] = (incoming[leftIndex] ?? 0) + 1;
      }
    }
  }

  const remaining = new Set(items.map((_, index) => index));
  const layers: T[][] = [];
  while (remaining.size > 0) {
    const layerIndices = [...remaining]
      .filter((index) => incoming[index] === 0)
      .sort((left, right) =>
        compareStableStrings(ids[left] as string, ids[right] as string),
      );
    if (layerIndices.length === 0) throw new PreferenceCycleError();

    const layer: T[] = [];
    for (const index of layerIndices) {
      const item = items[index];
      if (item === undefined) throw new Error(`Missing candidate ${index}`);
      layer.push(item);
      remaining.delete(index);
      for (const dominatedIndex of preferredOver[index] ?? []) {
        incoming[dominatedIndex] = (incoming[dominatedIndex] ?? 0) - 1;
      }
    }
    layers.push(layer);
  }
  return layers;
}
