import { AsyncLocalStorage } from "node:async_hooks";

import type { SyntheticMutationResult } from "./factory-environment.js";

export const RECOVERY_DEMO_FACTORY_BOUNDARY =
  "after_factory_commit_before_m2_binding" as const;

interface RecoveryDemoScope {
  readonly boundary: typeof RECOVERY_DEMO_FACTORY_BOUNDARY;
  readonly executionAttemptId: string;
  armed: boolean;
}

const ACTIVE_RECOVERY_DEMO = new AsyncLocalStorage<RecoveryDemoScope>();

/**
 * Internal deterministic-demo scope. This module is intentionally omitted from
 * the public barrel: normal executors cannot arm the demonstration seam.
 */
export function runWithRecoveryDemoFactoryInterruption<T>(
  executionAttemptId: string,
  operation: () => T,
): T {
  const scope: RecoveryDemoScope = {
    boundary: RECOVERY_DEMO_FACTORY_BOUNDARY,
    executionAttemptId,
    armed: true,
  };
  return ACTIVE_RECOVERY_DEMO.run(scope, () => {
    try {
      return operation();
    } finally {
      // Async resources may retain an AsyncLocalStorage context. Clearing this
      // invocation-owned arm makes every retained or restored context inert.
      scope.armed = false;
    }
  });
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
  const scope = ACTIVE_RECOVERY_DEMO.getStore();
  if (
    scope?.boundary !== RECOVERY_DEMO_FACTORY_BOUNDARY ||
    !scope.armed ||
    scope.executionAttemptId !== result.executionAttemptId
  ) {
    return;
  }
  scope.armed = false;
  throw new RecoveryDemoFactoryInterruption(result);
}
