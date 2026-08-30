import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

import { canonicalSerialize } from "../src/canonical.js";
import {
  M4_HERO_MISSION_ID,
  M5DemoCoordinator,
  exportMissionEvidenceBundle,
  runDeterministicM4Mission,
  sanitizeEvidenceValue,
  startM5JudgeServer,
  verifyMissionEvidenceBytes,
  type MissionEvidenceBuildOptions,
} from "../src/index.js";

describe("canonical Mission Evidence Bundle", { concurrency: false }, () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-evidence-test-"));
  const options: MissionEvidenceBuildOptions = {
    missionId: M4_HERO_MISSION_ID,
    m2DatabasePath: join(directory, "m2.sqlite"),
    factoryDatabasePath: join(directory, "factory.sqlite"),
    missionDatabasePath: join(directory, "mission.sqlite"),
  };
  const missionOptions = {
    ...options,
    trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
    localSandboxRootParent: join(directory, "trueforge-data"),
  };
  let canonicalBytes = "";

  before(async () => {
    const owner = new M5DemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: false,
    });
    await owner.close();
    await runDeterministicM4Mission(missionOptions);
    canonicalBytes = exportMissionEvidenceBundle(options);
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("same durable mission is byte-identical across refresh and restart", async () => {
    assert.equal(exportMissionEvidenceBundle(options), canonicalBytes);
    assert.equal(exportMissionEvidenceBundle(options), canonicalBytes);
    const beforeRestart = durableSnapshot(options);
    await runDeterministicM4Mission(missionOptions);
    assert.equal(exportMissionEvidenceBundle(options), canonicalBytes);
    assert.deepEqual(durableSnapshot(options), beforeRestart);
  });

  test("canonical payload excludes machine-local, secret, timestamp, and display-only data", () => {
    assert.equal(canonicalBytes.includes(directory), false);
    for (const field of [
      "attemptedAt",
      "completedAt",
      "createdAt",
      "issuedAt",
      "observedAt",
      "recordedAt",
      "updatedAt",
    ]) {
      assert.equal(canonicalBytes.includes(`\"${field}\"`), false, field);
    }
    assert.equal(canonicalBytes.includes("runtimeEvidence"), false);
    assert.deepEqual(
      sanitizeEvidenceValue({ createdAt: "nondeterministic", stable: "durable" }),
      { stable: "durable" },
    );
    assert.throws(
      () => sanitizeEvidenceValue({ apiKey: "must-not-export" }),
      /forbidden field/u,
    );
    assert.throws(
      () => sanitizeEvidenceValue({ databasePath: "/machine/local.sqlite" }),
      /forbidden field/u,
    );
  });

  test("verifier checks exact source bytes and leaves all durable snapshots unchanged", () => {
    const beforeVerification = durableSnapshot(options);
    const result = verifyMissionEvidenceBytes(canonicalBytes, options);
    assert.equal(result.missionId, M4_HERO_MISSION_ID);
    assert.match(result.payloadDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.canonicalByteLength, Buffer.byteLength(canonicalBytes));
    assert.equal(result.databaseMatch, true);
    assert.deepEqual(durableSnapshot(options), beforeVerification);
  });

  test("local CLI independently verifies the downloaded file without database mutation", () => {
    const bundlePath = join(directory, "mission-evidence.json");
    writeFileSync(bundlePath, canonicalBytes, "utf8");
    const beforeVerification = durableSnapshot(options);
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "dist/src/mission-evidence-cli.js"),
        "--bundle",
        bundlePath,
        "--data-dir",
        directory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified canonical mission evidence bundle/u);
    assert.match(result.stdout, /Durable database match: exact/u);
    assert.deepEqual(durableSnapshot(options), beforeVerification);
  });

  test("noncanonical bytes, payload tampering, missing evidence, and inconsistent counts fail closed", () => {
    assert.throws(
      () => verifyMissionEvidenceBytes(`${canonicalBytes}\n`),
      /not exact canonical JSON/u,
    );

    const tampered = mutableBundle(canonicalBytes);
    const firstFact = tampered.payload.actualConsumptionFacts[0];
    assert.ok(firstFact);
    firstFact.body["actualConsumption"] = 999;
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(tampered)),
      /payload digest does not match/u,
    );

    const missing = mutableBundle(canonicalBytes);
    missing.payload.actualConsumptionFacts.pop();
    missing.payload.counts["actualConsumptionFacts"] = 1;
    refreshDigest(missing);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(missing)),
      /actual-consumption facts do not match/u,
    );

    const inconsistent = mutableBundle(canonicalBytes);
    inconsistent.payload.counts["factoryMutations"] = 2;
    refreshDigest(inconsistent);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(inconsistent)),
      /exact relevant evidence counts are inconsistent/u,
    );

    const missingReceipt = mutableBundle(canonicalBytes);
    missingReceipt.payload.terminalProjection.receiptId = "receipt/tampered";
    refreshDigest(missingReceipt);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(missingReceipt)),
      /attempt, fence, receipt, read-back, and terminal linkage is inconsistent/u,
    );
  });

  test("concurrent read-only HTTP downloads return one canonical bundle", async () => {
    const beforeReads = durableSnapshot(options);
    const running = await startM5JudgeServer({
      dataRoot: directory,
      cleanupDataOnClose: false,
      port: 0,
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => fetch(`${running.url}/api/evidence`)),
      );
      assert.ok(responses.every((response) => response.status === 200));
      assert.ok(
        responses.every(
          (response) =>
            response.headers.get("content-disposition") ===
            'attachment; filename="flakebrake-mission-evidence.json"',
        ),
      );
      const bodies = await Promise.all(responses.map((response) => response.text()));
      assert.deepEqual([...new Set(bodies)], [canonicalBytes]);
      assert.ok(bodies.every((body) => verifyMissionEvidenceBytes(body).databaseMatch === false));
    } finally {
      await running.close();
    }
    assert.deepEqual(durableSnapshot(options), beforeReads);
  });

  test("endpoint rejects export before terminal verification", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "flakebrake-evidence-empty-"));
    const running = await startM5JudgeServer({ dataRoot: emptyRoot, port: 0 });
    try {
      const response = await fetch(`${running.url}/api/evidence`);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "evidence_not_ready",
        message:
          "Canonical mission evidence is available only after durable verification completes",
      });
    } finally {
      await running.close();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("UI exposes a responsive, CSP-compatible completed-mission download control", () => {
    const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
    const application = readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8");
    const stylesheet = readFileSync(join(process.cwd(), "ui/m5/styles.css"), "utf8");
    assert.match(document, /id="evidence-download"[^>]*href="\/api\/evidence"/u);
    assert.match(document, /download="flakebrake-mission-evidence\.json"/u);
    assert.match(application, /evidenceReady/u);
    assert.match(application, /aria-disabled/u);
    assert.match(stylesheet, /\.evidence-bundle[^}]*display:\s*flex/u);
    assert.match(stylesheet, /\.evidence-bundle[^}]*flex-direction:\s*column/u);
    assert.doesNotMatch(document, /style=/u);
  });
});

interface MutableEvidenceBundle {
  schemaVersion: string;
  canonicalization: string;
  digestAlgorithm: string;
  payloadDigest: string;
  payload: {
    actualConsumptionFacts: {
      body: Record<string, unknown>;
    }[];
    counts: Record<string, number>;
    terminalProjection: { receiptId: string };
    [key: string]: unknown;
  };
}

function mutableBundle(bytes: string): MutableEvidenceBundle {
  return JSON.parse(bytes) as MutableEvidenceBundle;
}

function refreshDigest(bundle: MutableEvidenceBundle): void {
  bundle.payloadDigest = `sha256:${createHash("sha256")
    .update(canonicalSerialize(bundle.payload), "utf8")
    .digest("hex")}`;
}

function durableSnapshot(
  paths: MissionEvidenceBuildOptions,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [
      ["m2", paths.m2DatabasePath],
      ["factory", paths.factoryDatabasePath],
      ["mission", paths.missionDatabasePath],
    ].map(([label, path]) => [label, logicalDatabaseDigest(path as string)]),
  );
}

function logicalDatabaseDigest(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const schema = database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name`,
      )
      .all();
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as Record<string, unknown>[];
    const contents = tables.map((row) => {
      const name = String(row["name"]);
      const quoted = name.replaceAll('"', '""');
      const rows = (database.prepare(`SELECT * FROM "${quoted}"`).all() as Record<
        string,
        unknown
      >[]).sort((left, right) =>
        canonicalSerialize(left).localeCompare(canonicalSerialize(right), "en"),
      );
      return { name, rows };
    });
    return `sha256:${createHash("sha256")
      .update(canonicalSerialize({ schema, contents }), "utf8")
      .digest("hex")}`;
  } finally {
    database.close();
  }
}
