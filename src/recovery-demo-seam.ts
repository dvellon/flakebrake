import { AsyncLocalStorage } from "node:async_hooks";

import type { SyntheticMutationResult } from "./factory-environment.js";

export const RECOVERY_DEMO_FACTORY_BOUNDARY =
  "after_factory_commit_before_m2_binding" as const;

interface RecoveryDemoScope {
  readonly boundary: typeof RECOVERY_DEMO_FACTORY_BOUNDARY;
}

const ACTIVE_RECOVERY_DEMO = new AsyncLocalStorage<RecoveryDemoScope>();

/**
 * Internal deterministic-demo scope. This module is intentionally omitted from
 * the public barrel: normal executors cannot arm the demonstration seam.
 */
export function runWithRecoveryDemoFactoryInterruption<T>(
  operation: () => T,
): T {
  return ACTIVE_RECOVERY_DEMO.run(
    { boundary: RECOVERY_DEMO_FACTORY_BOUNDARY },
    operation,
  );
}

export class RecoveryDemoFactoryInterruption extends Error {
  public constructor(public readonly result: SyntheticMutationResult) {
    super(
      "Deterministic recovery demonstration reached the durable factory-commit boundary",
    );
    this.name = "RecoveryDemoFactoryInterruption";
  }
}

export function reachRecoveryDemoFactoryCommitBoundary(
  result: SyntheticMutationResult,
): void {
  if (ACTIVE_RECOVERY_DEMO.getStore()?.boundary !== RECOVERY_DEMO_FACTORY_BOUNDARY) {
    return;
  }
  throw new RecoveryDemoFactoryInterruption(result);
}
