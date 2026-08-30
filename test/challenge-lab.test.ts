import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  readAdversarialChallengeLab,
  runAdversarialChallengeLab,
} from "../src/challenge-lab.js";
import { canonicalSerialize } from "../src/canonical.js";
import { M5DemoCoordinator } from "../src/m5-ui.js";

describe("deterministic adversarial challenge lab", { concurrency: false }, () => {
  test("all required challenges use real controls and prove exact zero-effect boundaries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-challenge-lab-"));
    const coordinator = new M5DemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: false,
    });
    try {
      const result = await runAdversarialChallengeLab(directory);
      assert.equal(result.complete, true);
      assert.equal(result.allPassed, true);
      assert.deepEqual(result.omitted, []);
      assert.deepEqual(
        result.challenges.map((challenge) => challenge.id),
        [
          "identity-substitution",
          "stale-authoritative-basis",
          "attempt-id-conflict",
          "forged-receipt",
          "alternate-after-denial",
          "valid-idempotent-replay",
        ],
      );
      const expectedCounts = {
        "identity-substitution": [3, 1, 1, 0, 0, 0, 0, 0],
        "stale-authoritative-basis": [3, 1, 1, 0, 0, 0, 0, 0],
        "attempt-id-conflict": [3, 1, 1, 1, 1, 1, 0, 0],
        "forged-receipt": [3, 1, 1, 1, 1, 1, 0, 0],
        "alternate-after-denial": [2, 1, 0, 0, 0, 0, 0, 0],
        "valid-idempotent-replay": [3, 1, 1, 1, 1, 1, 1, 2],
      } as const;
      for (const challenge of result.challenges) {
        assert.equal(challenge.zeroUnauthorizedEffects, true, challenge.id);
        assert.equal(challenge.snapshotEqual, true, challenge.id);
        assert.equal(
          canonicalSerialize(challenge.before),
          canonicalSerialize(challenge.after),
          challenge.id,
        );
        assert.deepEqual(
          Object.values(challenge.before.counts),
          expectedCounts[challenge.id],
          challenge.id,
        );
        assert.equal(challenge.attemptedAction.includes(directory), false);
        assert.equal(challenge.authoritativeReason.includes(directory), false);
        assert.equal(challenge.adapterPath.includes(directory), false);
      }

      const denial = result.challenges.find(
        (challenge) => challenge.id === "alternate-after-denial",
      );
      assert.match(denial?.authoritativeReason ?? "", /active_denial/u);
      assert.equal(denial?.before.counts.attempts, 0);
      assert.equal(denial?.after.counts.mutations, 0);

      const replay = result.challenges.find(
        (challenge) => challenge.id === "valid-idempotent-replay",
      );
      assert.deepEqual(replay?.replayProof, {
        replayed: true,
        originalResultReturned: true,
        originalReceiptReturned: true,
        noSecondMutation: true,
        noDuplicateFacts: true,
      });
      assert.equal(replay?.before.counts.mutations, 1);
      assert.equal(replay?.before.counts.receipts, 1);
      assert.equal(replay?.before.counts.terminalEvents, 1);
      assert.equal(replay?.before.counts.actualFacts, 2);

      const durableReplay = readAdversarialChallengeLab(directory);
      assert.equal(canonicalSerialize(durableReplay), canonicalSerialize(result));
      assert.equal(
        canonicalSerialize(await runAdversarialChallengeLab(directory)),
        canonicalSerialize(result),
      );

      const challengeRoot = join(directory, "challenge-lab-v1");
      const identityRoot = join(challengeRoot, "01-identity");
      const m2Path = join(identityRoot, "m2.sqlite");
      const copiedM2Path = join(identityRoot, "m2-copy.sqlite");
      renameSync(m2Path, copiedM2Path);
      try {
        symlinkSync(copiedM2Path, m2Path);
        assert.throws(
          () => readAdversarialChallengeLab(directory),
          /regular non-symbolic-link file/u,
        );
      } finally {
        rmSync(m2Path, { force: true });
        renameSync(copiedM2Path, m2Path);
      }

      const copiedIdentityRoot = join(challengeRoot, "01-identity-copy");
      renameSync(identityRoot, copiedIdentityRoot);
      try {
        symlinkSync(copiedIdentityRoot, identityRoot, "dir");
        assert.throws(
          () => readAdversarialChallengeLab(directory),
          /scenario directory must not be a symbolic link/u,
        );
      } finally {
        rmSync(identityRoot, { force: true });
        renameSync(copiedIdentityRoot, identityRoot);
      }
    } finally {
      await coordinator.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("challenge cleanup cannot skip core cleanup and remains retryable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-challenge-cleanup-"));
    const coordinator = new M5DemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: true,
    });
    const challengeRoot = join(directory, "challenge-lab-v1");
    const challengeMarker = join(challengeRoot, ".flakebrake-challenge-owned-v1");
    const coreFiles = ["m2.sqlite", "factory.sqlite", "mission.sqlite", "trueforge.sqlite"];
    try {
      mkdirSync(challengeRoot, { mode: 0o700 });
      writeFileSync(challengeMarker, "invalid\n");
      for (const file of coreFiles) writeFileSync(join(directory, file), "owned fixture\n");
      mkdirSync(join(directory, "trueforge-data", "owned"), { recursive: true });
      writeFileSync(join(directory, "trueforge-data", "owned", "sentinel"), "owned\n");

      await assert.rejects(coordinator.close(), (error: unknown) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(String(error), /M5 invocation cleanup did not complete/u);
        return true;
      });
      assert.equal(coreFiles.every((file) => !existsSync(join(directory, file))), true);
      assert.equal(existsSync(join(directory, "trueforge-data")), false);
      assert.equal(existsSync(challengeRoot), true);

      writeFileSync(challengeMarker, "flakebrake-adversarial-challenge/v1\n");
      await coordinator.close();
      assert.equal(existsSync(challengeRoot), false);
    } finally {
      await coordinator.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
