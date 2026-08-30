import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { canonicalSerialize } from "../src/canonical.js";
import {
  readAdversarialChallengeLab,
  runAdversarialChallengeLab,
} from "../src/challenge-lab.js";
import type { SyntheticMutationResult } from "../src/factory-environment.js";
import {
  RECOVERY_DEMO_ATTEMPT_ID,
  interruptRecoveryDemonstration,
  recoverRecoveryDemonstration,
  replayCompletedRecoveryDemonstration,
  restartRecoveryDemonstration,
} from "../src/index.js";
import {
  RecoveryDemoFactoryInterruption,
  reachRecoveryDemoFactoryCommitBoundary,
  runWithRecoveryDemoFactoryInterruption,
} from "../src/recovery-demo-seam.js";

const FACTORY_BOUNDARY = "after_factory_commit_before_m2_binding" as const;

describe("challenge and recovery scope isolation", { concurrency: false }, () => {
  test("challenge and recovery cannot activate or contaminate each other", async () => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-challenge-recovery-"));
    try {
      // An armed recovery scope is bound to the recovery demo's own attempt
      // identity: challenge attempt identities never trigger it, the matching
      // identity triggers it exactly once, and the disarmed scope is inert.
      runWithRecoveryDemoFactoryInterruption(RECOVERY_DEMO_ATTEMPT_ID, () => {
        assert.doesNotThrow(() =>
          reachRecoveryDemoFactoryCommitBoundary({
            executionAttemptId: "attempt/challenge-valid-replay",
          } as SyntheticMutationResult),
        );
        assert.throws(
          () =>
            reachRecoveryDemoFactoryCommitBoundary({
              executionAttemptId: RECOVERY_DEMO_ATTEMPT_ID,
            } as SyntheticMutationResult),
          (error: unknown) => error instanceof RecoveryDemoFactoryInterruption,
        );
        assert.doesNotThrow(() =>
          reachRecoveryDemoFactoryCommitBoundary({
            executionAttemptId: RECOVERY_DEMO_ATTEMPT_ID,
          } as SyntheticMutationResult),
        );
      });

      // The complete challenge lab traverses the factory adapter's recovery
      // commit boundary for every real mutation and completes untouched,
      // because nothing outside the recovery demo can arm the seam.
      const challengeRoot = join(root, "challenge");
      mkdirSync(challengeRoot, { mode: 0o700 });
      writeFileSync(
        join(challengeRoot, ".flakebrake-m5-owned-v1"),
        "flakebrake-m5-judge-state/v1\n",
        { mode: 0o600 },
      );
      const challengeResult = await runAdversarialChallengeLab(challengeRoot);
      assert.equal(challengeResult.complete, true);
      assert.equal(challengeResult.allPassed, true);
      const challengeExpected = canonicalSerialize(challengeResult);

      // A full recovery demonstration at the shared factory-adapter boundary
      // converges in the same process after the challenge lab ran, so
      // challenge execution leaves no process-global seam or adapter state.
      const recoveryRoot = join(root, "recovery");
      mkdirSync(recoveryRoot, { recursive: true });
      const recoveryPaths = {
        m2DatabasePath: join(recoveryRoot, "m2.sqlite"),
        factoryDatabasePath: join(recoveryRoot, "factory.sqlite"),
      };
      const interrupted = interruptRecoveryDemonstration(recoveryPaths, FACTORY_BOUNDARY);
      assert.equal(interrupted.counts.mutations, 1);
      assert.equal(interrupted.counts.terminalEvents, 0);
      const restarted = restartRecoveryDemonstration(recoveryPaths, FACTORY_BOUNDARY);
      assert.equal(restarted.durableStateDigest, interrupted.durableStateDigest);
      const recovered = recoverRecoveryDemonstration(recoveryPaths, FACTORY_BOUNDARY);
      assert.deepEqual(recovered.counts, {
        acceptances: 1,
        attempts: 1,
        fences: 1,
        fenceBindings: 1,
        mutations: 1,
        receipts: 1,
        terminalEvents: 1,
        terminalFailures: 0,
        actualConsumptionFacts: 2,
      });
      assert.equal(recovered.mixedTerminalFailureAndMutation, false);
      assert.equal(
        replayCompletedRecoveryDemonstration(recoveryPaths, FACTORY_BOUNDARY)
          .durableStateUnchanged,
        true,
      );

      // Recovery activity did not contaminate the durable challenge evidence:
      // restart replay still returns the exact pre-recovery representation.
      assert.equal(
        canonicalSerialize(readAdversarialChallengeLab(challengeRoot)),
        challengeExpected,
      );

      // File-scope isolation: each root holds only its own artifacts.
      assert.deepEqual(readdirSync(challengeRoot).sort(), [
        ".flakebrake-m5-owned-v1",
        "challenge-lab-v1",
      ]);
      const recoveryEntries = readdirSync(recoveryRoot);
      assert.equal(
        recoveryEntries.some((entry) => entry.includes("challenge")),
        false,
      );
      assert.equal(
        recoveryEntries.every((entry) => entry.startsWith("m2.sqlite") || entry.startsWith("factory.sqlite")),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
