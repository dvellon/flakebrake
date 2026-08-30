export interface RecoveryBrowserCleanupAction {
  readonly name: "browser" | "server" | "directory";
  run(): void | Promise<void>;
}

export type RecoveryBrowserCleanup = () => Promise<void>;

export function createRecoveryBrowserCleanup(
  actions: readonly RecoveryBrowserCleanupAction[],
): RecoveryBrowserCleanup {
  let cleanup: Promise<void> | null = null;
  return () => {
    cleanup ??= (async () => {
      const failures: { readonly name: string; readonly error: unknown }[] = [];
      for (const action of actions) {
        try {
          await action.run();
        } catch (error: unknown) {
          failures.push({ name: action.name, error });
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.error),
          `Recovery browser cleanup failed: ${failures
            .map((failure) => `${failure.name}: ${String(failure.error)}`)
            .join("; ")}`,
        );
      }
    })();
    return cleanup;
  };
}

export async function finishRecoveryBrowserSmoke(
  primaryError: unknown | null,
  cleanup: RecoveryBrowserCleanup,
): Promise<void> {
  let cleanupError: unknown | null = null;
  try {
    await cleanup();
  } catch (error: unknown) {
    cleanupError = error;
  }
  if (primaryError !== null) {
    if (cleanupError !== null) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors as unknown[]
        : [cleanupError];
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Recovery browser smoke and cleanup failed",
        { cause: primaryError instanceof Error ? primaryError : undefined },
      );
    }
    throw primaryError;
  }
  if (cleanupError !== null) throw cleanupError;
}
