import type { Rational } from "./domain.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

function safeNumber(value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw new RangeError("Exact rational arithmetic exceeded Number.MAX_SAFE_INTEGER");
  }

  return Number(value);
}

export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new TypeError("Rational components must be safe integers");
  }
  if (denominator <= 0) {
    throw new RangeError("A rational denominator must be positive");
  }

  const normalizedNumerator = BigInt(numerator);
  const normalizedDenominator = BigInt(denominator);

  const divisor = greatestCommonDivisor(
    normalizedNumerator,
    normalizedDenominator,
  );

  return {
    numerator: safeNumber(normalizedNumerator / divisor),
    denominator: safeNumber(normalizedDenominator / divisor),
  };
}

export function normalizeRational(value: unknown): Rational {
  validateCanonicalRational(value, "rational");
  return rational(value.numerator, value.denominator);
}

export function validateCanonicalRational(
  value: unknown,
  path: string,
): asserts value is Rational {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path}: must be a rational object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path}: must be a plain rational object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "denominator" || keys[1] !== "numerator") {
    throw new TypeError(`${path}: must contain exactly numerator and denominator`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path}: rational symbol keys are invalid`);
  }
  const candidate = value as Partial<Rational>;
  if (
    !Number.isSafeInteger(candidate.numerator) ||
    !Number.isSafeInteger(candidate.denominator)
  ) {
    throw new TypeError(`${path}: rational components must be safe integers`);
  }
  if ((candidate.denominator as number) <= 0) {
    throw new RangeError(`${path}: rational denominator must be positive`);
  }
  const normalized = rational(
    candidate.numerator as number,
    candidate.denominator as number,
  );
  if (
    normalized.numerator !== candidate.numerator ||
    normalized.denominator !== candidate.denominator
  ) {
    throw new TypeError(`${path}: rational must be gcd-normalized`);
  }
}

export function addRational(left: Rational, right: Rational): Rational {
  return rationalFromBigInts(
    BigInt(left.numerator) * BigInt(right.denominator) +
      BigInt(right.numerator) * BigInt(left.denominator),
    BigInt(left.denominator) * BigInt(right.denominator),
  );
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rationalFromBigInts(
    BigInt(left.numerator) * BigInt(right.denominator) -
      BigInt(right.numerator) * BigInt(left.denominator),
    BigInt(left.denominator) * BigInt(right.denominator),
  );
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rationalFromBigInts(
    BigInt(left.numerator) * BigInt(right.numerator),
    BigInt(left.denominator) * BigInt(right.denominator),
  );
}

export function divideRational(left: Rational, right: Rational): Rational {
  if (right.numerator === 0) {
    throw new RangeError("Cannot divide by zero");
  }

  return rationalFromBigInts(
    BigInt(left.numerator) * BigInt(right.denominator),
    BigInt(left.denominator) * BigInt(right.numerator),
  );
}

export function compareRational(left: Rational, right: Rational): number {
  const difference =
    BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function rationalFromBigInts(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new RangeError("A rational denominator cannot be zero");
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }

  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: safeNumber(numerator / divisor),
    denominator: safeNumber(denominator / divisor),
  };
}
