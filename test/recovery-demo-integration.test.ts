import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import * as publicApi from "../src/index.js";
import {
  M4_HERO_MISSION_ID,
  M5DemoCoordinator,
  M5RequestError,
  RECOVERY_DEMO_ATTEMPT_ID,
  exportMissionEvidenceBundle,
  interruptRecoveryDemonstration,
  recoverRecoveryDemonstration,
  replayCompletedRecoveryDemonstration,
  restartRecoveryDemonstration,
  runDeterministicM4Mission,
  type RecoveryDemoBoundary,
  type RecoveryDemoPaths,
} from "../src/index.js";
import { reachRecoveryDemoFactoryCommitBoundary } from "../src/recovery-demo-seam.js";
import type { SyntheticMutationResult } from "../src/factory-environment.js";

const BOUNDARIES = [
  "after_execution_fence_before_factory_mutation",
  "after_factory_commit_before_m2_binding",
] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Recovery Lab integration isolation", { concurrency: false }, () => {
  test("both boundaries converge without changing an idle M5 owner or arming the factory seam", async () => {
    const root = fixtureRoot();
    const m5 = new M5DemoCoordinator({
      dataRoot: join(root, "normal-m5"),
      cleanupDataOnClose: false,
    });
    const normalBefore = m5.state();
    try {
      assert.equal(Object.hasOwn(publicApi, "runWithRecoveryDemoFactoryInterruption"), false);
      assert.doesNotThrow(() =>
        reachRecoveryDemoFactoryCommitBoundary({
          executionAttemptId: "attempt/ordinary-integration",
        } as SyntheticMutationResult),
      );

      for (const boundary of BOUNDARIES) {
        const paths = recoveryPaths(root, boundary);
        const interrupted = interruptRecoveryDemonstration(paths, boundary);
        assert.equal(interrupted.counts.acceptances, 1);
        assert.equal(interrupted.counts.attempts, 1);
        assert.equal(interrupted.counts.fences, 1);
        assert.equal(interrupted.counts.fenceBindings, 0);
        assert.equal(interrupted.counts.mutations, boundary === BOUNDARIES[1] ? 1 : 0);
        assert.equal(interrupted.counts.receipts, interrupted.counts.mutations);
        assert.equal(interrupted.counts.terminalEvents, 0);
        assert.equal(interrupted.counts.terminalFailures, 0);
        assert.equal(interrupted.counts.actualConsumptionFacts, 0);
        assert.equal(interrupted.mixedTerminalFailureAndMutation, false);

        const restarted = restartRecoveryDemonstration(paths, boundary);
        assert.equal(restarted.durableStateDigest, interrupted.durableStateDigest);
        assert.deepEqual(restarted.counts, interrupted.counts);

        const recovered = recoverRecoveryDemonstration(paths, boundary);
        assert.deepEqual(recovered.counts, expectedTerminalCounts());
        assert.equal(recovered.mixedTerminalFailureAndMutation, false);

        const replayed = replayCompletedRecoveryDemonstration(paths, boundary);
        assert.deepEqual(replayed.counts, recovered.counts);
        assert.equal(replayed.durableStateDigest, recovered.durableStateDigest);
        assert.equal(replayed.durableStateUnchanged, true);
      }

      assert.deepEqual(m5.state(), normalBefore);
      assert.throws(
        () => m5.evidenceBundle(),
        (error: unknown) => error instanceof M5RequestError && error.code === "evidence_not_ready",
      );
      assert.doesNotThrow(() =>
        reachRecoveryDemoFactoryCommitBoundary({
          executionAttemptId: "attempt/ordinary-after-recovery",
        } as SyntheticMutationResult),
      );
    } finally {
      await m5.close();
    }
  });

  test("Recovery databases cannot alter a completed canonical Mission Evidence Bundle", async () => {
    const root = fixtureRoot();
    const normalRoot = join(root, "normal-mission");
    mkdirSync(normalRoot, { recursive: true });
    const missionOptions = {
      missionId: M4_HERO_MISSION_ID,
      m2DatabasePath: join(normalRoot, "m2.sqlite"),
      factoryDatabasePath: join(normalRoot, "factory.sqlite"),
      missionDatabasePath: join(normalRoot, "mission.sqlite"),
      trueforgeDatabasePath: join(normalRoot, "trueforge.sqlite"),
      localSandboxRootParent: join(normalRoot, "trueforge-data"),
    } as const;

    await runDeterministicM4Mission(missionOptions);
    const before = exportMissionEvidenceBundle(missionOptions);
    assert.equal(before.includes(RECOVERY_DEMO_ATTEMPT_ID), false);

    for (const boundary of BOUNDARIES) {
      const paths = recoveryPaths(root, `evidence-${boundary}`);
      interruptRecoveryDemonstration(paths, boundary);
      restartRecoveryDemonstration(paths, boundary);
      const recovered = recoverRecoveryDemonstration(paths, boundary);
      assert.deepEqual(recovered.counts, expectedTerminalCounts());
      assert.equal(recovered.mixedTerminalFailureAndMutation, false);
      assert.equal(replayCompletedRecoveryDemonstration(paths, boundary).durableStateUnchanged, true);
    }

    assert.equal(exportMissionEvidenceBundle(missionOptions), before);
    let replayOwnerCalls = 0;
    await runDeterministicM4Mission({
      ...missionOptions,
      ownerDecisionProvider: () => {
        replayOwnerCalls += 1;
        throw new Error("completed M5 replay must not call the owner");
      },
    });
    assert.equal(replayOwnerCalls, 0);
    assert.equal(exportMissionEvidenceBundle(missionOptions), before);
  });
});

function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-recovery-integration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function recoveryPaths(
  root: string,
  identity: RecoveryDemoBoundary | string,
): RecoveryDemoPaths {
  const directory = join(root, "recovery", identity);
  mkdirSync(directory, { recursive: true });
  return {
    m2DatabasePath: join(directory, "m2.sqlite"),
    factoryDatabasePath: join(directory, "factory.sqlite"),
  };
}

function expectedTerminalCounts(): {
  readonly acceptances: 1;
  readonly attempts: 1;
  readonly fences: 1;
  readonly fenceBindings: 1;
  readonly mutations: 1;
  readonly receipts: 1;
  readonly terminalEvents: 1;
  readonly terminalFailures: 0;
  readonly actualConsumptionFacts: 2;
} {
  return {
    acceptances: 1,
    attempts: 1,
    fences: 1,
    fenceBindings: 1,
    mutations: 1,
    receipts: 1,
    terminalEvents: 1,
    terminalFailures: 0,
    actualConsumptionFacts: 2,
  };
}
