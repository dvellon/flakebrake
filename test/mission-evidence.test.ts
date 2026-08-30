import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
    trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
  };
  const missionOptions = {
    ...options,
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
    let replayOwnerCalls = 0;
    await runDeterministicM4Mission({
      ...missionOptions,
      ownerDecisionProvider: () => {
        replayOwnerCalls += 1;
        throw new Error("completed replay must not call the owner");
      },
    });
    assert.equal(replayOwnerCalls, 0);
    assert.equal(exportMissionEvidenceBundle(options), canonicalBytes);
    const afterRestart = durableSnapshot(options);
    assert.deepEqual(
      consequentialSnapshots(afterRestart),
      consequentialSnapshots(beforeRestart),
    );
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
      "created_at",
      "updated_at",
      "last_activity_at",
    ]) {
      assert.equal(canonicalBytes.includes(`\"${field}\"`), false, field);
    }
    for (const excluded of [
      "v1:local:",
      '"manifest"',
      '"base_url"',
      '"owner_token"',
    ]) {
      assert.equal(canonicalBytes.includes(excluded), false, excluded);
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

  test("canonical payload contains the exact durable TrueForge provenance projection", () => {
    const bundle = mutableBundle(canonicalBytes);
    const provenance = bundle.payload.trueforgeProvenance;
    assert.equal(provenance.runtimeProfile.runtimeId, "@truefoundry/trueforge");
    assert.equal(provenance.runtimeProfile.profileKind, "deterministic_judge");
    assert.equal(provenance.runtimeProfile.provider.name, "flakebrake-deterministic");
    assert.equal(provenance.runtimeProfile.provider.modelId, "m4-mission");
    assert.equal(provenance.turns.length, 7);
    assert.equal(provenance.subagentThreads.length, 3);
    assert.deepEqual(
      provenance.connectors.map((connector) => connector.serviceId),
      [
        "factory-capacity",
        "factory-change-control",
        "factory-orders",
        "factory-simulator",
      ],
    );
    assert.equal(bundle.payload.ownerApprovalBindings.length, 5);
    assert.equal(
      bundle.payload.ownerApprovalBindings.filter(
        (binding) => binding.ownerRequest !== null,
      ).length,
      4,
    );
    assert.equal(provenance.replayContinuity.resumeEventIds.length, 5);
    assert.equal(bundle.payload.counts["trueforgeSessionEvents"], 71);
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

  test("export rejects a mission combined with a different durable database instance", () => {
    const mixedRoot = mkdtempSync(join(tmpdir(), "flakebrake-evidence-mixed-"));
    const copiedM2 = join(mixedRoot, "m2.sqlite");
    const copiedFactory = join(mixedRoot, "factory.sqlite");
    try {
      copyFileSync(options.m2DatabasePath, copiedM2);
      copyFileSync(options.factoryDatabasePath, copiedFactory);
      assert.throws(
        () =>
          exportMissionEvidenceBundle({
            ...options,
            m2DatabasePath: copiedM2,
          }),
        /database instance identities conflict/u,
      );
      assert.throws(
        () =>
          exportMissionEvidenceBundle({
            ...options,
            factoryDatabasePath: copiedFactory,
          }),
        /database instance identities conflict/u,
      );
    } finally {
      rmSync(mixedRoot, { recursive: true, force: true });
    }
  });

  test("export rejects a different TrueForge session-store incarnation", async () => {
    const foreignRoot = mkdtempSync(join(tmpdir(), "flakebrake-evidence-foreign-tf-"));
    const foreignOptions = {
      missionId: M4_HERO_MISSION_ID,
      m2DatabasePath: join(foreignRoot, "m2.sqlite"),
      factoryDatabasePath: join(foreignRoot, "factory.sqlite"),
      missionDatabasePath: join(foreignRoot, "mission.sqlite"),
      trueforgeDatabasePath: join(foreignRoot, "trueforge.sqlite"),
      localSandboxRootParent: join(foreignRoot, "trueforge-data"),
    } as const;
    try {
      await runDeterministicM4Mission(foreignOptions);
      assert.throws(
        () =>
          exportMissionEvidenceBundle({
            ...options,
            trueforgeDatabasePath: foreignOptions.trueforgeDatabasePath,
          }),
        /mission-bound TrueForge session must have exactly one row; found 0/u,
      );
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
    }
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
      /exact (?:relevant evidence|TrueForge provenance) counts are inconsistent/u,
    );

    const missingReceipt = mutableBundle(canonicalBytes);
    missingReceipt.payload.terminalProjection.receiptId = "receipt/tampered";
    refreshDigest(missingReceipt);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(missingReceipt)),
      /attempt, fence, receipt, read-back, and terminal linkage is inconsistent/u,
    );

    const mismatchedSession = mutableBundle(canonicalBytes);
    mismatchedSession.payload.mission.trueforgeSessionId = "session/tampered";
    refreshDigest(mismatchedSession);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(mismatchedSession)),
      /TrueForge session and terminal-turn linkage is inconsistent/u,
    );

    const mismatchedTurn = mutableBundle(canonicalBytes);
    mismatchedTurn.payload.mission.terminalTurnId = "turn/tampered";
    refreshDigest(mismatchedTurn);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(mismatchedTurn)),
      /TrueForge session and terminal-turn linkage is inconsistent/u,
    );

    const missingAcceptanceOwner = mutableBundle(canonicalBytes);
    missingAcceptanceOwner.payload.promiseAcceptance.body["ownerDecisionId"] =
      "owner-decision/missing";
    refreshDigest(missingAcceptanceOwner);
    assert.throws(
      () => verifyMissionEvidenceBytes(canonicalSerialize(missingAcceptanceOwner)),
      /promise acceptance owner decision must occur exactly once; found 0/u,
    );
  });

  test("every added TrueForge provenance category rejects focused tampering", () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (bundle: MutableEvidenceBundle) => void;
      readonly databaseBacked?: boolean;
    }[] = [
      {
        name: "runtime identity",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.runtimeProfile.runtimeId =
            "@truefoundry/foreign";
        },
      },
      {
        name: "deterministic profile disclosure",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.runtimeProfile.agent.iterationLimit = 95;
        },
      },
      {
        name: "agent identity",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.missionBinding.agentId = "agent/foreign";
        },
      },
      {
        name: "mission session identity",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.missionBinding.sessionId =
            "session/foreign";
        },
      },
      {
        name: "turn chain",
        mutate: (bundle) => {
          const turn = requiredItem(
            bundle.payload.trueforgeProvenance.turns,
            2,
            "third turn",
          );
          turn.previousTurnId = "turn/foreign";
        },
      },
      {
        name: "durable cursor",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.cursor.currentTurnId = "turn/foreign";
        },
      },
      {
        name: "subagent thread linkage",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.trueforgeProvenance.subagentThreads,
            0,
            "first subagent",
          ).parentThreadId = "thread/foreign";
        },
      },
      {
        name: "connector identity",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.trueforgeProvenance.connectors,
            0,
            "first connector",
          ).serviceId = "service/foreign";
        },
      },
      {
        name: "native MCP tool-call linkage",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native.toolCallPosition.turnOrdinal = 7;
        },
      },
      {
        name: "cross-thread action substitution",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).trueforgeThreadId = "thread/foreign";
        },
      },
      {
        name: "safe argument commitment",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).arguments["tampered"] = true;
        },
      },
      {
        name: "native MCP response status",
        mutate: (bundle) => {
          const native = requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native;
          native.responseStatus =
            native.responseStatus === "completed" ? "rejected" : "completed";
        },
      },
      {
        name: "local sandbox identity",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.sandbox.sandboxIdentity =
            digestIdentity("trueforge-local-sandbox", "0");
        },
      },
      {
        name: "sandbox completion result",
        databaseBacked: true,
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.sandbox.resultDigest = digest("1");
        },
      },
      {
        name: "sandbox execution argument commitment",
        databaseBacked: true,
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.sandbox.executionArgumentsDigest =
            digest("4");
        },
      },
      {
        name: "approval-required event identity",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native.approvalRequiredEventId = "event/foreign";
        },
      },
      {
        name: "user approval decision linkage",
        mutate: (bundle) => {
          const userApproval = requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native.userApproval;
          userApproval.decision =
            userApproval.decision === "allow" ? "deny" : "allow";
        },
      },
      {
        name: "user approval input commitment",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native.userApproval.inputDigest = digest("5");
        },
      },
      {
        name: "owner action digest",
        mutate: (bundle) => {
          const binding = requiredItem(
            bundle.payload.ownerApprovalBindings.filter(
              (item) => item.ownerRequest !== null,
            ),
            0,
            "owner approval",
          );
          assert.ok(binding.ownerRequest);
          binding.ownerRequest.requestDigest = digest("2");
        },
      },
      {
        name: "refresh resume linkage",
        mutate: (bundle) => {
          requiredItem(
            bundle.payload.ownerApprovalBindings,
            0,
            "first approval",
          ).native.resumeBridgeEventId = digestIdentity("m4-bridge-event", "3");
        },
      },
      {
        name: "restart replay continuity",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.replayContinuity.resumeEventIds.pop();
        },
      },
      {
        name: "durable terminal ordering",
        mutate: (bundle) => {
          bundle.payload.trueforgeProvenance.durableOrdering.terminal.position = {
            turnOrdinal: 1,
            eventOrdinal: 1,
          };
        },
      },
      {
        name: "native response result commitment",
        mutate: (bundle) => {
          const binding = requiredItem(
            bundle.payload.ownerApprovalBindings.filter(
              (item) => item.trueforgeToolCallId === "approve-alternative",
            ),
            0,
            "mutation approval",
          );
          binding.native.responseDigest = digest("6");
        },
      },
      {
        name: "exact TrueForge counts",
        mutate: (bundle) => {
          bundle.payload.counts["trueforgeSessionEvents"] = 70;
        },
      },
    ];
    for (const regression of cases) {
      const tampered = mutableBundle(canonicalBytes);
      regression.mutate(tampered);
      refreshDigest(tampered);
      assert.throws(
        () =>
          verifyMissionEvidenceBytes(
            canonicalSerialize(tampered),
            regression.databaseBacked === true ? options : undefined,
          ),
        regression.name,
      );
    }
  });

  test("failed read-only database opens release every acquired handle", () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), "flakebrake-evidence-corrupt-"));
    const corruptOptions: MissionEvidenceBuildOptions = {
      ...options,
      m2DatabasePath: join(corruptRoot, "m2.sqlite"),
      factoryDatabasePath: join(corruptRoot, "factory.sqlite"),
      missionDatabasePath: join(corruptRoot, "mission.sqlite"),
      trueforgeDatabasePath: join(corruptRoot, "trueforge.sqlite"),
    };
    try {
      copyFileSync(options.m2DatabasePath, corruptOptions.m2DatabasePath);
      copyFileSync(options.factoryDatabasePath, corruptOptions.factoryDatabasePath);
      copyFileSync(
        options.trueforgeDatabasePath,
        corruptOptions.trueforgeDatabasePath,
      );
      writeFileSync(corruptOptions.missionDatabasePath, "not a SQLite database", "utf8");
      for (let attempt = 0; attempt < 16; attempt += 1) {
        assert.throws(
          () => exportMissionEvidenceBundle(corruptOptions),
          /(?:could not open mission database read-only|file is not a database)/u,
        );
      }
      assert.equal(openDescriptorCount(corruptOptions.m2DatabasePath), 0);
      assert.equal(openDescriptorCount(corruptOptions.missionDatabasePath), 0);
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true });
    }
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

  test("endpoint reports completed evidence corruption as a safe internal failure", async () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), "flakebrake-evidence-http-corrupt-"));
    const owner = new M5DemoCoordinator({
      dataRoot: corruptRoot,
      cleanupDataOnClose: false,
    });
    await owner.close();
    copyFileSync(options.m2DatabasePath, join(corruptRoot, "m2.sqlite"));
    copyFileSync(options.factoryDatabasePath, join(corruptRoot, "factory.sqlite"));
    copyFileSync(options.missionDatabasePath, join(corruptRoot, "mission.sqlite"));
    copyFileSync(options.trueforgeDatabasePath, join(corruptRoot, "trueforge.sqlite"));
    const mission = new DatabaseSync(join(corruptRoot, "mission.sqlite"));
    try {
      mission
        .prepare(
          `UPDATE m4_missions SET m2_environment_identity = ? WHERE mission_id = ?`,
        )
        .run("database-instance/sha256:tampered", M4_HERO_MISSION_ID);
    } finally {
      mission.close();
    }
    const running = await startM5JudgeServer({
      dataRoot: corruptRoot,
      cleanupDataOnClose: false,
      port: 0,
    });
    try {
      const response = await fetch(`${running.url}/api/evidence`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "internal_error",
        message: "The request failed safely",
      });
    } finally {
      await running.close();
      rmSync(corruptRoot, { recursive: true, force: true });
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
    mission: {
      terminalTurnId: string;
      trueforgeSessionId: string;
    };
    promiseAcceptance: {
      body: Record<string, unknown>;
    };
    ownerApprovalBindings: {
      bridgeKey: string;
      toolName: string;
      trueforgeThreadId: string;
      trueforgeToolCallId: string;
      arguments: Record<string, unknown>;
      ownerRequest: {
        bridgeEventId: string;
        requestDigest: string;
        phase: string;
      } | null;
      native: {
        toolCallPosition: { turnOrdinal: number; eventOrdinal: number };
        approvalRequiredEventId: string;
        responseStatus: "completed" | "rejected";
        responseDigest: string;
        resumeBridgeEventId: string;
        userApproval: { decision: "allow" | "deny"; inputDigest: string };
      };
    }[];
    trueforgeProvenance: {
      runtimeProfile: {
        runtimeId: string;
        profileKind: string;
        provider: { name: string; modelId: string };
        agent: { iterationLimit: number };
      };
      missionBinding: { agentId: string; sessionId: string };
      cursor: { currentTurnId: string };
      turns: { previousTurnId: string | null }[];
      subagentThreads: { parentThreadId: string }[];
      connectors: { serviceId: string }[];
      sandbox: {
        sandboxIdentity: string;
        executionArgumentsDigest: string;
        resultDigest: string;
      };
      replayContinuity: { resumeEventIds: string[] };
      durableOrdering: {
        terminal: {
          position: { turnOrdinal: number; eventOrdinal: number };
        };
      };
    };
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

function digest(fill: string): string {
  return `sha256:${fill.repeat(64)}`;
}

function digestIdentity(prefix: string, fill: string): string {
  return `${prefix}/${digest(fill)}`;
}

function requiredItem<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  assert.ok(value, `${label} is missing`);
  return value;
}

function openDescriptorCount(path: string): number {
  return readdirSync("/proc/self/fd").filter((descriptor) => {
    try {
      return readlinkSync(join("/proc/self/fd", descriptor)) === path;
    } catch {
      return false;
    }
  }).length;
}

function durableSnapshot(
  paths: MissionEvidenceBuildOptions,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [
      ["m2", paths.m2DatabasePath],
      ["factory", paths.factoryDatabasePath],
      ["mission", paths.missionDatabasePath],
      ["trueforge", paths.trueforgeDatabasePath],
    ].map(([label, path]) => [label, logicalDatabaseDigest(path as string)]),
  );
}

function consequentialSnapshots(
  snapshot: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([label]) => label !== "trueforge"),
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
      >[]).map(normalizeDatabaseRow).sort((left, right) =>
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

function normalizeDatabaseRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? {
            sqliteBlobByteLength: value.byteLength,
            sqliteBlobDigest: `sha256:${createHash("sha256")
              .update(value)
              .digest("hex")}`,
          }
        : value,
    ]),
  );
}
