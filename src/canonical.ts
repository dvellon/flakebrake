import type { JsonValue } from "./domain.js";

export class CanonicalValueError extends TypeError {
  public constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CanonicalValueError";
  }
}

export function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$", new WeakSet<object>()));
}

export function canonicalClone<T>(value: unknown): T {
  return canonicalize(value, "$", new WeakSet<object>()) as T;
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalValueError(path, "numbers must be finite");
      }
      return value;
    case "undefined":
      throw new CanonicalValueError(path, "undefined is not canonical JSON");
    case "bigint":
    case "function":
    case "symbol":
      throw new CanonicalValueError(
        path,
        `${typeof value} is not canonical JSON`,
      );
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new CanonicalValueError(path, "cyclic values are not canonical JSON");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalValueError(path, "symbol keys are not canonical JSON");
      }
      const items: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new CanonicalValueError(
            `${path}[${index}]`,
            "sparse arrays are not canonical JSON",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new CanonicalValueError(
            `${path}[${index}]`,
            "accessor array elements are not canonical JSON",
          );
        }
        items.push(
          canonicalize(descriptor.value, `${path}[${index}]`, ancestors),
        );
      }
      const expectedKeys = new Set(
        Array.from({ length: value.length }, (_, index) => String(index)),
      );
      for (const key of Object.keys(value)) {
        if (!expectedKeys.has(key)) {
          throw new CanonicalValueError(
            `${path}.${key}`,
            "non-index array properties are not canonical JSON",
          );
        }
      }
      return items;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalValueError(path, "only plain objects are supported");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalValueError(path, "symbol keys are not canonical JSON");
    }

    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor)) {
        throw new CanonicalValueError(
          `${path}.${key}`,
          "accessor properties are not canonical JSON",
        );
      }
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareStableStrings)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new CanonicalValueError(
          `${path}.${key}`,
          "accessor properties are not canonical JSON",
        );
      }
      Object.defineProperty(result, key, {
        value: canonicalize(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
