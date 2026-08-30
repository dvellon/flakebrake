interface OwnedResource {
  readonly close: () => Promise<void>;
  closeFailureReported: boolean;
}

export interface M4RunnerLifecycleError extends Error {
  readonly cleanupFailures: readonly unknown[];
}

const CLEANUP_FAILURE_SOURCES = new WeakMap<Error, (readonly unknown[])[]>();

/**
 * Invocation-local ownership for the deterministic M4 runner. It deliberately
 * handles only the runner's linear acquisition stack and abortable waits.
 */
export class DeterministicM4RunnerOwnership {
  readonly #signal: AbortSignal | undefined;
  readonly #owned: OwnedResource[] = [];
  readonly #cleanupFailures: unknown[] = [];
  #closePromise: Promise<readonly unknown[]> | undefined;
  #closing = false;

  public constructor(signal?: AbortSignal) {
    this.#signal = signal;
  }

  public get cleanupFailures(): readonly unknown[] {
    return this.#cleanupFailures;
  }

  public throwIfAborted(): void {
    if (this.#signal?.aborted === true) throw abortReason(this.#signal);
  }

  public own<T>(resource: T, close: (resource: T) => Promise<void> | void): T {
    if (this.#closing) {
      throw new Error("Deterministic M4 runner ownership is already closed");
    }
    this.throwIfAborted();
    this.#owned.push(ownedResource(resource, close));
    return resource;
  }

  public async acquire<T>(
    acquire: () => Promise<T>,
    close: (resource: T) => Promise<void> | void,
  ): Promise<T> {
    return this.wait(async () => {
      const resource = await acquire();
      const owned = ownedResource(resource, close);
      if (this.#closing || this.#signal?.aborted === true) {
        await this.#closeOwned(owned);
        if (this.#signal?.aborted === true) throw abortReason(this.#signal);
        throw new Error("Deterministic M4 acquisition settled after teardown");
      }
      this.#owned.push(owned);
      return resource;
    });
  }

  public async wait<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.#signal;
    if (signal === undefined) return operation();
    if (signal.aborted) throw abortReason(signal);

    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => rejectAbort?.(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error: unknown) {
      signal.removeEventListener("abort", onAbort);
      throw error;
    }
    try {
      // Promise.race installs handlers on pending, so a post-abort rejection is
      // still observed even after the abort branch wins.
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  public close(): Promise<readonly unknown[]> {
    this.#closePromise ??= this.#closeAll();
    return this.#closePromise;
  }

  async #closeAll(): Promise<readonly unknown[]> {
    this.#closing = true;
    for (let index = this.#owned.length - 1; index >= 0; index -= 1) {
      const owned = this.#owned[index];
      if (owned !== undefined) await this.#closeOwned(owned);
    }
    return this.#cleanupFailures;
  }

  async #closeOwned(owned: OwnedResource): Promise<void> {
    try {
      await owned.close();
    } catch (error: unknown) {
      if (!owned.closeFailureReported) {
        owned.closeFailureReported = true;
        this.#cleanupFailures.push(error);
      }
    }
  }
}

export function retainM4RunnerCleanupDiagnostics(
  error: Error,
  cleanupFailures: readonly unknown[],
): M4RunnerLifecycleError {
  const sources = CLEANUP_FAILURE_SOURCES.get(error) ?? [];
  if (!sources.includes(cleanupFailures)) sources.push(cleanupFailures);
  CLEANUP_FAILURE_SOURCES.set(error, sources);
  if (!("cleanupFailures" in error) && Object.isExtensible(error)) {
    Object.defineProperty(error, "cleanupFailures", {
      configurable: false,
      enumerable: false,
      get: () => m4RunnerCleanupFailures(error),
    });
  }
  return error as M4RunnerLifecycleError;
}

export function m4RunnerCleanupFailures(error: Error): readonly unknown[] {
  return (CLEANUP_FAILURE_SOURCES.get(error) ?? []).flatMap((source) => source);
}

function ownedResource<T>(
  resource: T,
  close: (resource: T) => Promise<void> | void,
): OwnedResource {
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= Promise.resolve().then(() => close(resource));
      return closePromise;
    },
    closeFailureReported: false,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
