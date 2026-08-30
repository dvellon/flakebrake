export interface EvidenceOwnedHandle {
  close(): void;
}

export interface EvidenceHandleRequest {
  readonly key: string;
  readonly path: string;
  readonly label: string;
}

export interface EvidenceHandleScope<H extends EvidenceOwnedHandle> {
  acquire(request: EvidenceHandleRequest): H;
  readonly acquiredCount: number;
  readonly closedCount: number;
  readonly ownedCount: number;
}

type OwnedEntry<H extends EvidenceOwnedHandle> = {
  readonly key: string;
  readonly handle: H;
  closed: boolean;
};

const cleanupErrorsByPrimary = new WeakMap<Error, readonly Error[]>();

class EvidenceHandleCleanupError extends Error {
  readonly handleKey: string;

  constructor(handleKey: string, cause: unknown) {
    super(`failed to close evidence database handle ${handleKey}`, { cause });
    this.name = "EvidenceHandleCleanupError";
    this.handleKey = handleKey;
  }
}

/**
 * Internal ownership boundary for handles used by a single evidence operation.
 * A handle is registered immediately after its factory returns successfully.
 */
export class EvidenceHandleOwnership<H extends EvidenceOwnedHandle> {
  readonly #entries: OwnedEntry<H>[] = [];
  #closedCount = 0;
  #releasing = false;
  #sealed = false;

  get acquiredCount(): number {
    return this.#entries.length;
  }

  get closedCount(): number {
    return this.#closedCount;
  }

  get ownedCount(): number {
    return this.#entries.reduce(
      (count, entry) => count + (entry.closed ? 0 : 1),
      0,
    );
  }

  acquire(key: string, factory: () => H): H {
    if (this.#sealed) {
      throw new Error("evidence handle ownership is already sealed");
    }
    if (this.#entries.some((entry) => entry.key === key)) {
      throw new Error(`duplicate evidence database handle key ${key}`);
    }

    // The factory must return before ownership is recorded. A constructor/open
    // failure therefore cannot be misreported as an operation-owned handle.
    const handle = factory();
    this.#entries.push({ key, handle, closed: false });
    return handle;
  }

  /**
   * Close every still-owned handle in reverse acquisition order. Failed closes
   * remain owned so a caller holding this internal object can retry cleanup;
   * handles already closed successfully are never closed twice.
   */
  release(): readonly Error[] {
    if (this.#releasing) {
      throw new Error("evidence handle cleanup is already in progress");
    }

    this.#sealed = true;
    this.#releasing = true;
    const errors: Error[] = [];
    try {
      for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
        const entry = this.#entries[index];
        if (entry === undefined || entry.closed) {
          continue;
        }
        try {
          entry.handle.close();
          entry.closed = true;
          this.#closedCount += 1;
        } catch (error) {
          errors.push(new EvidenceHandleCleanupError(entry.key, error));
        }
      }
    } finally {
      this.#releasing = false;
    }
    return Object.freeze(errors);
  }
}

export function evidenceCleanupErrors(error: unknown): readonly Error[] {
  if (!(error instanceof Error)) {
    return [];
  }
  return cleanupErrorsByPrimary.get(error) ?? [];
}

function attachCleanupErrors(
  primaryError: unknown,
  cleanupErrors: readonly Error[],
): unknown {
  if (primaryError instanceof Error) {
    const existing = evidenceCleanupErrors(primaryError);
    cleanupErrorsByPrimary.set(
      primaryError,
      Object.freeze([...existing, ...cleanupErrors]),
    );
    return primaryError;
  }

  return new AggregateError(
    [primaryError, ...cleanupErrors],
    "evidence operation and database cleanup both failed",
  );
}

export function withEvidenceHandleOwnership<
  H extends EvidenceOwnedHandle,
  Result,
>(
  factory: (request: EvidenceHandleRequest) => H,
  operation: (scope: EvidenceHandleScope<H>) => Result,
): Result {
  const ownership = new EvidenceHandleOwnership<H>();
  const scope: EvidenceHandleScope<H> = {
    acquire(request) {
      return ownership.acquire(request.key, () => factory(request));
    },
    get acquiredCount() {
      return ownership.acquiredCount;
    },
    get closedCount() {
      return ownership.closedCount;
    },
    get ownedCount() {
      return ownership.ownedCount;
    },
  };

  let result: Result | undefined;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    result = operation(scope);
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  const cleanupErrors = ownership.release();
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw attachCleanupErrors(primaryError, cleanupErrors);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "evidence database handle cleanup failed",
    );
  }
  return result as Result;
}
