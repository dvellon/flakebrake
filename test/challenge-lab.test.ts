import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  test("durable replay rejects foreign SQLite participants before evidence use", async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-challenge-provenance-"));
    const coordinator = new M5DemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: false,
    });
    try {
      const result = await runAdversarialChallengeLab(directory);
      const scenario = join(directory, "challenge-lab-v1", "01-identity");
      const m2 = join(scenario, "m2.sqlite");
      const factory = join(scenario, "factory.sqlite");

      for (const [label, primary] of [
        ["M2", m2],
        ["factory", factory],
      ] as const) {
        await context.test(`hardlinked ${label} primary is rejected without effects`, () => {
          const foreign = join(directory, `foreign-${label.toLowerCase()}.sqlite`);
          renameSync(primary, foreign);
          linkSync(foreign, primary);
          try {
            assertProvenanceRejectionLeavesSourcesUnchanged(
              directory,
              primary,
              foreign,
              () => readAdversarialChallengeLab(directory),
            );
          } finally {
            rmSync(primary, { force: true });
            renameSync(foreign, primary);
          }
        });
      }

      for (const suffix of ["-wal", "-shm"] as const) {
        for (const linkKind of ["symbolic", "hard"] as const) {
          await context.test(`${linkKind} ${suffix.slice(1)} sidecar is rejected without effects`, () => {
            const participant = `${m2}${suffix}`;
            const ownedParticipant = `${participant}.owned`;
            const foreign = join(directory, `foreign-m2.sqlite${suffix}-${linkKind}`);
            const hadOwnedParticipant = existsSync(participant);
            if (hadOwnedParticipant) renameSync(participant, ownedParticipant);
            writeFileSync(foreign, `foreign ${suffix} participant\n`, { mode: 0o600 });
            if (linkKind === "symbolic") symlinkSync(foreign, participant);
            else linkSync(foreign, participant);
            try {
              assertProvenanceRejectionLeavesSourcesUnchanged(
                directory,
                participant,
                foreign,
                () => readAdversarialChallengeLab(directory),
              );
            } finally {
              rmSync(participant, { force: true });
              rmSync(foreign, { force: true });
              if (hadOwnedParticipant) renameSync(ownedParticipant, participant);
            }
          });
        }
      }

      await context.test("legitimate owned primary, WAL, and SHM participants remain accepted", () => {
        const databases = [new DatabaseSync(m2), new DatabaseSync(factory)];
        try {
          for (const database of databases) {
            database.prepare("SELECT name FROM sqlite_schema ORDER BY name LIMIT 1").get();
          }
          for (const primary of [m2, factory]) {
            assert.equal(existsSync(`${primary}-wal`), true);
            assert.equal(existsSync(`${primary}-shm`), true);
          }
          assert.equal(
            canonicalSerialize(readAdversarialChallengeLab(directory)),
            canonicalSerialize(result),
          );
        } finally {
          for (const database of databases.reverse()) database.close();
        }
      });
    } finally {
      await coordinator.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function assertProvenanceRejectionLeavesSourcesUnchanged(
  directory: string,
  participant: string,
  foreign: string,
  action: () => unknown,
): void {
  const challengeBefore = challengeDurableSourceSnapshot(directory);
  const participantBefore = participantSnapshot(participant);
  const foreignBefore = participantSnapshot(foreign);
  assert.throws(action, /single-link SQLite participant/u);
  assert.equal(challengeDurableSourceSnapshot(directory), challengeBefore);
  assert.equal(participantSnapshot(participant), participantBefore);
  assert.equal(participantSnapshot(foreign), foreignBefore);
}

function participantSnapshot(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return canonicalSerialize({
    bytes: stat.isSymbolicLink() ? null : readFileSync(path).toString("base64"),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    kind: stat.isSymbolicLink() ? "symbolic-link" : stat.isFile() ? "regular-file" : "other",
    links: stat.nlink.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    target: stat.isSymbolicLink() ? readlinkSync(path) : null,
  });
}

function challengeDurableSourceSnapshot(directory: string): string {
  const root = join(directory, "challenge-lab-v1");
  const paths = [
    ["result", join(root, "challenge-result.json")],
    ...[
      "01-identity",
      "02-stale-basis",
      "03-attempt-conflict",
      "04-forged-receipt",
      "05-alternate-denial",
      "06-valid-replay",
    ].flatMap((scenario) => [
      [`${scenario}/m2`, join(root, scenario, "m2.sqlite")],
      [`${scenario}/factory`, join(root, scenario, "factory.sqlite")],
    ]),
  ] as const;
  return canonicalSerialize(
    Object.fromEntries(
      paths.map(([label, path]) => [label, readFileSync(path).toString("base64")]),
    ),
  );
}
