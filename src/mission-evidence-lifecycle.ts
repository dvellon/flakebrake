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

export interface EvidenceHandleLifecycleSnapshot {
  readonly activeOperationCount: number;
  readonly retainedOperationCount: number;
  readonly ownedHandleCount: number;
  readonly closed: boolean;
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

function cleanupFailure(errors: readonly Error[]): AggregateError {
  return new AggregateError(
    errors,
    "evidence database handle cleanup failed",
  );
}

function cleanupErrorsFromUnknown(error: unknown): readonly Error[] {
  if (error instanceof AggregateError) {
    return Object.freeze(
      error.errors.map((item: unknown) =>
        item instanceof Error ? item : new Error(String(item))),
    );
  }
  return Object.freeze([
    error instanceof Error ? error : new Error(String(error)),
  ]);
}

/**
 * Internal outer owner for evidence-operation handle scopes. Each operation has
 * an isolated lower-level owner. A scope whose close fails moves from active to
 * retained ownership and remains reachable until a bounded drain closes it.
 */
export class EvidenceHandleLifecycleManager<H extends EvidenceOwnedHandle> {
  readonly #active = new Set<EvidenceHandleOwnership<H>>();
  readonly #retained = new Set<EvidenceHandleOwnership<H>>();
  #draining = false;
  #closed = false;

  public constructor(
    private readonly factory: (request: EvidenceHandleRequest) => H,
  ) {}

  public snapshot(): EvidenceHandleLifecycleSnapshot {
    return Object.freeze({
      activeOperationCount: this.#active.size,
      retainedOperationCount: this.#retained.size,
      ownedHandleCount: this.#ownedHandleCount(),
      closed: this.#closed,
    });
  }

  public run<Result>(operation: (scope: EvidenceHandleScope<H>) => Result): Result {
    if (this.#closed) {
      throw new Error("evidence handle lifecycle is closed");
    }

    // A safe subsequent operation gets exactly one bounded chance to drain
    // cleanup retained by earlier calls. Persistent failure stops acquisition.
    this.drain();

    const ownership = new EvidenceHandleOwnership<H>();
    this.#active.add(ownership);
    const scope: EvidenceHandleScope<H> = {
      acquire: (request) =>
        ownership.acquire(request.key, () => this.factory(request)),
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
    this.#active.delete(ownership);
    if (ownership.ownedCount > 0) {
      this.#retained.add(ownership);
    }

    if (operationFailed) {
      if (cleanupErrors.length > 0) {
        throw attachCleanupErrors(primaryError, cleanupErrors);
      }
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw cleanupFailure(cleanupErrors);
    }
    return result as Result;
  }

  /** Retry each retained owner once; failures remain retained and observable. */
  public drain(): void {
    if (this.#draining) {
      throw new Error("evidence handle lifecycle drain is already in progress");
    }
    if (this.#retained.size === 0) return;

    this.#draining = true;
    const errors: Error[] = [];
    try {
      for (const ownership of [...this.#retained]) {
        errors.push(...ownership.release());
        if (ownership.ownedCount === 0) {
          this.#retained.delete(ownership);
        }
      }
    } finally {
      this.#draining = false;
    }
    if (errors.length > 0) throw cleanupFailure(errors);
  }

  /** A shutdown attempt is bounded; a failed drain can be retried later. */
  public close(): void {
    if (this.#closed) return;
    if (this.#active.size > 0) {
      throw new Error("cannot close evidence handle lifecycle while operations are active");
    }
    this.drain();
    this.#closed = true;
  }

  #ownedHandleCount(): number {
    let count = 0;
    for (const ownership of this.#active) count += ownership.ownedCount;
    for (const ownership of this.#retained) count += ownership.ownedCount;
    return count;
  }
}

export function withEvidenceHandleOwnership<
  H extends EvidenceOwnedHandle,
  Result,
>(
  lifecycle: EvidenceHandleLifecycleManager<H>,
  operation: (scope: EvidenceHandleScope<H>) => Result,
): Result {
  return lifecycle.run(operation);
}

/**
 * Internal synchronous shutdown boundary used by the verifier CLI. It makes
 * one bounded retained-cleanup retry and preserves any operation error as the
 * primary error when shutdown also fails.
 */
export function withEvidenceLifecycleShutdown<
  H extends EvidenceOwnedHandle,
  Result,
>(
  lifecycle: EvidenceHandleLifecycleManager<H>,
  operation: () => Result,
): Result {
  let result: Result | undefined;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  let shutdownError: unknown;
  try {
    lifecycle.close();
  } catch (error) {
    shutdownError = error;
  }

  if (operationFailed) {
    if (shutdownError !== undefined) {
      throw attachCleanupErrors(
        primaryError,
        cleanupErrorsFromUnknown(shutdownError),
      );
    }
    throw primaryError;
  }
  if (shutdownError !== undefined) throw shutdownError;
  return result as Result;
}
