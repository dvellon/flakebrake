import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

interface OwnedResource {
  readonly close: () => Promise<void>;
  closeFailureReported: boolean;
}

export interface M4RunnerLifecycleError extends Error {
  readonly cleanupFailures: readonly unknown[];
}

const CLEANUP_FAILURE_SOURCES = new WeakMap<Error, (readonly unknown[])[]>();

interface OwnedHttpHandler {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly cancellation: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  forcedDrainReason?: Error;
}

interface OwnedHttpSocket {
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly observeError: (error: Error) => void;
}

export interface OwnedHttpServerLifecycleOptions {
  readonly signal?: AbortSignal;
  readonly drainTimeoutMs: number;
  readonly forceSettlementTimeoutMs: number;
  readonly incompleteRequestMessage: string;
  readonly closeFailureMessage: string;
}

type ListenerState = "idle" | "starting" | "listening" | "failed" | "stopped";

/**
 * One invocation-local owner for a listening HTTP server, its handlers, and
 * every accepted socket. Abort and explicit teardown always join the same
 * retryable close attempt.
 */
export class OwnedHttpServerLifecycle {
  readonly #server: Server;
  readonly #options: OwnedHttpServerLifecycleOptions;
  readonly #handlers = new Set<OwnedHttpHandler>();
  readonly #sockets = new Map<Socket, OwnedHttpSocket>();
  readonly #cleanupDiagnostics: unknown[] = [];
  readonly #transportFailures: unknown[] = [];
  #listenerState: ListenerState = "idle";
  #underlyingListenSettled: Promise<void> = Promise.resolve();
  #rejectStartupAbort: ((reason: unknown) => void) | undefined;
  #abortListener: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #serverStopPromise: Promise<void> | undefined;
  #serverCloseObserved = false;
  #closing = false;
  #closed = false;

  public constructor(server: Server, options: OwnedHttpServerLifecycleOptions) {
    this.#server = server;
    this.#options = options;
    server.on("connection", this.#trackSocket);
    server.once("close", this.#observeServerClose);
  }

  public get closing(): boolean {
    return this.#closing;
  }

  public listen(host: string, port: number): Promise<void> {
    if (this.#listenerState !== "idle") {
      throw new Error("HTTP server lifecycle listen may only be called once");
    }
    const signal = this.#options.signal;
    this.#listenerState = "starting";
    let settleUnderlying: (() => void) | undefined;
    this.#underlyingListenSettled = new Promise<void>((resolve) => {
      settleUnderlying = resolve;
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      this.#rejectStartupAbort = reject;
    });
    this.#armAbort(signal);
    if (signal?.aborted === true) {
      this.#listenerState = "failed";
      settleUnderlying?.();
      return aborted.finally(() => {
        this.#rejectStartupAbort = undefined;
      });
    }
    const underlying = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        this.#listenerState = "failed";
        settleUnderlying?.();
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        this.#listenerState = "listening";
        settleUnderlying?.();
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      try {
        this.#server.listen({ host, port });
      } catch (error: unknown) {
        this.#server.off("error", onError);
        this.#server.off("listening", onListening);
        this.#listenerState = "failed";
        settleUnderlying?.();
        reject(error);
      }
    });
    // The underlying listener result remains observed if abort wins first.
    void underlying.catch(() => undefined);
    return Promise.race([underlying, aborted]).finally(() => {
      this.#rejectStartupAbort = undefined;
    });
  }

  public runHandler(
    request: IncomingMessage,
    response: ServerResponse,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const handler: OwnedHttpHandler = {
      request,
      response,
      cancellation: new AbortController(),
      done,
      resolveDone: () => resolveDone?.(),
    };
    this.#handlers.add(handler);
    return Promise.resolve()
      .then(() => operation(handler.cancellation.signal))
      .finally(() => {
        this.#handlers.delete(handler);
        handler.resolveDone();
      });
  }

  public close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    const attempt = this.#closeAttempt();
    this.#closePromise = attempt;
    void attempt.then(
      () => {
        this.#closed = true;
        this.#disarmAbort();
      },
      () => {
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      },
    );
    return attempt;
  }

  async #closeAttempt(): Promise<void> {
    const failures: unknown[] = [];
    const stopped = this.#stopAdmission();
    try {
      this.#server.closeIdleConnections();
    } catch (error: unknown) {
      failures.push(error);
    }

    const drained = await waitForOwnedSettlement(
      () => [...this.#handlers].map((handler) => handler.done),
      this.#options.drainTimeoutMs,
    );
    if (!drained) {
      for (const handler of this.#handlers) {
        const reason =
          handler.forcedDrainReason ??
          new Error(this.#options.incompleteRequestMessage);
        handler.forcedDrainReason = reason;
        if (!handler.cancellation.signal.aborted) {
          this.#recordCleanupDiagnostic(reason);
          handler.cancellation.abort(reason);
        }
        // The reason is retained on the owned handler signal and, for runner
        // cancellation, on the primary error's cleanup diagnostics. It must
        // not be injected into EventEmitter streams that may have no error
        // observer at this lifecycle boundary.
        handler.request.destroy();
        handler.response.destroy();
      }
    }

    try {
      this.#server.closeAllConnections();
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const socket of this.#sockets.keys()) socket.destroy();

    const handlersSettled = await waitForOwnedSettlement(
      () => [...this.#handlers].map((handler) => handler.done),
      this.#options.forceSettlementTimeoutMs,
    );
    const socketsSettled = await waitForOwnedSettlement(
      () => [...this.#sockets.values()].map((socket) => socket.done),
      this.#options.forceSettlementTimeoutMs,
    );
    let stopFailure: unknown;
    try {
      await stopped;
    } catch (error: unknown) {
      stopFailure = error;
    }
    if (
      stopFailure !== undefined &&
      !(
        isServerNotRunningError(stopFailure) &&
        this.#serverCloseObserved &&
        this.#handlers.size === 0 &&
        this.#sockets.size === 0
      )
    ) {
      failures.push(stopFailure);
    }
    if (!handlersSettled || this.#handlers.size > 0) {
      failures.push(
        new Error(
          `HTTP server teardown retained ${String(this.#handlers.size)} handler(s)`,
        ),
      );
    }
    if (!socketsSettled || this.#sockets.size > 0) {
      failures.push(
        new Error(
          `HTTP server teardown retained ${String(this.#sockets.size)} socket(s)`,
        ),
      );
    }
    failures.push(...this.#transportFailures.splice(0));
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, this.#options.closeFailureMessage);
    }
    this.#listenerState = "stopped";
  }

  #stopAdmission(): Promise<void> {
    if (this.#serverStopPromise !== undefined) return this.#serverStopPromise;
    const attempt = this.#stopAdmissionAttempt();
    this.#serverStopPromise = attempt;
    void attempt.catch(() => {
      if (this.#serverStopPromise === attempt) this.#serverStopPromise = undefined;
    });
    return attempt;
  }

  async #stopAdmissionAttempt(): Promise<void> {
    if (this.#listenerState === "starting") {
      await this.#underlyingListenSettled;
    }
    if (
      this.#listenerState === "idle" ||
      this.#listenerState === "failed" ||
      this.#listenerState === "stopped" ||
      this.#serverCloseObserved
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      try {
        this.#server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error: unknown) {
        reject(error);
      }
    });
  }

  #armAbort(signal: AbortSignal | undefined): void {
    if (signal === undefined || this.#abortListener !== undefined) return;
    const onAbort = (): void => {
      this.#closing = true;
      this.#rejectStartupAbort?.(abortReason(signal));
      // This observer prevents an abort-triggered cleanup rejection from
      // becoming unhandled. A concurrent explicit close joins this attempt;
      // a later close retries after failure.
      void this.close().catch(() => undefined);
    };
    this.#abortListener = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  #disarmAbort(): void {
    if (this.#abortListener === undefined) return;
    this.#options.signal?.removeEventListener("abort", this.#abortListener);
    this.#abortListener = undefined;
  }

  readonly #trackSocket = (socket: Socket): void => {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const observeError = (error: Error): void => {
      this.#transportFailures.push(error);
    };
    const owned: OwnedHttpSocket = {
      done,
      resolveDone: () => resolveDone?.(),
      observeError,
    };
    this.#sockets.set(socket, owned);
    socket.on("error", observeError);
    socket.once("close", () => {
      socket.off("error", owned.observeError);
      this.#sockets.delete(socket);
      owned.resolveDone();
    });
    if (this.#closing) socket.destroy();
  };

  #recordCleanupDiagnostic(reason: Error): void {
    this.#cleanupDiagnostics.push(reason);
    const primary = this.#options.signal?.reason;
    if (primary instanceof Error) {
      retainM4RunnerCleanupDiagnostics(primary, this.#cleanupDiagnostics);
    }
  }

  readonly #observeServerClose = (): void => {
    this.#serverCloseObserved = true;
    this.#listenerState = "stopped";
  };
}

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

async function waitForOwnedSettlement(
  owned: () => readonly Promise<void>[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (owned().length > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const settled = await settlesBefore(
      Promise.allSettled(owned()).then(() => undefined),
      remaining,
    );
    if (!settled) return false;
  }
  return true;
}

function settlesBefore(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isServerNotRunningError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code ===
      "ERR_SERVER_NOT_RUNNING"
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
