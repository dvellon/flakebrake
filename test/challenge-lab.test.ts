import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  ChallengeEvidenceSession,
  readAdversarialChallengeLab,
  runAdversarialChallengeLab,
} from "../src/challenge-lab.js";
import { canonicalSerialize } from "../src/canonical.js";
import { SyntheticFactoryEnvironment } from "../src/factory-environment.js";
import {
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  createHeroInitialState,
} from "../src/hero-fixture.js";
import { M5DemoCoordinator } from "../src/m5-ui.js";
import { createStore } from "../src/store.js";

interface MutableChallengeEvidenceBundle {
  schemaVersion: string;
  missionId: string;
  labSessionId: string;
  resultDigest: string;
  scenarios: {
    scenarioId: string;
    directory: string;
    databases: {
      m2: { storeKind: string; incarnationId: string };
      factory: { storeKind: string; incarnationId: string };
    };
    counts: Record<string, number>;
    terminal: { reservationEventKinds: string[]; verifiedTerminalEvents: number };
    snapshot: { m2: Record<string, unknown[]>; factory: Record<string, unknown[]> };
    snapshotDigest: string;
  }[];
}

interface MutableChallengeResult {
  omitted: string[];
  challenges: {
    title: string;
    before: { counts: Record<string, number>; snapshotDigest: string };
    after: { counts: Record<string, number>; snapshotDigest: string };
  }[];
}

function sha256OfBytes(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

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

      const expected = canonicalSerialize(result);
      const durableReplay = readAdversarialChallengeLab(directory);
      assert.equal(canonicalSerialize(durableReplay), expected);
      assert.equal(
        canonicalSerialize(await runAdversarialChallengeLab(directory)),
        expected,
      );

      // Restart replay consumes the persisted canonical representation, so
      // rename-and-restore substitution of the source databases can no longer
      // affect the evidence: replay returns the original result unchanged.
      const challengeRoot = join(directory, "challenge-lab-v1");
      const identityRoot = join(challengeRoot, "01-identity");
      const m2Path = join(identityRoot, "m2.sqlite");
      const asidePath = join(identityRoot, "m2-aside.sqlite");

      renameSync(m2Path, asidePath);
      try {
        symlinkSync(asidePath, m2Path);
        assertReplayReturnsOriginal(directory, expected);
      } finally {
        rmSync(m2Path, { force: true });
        renameSync(asidePath, m2Path);
      }

      renameSync(m2Path, asidePath);
      try {
        copyFileSync(join(identityRoot, "factory.sqlite"), m2Path);
        assertReplayReturnsOriginal(directory, expected);
      } finally {
        rmSync(m2Path, { force: true });
        renameSync(asidePath, m2Path);
      }

      const copiedIdentityRoot = join(challengeRoot, "01-identity-copy");
      renameSync(identityRoot, copiedIdentityRoot);
      try {
        symlinkSync(copiedIdentityRoot, identityRoot, "dir");
        assertReplayReturnsOriginal(directory, expected);
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

  test("restart replay consumes the canonical representation and never rereads source databases", async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-challenge-provenance-"));
    const coordinator = new M5DemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: false,
    });
    try {
      const result = await runAdversarialChallengeLab(directory);
      const expected = canonicalSerialize(result);
      const challengeRoot = join(directory, "challenge-lab-v1");
      const scenario = join(challengeRoot, "01-identity");
      const m2 = join(scenario, "m2.sqlite");
      const factory = join(scenario, "factory.sqlite");
      const evidencePath = join(challengeRoot, "challenge-evidence.json");
      const resultPath = join(challengeRoot, "challenge-result.json");
      const originalEvidenceBytes = readFileSync(evidencePath, "utf8");
      const originalResultBytes = readFileSync(resultPath, "utf8");

      for (const [label, primary] of [
        ["M2", m2],
        ["factory", factory],
      ] as const) {
        await context.test(`hardlinked ${label} primary cannot affect replay`, () => {
          const foreign = join(directory, `foreign-${label.toLowerCase()}.sqlite`);
          renameSync(primary, foreign);
          linkSync(foreign, primary);
          try {
            assertReplayReturnsOriginal(directory, expected);
          } finally {
            rmSync(primary, { force: true });
            renameSync(foreign, primary);
          }
        });
      }

      for (const suffix of ["-wal", "-shm"] as const) {
        for (const linkKind of ["symbolic", "hard"] as const) {
          await context.test(`${linkKind} ${suffix.slice(1)} sidecar cannot affect replay`, () => {
            const participant = `${m2}${suffix}`;
            const ownedParticipant = `${participant}.owned`;
            const foreign = join(directory, `foreign-m2.sqlite${suffix}-${linkKind}`);
            const hadOwnedParticipant = existsSync(participant);
            if (hadOwnedParticipant) renameSync(participant, ownedParticipant);
            writeFileSync(foreign, `foreign ${suffix} participant\n`, { mode: 0o600 });
            if (linkKind === "symbolic") symlinkSync(foreign, participant);
            else linkSync(foreign, participant);
            try {
              assertReplayReturnsOriginal(directory, expected);
            } finally {
              rmSync(participant, { force: true });
              rmSync(foreign, { force: true });
              if (hadOwnedParticipant) renameSync(ownedParticipant, participant);
            }
          });
        }
      }

      await context.test("a fully removed scenario directory cannot affect replay", () => {
        const aside = join(challengeRoot, "01-identity-removed");
        renameSync(scenario, aside);
        try {
          assertReplayReturnsOriginal(directory, expected);
        } finally {
          renameSync(aside, scenario);
        }
      });

      await context.test("live owned WAL and SHM sidecars cannot affect replay", () => {
        const databases = [new DatabaseSync(m2), new DatabaseSync(factory)];
        try {
          for (const database of databases) {
            database.prepare("SELECT name FROM sqlite_schema ORDER BY name LIMIT 1").get();
          }
          for (const primary of [m2, factory]) {
            assert.equal(existsSync(`${primary}-wal`), true);
            assert.equal(existsSync(`${primary}-shm`), true);
          }
          assertReplayReturnsOriginal(directory, expected);
        } finally {
          for (const database of databases.reverse()) database.close();
        }
      });

      await context.test("tampering with the representation or its bindings fails closed", () => {
        const readBundle = (): MutableChallengeEvidenceBundle =>
          JSON.parse(readFileSync(evidencePath, "utf8")) as MutableChallengeEvidenceBundle;
        const restore = (): void => {
          rmSync(evidencePath, { force: true });
          writeFileSync(evidencePath, originalEvidenceBytes, "utf8");
          rmSync(resultPath, { force: true });
          writeFileSync(resultPath, originalResultBytes, "utf8");
        };

        // Missing representation.
        renameSync(evidencePath, `${evidencePath}.aside`);
        try {
          assert.throws(
            () => readAdversarialChallengeLab(directory),
            /challenge lab evidence representation is missing/u,
          );
        } finally {
          renameSync(`${evidencePath}.aside`, evidencePath);
        }

        // Symbolic-link representation.
        renameSync(evidencePath, `${evidencePath}.aside`);
        try {
          symlinkSync(`${evidencePath}.aside`, evidencePath);
          assert.throws(
            () => readAdversarialChallengeLab(directory),
            /evidence representation must not be a symbolic link/u,
          );
        } finally {
          rmSync(evidencePath, { force: true });
          renameSync(`${evidencePath}.aside`, evidencePath);
        }

        // Non-canonical bytes.
        writeFileSync(evidencePath, `${originalEvidenceBytes} `, "utf8");
        try {
          assert.throws(
            () => readAdversarialChallengeLab(directory),
            /durable challenge evidence representation is invalid/u,
          );
        } finally {
          restore();
        }

        // Reordered scenario records are malformed.
        {
          const bundle = readBundle();
          const [first, second] = [bundle.scenarios[0], bundle.scenarios[1]];
          assert.ok(first !== undefined && second !== undefined);
          bundle.scenarios[0] = second;
          bundle.scenarios[1] = first;
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /durable challenge evidence representation is invalid/u,
            );
          } finally {
            restore();
          }
        }

        // Mixed snapshots: one scenario's snapshot paired with another's record.
        {
          const bundle = readBundle();
          const [first, second] = [bundle.scenarios[0], bundle.scenarios[1]];
          assert.ok(first !== undefined && second !== undefined);
          const swapped = first.snapshot;
          first.snapshot = second.snapshot;
          second.snapshot = swapped;
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /internally inconsistent/u,
            );
          } finally {
            restore();
          }
        }

        // Tampered durable counts.
        {
          const bundle = readBundle();
          const first = bundle.scenarios[0];
          assert.ok(first !== undefined);
          first.counts["admissions"] = (first.counts["admissions"] ?? 0) + 1;
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /internally inconsistent/u,
            );
          } finally {
            restore();
          }
        }

        // Tampered database-identity binding.
        {
          const bundle = readBundle();
          const first = bundle.scenarios[0];
          assert.ok(first !== undefined);
          first.databases.m2.incarnationId =
            "database-incarnation/00000000-0000-0000-0000-000000000000";
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /internally inconsistent/u,
            );
          } finally {
            restore();
          }
        }

        // A canonically rewritten result no longer binds to the representation.
        {
          const tamperedResult = JSON.parse(originalResultBytes) as MutableChallengeResult;
          const first = tamperedResult.challenges[0];
          assert.ok(first !== undefined);
          first.title = `${first.title} (tampered)`;
          writeFileSync(resultPath, canonicalSerialize(tamperedResult), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /does not bind to the durable challenge result/u,
            );
          } finally {
            restore();
          }
        }

        // Mixed before/after evidence fails even when both files are
        // regenerated consistently around it.
        {
          const tamperedResult = JSON.parse(originalResultBytes) as MutableChallengeResult;
          const first = tamperedResult.challenges[0];
          assert.ok(first !== undefined);
          first.before = {
            ...first.before,
            snapshotDigest: `sha256:${"0".repeat(64)}`,
          };
          const tamperedResultBytes = canonicalSerialize(tamperedResult);
          const bundle = readBundle();
          bundle.resultDigest = sha256OfBytes(tamperedResultBytes);
          writeFileSync(resultPath, tamperedResultBytes, "utf8");
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /does not bind to the durable challenge result/u,
            );
          } finally {
            restore();
          }
        }

        // A result whose recorded evidence digest no longer matches the
        // bundle scenario fails the after-to-scenario binding even when
        // before and after are kept equal and both files are regenerated.
        {
          const tamperedResult = JSON.parse(originalResultBytes) as MutableChallengeResult;
          const first = tamperedResult.challenges[0];
          assert.ok(first !== undefined);
          const forged = `sha256:${"1".repeat(64)}`;
          first.before = { ...first.before, snapshotDigest: forged };
          first.after = { ...first.after, snapshotDigest: forged };
          const tamperedResultBytes = canonicalSerialize(tamperedResult);
          const bundle = readBundle();
          bundle.resultDigest = sha256OfBytes(tamperedResultBytes);
          writeFileSync(resultPath, tamperedResultBytes, "utf8");
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /does not bind to the durable challenge result/u,
            );
          } finally {
            restore();
          }
        }

        // The same holds for the counts binding when before and after agree.
        {
          const tamperedResult = JSON.parse(originalResultBytes) as MutableChallengeResult;
          const first = tamperedResult.challenges[0];
          assert.ok(first !== undefined);
          const forgedCounts = {
            ...first.after.counts,
            admissions: (first.after.counts["admissions"] ?? 0) + 1,
          };
          first.before = { ...first.before, counts: { ...forgedCounts } };
          first.after = { ...first.after, counts: { ...forgedCounts } };
          const tamperedResultBytes = canonicalSerialize(tamperedResult);
          const bundle = readBundle();
          bundle.resultDigest = sha256OfBytes(tamperedResultBytes);
          writeFileSync(resultPath, tamperedResultBytes, "utf8");
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /does not bind to the durable challenge result/u,
            );
          } finally {
            restore();
          }
        }

        // A tampered snapshot row value with a stale digest fails the
        // content-digest recomputation even though every count still matches.
        {
          const bundle = readBundle();
          const first = bundle.scenarios[0];
          assert.ok(first !== undefined);
          const grants = first.snapshot.m2["grants"];
          assert.ok(Array.isArray(grants) && grants.length === 1);
          const row = grants[0] as Record<string, unknown>;
          row["body_json"] = JSON.stringify({ forged: true });
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /internally inconsistent/u,
            );
          } finally {
            restore();
          }
        }

        // A tampered terminal-state binding fails its recomputation.
        {
          const bundle = readBundle();
          const first = bundle.scenarios[0];
          assert.ok(first !== undefined);
          first.terminal.verifiedTerminalEvents += 1;
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /internally inconsistent/u,
            );
          } finally {
            restore();
          }
        }

        // Forged omissions and injected extra keys are rejected by the strict
        // result schema even when the bundle digest is regenerated to match.
        {
          const tamperedResult = JSON.parse(originalResultBytes) as MutableChallengeResult;
          tamperedResult.omitted = ["scenario-07 was omitted for capacity reasons"];
          const tamperedResultBytes = canonicalSerialize(tamperedResult);
          const bundle = readBundle();
          bundle.resultDigest = sha256OfBytes(tamperedResultBytes);
          writeFileSync(resultPath, tamperedResultBytes, "utf8");
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /durable challenge result is invalid/u,
            );
          } finally {
            restore();
          }
        }
        {
          const tamperedResult = JSON.parse(originalResultBytes) as Record<string, unknown>;
          tamperedResult["zzInjectedNarrative"] = { forged: true };
          const tamperedResultBytes = canonicalSerialize(tamperedResult);
          const bundle = readBundle();
          bundle.resultDigest = sha256OfBytes(tamperedResultBytes);
          writeFileSync(resultPath, tamperedResultBytes, "utf8");
          writeFileSync(evidencePath, canonicalSerialize(bundle), "utf8");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /durable challenge result is invalid/u,
            );
          } finally {
            restore();
          }
        }

        // The read path's own entry guards fail closed: a corrupted ownership
        // marker, a missing result, and a symlinked result are each rejected.
        {
          const marker = join(challengeRoot, ".flakebrake-challenge-owned-v1");
          writeFileSync(marker, "invalid\n");
          try {
            assert.throws(
              () => readAdversarialChallengeLab(directory),
              /challenge-lab ownership marker is invalid/u,
            );
          } finally {
            writeFileSync(marker, "flakebrake-adversarial-challenge/v1\n");
          }
        }
        renameSync(resultPath, `${resultPath}.aside`);
        try {
          assert.throws(
            () => readAdversarialChallengeLab(directory),
            /challenge lab has incomplete durable state/u,
          );
        } finally {
          renameSync(`${resultPath}.aside`, resultPath);
        }
        renameSync(resultPath, `${resultPath}.aside`);
        try {
          symlinkSync(`${resultPath}.aside`, resultPath);
          assert.throws(
            () => readAdversarialChallengeLab(directory),
            /challenge result must not be a symbolic link/u,
          );
        } finally {
          rmSync(resultPath, { force: true });
          renameSync(`${resultPath}.aside`, resultPath);
        }

        // The intact representation still replays after every restoration.
        assertReplayReturnsOriginal(directory, expected);
      });
    } finally {
      await coordinator.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("in-run evidence reads only the connections established at scenario creation", () => {
    const fixture = fabricateOwnedChallengeScenario("flakebrake-challenge-session-");
    try {
      const substitute = join(fixture.directory, "substitute.sqlite");
      createStore({
        path: substitute,
        initialState: createHeroInitialState(),
        now: () => HERO_HORIZON_START,
      }).close();
      const substituteReader = new DatabaseSync(substitute, { readOnly: true });
      let substituteIncarnation: unknown;
      try {
        substituteIncarnation = (
          substituteReader
            .prepare("SELECT incarnation_id FROM database_incarnation WHERE singleton = 1")
            .get() as Record<string, unknown>
        )["incarnation_id"];
      } finally {
        substituteReader.close();
      }

      const session = ChallengeEvidenceSession.open({ m2: fixture.m2, factory: fixture.factory });
      try {
        const baseline = session.snapshot();

        // Rename-and-restore substitution at the primary pathname. A pathname
        // reopen would consume the substituted database; the held session
        // keeps reading the connections established at creation.
        assert.notEqual(substituteIncarnation, session.bindings.m2.incarnationId);
        const aside = `${fixture.m2}.aside`;
        renameSync(fixture.m2, aside);
        copyFileSync(substitute, fixture.m2);
        try {
          const during = session.snapshot();
          assert.equal(during.snapshotDigest, baseline.snapshotDigest);
        } finally {
          rmSync(fixture.m2, { force: true });
          renameSync(aside, fixture.m2);
        }
        const restored = session.snapshot();
        assert.equal(restored.snapshotDigest, baseline.snapshotDigest);

        // A commit that lands in either database after the snapshot
        // transactions are pinned is invisible to that snapshot and visible
        // to the next one, so rows and counts can never mix database states.
        const pinnedView = session.snapshot({
          onSnapshotsPinned: () => {
            const m2Writer = new DatabaseSync(fixture.m2);
            try {
              m2Writer.exec(
                "INSERT INTO denials (denial_id, created_at, body_json) VALUES ('denial/challenge-pinned-proof', '2026-08-26T09:10:00.000Z', '{}')",
              );
            } finally {
              m2Writer.close();
            }
            const factoryWriter = new DatabaseSync(fixture.factory);
            try {
              factoryWriter.exec(
                "INSERT INTO incoming_proposals (proposal_id, body_json) VALUES ('proposal/challenge-pinned-proof', '{}')",
              );
            } finally {
              factoryWriter.close();
            }
          },
        });
        assert.equal(pinnedView.snapshotDigest, baseline.snapshotDigest);
        assert.equal(
          canonicalSerialize(pinnedView.content.factory),
          canonicalSerialize(baseline.content.factory),
        );
        const fresh = session.snapshot();
        assert.notEqual(fresh.snapshotDigest, baseline.snapshotDigest);
        assert.notEqual(
          canonicalSerialize(fresh.content.factory),
          canonicalSerialize(baseline.content.factory),
        );
      } finally {
        session.close();
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("evidence admission rejects symlinked and multi-link files at scenario creation", () => {
    const fixture = fabricateOwnedChallengeScenario("flakebrake-challenge-admission-");
    const paths = { m2: fixture.m2, factory: fixture.factory };
    try {
      const aside = `${fixture.m2}.aside`;
      renameSync(fixture.m2, aside);
      try {
        symlinkSync(aside, fixture.m2);
        assert.throws(
          () => ChallengeEvidenceSession.open(paths),
          /single-link SQLite participant/u,
        );
      } finally {
        rmSync(fixture.m2, { force: true });
        renameSync(aside, fixture.m2);
      }

      const hardlink = join(fixture.directory, "hardlinked-m2.sqlite");
      linkSync(fixture.m2, hardlink);
      try {
        assert.throws(
          () => ChallengeEvidenceSession.open(paths),
          /single-link SQLite participant/u,
        );
      } finally {
        rmSync(hardlink, { force: true });
      }

      const foreignWal = join(fixture.directory, "foreign-wal");
      writeFileSync(foreignWal, "foreign wal\n", { mode: 0o600 });
      symlinkSync(foreignWal, `${fixture.m2}-wal`);
      try {
        assert.throws(
          () => ChallengeEvidenceSession.open(paths),
          /single-link SQLite participant/u,
        );
      } finally {
        rmSync(`${fixture.m2}-wal`, { force: true });
        rmSync(foreignWal, { force: true });
      }

      const foreignShm = join(fixture.directory, "foreign-shm");
      writeFileSync(foreignShm, "foreign shm\n", { mode: 0o600 });
      linkSync(foreignShm, `${fixture.factory}-shm`);
      try {
        assert.throws(
          () => ChallengeEvidenceSession.open(paths),
          /single-link SQLite participant/u,
        );
      } finally {
        rmSync(`${fixture.factory}-shm`, { force: true });
        rmSync(foreignShm, { force: true });
      }

      const scenarioAside = `${fixture.scenario}-aside`;
      renameSync(fixture.scenario, scenarioAside);
      try {
        symlinkSync(scenarioAside, fixture.scenario, "dir");
        assert.throws(
          () => ChallengeEvidenceSession.open(paths),
          /single-link SQLite participant/u,
        );
      } finally {
        rmSync(fixture.scenario, { force: true });
        renameSync(scenarioAside, fixture.scenario);
      }

      // Positive control: legitimately owned primaries with live WAL and SHM
      // sidecars, exactly as during real scenario creation, are admitted.
      const databases = [new DatabaseSync(fixture.m2), new DatabaseSync(fixture.factory)];
      try {
        for (const database of databases) {
          database.prepare("SELECT name FROM sqlite_schema ORDER BY name LIMIT 1").get();
        }
        for (const primary of [fixture.m2, fixture.factory]) {
          assert.equal(existsSync(`${primary}-wal`), true);
          assert.equal(existsSync(`${primary}-shm`), true);
        }
        const session = ChallengeEvidenceSession.open(paths);
        try {
          assert.match(session.snapshot().snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
        } finally {
          session.close();
        }
      } finally {
        for (const database of databases.reverse()) database.close();
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("valid roots reached through symlinked ancestors produce and replay evidence", async () => {
    const realParent = mkdtempSync(join(tmpdir(), "flakebrake-challenge-realroot-"));
    const linkParent = mkdtempSync(join(tmpdir(), "flakebrake-challenge-linkroot-"));
    try {
      const realRoot = join(realParent, "data");
      mkdirSync(realRoot, { mode: 0o700 });
      writeFileSync(
        join(realRoot, ".flakebrake-m5-owned-v1"),
        "flakebrake-m5-judge-state/v1\n",
        { mode: 0o600 },
      );
      const alias = join(linkParent, "alias");
      symlinkSync(realParent, alias, "dir");
      const aliasedRoot = join(alias, "data");

      const result = await runAdversarialChallengeLab(aliasedRoot);
      assert.equal(result.complete, true);
      assert.equal(result.allPassed, true);
      const expected = canonicalSerialize(result);
      assert.equal(canonicalSerialize(readAdversarialChallengeLab(aliasedRoot)), expected);
      assert.equal(canonicalSerialize(readAdversarialChallengeLab(realRoot)), expected);
      assert.equal(
        canonicalSerialize(await runAdversarialChallengeLab(realRoot)),
        expected,
      );

      // A symbolic link at the data root's own final entry stays rejected;
      // only aliased ancestors are canonicalized.
      const rootAlias = join(linkParent, "root-alias");
      symlinkSync(realRoot, rootAlias, "dir");
      assert.throws(
        () => readAdversarialChallengeLab(rootAlias),
        /Challenge data root must be a real directory/u,
      );
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(realParent, { recursive: true, force: true });
    }
  });
});

function assertReplayReturnsOriginal(directory: string, expected: string): void {
  const sourcesBefore = challengeDurableSourceSnapshot(directory);
  assert.equal(canonicalSerialize(readAdversarialChallengeLab(directory)), expected);
  assert.equal(challengeDurableSourceSnapshot(directory), sourcesBefore);
}

function challengeDurableSourceSnapshot(directory: string): string {
  const root = join(directory, "challenge-lab-v1");
  const paths = [
    ["result", join(root, "challenge-result.json")],
    ["evidence", join(root, "challenge-evidence.json")],
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
      paths.map(([label, path]) => [
        label,
        existsSync(path) && !lstatSync(path).isSymbolicLink()
          ? readFileSync(path).toString("base64")
          : null,
      ]),
    ),
  );
}

function fabricateOwnedChallengeScenario(prefix: string): {
  readonly directory: string;
  readonly scenario: string;
  readonly m2: string;
  readonly factory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(directory, ".flakebrake-m5-owned-v1"),
    "flakebrake-m5-judge-state/v1\n",
    { mode: 0o600 },
  );
  const challengeRoot = join(directory, "challenge-lab-v1");
  mkdirSync(challengeRoot, { mode: 0o700 });
  writeFileSync(
    join(challengeRoot, ".flakebrake-challenge-owned-v1"),
    "flakebrake-adversarial-challenge/v1\n",
    { mode: 0o600 },
  );
  const scenario = join(challengeRoot, "01-identity");
  mkdirSync(scenario, { mode: 0o700 });
  const m2 = join(scenario, "m2.sqlite");
  const factory = join(scenario, "factory.sqlite");
  createStore({
    path: m2,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_START,
  }).close();
  new SyntheticFactoryEnvironment({ path: factory, now: () => HERO_HORIZON_END }).close();
  return { directory, scenario, m2, factory };
}
