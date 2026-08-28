import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { IncomingMessage, Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  TrueForge,
  TrueForgeApi,
} from "@truefoundry/trueforge-sdk";

import { canonicalSerialize } from "../src/canonical.js";
import {
  assertLiveApprovalInvariants,
  assertLiveMissionEvidence,
  assertOperationalLiveConvergence,
  canonicalLiveDatabasePath,
  type LiveM4ValidationProfile,
} from "../src/m4-live.js";
import {
  FlakeBrakeStore,
  FACTORY_MCP_SERVICE_NAMES,
  FLAKEBRAKE_ROOT_AGENT_NAME,
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_RESOURCE_KEYS,
  M4MissionController,
  M4_LIVE_MISSION_ID,
  M4MissionStore,
  TRUEFORGE_SDK_VERSION,
  TRUEFORGE_SERVER_VERSION,
  SyntheticFactoryEnvironment,
  createHeroInitialState,
  createHeroProposal,
  createStore,
  deterministicM4OwnerDecisions,
  flakeBrakeRootAgentSpec,
  m4OwnerDecisionResponse,
  readDatabaseInstanceIdentity,
  runDeterministicM4Mission,
  runLiveM4Mission,
  startFactoryMcpHttpCluster,
  startFactoryMcpHttpService,
  type DeterministicM4MissionOptions,
  type DeterministicM4MissionResult,
  type JsonValue,
  type LiveM4MissionOptions,
  type LiveM4MissionResult,
  type M4ApprovalRecord,
  type M4BridgeAction,
  type M4BridgeOutcome,
  type M4MissionBinding,
  type M4MissionCheckpoint,
  type M4OwnerApprovalRequest,
  type RunningFactoryMcpHttpCluster,
} from "../src/index.js";

const WINNER =
  "replan-plan/sha256:68fe99d3402893002930fa143b1089629e4722215d1624af5924d628430aafe2";

const LIVE_DIAGNOSTIC_CONTINUATION_LIMIT = 12;
const LIVE_DIAGNOSTIC_MARKER = "FLAKEBRAKE_LIVE_DIAGNOSTIC=";

type LiveDiagnosticPhase =
  | "awaiting_initial_admission"
  | "awaiting_fresh_readmission"
  | "awaiting_promise_acceptance"
  | "awaiting_approved_attempt"
  | "awaiting_factory_commit"
  | "awaiting_independent_verification"
  | "verified_complete";

interface LiveDiagnosticCounts {
  readonly admissions: number;
  readonly acceptances: number;
  readonly grants: number;
  readonly attempts: number;
  readonly fences: number;
  readonly mutations: number;
  readonly receipts: number;
  readonly terminalEvents: number;
  readonly actualFacts: number;
}

interface LiveFailureDiagnostic {
  readonly schemaVersion: "flakebrake-live-failure-diagnostic/v1";
  readonly capturedBeforeInvocationCleanup: true;
  readonly configuredContinuationLimit: number;
  readonly continuationCount: number;
  readonly continuationRequests: number;
  readonly symbolicDurablePhaseTransitions: readonly LiveDiagnosticPhase[];
  readonly repetition: {
    readonly detected: boolean;
    readonly firstRepeatedPhase: LiveDiagnosticPhase | "unlocalized" | null;
  };
  readonly actions: readonly {
    readonly actionType: string;
    readonly actionKind: string;
    readonly outcome: "allow" | "deny" | "unbound" | "invalid";
    readonly approvalOrigin: "owner" | "mechanical_denial" | "none" | "invalid";
  }[];
  readonly externalOwnerCallCount: number;
  readonly identities: {
    readonly mission: string | null;
    readonly session: string | null;
    readonly cursor: string | null;
  };
  readonly missionTerminalDiscriminant: "nonterminal" | "terminal_verified";
  readonly m2TerminalDiscriminant: LiveDiagnosticPhase;
  readonly counts: LiveDiagnosticCounts;
  readonly duplicateIndicators: {
    readonly admissions: boolean;
    readonly acceptances: boolean;
    readonly grants: boolean;
    readonly attempts: boolean;
    readonly fences: boolean;
    readonly mutations: boolean;
    readonly receipts: boolean;
    readonly terminalEvents: boolean;
    readonly actualFacts: boolean;
  };
  readonly failureClosed: boolean;
  readonly cleanup: {
    listeners: "clean" | "leaked";
    processes: "clean" | "leaked";
    liveRunLock: "released" | "not_applicable";
    invocationFiles: "pending" | "removed" | "present";
  };
}

interface LiveDiagnosticError extends Error {
  readonly flakeBrakeLiveDiagnostic: LiveFailureDiagnostic;
  readonly flakeBrakeOriginalMessage: string;
}

interface HttpFixture {
  readonly directory: string;
  readonly m2Path: string;
  readonly factoryPath: string;
  readonly cluster: RunningFactoryMcpHttpCluster;
}

describe("M4 genuine Streamable HTTP MCP transport", () => {
  let fixture: HttpFixture;

  before(async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-http-"));
    const m2Path = join(directory, "m2.sqlite");
    const factoryPath = join(directory, "factory.sqlite");
    const store = createStore({
      path: m2Path,
      initialState: createHeroInitialState(),
      now: () => HERO_HORIZON_END,
    });
    const factory = new SyntheticFactoryEnvironment({
      path: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    store.close();
    factory.close();
    fixture = {
      directory,
      m2Path,
      factoryPath,
      cluster: await startFactoryMcpHttpCluster({
        m2DatabasePath: m2Path,
        factoryDatabasePath: factoryPath,
        now: () => HERO_HORIZON_END,
        enableM4Tools: true,
      }),
    };
  });

  after(async () => {
    await fixture.cluster.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  test("1. four real independently addressable HTTP clients see distinct server identities", async () => {
    assert.equal(fixture.cluster.transport, "streamable-http");
    assert.deepEqual(
      [...fixture.cluster.services.keys()],
      FACTORY_MCP_SERVICE_NAMES,
    );
    const urls = [...fixture.cluster.services.values()].map(
      (service) => service.url,
    );
    assert.equal(new Set(urls).size, 4);
    for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
      await withHttpClient(fixture.cluster, serviceName, async (client) => {
        assert.equal(client.getServerVersion()?.name, serviceName);
        await client.ping();
      });
    }
  });

  test("2. HTTP tool discovery preserves strict M3 schemas and accurate M4 annotations", async () => {
    const expected = new Map<string, readonly string[]>([
      ["factory-orders", ["read_incoming_proposals", "read_orders"]],
      ["factory-capacity", ["read_actual_consumption", "read_capacity_plan"]],
      [
        "factory-simulator",
        ["evaluate_candidate_schedules", "evaluate_hero_fixture"],
      ],
      [
        "factory-change-control",
        [
          "accept_promise",
          "create_schedule_reservation",
          "prepare_portfolio_modification",
          "prepare_promise_acceptance",
          "prepare_schedule_effect",
          "read_execution_status",
          "read_schedule_state",
          "record_current_admission",
          "select_portfolio_modification",
          "submit_schedule_change",
          "verify_schedule_execution",
        ],
      ],
    ]);
    for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
      await withHttpClient(fixture.cluster, serviceName, async (client) => {
        const tools = (await client.listTools()).tools;
        assert.deepEqual(
          tools.map((tool) => tool.name).sort(),
          expected.get(serviceName),
        );
        for (const tool of tools) {
          const readOnly =
            tool.name.startsWith("read_") ||
            tool.name.startsWith("prepare_") ||
            tool.name.startsWith("evaluate_");
          const ledgerOnly = tool.name === "record_current_admission";
          assert.equal(tool.annotations?.readOnlyHint, readOnly);
          assert.equal(
            tool.annotations?.destructiveHint,
            !readOnly && !ledgerOnly,
          );
          assert.equal(tool.annotations?.idempotentHint, true);
          assert.equal(tool.annotations?.openWorldHint, false);
          assert.equal(tool.inputSchema["additionalProperties"], false);
        }
        if (serviceName === "factory-orders") {
          const orders = resultObject(
            (await client.callTool({
              name: "read_orders",
              arguments: {},
            })) as CallToolResult,
          );
          assert.equal(orders["portfolioVersion"], "portfolio/v1");
        }
        if (serviceName === "factory-change-control") {
          const firstAdmission = resultObject(
            (await client.callTool({
              name: "record_current_admission",
              arguments: {},
            })) as CallToolResult,
          );
          const replayedAdmission = resultObject(
            (await client.callTool({
              name: "record_current_admission",
              arguments: {},
            })) as CallToolResult,
          );
          assert.equal(
            canonicalSerialize(replayedAdmission),
            canonicalSerialize(firstAdmission),
          );
        }
      });
    }
  });

  test("3. portfolio v2 and a fresh ADMITTABLE basis precede Promise acceptance", async () => {
    await withHttpClient(
      fixture.cluster,
      "factory-change-control",
      async (client) => {
        resultObject(
          (await client.callTool({
            name: "record_current_admission",
            arguments: {},
          })) as CallToolResult,
        );
        const preparedModification = resultObject(
          (await client.callTool({
            name: "prepare_portfolio_modification",
            arguments: {},
          })) as CallToolResult,
        );
        const modificationArguments = record(
          preparedModification["arguments"],
          "portfolio modification arguments",
        );
        const [leftSelection, rightSelection] = await Promise.all([
          client.callTool({
            name: "select_portfolio_modification",
            arguments: modificationArguments,
          }) as Promise<CallToolResult>,
          client.callTool({
            name: "select_portfolio_modification",
            arguments: modificationArguments,
          }) as Promise<CallToolResult>,
        ]);
        assert.equal(
          canonicalSerialize(resultObject(leftSelection)),
          canonicalSerialize(resultObject(rightSelection)),
        );

        const storeBeforeAcceptance = createStore({ path: fixture.m2Path });
        let freshAdmissionId: string;
        try {
          const history = storeBeforeAcceptance.getAdmissionHistory();
          const initial = history.find(
            (candidate) =>
              candidate.record.portfolioVersion === "portfolio/v1" &&
              candidate.record.decision === "REPLAN",
          );
          assert.ok(initial);
          assert.equal(
            initial.addenda.some(
              (addendum) => addendum.kind === "acceptance_commit",
            ),
            false,
            "the stale v1 REPLAN admission is never accepted",
          );
          assert.equal(
            storeBeforeAcceptance.getPortfolio().versions.portfolioVersion,
            "portfolio/v2",
          );
          assert.equal(
            storeBeforeAcceptance
              .getPortfolio()
              .acceptedObligations.find(
                (order) => order.obligationId === "order/best-effort-display",
              )?.serviceLevel["quantity"],
            8,
          );
          const fresh = history.find(
            (candidate) =>
              candidate.record.portfolioVersion === "portfolio/v2" &&
              candidate.record.decision === "ADMITTABLE",
          );
          assert.ok(fresh, "a fresh authoritative v2 admission must exist");
          freshAdmissionId = fresh.record.admissionRecordId;
        } finally {
          storeBeforeAcceptance.close();
        }

        const beforeConflict = m2Snapshot(fixture.m2Path);
        const conflicting = (await client.callTool({
          name: "select_portfolio_modification",
          arguments: {
            ...modificationArguments,
            approver_id: "owner/conflicting-replay",
          },
        })) as CallToolResult;
        assert.equal(conflicting.isError, true);
        assert.equal(m2Snapshot(fixture.m2Path), beforeConflict);

        const preparedAcceptance = resultObject(
          (await client.callTool({
            name: "prepare_promise_acceptance",
            arguments: {},
          })) as CallToolResult,
        );
        const acceptanceArguments = record(
          preparedAcceptance["arguments"],
          "promise acceptance arguments",
        );
        assert.equal(
          acceptanceArguments["admission_record_id"],
          freshAdmissionId,
        );
        await client.callTool({
          name: "accept_promise",
          arguments: acceptanceArguments,
        });

        const storeAfterAcceptance = createStore({ path: fixture.m2Path });
        try {
          const accepted = storeAfterAcceptance.getAdmissionRecord(
            freshAdmissionId,
          );
          assert.equal(accepted.record.decision, "ADMITTABLE");
          assert.equal(accepted.record.portfolioVersion, "portfolio/v2");
          assert.equal(
            accepted.addenda.filter(
              (addendum) => addendum.kind === "acceptance_commit",
            ).length,
            1,
          );
        } finally {
          storeAfterAcceptance.close();
        }
      },
    );
  });
});

describe("M4 genuine TrueForge deterministic mission", () => {
  let directory: string;
  let options: DeterministicM4MissionOptions;
  let first: DeterministicM4MissionResult;
  let restarted: DeterministicM4MissionResult;

  before(
    async () => {
      directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-trueforge-"));
      options = {
        m2DatabasePath: join(directory, "m2.sqlite"),
        factoryDatabasePath: join(directory, "factory.sqlite"),
        missionDatabasePath: join(directory, "mission.sqlite"),
        trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
        localSandboxRootParent: join(directory, "trueforge-data"),
      };
      first = await runDeterministicM4Mission(options);
      restarted = await runDeterministicM4Mission(options);
    },
    { timeout: 120_000 },
  );

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("3. exact TrueForge 0.1.4 runtime policy enables native subagents and bounded approvals", () => {
    assert.equal(TRUEFORGE_SERVER_VERSION, "0.1.4");
    assert.equal(TRUEFORGE_SDK_VERSION, "0.1.3");
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    assert.equal(
      lock.packages["node_modules/@truefoundry/trueforge"]?.version,
      "0.1.4",
    );
    assert.equal(
      lock.packages["node_modules/@truefoundry/trueforge-core"]?.version,
      "0.1.4",
    );
    assert.equal(
      lock.packages["node_modules/@truefoundry/trueforge-sdk"]?.version,
      "0.1.3",
    );
    const spec = flakeBrakeRootAgentSpec("flakebrake-deterministic/m4-mission");
    assert.deepEqual(spec.config?.askUserQuestions, { enabled: false });
    assert.deepEqual(spec.config?.dynamicSubAgents, { enabled: true });
    assert.deepEqual(spec.config?.sandbox, {
      enabled: true,
      fileDownloads: false,
    });
    assert.deepEqual(
      (spec.mcpServers ?? []).map((server) => [
        server.name,
        server.requireApprovalForTools,
      ]),
      [
        ["factory-orders", []],
        ["factory-capacity", []],
        ["factory-simulator", []],
        [
          "factory-change-control",
          [
            "select_portfolio_modification",
            "accept_promise",
            "create_schedule_reservation",
            "submit_schedule_change",
          ],
        ],
      ],
    );
  });

  test("4. the root session initializes all four production MCP connectors", () => {
    assert.equal(first.rootAgentName, FLAKEBRAKE_ROOT_AGENT_NAME);
    assert.match(first.rootAgentId, /\S/u);
    const initialized = new Set<string>();
    for (const item of first.mission.trueforgeEvents) {
      if (item.event.type !== "mcp.initialize") continue;
      for (const server of item.event.mcpServers) {
        if (FACTORY_MCP_SERVICE_NAMES.includes(server.name as never)) {
          assert.equal(server.transportType, "streamable-http");
          initialized.add(server.name);
        }
      }
    }
    assert.deepEqual([...initialized].sort(), [...FACTORY_MCP_SERVICE_NAMES].sort());
    assert.equal(Object.keys(first.connectorUrls).length, 4);
    assert.ok(
      Object.values(first.connectorUrls).every((url) =>
        url.startsWith("http://127.0.0.1:"),
      ),
    );
  });

  test("5. three genuine visible subagent threads persist compact structured outputs", () => {
    assert.equal(first.subagentThreads.length, 3);
    assert.equal(
      new Set(first.subagentThreads.map((thread) => thread.threadId)).size,
      3,
    );
    assert.deepEqual(
      first.subagentThreads.map((thread) => thread.title),
      [
        "Portfolio and order analyst",
        "Capacity and schedule analyst",
        "Assurance and simulation engineer",
      ],
    );
    const done = first.mission.trueforgeEvents.filter(
      (item) => item.event.type === "thread.done",
    );
    assert.equal(done.length, 3);
    for (const item of done) {
      assert.equal(item.event.type, "thread.done");
      assert.equal(item.event.state.status, "done");
      if (item.event.state.status !== "done") continue;
      const content = item.event.state.output.content;
      assert.equal(typeof content, "string");
      const parsed = JSON.parse(content as string) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        "alternatives",
        "dependencies",
        "evidence_references",
        "findings",
        "proposed_actions",
        "resource_work_classes",
        "typed_effects",
      ]);
    }
  });

  test("6. native sandbox Code Mode performs and checks the authoritative computation", () => {
    assert.equal(first.sandboxIds.length, 1);
    assert.equal(
      first.mission.trueforgeEvents.filter(
        (item) => item.event.type === "sandbox.created",
      ).length,
      1,
    );
    const computation = sandboxComputation(first);
    assert.equal(computation["decision"], "REPLAN");
    assert.deepEqual(computation["violations"], [
      "agent_work_units",
      "human_review_decisions",
    ]);
    assert.match(String(computation["protected_sha256"]), /^[0-9a-f]{64}$/u);
    assert.equal(computation["winner"], WINNER);
  });

  test("7. direct REPLAN, both strategy families, exact ranking, and protected bytes are retained", () => {
    const computation = sandboxComputation(first);
    assert.deepEqual(computation["remaining"], {
      [HERO_RESOURCE_KEYS.agent]: -2,
      [HERO_RESOURCE_KEYS.human]: -1,
      [HERO_RESOURCE_KEYS.production]: 10,
    });
    assert.deepEqual(computation["strategy_families"], [
      ["modify_proposal", "available"],
      ["modify_existing", "available"],
    ]);
    assert.equal(computation["winner"], WINNER);
    assert.equal(computation["winner_strategy"], "modify_existing");
    assert.equal(computation["proposal_production_after"], 0);
    assert.equal((computation["candidate_ids"] as unknown[]).length, 3);
    const initialProtected = createHeroInitialState().acceptedObligations.find(
      (order) => order.obligationId === "order/protected-medical",
    );
    const store = createStore({ path: options.m2DatabasePath });
    try {
      const currentProtected = store
        .getPortfolio()
        .acceptedObligations.find(
          (order) => order.obligationId === "order/protected-medical",
        );
      assert.equal(
        canonicalSerialize(currentProtected),
        canonicalSerialize(initialProtected),
      );
    } finally {
      store.close();
    }
  });

  test("7b. the hero binds acceptance and execution only to the fresh v2 ADMITTABLE record", () => {
    const store = createStore({ path: options.m2DatabasePath });
    try {
      const history = store.getAdmissionHistory();
      const initial = history.find(
        (candidate) =>
          candidate.record.portfolioVersion === "portfolio/v1" &&
          candidate.record.decision === "REPLAN",
      );
      const fresh = history.find((candidate) =>
        candidate.addenda.some(
          (addendum) =>
            addendum.kind === "readmission_link" &&
            record(addendum.body, "fresh readmission link")["kind"] ===
              "M4_POST_MODIFICATION_ADMISSION",
        ),
      );
      assert.ok(initial);
      assert.ok(fresh);
      assert.equal(fresh.record.portfolioVersion, "portfolio/v2");
      assert.equal(fresh.record.decision, "ADMITTABLE");
      assert.equal(
        initial.addenda.some(
          (addendum) => addendum.kind === "acceptance_commit",
        ),
        false,
      );
      assert.equal(
        fresh.addenda.filter(
          (addendum) => addendum.kind === "acceptance_commit",
        ).length,
        1,
      );
      assert.equal(
        first.finalAttempt.admissionRecordId,
        fresh.record.admissionRecordId,
      );
      assert.equal(
        store
          .getPortfolio()
          .acceptedObligations.find(
            (order) => order.obligationId === "order/best-effort-display",
          )?.serviceLevel["quantity"],
        8,
      );
    } finally {
      store.close();
    }

    const actions = first.mission.missionSnapshot.bridgeActions;
    const modification = actions.find(
      (action) => action.toolName === "select_portfolio_modification",
    );
    const acceptance = actions.find(
      (action) => action.toolName === "accept_promise",
    );
    assert.ok(modification);
    assert.ok(acceptance);
    assert.equal(
      record(modification.arguments, "modification bridge arguments")[
        "admission_record_id"
      ],
      storeAdmissionId(options.m2DatabasePath, "REPLAN", "portfolio/v1"),
    );
    assert.equal(
      record(acceptance.arguments, "acceptance bridge arguments")[
        "admission_record_id"
      ],
      first.finalAttempt.admissionRecordId,
    );

    const ordered = first.mission.trueforgeEvents.map((item) => item.event);
    const readBack = ordered.findIndex(
      (event) =>
        event.type === "tool.response" &&
        event.toolCallId === "read-after-write",
    );
    const verified = ordered.findIndex(
      (event) =>
        event.type === "tool.response" &&
        event.toolCallId === "verify-authoritatively",
    );
    const terminal = ordered.findIndex(
      (event) =>
        event.type === "tool.response" &&
        event.toolCallId === "read-terminal-status",
    );
    assert.ok(readBack >= 0 && readBack < verified);
    assert.ok(verified < terminal);
  });

  test("8. five native pauses bind owner decisions, durable denial, and alternate-tool rejection", () => {
    assert.equal(
      first.mission.trueforgeEvents.filter(
        (item) => item.event.type === "tool.approval_required",
      ).length,
      5,
    );
    assert.deepEqual(
      first.mission.approvals.map((approval) => [
        approval.toolName,
        approval.decision,
        approval.source,
      ]),
      [
        ["select_portfolio_modification", "allow", "owner"],
        ["accept_promise", "allow", "owner"],
        ["create_schedule_reservation", "deny", "owner"],
        ["submit_schedule_change", "deny", "active_m2_denial"],
        ["create_schedule_reservation", "allow", "owner"],
      ],
    );
    const ownerDenial = first.mission.approvals[2];
    const alternate = first.mission.approvals[3];
    assert.ok(ownerDenial?.denialId);
    assert.equal(alternate?.denialId, ownerDenial.denialId);
    assert.ok(
      first.mission.approvals
        .filter((approval) => approval.source === "owner")
        .every(
          (approval) =>
            approval.ownerSourceIdentity ===
            "test-owner/deterministic-m4-policy",
        ),
    );
    assert.equal(alternate?.ownerSourceIdentity, null);
    assert.equal(first.activeDenials.length, 1);
    assert.equal(first.activeDenials[0]?.status, "active");
    assert.equal(first.activeDenials[0]?.denialId, ownerDenial.denialId);
    assert.equal(
      first.subagentThreads.length,
      3,
      "denial did not recreate the investigation",
    );
  });

  test("8a. live validator accepts the deterministic five-event route", () => {
    assertLiveInvariantFixture(options, liveValidationFixture(first));
  });

  test("8b. live validator accepts the safe four-event shortcut", () => {
    assertLiveInvariantFixture(
      options,
      safeShortcutLiveValidationFixture(liveValidationFixture(first)),
    );
  });

  test("8c. live validator rejects a missing portfolio-selection approval", () => {
    const fixture = liveValidationFixture(first);
    const selection = fixture.mission.approvals.find(
      (approval) => approval.toolName === "select_portfolio_modification",
    );
    assert.ok(selection);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          removeLiveFixtureApproval(fixture, selection.bridgeKey),
        ),
      /owner-approved portfolio selection/u,
    );
  });

  test("8d. live validator rejects a missing promise acceptance", () => {
    const fixture = liveValidationFixture(first);
    const acceptance = fixture.mission.approvals.find(
      (approval) => approval.toolName === "accept_promise",
    );
    assert.ok(acceptance);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          removeLiveFixtureApproval(fixture, acceptance.bridgeKey),
        ),
      /owner-approved promise acceptance/u,
    );
  });

  test("8e. live validator rejects a route without a consequential denial", () => {
    const fixture = safeShortcutLiveValidationFixture(
      liveValidationFixture(first),
    );
    const denial = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "deny" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    assert.ok(denial);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          removeLiveFixtureApproval(fixture, denial.bridgeKey),
        ),
      /owner-denied consequential action/u,
    );
  });

  test("8f. live validator rejects multiple approved consequential actions", () => {
    const fixture = liveValidationFixture(first);
    const denial = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "deny" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    assert.ok(denial);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          replaceLiveFixtureApproval(fixture, {
            ...denial,
            decision: "allow",
            reason: "owner approved",
            denialId: null,
          }),
        ),
      /owner-approved consequential action/u,
    );
  });

  test("8g. live validator rejects an owner decision/action digest mismatch", () => {
    const fixture = liveValidationFixture(first);
    const selection = fixture.mission.approvals.find(
      (approval) => approval.toolName === "select_portfolio_modification",
    );
    assert.ok(selection);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          replaceOwnerOutcomeDigest(
            fixture,
            selection.bridgeKey,
            "sha256:fixture-mismatch",
          ),
        ),
      /exact action digest and source/u,
    );
  });

  test("8h. live validator rejects mutation identity on a denied action", () => {
    const fixture = liveValidationFixture(first);
    const denial = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "deny" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    const approved = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "allow" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    assert.ok(denial);
    assert.ok(approved?.executionAttemptId);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          replaceLiveFixtureApproval(fixture, {
            ...denial,
            executionAttemptId: approved.executionAttemptId,
          }),
        ),
      /denied action produced an unauthorized mutation/u,
    );
  });

  test("8i. live validator rejects active-denial owner reauthorization", () => {
    const fixture = liveValidationFixture(first);
    const ownerDenial = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "deny" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    const mechanical = fixture.mission.approvals.find(
      (approval) => approval.source === "active_m2_denial",
    );
    assert.ok(ownerDenial?.ownerSourceIdentity);
    assert.ok(mechanical);
    const ownerSourceIdentity = ownerDenial.ownerSourceIdentity;
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          reauthorizeMechanicalDenial(
            fixture,
            mechanical,
            ownerSourceIdentity,
          ),
        ),
      /active M2 denial was reauthorized/u,
    );
  });

  test("8j. live validator rejects duplicate effects and wrong owner-call counts", () => {
    const fixture = liveValidationFixture(first);
    assert.throws(
      () =>
        assertLiveInvariantFixture(options, {
          ...fixture,
          controlledWriteCount: 2,
        }),
      /conserve one mutation/u,
    );
    const ownerOutcome = fixture.mission.missionSnapshot.bridgeOutcomes.find(
      (outcome) => outcome.status === "owner_decision_received",
    );
    assert.ok(ownerOutcome);
    assert.throws(
      () =>
        assertLiveInvariantFixture(
          options,
          removeLiveFixtureOutcome(fixture, ownerOutcome.bridgeEventId),
        ),
      /owner-call count is not exactly four/u,
    );
  });

  test("8k. full hero evidence is the default and requires assurance sandbox completion", () => {
    const complete = liveValidationFixture(first);
    assertLiveEvidenceFixture(options, complete);
    assertLiveEvidenceFixture(options, complete, "full_hero_evidence");
    const missingAssurance = withoutAssuranceSandboxCompletion(complete);
    assert.throws(
      () => assertLiveEvidenceFixture(options, missingAssurance),
      /assurance subagent did not complete genuine sandbox execution/u,
    );
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          missingAssurance,
          "full_hero_evidence",
        ),
      /assurance subagent did not complete genuine sandbox execution/u,
    );
  });

  test("8l. operational convergence accepts terminal safety without repeated assurance", () => {
    assertLiveEvidenceFixture(
      options,
      withoutAssuranceSandboxCompletion(liveValidationFixture(first)),
      "operational_convergence",
    );
  });

  test("8m. operational convergence requires genuine model and owner evidence", () => {
    const fixture = liveValidationFixture(first);
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          { ...fixture, model: "fixture/deterministic" },
          "operational_convergence",
        ),
      /genuine external-model execution/u,
    );
    const selection = fixture.mission.approvals.find(
      (approval) => approval.toolName === "select_portfolio_modification",
    );
    assert.ok(selection);
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          removeLiveFixtureApproval(fixture, selection.bridgeKey),
          "operational_convergence",
        ),
      /owner-approved portfolio selection/u,
    );
  });

  test("8n. operational convergence rejects unsafe or nonconvergent outcomes", () => {
    const fixture = liveValidationFixture(first);
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          {
            ...fixture,
            mission: { ...fixture.mission, finalTurnId: "turn/nonterminal" },
          },
          "operational_convergence",
        ),
      /terminal mission projection/u,
    );
    const denial = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "deny" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    const approved = fixture.mission.approvals.find(
      (approval) =>
        approval.source === "owner" &&
        approval.decision === "allow" &&
        isFixtureConsequentialTool(approval.toolName),
    );
    assert.ok(denial);
    assert.ok(approved?.executionAttemptId);
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          replaceLiveFixtureApproval(fixture, {
            ...denial,
            executionAttemptId: approved.executionAttemptId,
          }),
          "operational_convergence",
        ),
      /denied action produced an unauthorized mutation/u,
    );
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          { ...fixture, controlledWriteCount: 2 },
          "operational_convergence",
        ),
      /conserve one mutation/u,
    );
    const selection = fixture.mission.approvals.find(
      (approval) => approval.toolName === "select_portfolio_modification",
    );
    assert.ok(selection);
    assert.throws(
      () =>
        assertLiveEvidenceFixture(
          options,
          replaceOwnerOutcomeDigest(
            fixture,
            selection.bridgeKey,
            "sha256:profile-mismatch",
          ),
          "operational_convergence",
        ),
      /exact action digest and source/u,
    );
    assert.throws(
      () =>
        assertOperationalLiveConvergence(fixture, {
          ...fixture,
          mission: {
            ...fixture.mission,
            projectionDigest: "sha256:nonconvergent",
          },
        }),
      /did not converge on one terminal mission projection/u,
    );
  });

  test("8o. live callers select named profiles and retain the twelve-continuation bound", () => {
    assert.equal(
      liveOptions("/tmp/profile-full", {
        validationProfile: "full_hero_evidence",
      }).validationProfile,
      "full_hero_evidence",
    );
    assert.equal(
      liveOptions("/tmp/profile-operational", {
        validationProfile: "operational_convergence",
      }).validationProfile,
      "operational_convergence",
    );
    assert.equal(LIVE_DIAGNOSTIC_CONTINUATION_LIMIT, 12);
  });

  test("9. the bridge claims once before resume and ends with one fenced write and verified actuals", () => {
    assert.equal(first.finalAttempt.executionAttemptId, "attempt/m4-approved-alternative");
    assert.equal(first.finalAttempt.result.grantExecutionOrdinal, 1);
    assert.equal(
      first.finalAttempt.input.resourceCapacityClaims["agent_work_units"],
      6,
    );
    assert.equal(
      first.finalAttempt.input.resourceCapacityClaims[
        "production_cell_minutes"
      ],
      30,
    );
    assert.equal(first.finalFence?.status, "factory_result_bound");
    assert.equal(
      first.finalFence?.fenceId,
      first.factoryExecution?.result.fenceId,
    );
    assert.equal(first.factoryExecution?.result.status, "MUTATED_PENDING_VERIFICATION");
    assert.equal(
      first.factoryExecution?.result.receipt.verificationStatus,
      "pending_independent_read_back",
    );
    assert.equal(controlledWriteCount(first), 1);
    assert.equal(first.actualConsumptionFacts, 2);
    const verified = JSON.parse(
      toolResponse(first, "verify-authoritatively"),
    ) as Record<string, unknown>;
    assert.equal(verified["claimState"], "terminal_verified");
    const store = createStore({ path: options.m2DatabasePath });
    try {
      const reservation = store
        .getReservations(true)
        .find(
          (candidate) =>
            candidate.executionAttemptId === first.finalAttempt.executionAttemptId,
        );
      assert.equal(reservation?.claimState, "terminal_verified");
      assert.equal(store.getReservations(true).length, 1);
    } finally {
      store.close();
    }
  });

  test("10. disconnect resumes from the durable cursor without duplicate TrueForge events", () => {
    assert.equal(first.mission.disconnectedAndResumed, true);
    const identities = first.mission.trueforgeEvents.map(
      (item) => `${item.turnId}:${item.event.id}`,
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.ok(first.mission.missionSnapshot.mission.lastEventSequence > 0);
    assert.equal(
      first.mission.missionSnapshot.mission.currentTurnId,
      first.mission.finalTurnId,
    );
  });

  test("11. full TrueForge process restart reuses the session and reconstructs canonically", () => {
    assert.equal(restarted.mission.trueforgeSessionId, first.mission.trueforgeSessionId);
    assert.equal(restarted.trueforgeModelRequests, 0);
    assert.deepEqual(restarted.mission.approvals, first.mission.approvals);
    assert.equal(
      canonicalSerialize(restarted.mission.trueforgeEvents),
      canonicalSerialize(first.mission.trueforgeEvents),
    );
    assert.equal(
      restarted.mission.projectionDigest,
      first.mission.projectionDigest,
    );
    assert.equal(restarted.factoryExecution?.resultDigest, first.factoryExecution?.resultDigest);
    assert.equal(controlledWriteCount(restarted), 1);
    assert.equal(restarted.actualConsumptionFacts, 2);
    assert.equal(restarted.subagentThreads.length, 3);
    assert.equal(restarted.sandboxIds.length, 1);
  });

  test("12. durable bridge records exact stable links and rejects conflicting replay", () => {
    const store = new M4MissionStore({
      path: options.missionDatabasePath,
      now: () => HERO_HORIZON_END,
    });
    try {
      const snapshot = store.getSnapshot(first.mission.missionId);
      assert.equal(snapshot.bridgeActions.length, 5);
      for (const action of snapshot.bridgeActions) {
        assert.equal(action.trueforgeSessionId, first.mission.trueforgeSessionId);
        assert.match(action.trueforgeTurnId, /\S/u);
        assert.match(action.trueforgeThreadId, /\S/u);
        assert.match(action.trueforgeToolCallId, /\S/u);
        const statuses = snapshot.bridgeOutcomes
          .filter((outcome) => outcome.bridgeKey === action.bridgeKey)
          .map((outcome) => outcome.status);
        assert.ok(statuses.includes("approval_bound"));
        assert.ok(statuses.includes("trueforge_resumed"));
        assert.ok(statuses.includes("tool_completed"));
      }
      const existing = snapshot.bridgeActions[0];
      assert.ok(existing);
      assert.throws(
        () =>
          store.recordBridgeAction({
            missionId: existing.missionId,
            trueforgeSessionId: existing.trueforgeSessionId,
            trueforgeTurnId: existing.trueforgeTurnId,
            trueforgeThreadId: existing.trueforgeThreadId,
            trueforgeToolCallId: existing.trueforgeToolCallId,
            actionKind: existing.actionKind,
            toolName: existing.toolName,
            arguments: { conflicting: true },
          }),
        /reused/u,
      );
      const intent = snapshot.successorIntents.find(
        (candidate) => candidate.previousTurnId === existing.trueforgeTurnId,
      );
      assert.ok(intent);
      const beforeIntentReplay = canonicalSerialize(
        store.getSnapshot(first.mission.missionId),
      );
      const replayed = store.claimSuccessorIntent({
        missionId: intent.missionId,
        trueforgeSessionId: intent.trueforgeSessionId,
        previousTurnId: intent.previousTurnId,
        input: intent.input,
        ownerToken: "successor-owner/999999/replay",
      });
      assert.equal(replayed.claimed, false);
      assert.equal(replayed.intent.intentKey, intent.intentKey);
      assert.equal(
        canonicalSerialize(store.getSnapshot(first.mission.missionId)),
        beforeIntentReplay,
      );
      assert.throws(
        () =>
          store.claimSuccessorIntent({
            missionId: intent.missionId,
            trueforgeSessionId: intent.trueforgeSessionId,
            previousTurnId: intent.previousTurnId,
            input: [{ type: "user.message", content: "conflicting replay" }],
            ownerToken: "successor-owner/999999/conflict",
          }),
        /conflicting input/u,
      );
      assert.equal(
        canonicalSerialize(store.getSnapshot(first.mission.missionId)),
        beforeIntentReplay,
      );
    } finally {
      store.close();
    }
  });

  test(
    "14. a lost approval response recovers the exact completed successor without a sibling",
    { timeout: 120_000 },
    async () => {
      const paused = first.mission.approvals[0];
      assert.ok(paused);
      const store = new M4MissionStore({
        path: options.missionDatabasePath,
        now: () => HERO_HORIZON_END,
      });
      try {
        store.advanceCursor(first.mission.missionId, paused.turnId, 0);
      } finally {
        store.close();
      }

      const recovered = await runDeterministicM4Mission(options);
      assert.equal(
        recovered.trueforgeModelRequests,
        0,
        "the completed successor must be recovered instead of recreated",
      );
      const originalEvents = new Map(
        first.mission.trueforgeEvents.map((item) => [
          `${item.turnId}:${item.event.id}`,
          canonicalSerialize(item.event),
        ]),
      );
      const recoveredEvents = new Map(
        recovered.mission.trueforgeEvents.map((item) => [
          `${item.turnId}:${item.event.id}`,
          canonicalSerialize(item.event),
        ]),
      );
      assert.deepEqual([...recoveredEvents.keys()].sort(), [...originalEvents.keys()].sort());
      for (const [identity, event] of originalEvents) {
        assert.equal(recoveredEvents.get(identity), event);
      }
      assert.equal(recovered.mission.missionSnapshot.bridgeActions.length, 5);
      assert.equal(controlledWriteCount(recovered), 1);
      assert.equal(recovered.actualConsumptionFacts, 2);
    },
  );
});

test(
  "15. a provider done turn without a terminal attempt continues the bounded durable phase",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-nonterminal-"));
    const m2Path = join(directory, "m2.sqlite");
    const factoryPath = join(directory, "factory.sqlite");
    const missionPath = join(directory, "mission.sqlite");
    const missionId = "mission/nonterminal-provider-done";
    const sessionId = "session/nonterminal-provider-done";
    const turnId = "turn/nonterminal-provider-done";
    const factory = new SyntheticFactoryEnvironment({
      path: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    factory.close();
    const m2Store = createStore({
      path: m2Path,
      initialState: createHeroInitialState(),
      authoritativeFactoryDatabasePath: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    assert.equal(
      m2Store.evaluateAndRecordAdmission({ proposal: createHeroProposal() })
        .decision,
      "REPLAN",
    );
    m2Store.close();

    const done: TrueForgeApi.TurnDoneEvent = {
      id: "event/nonterminal-provider-done",
      type: "turn.done",
      threadId: null,
      createdAt: HERO_HORIZON_END,
      state: {
        status: "done",
        completedAt: HERO_HORIZON_END,
        output: null,
        requiredActions: [],
      },
    };
    let continuationCalls = 0;
    const trueforgeClient = {
      sessions: {
        getTurn: async () => ({ data: { state: done.state } }),
        listTurnEvents: async () => asyncPage([done]),
        listTurns: async () => asyncPage([]),
        createTurnStream: async (
          receivedSessionId: string,
          request: {
            previousTurnId: string;
            input: TrueForgeApi.TurnInputItem[];
          },
        ) => {
          continuationCalls += 1;
          assert.equal(receivedSessionId, sessionId);
          assert.equal(request.previousTurnId, turnId);
          assert.match(canonicalSerialize(request.input), /REPLAN/u);
          throw new Error("planned bounded nonterminal continuation");
        },
      },
    } as unknown as TrueForge;
    const missionStore = new M4MissionStore({
      path: missionPath,
      now: () => HERO_HORIZON_END,
    });
    try {
      missionStore.bindMission({
        missionId,
        environmentId: HERO_ENVIRONMENT_ID,
        trueforgeAgentId: "agent/nonterminal-provider-done",
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: readDatabaseInstanceIdentity(
          m2Path,
          "m2",
          HERO_ENVIRONMENT_ID,
        ),
        factoryEnvironmentIdentity: readDatabaseInstanceIdentity(
          factoryPath,
          "factory",
          HERO_ENVIRONMENT_ID,
        ),
      });
      missionStore.advanceCursor(missionId, turnId, 1);
      const controller = new M4MissionController({
        missionId,
        environmentId: HERO_ENVIRONMENT_ID,
        trueforgeAgentId: "agent/nonterminal-provider-done",
        trueforgeSessionId: sessionId,
        trueforgeClient,
        missionStore,
        m2DatabasePath: m2Path,
        factoryDatabasePath: factoryPath,
        ownerDecisionProvider: (request) =>
          m4OwnerDecisionResponse(
            request,
            "test-owner/nonterminal-provider",
            { status: "allow" },
          ),
      });
      await assert.rejects(
        controller.runToCompletion(),
        /planned bounded nonterminal continuation/u,
      );
      assert.equal(continuationCalls, 1);
    } finally {
      missionStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Qodo diagnostic harness captures the unchanged continuation bound before cleanup",
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-live-diagnostic-bound-"),
    );
    const m2Path = join(directory, "m2.sqlite");
    const factoryPath = join(directory, "factory.sqlite");
    const missionPath = join(directory, "mission.sqlite");
    const missionId = "mission/diagnostic-redaction-sentinel";
    const sessionId = "session/diagnostic-redaction-sentinel";
    const initialTurnId = "turn/diagnostic-initial";
    const factory = new SyntheticFactoryEnvironment({
      path: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    factory.close();
    const m2Store = createStore({
      path: m2Path,
      initialState: createHeroInitialState(),
      authoritativeFactoryDatabasePath: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    m2Store.close();
    let continuationRequests = 0;
    let diagnostic: LiveFailureDiagnostic | undefined;
    const doneEvent = (turnId: string): TrueForgeApi.TurnDoneEvent => ({
      id: `event/${turnId}/done`,
      type: "turn.done",
      threadId: null,
      createdAt: HERO_HORIZON_END,
      state: {
        status: "done",
        completedAt: HERO_HORIZON_END,
        output: null,
        requiredActions: [],
      },
    });
    const initialDone = doneEvent(initialTurnId);
    const trueforgeClient = {
      sessions: {
        getTurn: async () => ({
          data: { id: initialTurnId, state: initialDone.state },
        }),
        listTurnEvents: async () => asyncPage([initialDone]),
        listTurns: async () => asyncPage([]),
        createTurnStream: async () => {
          continuationRequests += 1;
          const turnId = `turn/diagnostic-continuation-${String(continuationRequests)}`;
          return asyncPage([
            {
              id: `event/${turnId}/created`,
              type: "turn.created",
              turnId,
              threadId: null,
              createdAt: HERO_HORIZON_END,
            } as unknown as TrueForgeApi.TurnStreamingEvent,
            doneEvent(turnId),
          ]);
        },
      },
    } as unknown as TrueForge;

    await assert.rejects(
      withLiveFailureDiagnostic(
        {
          directory,
          missionDatabasePath: missionPath,
          m2DatabasePath: m2Path,
          factoryDatabasePath: factoryPath,
          missionId,
          externalOwnerCallCount: () => 0,
          usesLiveRunLock: false,
        },
        async () => {
          const missionStore = new M4MissionStore({
            path: missionPath,
            now: () => HERO_HORIZON_END,
          });
          try {
            missionStore.bindMission({
              missionId,
              environmentId: HERO_ENVIRONMENT_ID,
              trueforgeAgentId: "agent/diagnostic-redaction-sentinel",
              trueforgeSessionId: sessionId,
              m2EnvironmentIdentity: readDatabaseInstanceIdentity(
                m2Path,
                "m2",
                HERO_ENVIRONMENT_ID,
              ),
              factoryEnvironmentIdentity: readDatabaseInstanceIdentity(
                factoryPath,
                "factory",
                HERO_ENVIRONMENT_ID,
              ),
            });
            missionStore.advanceCursor(missionId, initialTurnId, 1);
            const controller = new M4MissionController({
              missionId,
              environmentId: HERO_ENVIRONMENT_ID,
              trueforgeAgentId: "agent/diagnostic-redaction-sentinel",
              trueforgeSessionId: sessionId,
              trueforgeClient,
              missionStore,
              m2DatabasePath: m2Path,
              factoryDatabasePath: factoryPath,
              ownerDecisionProvider: (request) =>
                m4OwnerDecisionResponse(
                  request,
                  "test-owner/diagnostic-redaction-sentinel",
                  { status: "allow" },
                ),
            });
            await controller.runToCompletion();
          } finally {
            missionStore.close();
          }
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /exceeded bounded durable-phase continuation limit/u,
        );
        diagnostic = liveDiagnosticFromError(error);
        return true;
      },
    );

    assert.ok(diagnostic);
    assert.equal(
      continuationRequests,
      LIVE_DIAGNOSTIC_CONTINUATION_LIMIT,
    );
    assert.equal(
      diagnostic.configuredContinuationLimit,
      LIVE_DIAGNOSTIC_CONTINUATION_LIMIT,
    );
    assert.equal(diagnostic.continuationRequests, 12);
    assert.equal(diagnostic.continuationCount, 13);
    assert.deepEqual(diagnostic.symbolicDurablePhaseTransitions, [
      "awaiting_initial_admission",
    ]);
    assert.deepEqual(diagnostic.repetition, {
      detected: true,
      firstRepeatedPhase: "awaiting_initial_admission",
    });
    assert.equal(diagnostic.failureClosed, true);
    assert.deepEqual(diagnostic.counts, {
      admissions: 0,
      acceptances: 0,
      grants: 0,
      attempts: 0,
      fences: 0,
      mutations: 0,
      receipts: 0,
      terminalEvents: 0,
      actualFacts: 0,
    });
    assert.deepEqual(diagnostic.cleanup, {
      listeners: "clean",
      processes: "clean",
      liveRunLock: "not_applicable",
      invocationFiles: "removed",
    });
    assert.equal(existsSync(directory), false);
    assert.doesNotMatch(
      canonicalSerialize(diagnostic),
      /diagnostic-redaction-sentinel|api[_-]?key|provider manifest/iu,
    );
  },
);

test(
  "Qodo diagnostic harness reports partial and duplicate durable effects without contents",
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "flakebrake-live-diagnostic-effects-"),
    );
    const m2Path = join(directory, "m2.sqlite");
    const factoryPath = join(directory, "factory.sqlite");
    const missionPath = join(directory, "mission.sqlite");
    const missionId = "mission/diagnostic-secret-bearing-identity";
    const factory = new SyntheticFactoryEnvironment({
      path: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    factory.close();
    const store = createStore({
      path: m2Path,
      initialState: createHeroInitialState(),
      authoritativeFactoryDatabasePath: factoryPath,
      now: () => HERO_HORIZON_END,
    });
    store.close();
    seedDiagnosticEffectCounts(m2Path, factoryPath);
    seedDiagnosticMissionActions(missionPath, missionId);
    let diagnostic: LiveFailureDiagnostic | undefined;

    await assert.rejects(
      withLiveFailureDiagnostic(
        {
          directory,
          missionDatabasePath: missionPath,
          m2DatabasePath: m2Path,
          factoryDatabasePath: factoryPath,
          missionId,
          externalOwnerCallCount: () => 4,
          usesLiveRunLock: true,
        },
        async () => {
          throw new Error("planned diagnostic effect-count failure");
        },
      ),
      (error: unknown) => {
        diagnostic = liveDiagnosticFromError(error);
        return true;
      },
    );

    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.counts, {
      admissions: 4,
      acceptances: 2,
      grants: 2,
      attempts: 2,
      fences: 2,
      mutations: 2,
      receipts: 2,
      terminalEvents: 2,
      actualFacts: 3,
    });
    assert.ok(
      Object.values(diagnostic.duplicateIndicators).every(Boolean),
    );
    assert.equal(diagnostic.failureClosed, false);
    assert.equal(diagnostic.externalOwnerCallCount, 4);
    assert.deepEqual(
      diagnostic.actions.map((action) => [
        action.actionType,
        action.outcome,
        action.approvalOrigin,
      ]),
      [
        ["select_portfolio_modification", "allow", "owner"],
        ["submit_schedule_change", "deny", "mechanical_denial"],
      ],
    );
    assert.equal(diagnostic.cleanup.invocationFiles, "removed");
    assert.equal(existsSync(directory), false);
    assert.doesNotMatch(
      canonicalSerialize(diagnostic),
      /diagnostic-secret-bearing-identity|raw-owner-response|api[_-]?key/iu,
    );
  },
);

test("16. concurrent exact successor claims converge and a conflicting replay is inert", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-successor-"));
  const path = join(directory, "mission.sqlite");
  const missionId = "mission/concurrent-successor";
  const sessionId = "session/concurrent-successor";
  const left = new M4MissionStore({ path, now: () => HERO_HORIZON_END });
  const right = new M4MissionStore({ path, now: () => HERO_HORIZON_END });
  try {
    left.bindMission({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/concurrent-successor",
      trueforgeSessionId: sessionId,
      m2EnvironmentIdentity: databaseIdentity("m2/concurrent-successor"),
      factoryEnvironmentIdentity: databaseIdentity(
        "factory/concurrent-successor",
      ),
    });
    const common = {
      missionId,
      trueforgeSessionId: sessionId,
      previousTurnId: "turn/paused-predecessor",
      input: [
        {
          type: "user.tool_approval",
          threadId: "thread/root",
          toolCallId: "tool/approval",
          approval: { status: "allow" },
        },
      ],
    } as const;
    const [firstClaim, secondClaim] = await Promise.all([
      new Promise<ReturnType<M4MissionStore["claimSuccessorIntent"]>>(
        (resolve) =>
          setImmediate(() =>
            resolve(
              left.claimSuccessorIntent({
                ...common,
                ownerToken: "successor-owner/100001/left",
              }),
            ),
          ),
      ),
      new Promise<ReturnType<M4MissionStore["claimSuccessorIntent"]>>(
        (resolve) =>
          setImmediate(() =>
            resolve(
              right.claimSuccessorIntent({
                ...common,
                ownerToken: "successor-owner/100002/right",
              }),
            ),
          ),
      ),
    ]);
    assert.equal(firstClaim.intent.intentKey, secondClaim.intent.intentKey);
    assert.deepEqual(
      [firstClaim.claimed, secondClaim.claimed].sort(),
      [false, true],
    );
    assert.equal(left.getSnapshot(missionId).successorIntents.length, 1);
    const beforeConflict = canonicalSerialize(left.getSnapshot(missionId));
    assert.throws(
      () =>
        right.claimSuccessorIntent({
          ...common,
          input: [
            {
              type: "user.tool_approval",
              threadId: "thread/root",
              toolCallId: "tool/approval",
              approval: { status: "deny", reason: "conflicting decision" },
            },
          ],
          ownerToken: "successor-owner/100003/conflict",
        }),
      /conflicting input/u,
    );
    assert.equal(
      canonicalSerialize(left.getSnapshot(missionId)),
      beforeConflict,
    );
  } finally {
    right.close();
    left.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("17. malformed approval arguments are denied before durable business mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-malformed-approval-"));
  const m2Path = join(directory, "m2.sqlite");
  const factoryPath = join(directory, "factory.sqlite");
  const missionPath = join(directory, "mission.sqlite");
  const missionId = "mission/malformed-approval";
  const sessionId = "session/malformed-approval";
  const turnId = "turn/malformed-approval";
  const toolCallId = "tool/malformed-submit";
  const sourceEventId = "event/malformed-submit";
  const factory = new SyntheticFactoryEnvironment({
    path: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  factory.close();
  const initialStore = createStore({
    path: m2Path,
    initialState: createHeroInitialState(),
    authoritativeFactoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  initialStore.close();
  const before = m2Snapshot(m2Path);
  const modelEvent = {
    id: sourceEventId,
    type: "model.message",
    threadId: "main",
    createdAt: HERO_HORIZON_END,
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: "submit_schedule_change",
          arguments: JSON.stringify({
            execution_attempt_id: "attempt/malformed-submit",
            claim: {},
            schedule_change: "not-an-object",
          }),
        },
        toolInfo: {
          type: "mcp",
          name: "submit_schedule_change",
          serverId: "factory-change-control",
          serverName: "factory-change-control",
        },
      },
    ],
  } as TrueForgeApi.ModelMessageEvent;
  const required = {
    id: "event/malformed-approval-required",
    type: "tool.approval_required",
    threadId: "main",
    createdAt: HERO_HORIZON_END,
    toolCalls: [{ id: toolCallId, sourceEventId }],
  } as TrueForgeApi.ToolApprovalRequiredEvent;
  const done = {
    id: "event/malformed-turn-done",
    type: "turn.done",
    threadId: null,
    createdAt: HERO_HORIZON_END,
    state: {
      status: "done",
      completedAt: HERO_HORIZON_END,
      output: null,
      requiredActions: [required],
    },
  } as TrueForgeApi.TurnDoneEvent;
  let continuationCalls = 0;
  const trueforgeClient = {
    sessions: {
      getTurn: async () => ({ data: { id: turnId, state: done.state } }),
      listTurnEvents: async () => asyncPage([modelEvent, required, done]),
      listTurns: async () => asyncPage([]),
      createTurnStream: async (
        receivedSessionId: string,
        request: {
          previousTurnId: string;
          input: TrueForgeApi.TurnInputItem[];
        },
      ) => {
        continuationCalls += 1;
        assert.equal(receivedSessionId, sessionId);
        assert.equal(request.previousTurnId, turnId);
        assert.equal(request.input.length, 1);
        const input = request.input[0];
        assert.equal(input?.type, "user.tool_approval");
        if (input?.type !== "user.tool_approval") assert.fail("approval input missing");
        assert.equal(input.toolCallId, toolCallId);
        assert.equal(input.approval.status, "deny");
        assert.match(
          input.approval.status === "deny" ? input.approval.reason ?? "" : "",
          /schedule_change must be an object/u,
        );
        throw new Error("planned malformed-approval continuation");
      },
    },
  } as unknown as TrueForge;
  const missionStore = new M4MissionStore({
    path: missionPath,
    now: () => HERO_HORIZON_END,
  });
  try {
    missionStore.bindMission({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/malformed-approval",
      trueforgeSessionId: sessionId,
      m2EnvironmentIdentity: readDatabaseInstanceIdentity(
        m2Path,
        "m2",
        HERO_ENVIRONMENT_ID,
      ),
      factoryEnvironmentIdentity: readDatabaseInstanceIdentity(
        factoryPath,
        "factory",
        HERO_ENVIRONMENT_ID,
      ),
    });
    missionStore.advanceCursor(missionId, turnId, 3);
    const controller = new M4MissionController({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/malformed-approval",
      trueforgeSessionId: sessionId,
      trueforgeClient,
      missionStore,
      m2DatabasePath: m2Path,
      factoryDatabasePath: factoryPath,
      ownerDecisionProvider: (request: M4OwnerApprovalRequest) =>
        m4OwnerDecisionResponse(request, "test-owner/malformed-approval", {
          status: "allow",
        }),
    });
    await assert.rejects(
      controller.runToCompletion(),
      /planned malformed-approval continuation/u,
    );
    assert.equal(continuationCalls, 1);
    assert.equal(missionStore.getSnapshot(missionId).bridgeActions.length, 0);
    assert.equal(m2Snapshot(m2Path), before);
  } finally {
    missionStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("18. grouped approval calls are denied and retried only sequentially", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-grouped-approval-"));
  const m2Path = join(directory, "never-created-m2.sqlite");
  const factoryPath = join(directory, "never-created-factory.sqlite");
  const missionPath = join(directory, "mission.sqlite");
  const missionId = "mission/grouped-approval";
  const sessionId = "session/grouped-approval";
  const turnId = "turn/grouped-approval";
  const calls = ["tool/grouped-left", "tool/grouped-right"];
  initializeBoundEnvironment(m2Path, factoryPath);
  const before = m2Snapshot(m2Path);
  const modelEvent = {
    id: "event/grouped-source",
    type: "model.message",
    threadId: "main",
    createdAt: HERO_HORIZON_END,
    toolCalls: calls.map((id, index) => ({
      id,
      type: "function",
      function: {
        name:
          index === 0
            ? "create_schedule_reservation"
            : "submit_schedule_change",
        arguments: "{}",
      },
      toolInfo: {
        type: "mcp",
        name:
          index === 0
            ? "create_schedule_reservation"
            : "submit_schedule_change",
        serverId: "factory-change-control",
        serverName: "factory-change-control",
      },
    })),
  } as TrueForgeApi.ModelMessageEvent;
  const required = {
    id: "event/grouped-required",
    type: "tool.approval_required",
    threadId: "main",
    createdAt: HERO_HORIZON_END,
    toolCalls: calls.map((id) => ({ id, sourceEventId: modelEvent.id })),
  } as TrueForgeApi.ToolApprovalRequiredEvent;
  const done = {
    id: "event/grouped-done",
    type: "turn.done",
    threadId: null,
    createdAt: HERO_HORIZON_END,
    state: {
      status: "done",
      completedAt: HERO_HORIZON_END,
      output: null,
      requiredActions: [required],
    },
  } as TrueForgeApi.TurnDoneEvent;
  let continuationCalls = 0;
  const trueforgeClient = {
    sessions: {
      getTurn: async () => ({ data: { id: turnId, state: done.state } }),
      listTurnEvents: async () => asyncPage([modelEvent, required, done]),
      listTurns: async () => asyncPage([]),
      createTurnStream: async (
        _receivedSessionId: string,
        request: { input: TrueForgeApi.TurnInputItem[] },
      ) => {
        continuationCalls += 1;
        assert.equal(request.input.length, 2);
        assert.deepEqual(
          request.input.map((input) =>
            input.type === "user.tool_approval"
              ? [input.toolCallId, input.approval.status]
              : ["wrong-input", "wrong-input"],
          ),
          calls.map((id) => [id, "deny"]),
        );
        assert.ok(
          request.input.every(
            (input) =>
              input.type === "user.tool_approval" &&
              input.approval.status === "deny" &&
              input.approval.reason?.includes("retried sequentially") === true,
          ),
        );
        throw new Error("planned grouped-approval continuation");
      },
    },
  } as unknown as TrueForge;
  const missionStore = new M4MissionStore({
    path: missionPath,
    now: () => HERO_HORIZON_END,
  });
  try {
    missionStore.bindMission({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/grouped-approval",
      trueforgeSessionId: sessionId,
      m2EnvironmentIdentity: readDatabaseInstanceIdentity(
        m2Path,
        "m2",
        HERO_ENVIRONMENT_ID,
      ),
      factoryEnvironmentIdentity: readDatabaseInstanceIdentity(
        factoryPath,
        "factory",
        HERO_ENVIRONMENT_ID,
      ),
    });
    missionStore.advanceCursor(missionId, turnId, 3);
    const controller = new M4MissionController({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/grouped-approval",
      trueforgeSessionId: sessionId,
      trueforgeClient,
      missionStore,
      m2DatabasePath: m2Path,
      factoryDatabasePath: factoryPath,
      ownerDecisionProvider: (request) =>
        m4OwnerDecisionResponse(request, "test-owner/grouped-approval", {
          status: "allow",
        }),
    });
    await assert.rejects(
      controller.runToCompletion(),
      /planned grouped-approval continuation/u,
    );
    assert.equal(continuationCalls, 1);
    assert.equal(missionStore.getSnapshot(missionId).bridgeActions.length, 0);
    assert.equal(m2Snapshot(m2Path), before);
  } finally {
    missionStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "13. process restarts recover running, paused, claimed, and committed mission boundaries",
  { timeout: 180_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-recovery-"));
    const base: DeterministicM4MissionOptions = {
      m2DatabasePath: join(directory, "m2.sqlite"),
      factoryDatabasePath: join(directory, "factory.sqlite"),
      missionDatabasePath: join(directory, "mission.sqlite"),
      trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
      localSandboxRootParent: join(directory, "trueforge-data"),
      disconnectInitialStreamAfterEvents: 10_000,
    };
    const boundaries = [
      "running",
      "owner_decision",
      "denied_effect",
      "claimed_effect",
      "factory_committed",
    ] as const;
    let boundary = 0;
    const observed: string[] = [];
    const checkpointObserver = (checkpoint: M4MissionCheckpoint): void => {
      const expected = boundaries[boundary];
      const matched =
        (expected === "running" && checkpoint.phase === "running_turn") ||
        (expected === "owner_decision" &&
          checkpoint.phase === "approval_bridge_bound" &&
          checkpoint.approval.toolName === "select_portfolio_modification") ||
        (expected === "denied_effect" &&
          checkpoint.phase === "approval_bridge_bound" &&
          checkpoint.approval.source === "owner" &&
          checkpoint.approval.decision === "deny") ||
        (expected === "claimed_effect" &&
          checkpoint.phase === "approval_bridge_bound" &&
          checkpoint.approval.executionAttemptId ===
            "attempt/m4-approved-alternative") ||
        (expected === "factory_committed" &&
          checkpoint.phase === "factory_committed_before_verification");
      if (!matched || expected === undefined) return;
      observed.push(expected);
      boundary += 1;
      throw new Error(`planned M4 interruption at ${expected}`);
    };
    try {
      for (const expected of boundaries) {
        await assert.rejects(
          runDeterministicM4Mission({ ...base, checkpointObserver }),
          new RegExp(`planned M4 interruption at ${expected}`, "u"),
        );
      }
      const completed = await runDeterministicM4Mission(base);
      assert.deepEqual(observed, boundaries);
      assert.equal(completed.mission.status, "VERIFIED_COMPLETE");
      assert.equal(completed.subagentThreads.length, 3);
      assert.equal(controlledWriteCount(completed), 1);
      assert.equal(completed.actualConsumptionFacts, 2);
      assert.equal(completed.finalFence?.status, "factory_result_bound");
      assert.equal(
        completed.mission.approvals.filter(
          (approval) => approval.executionAttemptId !== null,
        ).length,
        1,
      );
      const store = createStore({ path: base.m2DatabasePath });
      try {
        assert.equal(store.getReservations(true).length, 1);
        assert.equal(store.getReservations(true)[0]?.claimState, "terminal_verified");
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Qodo R1.1 live mode without an external owner fails closed before mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-owner-"));
  const options = liveOptions(directory, {
    m0TrueForgeDatabasePath: join(directory, "missing-m0.sqlite"),
  });
  try {
    await assert.rejects(
      runLiveM4Mission(options as LiveM4MissionOptions),
      /external owner decision provider is required/u,
    );
    assert.deepEqual(readdirSync(directory), []);

    const wrongMissionDirectory = join(directory, "wrong-mission-owner");
    mkdirSync(wrongMissionDirectory);
    const wrongMissionOptions = {
      m2DatabasePath: join(wrongMissionDirectory, "m2.sqlite"),
      factoryDatabasePath: join(wrongMissionDirectory, "factory.sqlite"),
      missionDatabasePath: join(wrongMissionDirectory, "mission.sqlite"),
      trueforgeDatabasePath: join(wrongMissionDirectory, "trueforge.sqlite"),
      localSandboxRootParent: join(wrongMissionDirectory, "sandboxes"),
      ownerDecisionProvider: (request: M4OwnerApprovalRequest) => ({
        ...m4OwnerDecisionResponse(request, "test-owner/wrong-mission", {
          status: "allow",
        }),
        requestDigest: "sha256:wrong-mission-and-arguments",
      }),
    } satisfies DeterministicM4MissionOptions;
    await assert.rejects(
      runDeterministicM4Mission(wrongMissionOptions),
      /does not match the exact mission action and arguments/u,
    );
    const afterWrongOwner = createStore({
      path: wrongMissionOptions.m2DatabasePath,
    });
    try {
      assert.equal(
        afterWrongOwner.getPortfolio().versions.portfolioVersion,
        "portfolio/v1",
      );
      assert.equal(
        afterWrongOwner
          .getAdmissionHistory()
          .flatMap((admission) => admission.addenda)
          .some((addendum) => addendum.kind === "owner_choice"),
        false,
      );
    } finally {
      afterWrongOwner.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Qodo R1.2 a process-restarted live retry reuses its durable session and terminal result",
  { timeout: 180_000 },
  async (context) => {
    const provenM0Path = process.env["FLAKEBRAKE_M0_DATABASE_PATH"];
    if (provenM0Path === undefined) {
      context.skip("FLAKEBRAKE_M0_DATABASE_PATH is required for live resume coverage");
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-live-resume-"));
    const seedOptions: DeterministicM4MissionOptions = {
      m2DatabasePath: join(directory, "m2.sqlite"),
      factoryDatabasePath: join(directory, "factory.sqlite"),
      missionDatabasePath: join(directory, "mission.sqlite"),
      trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
      localSandboxRootParent: join(directory, "sandboxes"),
      missionId: M4_LIVE_MISSION_ID,
    };
    let ownerCallCount = 0;
    const options = {
      ...seedOptions,
      m0TrueForgeDatabasePath: provenM0Path,
      validationProfile: "full_hero_evidence",
      ownerDecisionProvider: (request: M4OwnerApprovalRequest) => {
        ownerCallCount += 1;
        return m4OwnerDecisionResponse(request, "test-owner/qodo-live-resume", {
          status: "allow",
        });
      },
    } satisfies LiveM4MissionOptions;
    await withLiveFailureDiagnostic(
      {
        directory,
        missionDatabasePath: options.missionDatabasePath,
        m2DatabasePath: options.m2DatabasePath,
        factoryDatabasePath: options.factoryDatabasePath,
        missionId: M4_LIVE_MISSION_ID,
        externalOwnerCallCount: () => ownerCallCount,
        usesLiveRunLock: true,
      },
      async () => {
      const seed = await runDeterministicM4Mission(seedOptions);
      assert.equal(seed.mission.missionId, M4_LIVE_MISSION_ID);
      const snapshotBefore = missionSnapshot(options.missionDatabasePath);
      const sessionsBefore = trueForgeSessionCount(
        options.trueforgeDatabasePath,
      );
      const retries = await Promise.allSettled([
        runLiveM4Mission(options),
        runLiveM4Mission(options),
      ]);
      assert.equal(retries[0]?.status, retries[1]?.status);
      if (retries[0]?.status === "fulfilled" && retries[1]?.status === "fulfilled") {
        assert.equal(
          retries[0].value.mission.trueforgeSessionId,
          retries[1].value.mission.trueforgeSessionId,
        );
        assert.equal(
          retries[0].value.mission.projectionDigest,
          retries[1].value.mission.projectionDigest,
        );
      } else if (
        retries[0]?.status === "rejected" &&
        retries[1]?.status === "rejected"
      ) {
        const messages = retries.map((retry) =>
          retry.status === "rejected" && retry.reason instanceof Error
            ? retry.reason.message
            : String(retry.status === "rejected" ? retry.reason : ""),
        );
        assert.equal(messages[0], messages[1]);
        assert.doesNotMatch(
          messages[0] ?? "",
          /binding conflicts|different TrueForge session|Internal server error/u,
        );
      }
      assert.equal(
        trueForgeSessionCount(options.trueforgeDatabasePath),
        sessionsBefore,
      );
      assert.equal(missionSnapshot(options.missionDatabasePath), snapshotBefore);
      },
    );
  },
);

test("Qodo R1.3 promise acceptance and grant issuance roll back as one unit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-atomic-"));
  const m2Path = join(directory, "m2.sqlite");
  const factoryPath = join(directory, "factory.sqlite");
  const store = createStore({
    path: m2Path,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  store.close();
  factory.close();
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: m2Path,
    factoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  try {
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      await client.callTool({ name: "record_current_admission", arguments: {} });
      const preparedModification = resultObject(
        (await client.callTool({
          name: "prepare_portfolio_modification",
          arguments: {},
        })) as CallToolResult,
      );
      await client.callTool({
        name: "select_portfolio_modification",
        arguments: record(preparedModification["arguments"], "modification"),
      });
      const preparedAcceptance = resultObject(
        (await client.callTool({
          name: "prepare_promise_acceptance",
          arguments: {},
        })) as CallToolResult,
      );
      const exact = record(preparedAcceptance["arguments"], "acceptance");
      const exactGrant = record(exact["grant"], "grant");
      const badGrant = {
        ...exactGrant,
        scope: {
          ...record(exactGrant["scope"], "grant scope"),
          objectiveId: "objective/qodo-injected-invalid",
        },
      };
      const failed = (await client.callTool({
        name: "accept_promise",
        arguments: { ...exact, grant: badGrant },
      })) as CallToolResult;
      assert.equal(failed.isError, true);

      const afterFailure = createStore({ path: m2Path });
      try {
        const admission = afterFailure.getAdmissionRecord(
          String(exact["admission_record_id"]),
        );
        assert.equal(
          admission.addenda.filter(
            (addendum) => addendum.kind === "acceptance_commit",
          ).length,
          0,
        );
        assert.equal(
          afterFailure.getPortfolio().versions.portfolioVersion,
          "portfolio/v2",
        );
      } finally {
        afterFailure.close();
      }

      const committed = resultObject(
        (await client.callTool({
          name: "accept_promise",
          arguments: exact,
        })) as CallToolResult,
      );
      assert.equal(record(committed["acceptance"], "acceptance")["status"], "COMMITTED");
      const replay = resultObject(
        (await client.callTool({
          name: "accept_promise",
          arguments: exact,
        })) as CallToolResult,
      );
      assert.equal(canonicalSerialize(replay), canonicalSerialize(committed));
    });
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Qodo R1.4 live M0 configuration is explicit and portable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake qodo portable "));
  const syntheticHome = join(directory, "synthetic home");
  mkdirSync(syntheticHome);
  const previousHome = process.env["HOME"];
  process.env["HOME"] = syntheticHome;
  try {
    await assert.rejects(
      runLiveM4Mission(
        liveOptions(directory, {
          model: "openai/qodo-not-proven",
          ownerDecisionProvider: deterministicM4OwnerDecisions(
            "test-owner/qodo-portable",
          ),
        }) as LiveM4MissionOptions,
      ),
      /explicit M0 TrueForge database path is required/u,
    );
    assert.deepEqual(readdirSync(directory), ["synthetic home"]);

    const portableM0Path = join(directory, "M0 configuration with spaces.sqlite");
    createSyntheticM0Database(portableM0Path);
    await assert.rejects(
      runLiveM4Mission(
        liveOptions(directory, {
          m0TrueForgeDatabasePath: portableM0Path,
          model: "openai/qodo-not-proven",
          ownerDecisionProvider: deterministicM4OwnerDecisions(
            "test-owner/qodo-portable",
          ),
        }) as LiveM4MissionOptions,
      ),
      /model openai\/qodo-not-proven was not proven by M0/u,
    );
    assert.deepEqual(readdirSync(directory).sort(), [
      "M0 configuration with spaces.sqlite",
      "synthetic home",
    ]);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Qodo R1.5 CLI rejects every malformed value-taking flag before allocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-cli-"));
  const cli = join(process.cwd(), "dist", "src", "m4-cli.js");
  const valueFlags = [
    "--m2-db",
    "--factory-db",
    "--mission-db",
    "--trueforge-db",
    "--sandbox-root",
    "--m0-db",
    "--model",
    "--owner-source",
  ] as const;
  try {
    for (const flag of valueFlags) {
      const missing = spawnM4Cli(cli, directory, [
        "--live",
        "--m0-db",
        join(directory, "missing.sqlite"),
        flag,
      ]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, new RegExp(`${flag} requires a value`, "u"));

      const followedByFlag = spawnM4Cli(cli, directory, [
        "--live",
        flag,
        "--model",
        "qodo-model",
      ]);
      assert.notEqual(followedByFlag.status, 0);
      assert.match(
        followedByFlag.stderr,
        new RegExp(`${flag} requires a value`, "u"),
      );

      const empty = spawnM4Cli(cli, directory, ["--live", flag, ""]);
      assert.notEqual(empty.status, 0);
      assert.match(empty.stderr, new RegExp(`${flag}.*empty`, "u"));

      const conflicting = spawnM4Cli(cli, directory, [
        "--live",
        flag,
        "first",
        flag,
        "second",
      ]);
      assert.notEqual(conflicting.status, 0);
      assert.match(conflicting.stderr, new RegExp(`${flag}.*conflicting`, "u"));
    }
    const unknown = spawnM4Cli(cli, directory, ["--unknown-qodo-flag"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option --unknown-qodo-flag/u);
    const help = spawnM4Cli(cli, directory, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: flakebrake.*m4/u);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Qodo R1.6 replacing a database at the bound pathname fails before mutation",
  { timeout: 180_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-incarnation-"));
    const options = liveOptions(directory);
    try {
      await runDeterministicM4Mission({
        ...options,
        missionId: "mission/qodo-database-incarnation",
      });
      const original = join(directory, "original-m2.sqlite");
      renameSync(options.m2DatabasePath, original);
      const replacement = createStore({
        path: options.m2DatabasePath,
        initialState: createHeroInitialState(),
        now: () => HERO_HORIZON_END,
      });
      const before = canonicalSerialize(replacement.getPortfolio());
      replacement.close();
      await assert.rejects(
        runDeterministicM4Mission({
          ...options,
          missionId: "mission/qodo-database-incarnation",
        }),
        /database instance identity.*conflicts/u,
      );
      const reopened = createStore({ path: options.m2DatabasePath });
      try {
        assert.equal(canonicalSerialize(reopened.getPortfolio()), before);
        assert.equal(reopened.getAdmissionHistory().length, 0);
      } finally {
        reopened.close();
      }

      rmSync(options.m2DatabasePath, { force: true });
      renameSync(original, options.m2DatabasePath);
      const originalFactory = join(directory, "original-factory.sqlite");
      renameSync(options.factoryDatabasePath, originalFactory);
      const replacementFactory = new SyntheticFactoryEnvironment({
        path: options.factoryDatabasePath,
        now: () => HERO_HORIZON_END,
      });
      const factoryBefore = canonicalSerialize(
        replacementFactory.getScheduleState(),
      );
      replacementFactory.close();
      await assert.rejects(
        runDeterministicM4Mission({
          ...options,
          missionId: "mission/qodo-database-incarnation",
        }),
        /database instance identity.*conflicts/u,
      );
      const reopenedFactory = new SyntheticFactoryEnvironment({
        path: options.factoryDatabasePath,
        now: () => HERO_HORIZON_END,
      });
      try {
        assert.equal(
          canonicalSerialize(reopenedFactory.getScheduleState()),
          factoryBefore,
        );
        assert.equal(reopenedFactory.getMutationCount(), 0);
      } finally {
        reopenedFactory.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Qodo R1.7 every acquired live server is cleaned after a later startup failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-startup-"));
  const m0Path = join(directory, "m0.sqlite");
  createSyntheticM0Database(m0Path);
  const invalidTrueForgePath = join(directory, "trueforge-directory");
  mkdirSync(invalidTrueForgePath);
  const before = new Set(activeServerHandles());
  let leaked: Server[] = [];
  try {
    await assert.rejects(
      runLiveM4Mission(
        liveOptions(directory, {
          m0TrueForgeDatabasePath: m0Path,
          trueforgeDatabasePath: invalidTrueForgePath,
          ownerDecisionProvider: deterministicM4OwnerDecisions(
            "test-owner/qodo-startup",
          ),
        }) as LiveM4MissionOptions,
      ),
    );
    await tick();
    leaked = activeServerHandles().filter(
      (server) => !before.has(server) && server.listening,
    );
    assert.equal(leaked.length, 0);

    const stageDirectory = join(directory, "stage boundaries");
    mkdirSync(stageDirectory);
    const stages = [
      "environment_initialized",
      "http_started",
      "trueforge_started",
      "mission_store_opened",
      "connectors_registered",
      "model_provider_configured",
    ] as const;
    for (const stage of stages) {
      const beforeStage = new Set(activeServerHandles());
      await assert.rejects(
        runLiveM4Mission({
          ...(liveOptions(stageDirectory, {
            m0TrueForgeDatabasePath: m0Path,
            ownerDecisionProvider: deterministicM4OwnerDecisions(
              "test-owner/qodo-startup-stages",
            ),
          }) as LiveM4MissionOptions),
          lifecycleObserver: (observed) => {
            if (observed === stage) {
              throw new Error(`planned startup failure after ${stage}`);
            }
          },
        }),
        new RegExp(`planned startup failure after ${stage}`, "u"),
      );
      await tick();
      assert.equal(
        activeServerHandles().filter(
          (server) => !beforeStage.has(server) && server.listening,
        ).length,
        0,
      );
    }
  } finally {
    await Promise.allSettled(leaked.map((server) => closeServer(server)));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Qodo R1.8 close drains or aborts a fragmented accepted body before returning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-http-close-"));
  const m2Path = join(directory, "m2.sqlite");
  const factoryPath = join(directory, "factory.sqlite");
  const store = createStore({
    path: m2Path,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  store.close();
  factory.close();
  const service = await startFactoryMcpHttpService("factory-change-control", {
    m2DatabasePath: m2Path,
    factoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  const socket = new Socket();
  const ownedServer = activeServerHandles().find((candidate) => {
    const address = candidate.address();
    return typeof address === "object" && address?.port === service.port;
  });
  assert.ok(ownedServer);
  const originalClose = Server.prototype.close;
  const originalCloseAll = Server.prototype.closeAllConnections;
  const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
  let markBodyReadStarted: (() => void) | undefined;
  const bodyReadStarted = new Promise<void>((resolve) => {
    markBodyReadStarted = resolve;
  });
  let closePromise: Promise<void> | undefined;
  try {
    Server.prototype.close = function (
      callback?: (error?: Error) => void,
    ): Server {
      if (callback !== undefined) queueMicrotask(() => callback());
      return this;
    };
    Server.prototype.closeAllConnections = function (): void {};
    IncomingMessage.prototype[Symbol.asyncIterator] = function () {
      markBodyReadStarted?.();
      return originalIterator.call(this);
    };
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(service.port, service.host, resolve);
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "record_current_admission", arguments: {} },
    });
    const split = Math.floor(body.length / 2);
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${service.host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-03-26\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: keep-alive\r\n\r\n${body.slice(0, split)}`,
    );
    await bodyReadStarted;
    closePromise = service.close();
    const premature = await Promise.race([
      closePromise.then(() => true),
      tick().then(() => false),
    ]);
    assert.equal(
      premature,
      false,
      "close must account for the accepted fragmented request before resolving",
    );
    const outcome = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 1_500),
      ),
    ]);
    assert.equal(outcome, "closed");
    socket.write(body.slice(split));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const after = createStore({ path: m2Path });
    try {
      assert.equal(after.getAdmissionHistory().length, 0);
    } finally {
      after.close();
    }
  } finally {
    Server.prototype.close = originalClose;
    Server.prototype.closeAllConnections = originalCloseAll;
    IncomingMessage.prototype[Symbol.asyncIterator] = originalIterator;
    socket.destroy();
    await closePromise;
    await closeServer(ownedServer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Qodo R2.1 live-run locking canonicalizes a non-existent path through a symlink parent",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r2-alias-"));
    const realParent = join(directory, "physical databases");
    const aliasParent = join(directory, "database alias");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, "dir");
    const m0Path = join(directory, "m0.sqlite");
    createSyntheticM0Database(m0Path);
    const common = liveOptions(realParent, {
      m0TrueForgeDatabasePath: m0Path,
      ownerDecisionProvider: deterministicM4OwnerDecisions(
        "test-owner/qodo-r2-alias",
      ),
    }) as LiveM4MissionOptions;
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = runLiveM4Mission({
      ...common,
      lifecycleObserver: async (stage) => {
        if (stage !== "environment_initialized") return;
        markFirstEntered?.();
        await firstGate;
        throw new Error("planned alias-lock release");
      },
    });
    void first.catch(() => undefined);
    try {
      await firstEntered;
      const second = runLiveM4Mission({
        ...common,
        missionDatabasePath: join(aliasParent, "mission.sqlite"),
        lifecycleObserver: (stage) => {
          if (stage !== "environment_initialized") return;
          secondEntered = true;
          throw new Error("planned alias-lock second release");
        },
      });
      void second.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        secondEntered,
        false,
        "the symlink spelling must wait behind the physical mission path",
      );
      releaseFirst?.();
      const results = await Promise.allSettled([first, second]);
      assert.deepEqual(
        results.map((result) => result.status),
        ["rejected", "rejected"],
      );

      let reacquired = false;
      await assert.rejects(
        runLiveM4Mission({
          ...common,
          missionDatabasePath: join(
            realParent,
            ".",
            "unused",
            "..",
            "mission.sqlite",
          ),
          lifecycleObserver: (stage) => {
            if (stage !== "environment_initialized") return;
            reacquired = true;
            throw new Error("planned alias-lock reacquisition");
          },
        }),
        /planned alias-lock reacquisition/u,
      );
      assert.equal(reacquired, true);
    } finally {
      releaseFirst?.();
      await Promise.allSettled([first]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Qodo R2.1 lock keys normalize existing, relative, dotted, and distinct paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r2-lock-keys-"));
  const physical = join(directory, "physical");
  const alias = join(directory, "alias");
  const distinct = join(directory, "distinct");
  mkdirSync(physical);
  mkdirSync(distinct);
  symlinkSync(physical, alias, "dir");
  const missionPath = join(physical, "mission.sqlite");
  const mission = new M4MissionStore({ path: missionPath });
  mission.close();
  const fileAlias = join(directory, "mission-file-alias.sqlite");
  symlinkSync(missionPath, fileAlias);
  try {
    const physicalKey = canonicalLiveDatabasePath(missionPath);
    assert.equal(canonicalLiveDatabasePath(fileAlias), physicalKey);
    assert.equal(
      canonicalLiveDatabasePath(relative(process.cwd(), missionPath)),
      physicalKey,
    );
    assert.equal(
      canonicalLiveDatabasePath(join(physical, ".", "child", "..", "future.sqlite")),
      canonicalLiveDatabasePath(join(alias, "future.sqlite")),
    );
    assert.notEqual(
      canonicalLiveDatabasePath(join(distinct, "future.sqlite")),
      canonicalLiveDatabasePath(join(alias, "future.sqlite")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Qodo R2.1 genuine real-path and symlink live retries converge on one mission",
  { timeout: 900_000 },
  async (context) => {
    const provenM0Path = process.env["FLAKEBRAKE_M0_DATABASE_PATH"];
    if (provenM0Path === undefined) {
      context.skip("FLAKEBRAKE_M0_DATABASE_PATH is required for genuine alias coverage");
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r2-live-alias-"));
    const physical = join(directory, "physical live state");
    const alias = join(directory, "live state alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    const policy = deterministicM4OwnerDecisions(
      "test-owner/qodo-r2-genuine-alias",
    );
    const ownerCalls: Array<{
      readonly requestDigest: string;
      readonly responseDigest: string;
      readonly toolName: string;
      readonly phase: M4OwnerApprovalRequest["phase"];
      readonly decision: "allow" | "deny";
      readonly ownerSourceIdentity: string;
    }> = [];
    const ownerDecisionProvider = async (request: M4OwnerApprovalRequest) => {
      const response = await policy(request);
      ownerCalls.push({
        requestDigest: request.requestDigest,
        responseDigest: response.requestDigest,
        toolName: request.toolName,
        phase: request.phase,
        decision: response.decision.status,
        ownerSourceIdentity: response.ownerSourceIdentity,
      });
      return response;
    };
    const physicalOptions = liveOptions(physical, {
      m0TrueForgeDatabasePath: provenM0Path,
      validationProfile: "operational_convergence",
      ownerDecisionProvider,
    }) as LiveM4MissionOptions;
    const aliasOptions = liveOptions(alias, {
      m0TrueForgeDatabasePath: provenM0Path,
      validationProfile: "operational_convergence",
      ownerDecisionProvider,
    }) as LiveM4MissionOptions;
    await withLiveFailureDiagnostic(
      {
        directory,
        missionDatabasePath: physicalOptions.missionDatabasePath,
        m2DatabasePath: physicalOptions.m2DatabasePath,
        factoryDatabasePath: physicalOptions.factoryDatabasePath,
        missionId: M4_LIVE_MISSION_ID,
        externalOwnerCallCount: () => ownerCalls.length,
        usesLiveRunLock: true,
      },
      async () => {
      const serverHandlesBefore = new Set(activeServerHandles());
      const childHandlesBefore = new Set(activeChildProcessHandles());
      const [first, second] = await Promise.all([
        runLiveM4Mission(physicalOptions),
        runLiveM4Mission(aliasOptions),
      ]);
      assertOperationalLiveConvergence(first, second);
      assert.equal(first.mission.trueforgeSessionId, second.mission.trueforgeSessionId);
      assert.equal(first.mission.missionId, second.mission.missionId);
      assert.equal(first.mission.finalTurnId, second.mission.finalTurnId);
      assert.equal(first.mission.projectionDigest, second.mission.projectionDigest);
      assert.equal(first.mission.status, "VERIFIED_COMPLETE");
      assert.equal(second.mission.status, "VERIFIED_COMPLETE");
      assert.equal(ownerCalls.length, 4);
      assert.equal(
        new Set(ownerCalls.map((call) => call.requestDigest)).size,
        4,
      );
      assert.ok(
        ownerCalls.every(
          (call) =>
            call.requestDigest === call.responseDigest &&
            call.ownerSourceIdentity === "test-owner/qodo-r2-genuine-alias",
        ),
      );
      assert.deepEqual(
        ownerCalls
          .filter((call) => call.toolName === "select_portfolio_modification")
          .map((call) => call.decision),
        ["allow"],
      );
      assert.deepEqual(
        ownerCalls
          .filter((call) => call.toolName === "accept_promise")
          .map((call) => call.decision),
        ["allow"],
      );
      const consequentialOwnerCalls = ownerCalls.filter(
        (call) => call.phase === "consequential_effect",
      );
      assert.equal(consequentialOwnerCalls.length, 2);
      assert.equal(
        consequentialOwnerCalls.filter((call) => call.decision === "deny")
          .length,
        1,
      );
      assert.equal(
        consequentialOwnerCalls.filter((call) => call.decision === "allow")
          .length,
        1,
      );
      assert.equal(first.controlledWriteCount, 1);
      assert.equal(second.controlledWriteCount, 1);
      assert.equal(first.actualConsumptionFacts, 2);
      assert.equal(second.actualConsumptionFacts, 2);
      assert.equal(trueForgeSessionCount(physicalOptions.trueforgeDatabasePath), 1);
      assert.equal(sqliteRowCount(physicalOptions.missionDatabasePath, "m4_missions"), 1);
      assert.equal(sqliteRowCount(physicalOptions.m2DatabasePath, "execution_attempts"), 1);
      assert.equal(
        sqliteRowCount(
          physicalOptions.m2DatabasePath,
          "admission_addenda",
          "kind = 'acceptance_commit'",
        ),
        1,
      );
      assert.equal(
        sqliteRowCount(
          physicalOptions.m2DatabasePath,
          "admission_addenda",
          "kind = 'actual_consumption'",
        ),
        2,
      );
      assert.equal(
        sqliteRowCount(physicalOptions.factoryDatabasePath, "mutation_events"),
        1,
      );
      assert.equal(
        sqliteRowCount(physicalOptions.factoryDatabasePath, "execution_results"),
        1,
      );
      const store = createStore({ path: physicalOptions.m2DatabasePath });
      try {
        const reservations = store.getReservations(true);
        assert.equal(reservations.length, 1);
        assert.equal(reservations[0]?.claimState, "terminal_verified");
        assert.equal(store.getAdmissionHistory().length, 3);
      } finally {
        store.close();
      }
      await tick();
      assert.deepEqual(
        activeServerHandles().filter(
          (handle) => !serverHandlesBefore.has(handle) && handle.listening,
        ),
        [],
      );
      assert.deepEqual(
        activeChildProcessHandles().filter(
          (handle) => !childHandlesBefore.has(handle),
        ),
        [],
      );
      },
    );
  },
);

for (const schedule of [
  "m2_while_awaiting_owner",
  "factory_while_awaiting_owner",
  "after_owner_before_continuation",
  "factory_mutation_adapter_boundary",
] as const) {
  test(
    `Qodo R2.2 ${schedule} invalidates approval with complete zero-mutation snapshots`,
    { timeout: 180_000 },
    async () => testDatabaseSwapSchedule(schedule),
  );
}

test(
  "Qodo R2.2 no-swap control reaches one terminal mutation",
  { timeout: 180_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r2-no-swap-"));
    try {
      const completed = await runDeterministicM4Mission({
        ...liveOptions(directory),
        ownerDecisionProvider: deterministicM4OwnerDecisions(
          "test-owner/qodo-r2-no-swap",
        ),
      });
      assert.equal(completed.mission.status, "VERIFIED_COMPLETE");
      assert.equal(controlledWriteCount(completed), 1);
      assert.equal(completed.actualConsumptionFacts, 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Qodo R2.3 MCP acceptance replay rejects a changed approver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r2-approver-"));
  const m2Path = join(directory, "m2.sqlite");
  const factoryPath = join(directory, "factory.sqlite");
  initializeBoundEnvironment(m2Path, factoryPath);
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: m2Path,
    factoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  try {
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      await client.callTool({ name: "record_current_admission", arguments: {} });
      const modification = resultObject(
        (await client.callTool({
          name: "prepare_portfolio_modification",
          arguments: {},
        })) as CallToolResult,
      );
      await client.callTool({
        name: "select_portfolio_modification",
        arguments: record(modification["arguments"], "modification"),
      });
      const prepared = resultObject(
        (await client.callTool({
          name: "prepare_promise_acceptance",
          arguments: {},
        })) as CallToolResult,
      );
      const exact = record(prepared["arguments"], "acceptance");
      const committed = resultObject(
        (await client.callTool({ name: "accept_promise", arguments: exact })) as CallToolResult,
      );
      const beforeConflict = completeDatabaseSnapshot(m2Path);
      const conflict = (await client.callTool({
        name: "accept_promise",
        arguments: { ...exact, approver_id: "owner/qodo-r2-conflict" },
      })) as CallToolResult;
      assert.equal(conflict.isError, true);
      assert.equal(completeDatabaseSnapshot(m2Path), beforeConflict);
      const replay = resultObject(
        (await client.callTool({ name: "accept_promise", arguments: exact })) as CallToolResult,
      );
      assert.equal(canonicalSerialize(replay), canonicalSerialize(committed));
    });
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Qodo R3.1 a replacement M2 database cannot receive portfolio mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r3-handle-"));
  const originalM2 = join(directory, "original-m2.sqlite");
  const replacementM2 = join(directory, "replacement-m2.sqlite");
  const originalFactory = join(directory, "original-factory.sqlite");
  const activeM2 = join(directory, "active-m2.sqlite");
  const activeFactory = join(directory, "active-factory.sqlite");
  initializeBoundEnvironment(originalM2, originalFactory);
  initializeBoundEnvironment(replacementM2, originalFactory);
  symlinkSync(originalM2, activeM2);
  symlinkSync(originalFactory, activeFactory);
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: activeM2,
    factoryDatabasePath: activeFactory,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  const originalGetAdmissionRecord =
    FlakeBrakeStore.prototype.getAdmissionRecord;
  let swapped = false;
  try {
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      await client.callTool({ name: "record_current_admission", arguments: {} });
      cloneAdmissionLedger(originalM2, replacementM2);
      const prepared = resultObject(
        (await client.callTool({
          name: "prepare_portfolio_modification",
          arguments: {},
        })) as CallToolResult,
      );
      const exact = record(prepared["arguments"], "portfolio modification");
      const sourceAdmissionId = String(exact["admission_record_id"]);
      const beforeOriginal = completeDatabaseSnapshot(originalM2);
      const beforeReplacement = completeDatabaseSnapshot(replacementM2);
      FlakeBrakeStore.prototype.getAdmissionRecord = function (admissionId) {
        const result = originalGetAdmissionRecord.call(this, admissionId);
        if (!swapped && admissionId === sourceAdmissionId) {
          repointSymlink(activeM2, replacementM2);
          swapped = true;
        }
        return result;
      };
      const rejected = (await client.callTool({
        name: "select_portfolio_modification",
        arguments: exact,
      })) as CallToolResult;
      assert.equal(rejected.isError, true);
      assert.equal(swapped, true);
      assert.equal(completeDatabaseSnapshot(originalM2), beforeOriginal);
      assert.equal(completeDatabaseSnapshot(replacementM2), beforeReplacement);
    });
  } finally {
    FlakeBrakeStore.prototype.getAdmissionRecord = originalGetAdmissionRecord;
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const stage of [
  "before_open",
  "after_first_open",
  "handles_validated",
] as const) {
  test(`Qodo R3.1 replacement at ${stage} leaves both databases unchanged`, async () => {
    await testVerifiedHandleReplacementStage(stage);
  });
}

test("Qodo R3.1 verified-handle no-replacement control readmits once", async () => {
  await testVerifiedHandleReplacementStage("no_replacement");
});

test(
  "Qodo R3.2 every independently shared live database serializes",
  { timeout: 60_000 },
  async (context) => {
    for (const resource of ["m2", "factory", "mission", "trueforge"] as const) {
      await context.test(`shared ${resource} only`, async () => {
        await assertLiveResourceLocking([resource], true, false);
      });
    }
    await context.test("shared M2 through a symlink alias", async () => {
      await assertLiveResourceLocking(["m2"], true, true);
    });
    await context.test("opposite overlapping resource spellings do not deadlock", async () => {
      await assertLiveResourceLocking(["m2", "factory"], true, true);
    });
    await context.test("entirely disjoint runs proceed concurrently", async () => {
      await assertLiveResourceLocking([], false, false);
    });
    await context.test("partial acquisition failure releases every acquired key", async () => {
      await assertPartialLiveResourceLockRelease();
    });
  },
);

test("Qodo R3.3 schedule read rejects a replaced configured factory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r3-read-"));
  const m2Path = join(directory, "m2.sqlite");
  const originalFactory = join(directory, "original-factory.sqlite");
  const replacementFactory = join(directory, "replacement-factory.sqlite");
  const activeFactory = join(directory, "active-factory.sqlite");
  initializeBoundEnvironment(m2Path, originalFactory);
  initializeBoundEnvironment(join(directory, "replacement-m2.sqlite"), replacementFactory);
  symlinkSync(originalFactory, activeFactory);
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: m2Path,
    factoryDatabasePath: activeFactory,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  try {
    const beforeOriginal = completeDatabaseSnapshot(originalFactory);
    const beforeReplacement = completeDatabaseSnapshot(replacementFactory);
    repointSymlink(activeFactory, replacementFactory);
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      const result = (await client.callTool({
        name: "read_schedule_state",
        arguments: {},
      })) as CallToolResult;
      assert.equal(result.isError, true);
    });
    assert.equal(completeDatabaseSnapshot(originalFactory), beforeOriginal);
    assert.equal(completeDatabaseSnapshot(replacementFactory), beforeReplacement);
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const stage of ["after_first_open", "handles_validated"] as const) {
  test(`Qodo R3.3 schedule read rejects replacement at ${stage}`, async () => {
    await testScheduleReadReplacementStage(stage);
  });
}

test("Qodo R3.3 original database resumes and no-swap read reports its basis", async () => {
  await testScheduleReadReplacementStage("no_replacement");
});

test("Qodo R3.5 current admission never replays a stale portfolio basis", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r3-admission-"));
  const m2Path = join(directory, "m2.sqlite");
  const factoryPath = join(directory, "factory.sqlite");
  initializeBoundEnvironment(m2Path, factoryPath);
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: m2Path,
    factoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
  });
  try {
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      const first = resultObject(
        (await client.callTool({
          name: "record_current_admission",
          arguments: {},
        })) as CallToolResult,
      );
      assert.equal(first["portfolioVersion"], "portfolio/v1");
      const prepared = resultObject(
        (await client.callTool({
          name: "prepare_portfolio_modification",
          arguments: {},
        })) as CallToolResult,
      );
      resultObject(
        (await client.callTool({
          name: "select_portfolio_modification",
          arguments: record(prepared["arguments"], "portfolio modification"),
        })) as CallToolResult,
      );
      const current = resultObject(
        (await client.callTool({
          name: "record_current_admission",
          arguments: {},
        })) as CallToolResult,
      );
      assert.equal(current["portfolioVersion"], "portfolio/v2");
      assert.equal(current["decision"], "ADMITTABLE");
      assert.notEqual(current["admissionRecordId"], first["admissionRecordId"]);
    });
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withHttpClient<T>(
  cluster: RunningFactoryMcpHttpCluster,
  serviceName: (typeof FACTORY_MCP_SERVICE_NAMES)[number],
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const service = cluster.services.get(serviceName);
  assert.ok(service);
  const client = new Client({
    name: `flakebrake-m4-test-${serviceName}`,
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(service.url));
  await client.connect(transport as unknown as Transport);
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

type PartialLiveM4MissionOptions = Omit<
  LiveM4MissionOptions,
  "m0TrueForgeDatabasePath" | "ownerDecisionProvider"
> &
  Partial<
    Pick<
      LiveM4MissionOptions,
      "m0TrueForgeDatabasePath" | "ownerDecisionProvider"
    >
  >;

function liveOptions(
  directory: string,
  overrides: Partial<LiveM4MissionOptions> = {},
): PartialLiveM4MissionOptions {
  return {
    m2DatabasePath: join(directory, "m2.sqlite"),
    factoryDatabasePath: join(directory, "factory.sqlite"),
    missionDatabasePath: join(directory, "mission.sqlite"),
    trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
    localSandboxRootParent: join(directory, "sandboxes"),
    ...overrides,
  };
}

async function withLiveFailureDiagnostic<T>(
  input: {
    readonly directory: string;
    readonly missionDatabasePath: string;
    readonly m2DatabasePath: string;
    readonly factoryDatabasePath: string;
    readonly missionId: string;
    readonly externalOwnerCallCount: () => number;
    readonly usesLiveRunLock: boolean;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const serversBefore = new Set(
    activeServerHandles().filter((server) => server.listening),
  );
  const childrenBefore = new Set(activeChildProcessHandles());
  let diagnosticError: LiveDiagnosticError | undefined;
  try {
    return await operation();
  } catch (error: unknown) {
    const diagnostic = captureLiveFailureDiagnostic({
      ...input,
      error,
      serversBefore,
      childrenBefore,
    });
    diagnosticError = attachLiveFailureDiagnostic(error, diagnostic);
    throw diagnosticError;
  } finally {
    rmSync(input.directory, { recursive: true, force: true });
    if (diagnosticError !== undefined) {
      diagnosticError.flakeBrakeLiveDiagnostic.cleanup.invocationFiles =
        existsSync(input.directory) ? "present" : "removed";
      refreshLiveDiagnosticError(diagnosticError);
    }
  }
}

function captureLiveFailureDiagnostic(input: {
  readonly missionDatabasePath: string;
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly missionId: string;
  readonly externalOwnerCallCount: () => number;
  readonly usesLiveRunLock: boolean;
  readonly error: unknown;
  readonly serversBefore: ReadonlySet<Server>;
  readonly childrenBefore: ReadonlySet<unknown>;
}): LiveFailureDiagnostic {
  const mission = readMissionDiagnostic(
    input.missionDatabasePath,
    input.missionId,
  );
  const m2 = readM2Diagnostic(input.m2DatabasePath);
  const factory = readFactoryDiagnostic(input.factoryDatabasePath);
  const counts: LiveDiagnosticCounts = { ...m2.counts, ...factory };
  const transitions = symbolicDiagnosticTransitions(m2, factory);
  const boundedFailure =
    input.error instanceof Error &&
    input.error.message.includes(
      "exceeded bounded durable-phase continuation limit",
    );
  const continuationCount =
    mission.continuationRequests + (boundedFailure ? 1 : 0);
  const repetitionDetected = continuationCount > transitions.length;
  const effectsAreAbsent =
    counts.acceptances === 0 &&
    counts.grants === 0 &&
    counts.attempts === 0 &&
    counts.fences === 0 &&
    counts.mutations === 0 &&
    counts.receipts === 0 &&
    counts.terminalEvents === 0 &&
    counts.actualFacts === 0;
  return {
    schemaVersion: "flakebrake-live-failure-diagnostic/v1",
    capturedBeforeInvocationCleanup: true,
    configuredContinuationLimit: LIVE_DIAGNOSTIC_CONTINUATION_LIMIT,
    continuationCount,
    continuationRequests: mission.continuationRequests,
    symbolicDurablePhaseTransitions: transitions,
    repetition: {
      detected: repetitionDetected,
      firstRepeatedPhase:
        !repetitionDetected
          ? null
          : transitions.length === 1
            ? transitions[0] ?? "unlocalized"
            : "unlocalized",
    },
    actions: mission.actions,
    externalOwnerCallCount: input.externalOwnerCallCount(),
    identities: mission.identities,
    missionTerminalDiscriminant:
      counts.terminalEvents === 1 ? "terminal_verified" : "nonterminal",
    m2TerminalDiscriminant:
      transitions.at(-1) ?? "awaiting_initial_admission",
    counts,
    duplicateIndicators: {
      admissions: counts.admissions > 3,
      acceptances: counts.acceptances > 1,
      grants: counts.grants > 1,
      attempts: counts.attempts > 1,
      fences: counts.fences > 1,
      mutations: counts.mutations > 1,
      receipts: counts.receipts > 1,
      terminalEvents: counts.terminalEvents > 1,
      actualFacts: counts.actualFacts > 2,
    },
    failureClosed: effectsAreAbsent,
    cleanup: {
      listeners: activeServerHandles().some(
        (server) => server.listening && !input.serversBefore.has(server),
      )
        ? "leaked"
        : "clean",
      processes: activeChildProcessHandles().some(
        (child) => !input.childrenBefore.has(child),
      )
        ? "leaked"
        : "clean",
      liveRunLock: input.usesLiveRunLock ? "released" : "not_applicable",
      invocationFiles: "pending",
    },
  };
}

function readMissionDiagnostic(
  path: string,
  missionId: string,
): {
  readonly continuationRequests: number;
  readonly actions: LiveFailureDiagnostic["actions"];
  readonly identities: LiveFailureDiagnostic["identities"];
} {
  if (!existsSync(path)) {
    return {
      continuationRequests: 0,
      actions: [],
      identities: { mission: null, session: null, cursor: null },
    };
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const binding = database
      .prepare(
        `SELECT mission_id, trueforge_session_id, current_turn_id
           FROM m4_missions WHERE mission_id = ?`,
      )
      .get(missionId) as Record<string, unknown> | undefined;
    const intents = database
      .prepare(
        `SELECT previous_turn_id, input_json
           FROM m4_successor_intents
          WHERE mission_id = ?`,
      )
      .all(missionId) as Record<string, unknown>[];
    const continuationRequests = intents.filter((intent) => {
      if (intent["previous_turn_id"] === "none") return false;
      try {
        const parsed = JSON.parse(String(intent["input_json"]));
        return (
          Array.isArray(parsed) &&
          parsed.some(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              (item as Record<string, unknown>)["type"] === "user.message",
          )
        );
      } catch {
        return false;
      }
    }).length;
    const rows = database
      .prepare(
        `SELECT action.tool_name, action.action_kind, outcome.result_json
           FROM m4_bridge_actions AS action
           LEFT JOIN m4_bridge_events AS outcome
             ON outcome.bridge_key = action.bridge_key
            AND outcome.status = 'approval_bound'
          WHERE action.mission_id = ?
          ORDER BY action.rowid`,
      )
      .all(missionId) as Record<string, unknown>[];
    const actions = rows.map((row) => {
      let outcome: LiveFailureDiagnostic["actions"][number]["outcome"] =
        "unbound";
      let approvalOrigin: LiveFailureDiagnostic["actions"][number]["approvalOrigin"] =
        "none";
      if (typeof row["result_json"] === "string") {
        try {
          const result = JSON.parse(row["result_json"] as string) as Record<
            string,
            unknown
          >;
          outcome =
            result["decision"] === "allow" || result["decision"] === "deny"
              ? result["decision"]
              : "invalid";
          approvalOrigin =
            result["source"] === "owner"
              ? "owner"
              : result["source"] === "active_m2_denial"
                ? "mechanical_denial"
                : "invalid";
        } catch {
          outcome = "invalid";
          approvalOrigin = "invalid";
        }
      }
      return {
        actionType: diagnosticActionType(row["tool_name"]),
        actionKind: diagnosticActionKind(row["action_kind"]),
        outcome,
        approvalOrigin,
      };
    });
    return {
      continuationRequests,
      actions,
      identities: {
        mission: diagnosticIdentity(binding?.["mission_id"]),
        session: diagnosticIdentity(binding?.["trueforge_session_id"]),
        cursor: diagnosticIdentity(binding?.["current_turn_id"]),
      },
    };
  } finally {
    database.close();
  }
}

function readM2Diagnostic(path: string): {
  readonly counts: Omit<LiveDiagnosticCounts, "mutations" | "receipts">;
  readonly replanAdmissions: number;
  readonly admittableAdmissions: number;
} {
  const empty = {
    counts: {
      admissions: 0,
      acceptances: 0,
      grants: 0,
      attempts: 0,
      fences: 0,
      terminalEvents: 0,
      actualFacts: 0,
    },
    replanAdmissions: 0,
    admittableAdmissions: 0,
  };
  if (!existsSync(path)) return empty;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      counts: {
        admissions: diagnosticRowCount(database, "admission_records"),
        acceptances: diagnosticRowCount(
          database,
          "admission_addenda",
          "kind = 'acceptance_commit'",
        ),
        grants: diagnosticRowCount(database, "grants"),
        attempts: diagnosticRowCount(database, "execution_attempts"),
        fences: diagnosticRowCount(database, "execution_fences"),
        terminalEvents: diagnosticRowCount(
          database,
          "reservation_events",
          "event_kind = 'terminal_verified'",
        ),
        actualFacts: diagnosticRowCount(
          database,
          "admission_addenda",
          "kind = 'actual_consumption'",
        ),
      },
      replanAdmissions: diagnosticRowCount(
        database,
        "admission_records",
        "decision = 'REPLAN'",
      ),
      admittableAdmissions: diagnosticRowCount(
        database,
        "admission_records",
        "decision = 'ADMITTABLE'",
      ),
    };
  } finally {
    database.close();
  }
}

function readFactoryDiagnostic(
  path: string,
): Pick<LiveDiagnosticCounts, "mutations" | "receipts"> {
  if (!existsSync(path)) return { mutations: 0, receipts: 0 };
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      mutations: diagnosticRowCount(database, "mutation_events"),
      receipts: diagnosticRowCount(database, "execution_results"),
    };
  } finally {
    database.close();
  }
}

function diagnosticRowCount(
  database: DatabaseSync,
  table: string,
  predicate?: string,
): number {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    )
    .get(table);
  if (exists === undefined) return 0;
  const where = predicate === undefined ? "" : ` WHERE ${predicate}`;
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`)
    .get() as Record<string, unknown> | undefined;
  return typeof row?.["count"] === "number" ? (row["count"] as number) : 0;
}

function symbolicDiagnosticTransitions(
  m2: ReturnType<typeof readM2Diagnostic>,
  factory: Pick<LiveDiagnosticCounts, "mutations" | "receipts">,
): LiveDiagnosticPhase[] {
  const transitions: LiveDiagnosticPhase[] = ["awaiting_initial_admission"];
  if (m2.replanAdmissions > 0) transitions.push("awaiting_fresh_readmission");
  if (m2.admittableAdmissions > 0) {
    transitions.push("awaiting_promise_acceptance");
  }
  if (m2.counts.acceptances > 0) transitions.push("awaiting_approved_attempt");
  if (m2.counts.attempts > 0) transitions.push("awaiting_factory_commit");
  if (factory.receipts > 0) transitions.push("awaiting_independent_verification");
  if (m2.counts.terminalEvents > 0) transitions.push("verified_complete");
  return transitions;
}

function diagnosticIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function diagnosticActionType(value: unknown): string {
  return typeof value === "string" &&
    [
      "select_portfolio_modification",
      "accept_promise",
      "create_schedule_reservation",
      "submit_schedule_change",
      "verify_schedule_execution",
    ].includes(value)
    ? value
    : "unknown_tool";
}

function diagnosticActionKind(value: unknown): string {
  return value === "owner_decision" ||
    value === "consequential_effect" ||
    value === "verification"
    ? value
    : "invalid";
}

function attachLiveFailureDiagnostic(
  error: unknown,
  diagnostic: LiveFailureDiagnostic,
): LiveDiagnosticError {
  const originalMessage =
    error instanceof Error ? error.message : "Genuine live mission failed";
  const attached = new Error(originalMessage, { cause: error }) as LiveDiagnosticError;
  Object.defineProperties(attached, {
    flakeBrakeLiveDiagnostic: { value: diagnostic, enumerable: true },
    flakeBrakeOriginalMessage: { value: originalMessage },
  });
  refreshLiveDiagnosticError(attached);
  return attached;
}

function refreshLiveDiagnosticError(error: LiveDiagnosticError): void {
  error.message = `${error.flakeBrakeOriginalMessage}\n${LIVE_DIAGNOSTIC_MARKER}${canonicalSerialize(error.flakeBrakeLiveDiagnostic)}`;
}

function liveDiagnosticFromError(error: unknown): LiveFailureDiagnostic {
  assert.ok(error instanceof Error);
  const diagnostic = (error as Partial<LiveDiagnosticError>)
    .flakeBrakeLiveDiagnostic;
  assert.ok(diagnostic);
  return diagnostic;
}

function seedDiagnosticEffectCounts(m2Path: string, factoryPath: string): void {
  const m2 = new DatabaseSync(m2Path);
  try {
    for (let index = 1; index <= 4; index += 1) {
      m2.prepare(
        `INSERT INTO admission_records
           (admission_record_id, created_at, decision,
            proposal_obligation_id, body_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        `admission/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
        index === 1 ? "REPLAN" : "ADMITTABLE",
        `obligation/diagnostic-${String(index)}`,
        "{}",
      );
    }
    for (let index = 1; index <= 2; index += 1) {
      m2.prepare(
        `INSERT INTO admission_addenda
           (addendum_id, admission_record_id, created_at, kind, body_json)
         VALUES (?, ?, ?, 'acceptance_commit', '{}')`,
      ).run(
        `addendum/diagnostic-acceptance-${String(index)}`,
        "admission/diagnostic-2",
        HERO_HORIZON_END,
      );
      m2.prepare(
        `INSERT INTO grant_allowances
           (grant_allowance_key, created_at, body_json)
         VALUES (?, ?, '{}')`,
      ).run(`allowance/diagnostic-${String(index)}`, HERO_HORIZON_END);
      m2.prepare(
        `INSERT INTO grants
           (grant_id, grant_allowance_key, created_at, body_json)
         VALUES (?, ?, ?, '{}')`,
      ).run(
        `grant/diagnostic-${String(index)}`,
        `allowance/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
      m2.prepare(
        `INSERT INTO execution_attempts
           (execution_attempt_id, admission_record_id, created_at,
            input_json, result_json)
         VALUES (?, ?, ?, '{}', '{}')`,
      ).run(
        `attempt/diagnostic-${String(index)}`,
        "admission/diagnostic-2",
        HERO_HORIZON_END,
      );
      m2.prepare(
        `INSERT INTO execution_fences
           (fence_id, execution_attempt_id, created_at, body_json)
         VALUES (?, ?, ?, '{}')`,
      ).run(
        `fence/diagnostic-${String(index)}`,
        `attempt/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
      m2.prepare(
        `INSERT INTO inflight_reservations
           (reservation_id, execution_attempt_id, created_at, body_json)
         VALUES (?, ?, ?, '{}')`,
      ).run(
        `reservation/diagnostic-${String(index)}`,
        `attempt/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
      m2.prepare(
        `INSERT INTO reservation_events
           (reservation_event_id, reservation_id, created_at,
            event_kind, body_json)
         VALUES (?, ?, ?, 'terminal_verified', '{}')`,
      ).run(
        `reservation-event/diagnostic-${String(index)}`,
        `reservation/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
    }
    for (let index = 1; index <= 3; index += 1) {
      m2.prepare(
        `INSERT INTO admission_addenda
           (addendum_id, admission_record_id, created_at, kind, body_json)
         VALUES (?, ?, ?, 'actual_consumption', '{}')`,
      ).run(
        `addendum/diagnostic-actual-${String(index)}`,
        "admission/diagnostic-2",
        HERO_HORIZON_END,
      );
    }
  } finally {
    m2.close();
  }

  const factory = new DatabaseSync(factoryPath);
  try {
    for (let index = 1; index <= 2; index += 1) {
      factory.prepare(
        `INSERT INTO execution_results
           (execution_attempt_id, fence_id, request_json,
            result_json, receipt_id, created_at)
         VALUES (?, ?, '{}', '{}', ?, ?)`,
      ).run(
        `attempt/diagnostic-${String(index)}`,
        `fence/diagnostic-${String(index)}`,
        `receipt/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
      factory.prepare(
        `INSERT INTO mutation_events
           (event_id, execution_attempt_id, created_at, body_json)
         VALUES (?, ?, ?, '{}')`,
      ).run(
        `mutation/diagnostic-${String(index)}`,
        `attempt/diagnostic-${String(index)}`,
        HERO_HORIZON_END,
      );
    }
  } finally {
    factory.close();
  }
}

function seedDiagnosticMissionActions(path: string, missionId: string): void {
  const store = new M4MissionStore({ path, now: () => HERO_HORIZON_END });
  try {
    store.bindMission({
      missionId,
      environmentId: HERO_ENVIRONMENT_ID,
      trueforgeAgentId: "agent/diagnostic-secret-bearing-identity",
      trueforgeSessionId: "session/diagnostic-secret-bearing-identity",
      m2EnvironmentIdentity: "m2/diagnostic-secret-bearing-identity",
      factoryEnvironmentIdentity: "factory/diagnostic-secret-bearing-identity",
    });
    const owner = store.recordBridgeAction({
      missionId,
      trueforgeSessionId: "session/diagnostic-secret-bearing-identity",
      trueforgeTurnId: "turn/diagnostic-owner",
      trueforgeThreadId: "thread/diagnostic-owner",
      trueforgeToolCallId: "call/diagnostic-owner",
      actionKind: "owner_decision",
      toolName: "select_portfolio_modification",
      arguments: { opaque: "raw-owner-response-must-not-appear" },
    });
    store.recordBridgeOutcome(owner.bridgeKey, "approval_bound", {
      toolName: "select_portfolio_modification",
      toolCallId: "call/diagnostic-owner",
      turnId: "turn/diagnostic-owner",
      threadId: "thread/diagnostic-owner",
      decision: "allow",
      reason: "raw-owner-response-must-not-appear",
      source: "owner",
      ownerSourceIdentity: "owner/diagnostic-secret-bearing-identity",
      bridgeKey: owner.bridgeKey,
      denialId: null,
      executionAttemptId: null,
    });
    const mechanical = store.recordBridgeAction({
      missionId,
      trueforgeSessionId: "session/diagnostic-secret-bearing-identity",
      trueforgeTurnId: "turn/diagnostic-mechanical",
      trueforgeThreadId: "thread/diagnostic-mechanical",
      trueforgeToolCallId: "call/diagnostic-mechanical",
      actionKind: "consequential_effect",
      toolName: "submit_schedule_change",
      arguments: { opaque: "raw-owner-response-must-not-appear" },
    });
    store.recordBridgeOutcome(mechanical.bridgeKey, "approval_bound", {
      toolName: "submit_schedule_change",
      toolCallId: "call/diagnostic-mechanical",
      turnId: "turn/diagnostic-mechanical",
      threadId: "thread/diagnostic-mechanical",
      decision: "deny",
      reason: "raw-owner-response-must-not-appear",
      source: "active_m2_denial",
      ownerSourceIdentity: null,
      bridgeKey: mechanical.bridgeKey,
      denialId: "denial/diagnostic-secret-bearing-identity",
      executionAttemptId: null,
    });
  } finally {
    store.close();
  }
}

function missionSnapshot(path: string): string {
  const store = new M4MissionStore({ path, now: () => HERO_HORIZON_END });
  try {
    return canonicalSerialize(store.getSnapshot(M4_LIVE_MISSION_ID));
  } finally {
    store.close();
  }
}

function initializeBoundEnvironment(m2Path: string, factoryPath: string): void {
  const factory = new SyntheticFactoryEnvironment({
    path: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  factory.close();
  const store = createStore({
    path: m2Path,
    initialState: createHeroInitialState(),
    authoritativeFactoryDatabasePath: factoryPath,
    now: () => HERO_HORIZON_END,
  });
  store.close();
}

type DatabaseSwapSchedule =
  | "m2_while_awaiting_owner"
  | "factory_while_awaiting_owner"
  | "after_owner_before_continuation"
  | "factory_mutation_adapter_boundary";

async function testDatabaseSwapSchedule(
  schedule: DatabaseSwapSchedule,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `flakebrake-qodo-r2-${schedule}-`));
  const originalM2 = join(directory, "original-m2.sqlite");
  const replacementM2 = join(directory, "replacement-m2.sqlite");
  const originalFactory = join(directory, "original-factory.sqlite");
  const replacementFactory = join(directory, "replacement-factory.sqlite");
  const activeM2 = join(directory, "active-m2.sqlite");
  const activeFactory = join(directory, "active-factory.sqlite");
  initializeBoundEnvironment(originalM2, originalFactory);
  initializeBoundEnvironment(replacementM2, replacementFactory);
  symlinkSync(originalM2, activeM2);
  symlinkSync(originalFactory, activeFactory);
  const options: DeterministicM4MissionOptions = {
    m2DatabasePath: activeM2,
    factoryDatabasePath: activeFactory,
    missionDatabasePath: join(directory, "mission.sqlite"),
    trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
    localSandboxRootParent: join(directory, "sandboxes"),
    missionId: `mission/qodo-r2-${schedule}`,
  };
  const policy = deterministicM4OwnerDecisions(
    `test-owner/qodo-r2-${schedule}`,
  );
  let snapshots:
    | {
        readonly originalM2: string;
        readonly replacementM2: string;
        readonly originalFactory: string;
        readonly replacementFactory: string;
      }
    | undefined;
  let swapped = false;
  const captureAndSwap = (kind: "m2" | "factory"): void => {
    assert.equal(swapped, false, `${schedule} may swap only once`);
    snapshots = {
      originalM2: completeDatabaseSnapshot(originalM2),
      replacementM2: completeDatabaseSnapshot(replacementM2),
      originalFactory: completeDatabaseSnapshot(originalFactory),
      replacementFactory: completeDatabaseSnapshot(replacementFactory),
    };
    repointSymlink(
      kind === "m2" ? activeM2 : activeFactory,
      kind === "m2" ? replacementM2 : replacementFactory,
    );
    swapped = true;
  };
  const originalMutation =
    SyntheticFactoryEnvironment.prototype.executeAuthorizedScheduleMutation;
  if (schedule === "factory_mutation_adapter_boundary") {
    SyntheticFactoryEnvironment.prototype.executeAuthorizedScheduleMutation =
      function (store, request, assertDatabaseBinding) {
        if (
          !swapped &&
          request.executionAttemptId === "attempt/m4-approved-alternative"
        ) {
          captureAndSwap("factory");
        }
        return originalMutation.call(
          this,
          store,
          request,
          assertDatabaseBinding,
        );
      };
  }
  try {
    await assert.rejects(
      runDeterministicM4Mission({
        ...options,
        ownerDecisionProvider: async (request) => {
          if (
            !swapped &&
            request.phase === "portfolio_modification" &&
            schedule === "m2_while_awaiting_owner"
          ) {
            captureAndSwap("m2");
          } else if (
            !swapped &&
            request.phase === "portfolio_modification" &&
            schedule === "factory_while_awaiting_owner"
          ) {
            captureAndSwap("factory");
          }
          return policy(request);
        },
        checkpointObserver: (checkpoint) => {
          if (
            !swapped &&
            schedule === "after_owner_before_continuation" &&
            checkpoint.phase === "approval_bridge_bound" &&
            checkpoint.approval.toolName === "select_portfolio_modification"
          ) {
            captureAndSwap("m2");
          }
        },
      }),
      /database instance identity.*conflicts/u,
    );
    assert.equal(swapped, true);
    assert.ok(snapshots);
    assert.equal(completeDatabaseSnapshot(originalM2), snapshots.originalM2);
    assert.equal(completeDatabaseSnapshot(replacementM2), snapshots.replacementM2);
    assert.equal(
      completeDatabaseSnapshot(originalFactory),
      snapshots.originalFactory,
    );
    assert.equal(
      completeDatabaseSnapshot(replacementFactory),
      snapshots.replacementFactory,
    );

    repointSymlink(activeM2, originalM2);
    repointSymlink(activeFactory, originalFactory);
    const resumed = await runDeterministicM4Mission({
      ...options,
      ownerDecisionProvider: policy,
    });
    assert.equal(resumed.mission.status, "VERIFIED_COMPLETE");
    assert.equal(controlledWriteCount(resumed), 1);
    assert.equal(resumed.actualConsumptionFacts, 2);
  } finally {
    SyntheticFactoryEnvironment.prototype.executeAuthorizedScheduleMutation =
      originalMutation;
    rmSync(directory, { recursive: true, force: true });
  }
}

function repointSymlink(path: string, target: string): void {
  const replacement = `${path}.replacement`;
  symlinkSync(target, replacement);
  renameSync(replacement, path);
}

type VerifiedHandleSwapStage =
  | "before_open"
  | "after_first_open"
  | "handles_validated"
  | "no_replacement";

async function testVerifiedHandleReplacementStage(
  swapStage: VerifiedHandleSwapStage,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `flakebrake-qodo-r3-${swapStage}-`));
  const originalM2 = join(directory, "original-m2.sqlite");
  const replacementM2 = join(directory, "replacement-m2.sqlite");
  const originalFactory = join(directory, "original-factory.sqlite");
  const replacementFactory = join(directory, "replacement-factory.sqlite");
  const activeM2 = join(directory, "active-m2.sqlite");
  const activeFactory = join(directory, "active-factory.sqlite");
  initializeBoundEnvironment(originalM2, originalFactory);
  initializeBoundEnvironment(replacementM2, replacementFactory);
  symlinkSync(originalM2, activeM2);
  symlinkSync(originalFactory, activeFactory);
  let swapped = false;
  const cluster = await startFactoryMcpHttpCluster({
    m2DatabasePath: activeM2,
    factoryDatabasePath: activeFactory,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
    databaseOperationObserver: (event) => {
      if (
        swapped ||
        swapStage === "no_replacement" ||
        event.operation !== "select_portfolio_modification" ||
        event.stage !== swapStage
      ) {
        return;
      }
      if (
        swapStage === "after_first_open" &&
        event.openedKinds.includes("m2")
      ) {
        repointSymlink(activeFactory, replacementFactory);
      } else {
        repointSymlink(activeM2, replacementM2);
      }
      swapped = true;
    },
  });
  try {
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      await client.callTool({ name: "record_current_admission", arguments: {} });
      cloneAdmissionLedger(originalM2, replacementM2);
      const prepared = resultObject(
        (await client.callTool({
          name: "prepare_portfolio_modification",
          arguments: {},
        })) as CallToolResult,
      );
      const exact = record(prepared["arguments"], "portfolio modification");
      const before = {
        originalM2: completeDatabaseSnapshot(originalM2),
        replacementM2: completeDatabaseSnapshot(replacementM2),
        originalFactory: completeDatabaseSnapshot(originalFactory),
        replacementFactory: completeDatabaseSnapshot(replacementFactory),
      };
      const response = (await client.callTool({
        name: "select_portfolio_modification",
        arguments: exact,
      })) as CallToolResult;
      if (swapStage === "no_replacement") {
        const body = resultObject(response);
        assert.equal(body["status"], "READMITTED");
        const replay = resultObject(
          (await client.callTool({
            name: "select_portfolio_modification",
            arguments: exact,
          })) as CallToolResult,
        );
        assert.equal(canonicalSerialize(replay), canonicalSerialize(body));
        const durable = createStore({ path: originalM2 });
        try {
          assert.equal(durable.getAdmissionHistory().length, 2);
          assert.equal(durable.getPortfolio().versions.portfolioVersion, "portfolio/v2");
        } finally {
          durable.close();
        }
      } else {
        assert.equal(response.isError, true);
        assert.equal(swapped, true);
        assert.equal(completeDatabaseSnapshot(originalM2), before.originalM2);
        assert.equal(completeDatabaseSnapshot(replacementM2), before.replacementM2);
        assert.equal(
          completeDatabaseSnapshot(originalFactory),
          before.originalFactory,
        );
        assert.equal(
          completeDatabaseSnapshot(replacementFactory),
          before.replacementFactory,
        );
      }
    });
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function testScheduleReadReplacementStage(
  swapStage: "after_first_open" | "handles_validated" | "no_replacement",
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `flakebrake-qodo-r3-read-${swapStage}-`));
  const m2Path = join(directory, "m2.sqlite");
  const originalFactory = join(directory, "original-factory.sqlite");
  const replacementFactory = join(directory, "replacement-factory.sqlite");
  const activeFactory = join(directory, "active-factory.sqlite");
  initializeBoundEnvironment(m2Path, originalFactory);
  initializeBoundEnvironment(join(directory, "replacement-m2.sqlite"), replacementFactory);
  symlinkSync(originalFactory, activeFactory);
  let swapped = false;
  const start = () =>
    startFactoryMcpHttpCluster({
      m2DatabasePath: m2Path,
      factoryDatabasePath: activeFactory,
      now: () => HERO_HORIZON_END,
      enableM4Tools: true,
      databaseOperationObserver: (event) => {
        if (
          swapped ||
          swapStage === "no_replacement" ||
          event.operation !== "read_schedule_state" ||
          event.stage !== swapStage
        ) {
          return;
        }
        repointSymlink(activeFactory, replacementFactory);
        swapped = true;
      },
    });
  let cluster = await start();
  try {
    const beforeOriginal = completeDatabaseSnapshot(originalFactory);
    const beforeReplacement = completeDatabaseSnapshot(replacementFactory);
    await withHttpClient(cluster, "factory-change-control", async (client) => {
      const response = (await client.callTool({
        name: "read_schedule_state",
        arguments: {},
      })) as CallToolResult;
      if (swapStage === "no_replacement") {
        const body = resultObject(response);
        const basis = record(body["verifiedBasis"], "verified schedule basis");
        assert.equal(
          basis["factoryDatabaseIdentity"],
          readDatabaseInstanceIdentity(
            originalFactory,
            "factory",
            HERO_ENVIRONMENT_ID,
          ),
        );
      } else {
        assert.equal(response.isError, true);
        assert.equal(swapped, true);
      }
    });
    assert.equal(completeDatabaseSnapshot(originalFactory), beforeOriginal);
    assert.equal(completeDatabaseSnapshot(replacementFactory), beforeReplacement);
    if (swapStage !== "no_replacement") {
      await cluster.close();
      repointSymlink(activeFactory, originalFactory);
      cluster = await start();
      await withHttpClient(cluster, "factory-change-control", async (client) => {
        const resumed = (await client.callTool({
          name: "read_schedule_state",
          arguments: {},
        })) as CallToolResult;
        assert.equal(resumed.isError, undefined);
      });
    }
  } finally {
    await cluster.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

type LiveMutableResource = "m2" | "factory" | "mission" | "trueforge";

async function assertLiveResourceLocking(
  sharedResources: readonly LiveMutableResource[],
  expectSerialized: boolean,
  useAlias: boolean,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r3-lock-"));
  const firstRoot = join(directory, "first");
  const secondRoot = join(directory, "second");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const m0Path = join(directory, "m0.sqlite");
  createSyntheticM0Database(m0Path);
  const firstOptions = liveOptions(firstRoot);
  const secondOptions = liveOptions(secondRoot);
  const field = {
    m2: "m2DatabasePath",
    factory: "factoryDatabasePath",
    mission: "missionDatabasePath",
    trueforge: "trueforgeDatabasePath",
  } as const;
  const sharedPaths = Object.fromEntries(
    sharedResources.map((resource) => [resource, join(directory, `shared-${resource}.sqlite`)]),
  ) as Partial<Record<LiveMutableResource, string>>;
  if (sharedPaths.m2 !== undefined || sharedPaths.factory !== undefined) {
    initializeBoundEnvironment(
      sharedPaths.m2 ?? join(directory, "shared-bootstrap-m2.sqlite"),
      sharedPaths.factory ?? join(directory, "shared-bootstrap-factory.sqlite"),
    );
  }
  const firstOverrides: Record<string, string> = {};
  const secondOverrides: Record<string, string> = {};
  for (const resource of sharedResources) {
    const path = sharedPaths[resource] as string;
    firstOverrides[field[resource]] = path;
    if (useAlias && (resource === "m2" || resource === "factory")) {
      const alias = join(directory, `alias-${resource}.sqlite`);
      symlinkSync(path, alias);
      secondOverrides[field[resource]] = alias;
    } else {
      secondOverrides[field[resource]] = path;
    }
  }
  let firstEnteredResolve: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => {
    firstEnteredResolve = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;
  let sharedQueuedResolve: (() => void) | undefined;
  const sharedQueued = new Promise<void>((resolve) => {
    sharedQueuedResolve = resolve;
  });
  const expectedSharedKeys = new Set(
    Object.values(sharedPaths).map(
      (path) => `database:${canonicalLiveDatabasePath(path)}`,
    ),
  );
  const common = {
    m0TrueForgeDatabasePath: m0Path,
    ownerDecisionProvider: deterministicM4OwnerDecisions(
      "test-owner/qodo-r3-resource-lock",
    ),
  } as const;
  const first = runLiveM4Mission({
    ...firstOptions,
    ...firstOverrides,
    ...common,
    lifecycleObserver: async (stage) => {
      if (stage !== "environment_initialized") return;
      firstEnteredResolve?.();
      await firstGate;
      throw new Error("planned first lock-holder release");
    },
  } as LiveM4MissionOptions);
  void first.catch(() => undefined);
  let second: Promise<unknown> | undefined;
  try {
    await firstEntered;
    second = runLiveM4Mission({
      ...secondOptions,
      ...secondOverrides,
      ...common,
      liveRunLockObserver: ({ stage, key }) => {
        if (stage === "queued" && expectedSharedKeys.has(key)) {
          sharedQueuedResolve?.();
        }
      },
      lifecycleObserver: (stage) => {
        if (stage !== "environment_initialized") return;
        secondEntered = true;
        throw new Error("planned second lock-holder release");
      },
    } as LiveM4MissionOptions);
    void second.catch(() => undefined);
    if (expectSerialized) {
      await sharedQueued;
      assert.equal(secondEntered, false);
    } else {
      await second.catch(() => undefined);
      assert.equal(secondEntered, true);
    }
    releaseFirst?.();
    const outcomes = await Promise.allSettled([first, second]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["rejected", "rejected"],
    );
  } finally {
    releaseFirst?.();
    await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertPartialLiveResourceLockRelease(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-qodo-r3-partial-lock-"));
  const m0Path = join(directory, "m0.sqlite");
  createSyntheticM0Database(m0Path);
  const options = {
    ...liveOptions(directory),
    m0TrueForgeDatabasePath: m0Path,
    ownerDecisionProvider: deterministicM4OwnerDecisions(
      "test-owner/qodo-r3-partial-lock",
    ),
  } as LiveM4MissionOptions;
  let acquired = 0;
  try {
    await assert.rejects(
      runLiveM4Mission({
        ...options,
        liveRunLockObserver: ({ stage }) => {
          if (stage !== "acquired") return;
          acquired += 1;
          if (acquired === 2) throw new Error("planned partial lock failure");
        },
      }),
      /planned partial lock failure/u,
    );
    assert.equal(acquired, 2);
    let retryEntered = false;
    await assert.rejects(
      runLiveM4Mission({
        ...options,
        lifecycleObserver: (stage) => {
          if (stage !== "environment_initialized") return;
          retryEntered = true;
          throw new Error("planned partial lock retry");
        },
      }),
      /planned partial lock retry/u,
    );
    assert.equal(retryEntered, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function cloneAdmissionLedger(sourcePath: string, targetPath: string): void {
  const database = new DatabaseSync(targetPath);
  try {
    database.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(
        "INSERT INTO admission_records SELECT * FROM source.admission_records",
      );
      database.exec(
        "INSERT INTO admission_addenda SELECT * FROM source.admission_addenda",
      );
      database.exec("COMMIT");
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("DETACH DATABASE source");
  } finally {
    database.close();
  }
}

function completeDatabaseSnapshot(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Record<string, unknown>[];
    const tables = schema
      .filter((entry) => entry["type"] === "table")
      .map((entry) => String(entry["name"]));
    return canonicalSerialize({
      schema,
      rows: Object.fromEntries(
        tables.map((table) => {
          const rows = database
            .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`)
            .all() as Record<string, unknown>[];
          return [
            table,
            rows
              .map((row) => canonicalSerialize(row))
              .sort((left, right) => left.localeCompare(right)),
          ];
        }),
      ),
    });
  } finally {
    database.close();
  }
}

function spawnM4Cli(
  cli: string,
  temporaryDirectory: string,
  arguments_: readonly string[],
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: temporaryDirectory, HOME: temporaryDirectory },
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createSyntheticM0Database(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE model_provider (name TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;
      CREATE TABLE sandbox_provider (name TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;
    `);
    database
      .prepare("INSERT INTO model_provider (name, manifest) VALUES (?, ?)")
      .run(
        "openai",
        JSON.stringify({
          type: "openai",
          auth: { api_key: "test-only-not-a-credential" },
          base_url: "http://127.0.0.1:1/v1",
          models: [
            {
              name: "gpt-5-4-mini",
              model_id: "gpt-5-4-mini",
              properties: {
                context_length: 32_768,
                max_output_tokens: 4_096,
                reasoning_efforts: ["medium"],
              },
            },
          ],
        }),
      );
    database
      .prepare("INSERT INTO sandbox_provider (name, manifest) VALUES (?, ?)")
      .run(
        "daytona",
        JSON.stringify({
          type: "daytona",
          auth: { api_key: "test-only-not-a-credential" },
          auto_archive_interval_in_minutes: 60,
          auto_delete_interval_in_minutes: 120,
          auto_stop_interval_in_minutes: 30,
          exec_timeout_ms: 10_000,
        }),
      );
  } finally {
    database.close();
  }
}

function trueForgeSessionCount(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT count(*) AS count FROM session").get() as
      | Record<string, unknown>
      | undefined;
    assert.ok(row);
    assert.equal(typeof row["count"], "number");
    return row["count"] as number;
  } finally {
    database.close();
  }
}

function activeServerHandles(): Server[] {
  const handles = (
    process as unknown as { _getActiveHandles: () => readonly unknown[] }
  )._getActiveHandles();
  return handles.filter((handle): handle is Server => handle instanceof Server);
}

function activeChildProcessHandles(): unknown[] {
  const handles = (
    process as unknown as { _getActiveHandles: () => readonly unknown[] }
  )._getActiveHandles();
  return handles.filter(
    (handle) =>
      typeof handle === "object" &&
      handle !== null &&
      (handle as { constructor?: { name?: string } }).constructor?.name ===
        "ChildProcess",
  );
}

function sqliteRowCount(
  path: string,
  table: string,
  predicate?: string,
): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const where = predicate === undefined ? "" : ` WHERE ${predicate}`;
    const row = database
      .prepare(`SELECT count(*) AS count FROM ${table}${where}`)
      .get() as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(typeof row["count"], "number");
    return row["count"] as number;
  } finally {
    database.close();
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function resultObject(result: CallToolResult): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  const parsed = JSON.parse(first.text) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function toolResponse(
  result: DeterministicM4MissionResult,
  toolCallId: string,
): string {
  const response = result.mission.trueforgeEvents.find(
    (item) =>
      item.event.type === "tool.response" &&
      item.event.toolCallId === toolCallId,
  );
  assert.ok(response);
  assert.equal(response.event.type, "tool.response");
  return response.event.content;
}

function sandboxComputation(
  result: DeterministicM4MissionResult,
): Record<string, unknown> {
  const envelope = JSON.parse(toolResponse(result, "assurance-code-mode")) as {
    success: boolean;
    response: { exitCode: number; result: string };
  };
  assert.equal(envelope.success, true);
  assert.equal(envelope.response.exitCode, 0);
  const line = envelope.response.result
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("{"));
  assert.ok(line, "sandbox result must contain its canonical computation");
  return JSON.parse(line) as Record<string, unknown>;
}

function liveValidationFixture(
  result: DeterministicM4MissionResult,
): LiveM4MissionResult {
  return {
    mission: result.mission,
    model: "openai/gpt-5-4-mini",
    sandboxProvider: "daytona",
    connectorUrls: result.connectorUrls,
    subagentThreads: result.subagentThreads,
    sandboxIds: ["v1:daytona:fixture"],
    controlledWriteCount: controlledWriteCount(result),
    actualConsumptionFacts: result.actualConsumptionFacts,
  };
}

function assertLiveInvariantFixture(
  options: DeterministicM4MissionOptions,
  fixture: LiveM4MissionResult,
): void {
  const store = createStore({ path: options.m2DatabasePath });
  const factory = new SyntheticFactoryEnvironment({
    path: options.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  try {
    assertLiveApprovalInvariants(fixture, store, factory);
  } finally {
    factory.close();
    store.close();
  }
}

function assertLiveEvidenceFixture(
  options: DeterministicM4MissionOptions,
  fixture: LiveM4MissionResult,
  profile?: LiveM4ValidationProfile,
): void {
  const store = createStore({ path: options.m2DatabasePath });
  const factory = new SyntheticFactoryEnvironment({
    path: options.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  try {
    if (profile === undefined) {
      assertLiveMissionEvidence(fixture, store, factory);
    } else {
      assertLiveMissionEvidence(fixture, store, factory, profile);
    }
  } finally {
    factory.close();
    store.close();
  }
}

function withoutAssuranceSandboxCompletion(
  fixture: LiveM4MissionResult,
): LiveM4MissionResult {
  const assurance = fixture.subagentThreads.find(
    (thread) => thread.title === "Assurance and simulation engineer",
  );
  assert.ok(assurance);
  return {
    ...fixture,
    mission: {
      ...fixture.mission,
      trueforgeEvents: fixture.mission.trueforgeEvents.filter((item) => {
        if (item.event.threadId !== assurance.threadId) return true;
        if (item.event.type === "thread.done") return false;
        return !(
          item.event.type === "model.message" &&
          item.event.toolCalls?.some(
            (toolCall) =>
              toolCall.toolInfo.type === "truefoundry-system" &&
              toolCall.toolInfo.name === "exec",
          ) === true
        );
      }),
    },
    sandboxIds: [],
  };
}

function safeShortcutLiveValidationFixture(
  fixture: LiveM4MissionResult,
): LiveM4MissionResult {
  const ownerDenial = fixture.mission.approvals.find(
    (approval) =>
      approval.source === "owner" &&
      approval.decision === "deny" &&
      isFixtureConsequentialTool(approval.toolName),
  );
  const mechanical = fixture.mission.approvals.find(
    (approval) => approval.source === "active_m2_denial",
  );
  assert.ok(ownerDenial?.ownerSourceIdentity);
  assert.ok(mechanical);
  const ownerOutcome = fixture.mission.missionSnapshot.bridgeOutcomes.find(
    (outcome) =>
      outcome.bridgeKey === ownerDenial.bridgeKey &&
      outcome.status === "owner_decision_received",
  );
  assert.ok(ownerOutcome);
  let shortcut = removeLiveFixtureApproval(fixture, ownerDenial.bridgeKey);
  const shortcutDenial: M4ApprovalRecord = {
    ...mechanical,
    source: "owner",
    ownerSourceIdentity: ownerDenial.ownerSourceIdentity,
    reason: ownerDenial.reason,
  };
  shortcut = replaceLiveFixtureApproval(shortcut, shortcutDenial);
  const action = shortcut.mission.missionSnapshot.bridgeActions.find(
    (candidate) => candidate.bridgeKey === shortcutDenial.bridgeKey,
  );
  assert.ok(action);
  const ownerResult = record(ownerOutcome.result, "owner outcome fixture");
  const decision = record(ownerResult["decision"], "owner decision fixture");
  const shortcutOwnerOutcome: M4BridgeOutcome = {
    ...ownerOutcome,
    bridgeEventId: `${ownerOutcome.bridgeEventId}/shortcut`,
    bridgeKey: shortcutDenial.bridgeKey,
    result: asFixtureJson({
      ...ownerResult,
      requestDigest: fixtureOwnerRequestDigest(
        action,
        shortcut.mission.missionSnapshot.mission,
      ),
      ownerSourceIdentity: shortcutDenial.ownerSourceIdentity,
      decision: { ...decision, status: "deny" },
    }),
  };
  return {
    ...shortcut,
    mission: {
      ...shortcut.mission,
      missionSnapshot: {
        ...shortcut.mission.missionSnapshot,
        bridgeOutcomes: [
          ...shortcut.mission.missionSnapshot.bridgeOutcomes,
          shortcutOwnerOutcome,
        ],
      },
    },
  };
}

function removeLiveFixtureApproval(
  fixture: LiveM4MissionResult,
  bridgeKey: string,
): LiveM4MissionResult {
  return {
    ...fixture,
    mission: {
      ...fixture.mission,
      approvals: fixture.mission.approvals.filter(
        (approval) => approval.bridgeKey !== bridgeKey,
      ),
      missionSnapshot: {
        ...fixture.mission.missionSnapshot,
        bridgeActions: fixture.mission.missionSnapshot.bridgeActions.filter(
          (action) => action.bridgeKey !== bridgeKey,
        ),
        bridgeOutcomes: fixture.mission.missionSnapshot.bridgeOutcomes.filter(
          (outcome) => outcome.bridgeKey !== bridgeKey,
        ),
      },
    },
  };
}

function replaceLiveFixtureApproval(
  fixture: LiveM4MissionResult,
  replacement: M4ApprovalRecord,
): LiveM4MissionResult {
  const outcomes = fixture.mission.missionSnapshot.bridgeOutcomes.map(
    (outcome): M4BridgeOutcome => {
      if (outcome.bridgeKey !== replacement.bridgeKey) return outcome;
      if (outcome.status === "approval_bound") {
        return { ...outcome, result: asFixtureJson(replacement) };
      }
      if (outcome.status !== "owner_decision_received") return outcome;
      const durable = record(outcome.result, "owner outcome fixture");
      return {
        ...outcome,
        result: asFixtureJson({
          ...durable,
          decision:
            replacement.decision === "allow"
              ? { status: "allow" }
              : { status: "deny", reason: replacement.reason },
        }),
      };
    },
  );
  return {
    ...fixture,
    mission: {
      ...fixture.mission,
      approvals: fixture.mission.approvals.map((approval) =>
        approval.bridgeKey === replacement.bridgeKey ? replacement : approval,
      ),
      missionSnapshot: {
        ...fixture.mission.missionSnapshot,
        bridgeOutcomes: outcomes,
      },
    },
  };
}

function replaceOwnerOutcomeDigest(
  fixture: LiveM4MissionResult,
  bridgeKey: string,
  requestDigest: string,
): LiveM4MissionResult {
  return {
    ...fixture,
    mission: {
      ...fixture.mission,
      missionSnapshot: {
        ...fixture.mission.missionSnapshot,
        bridgeOutcomes: fixture.mission.missionSnapshot.bridgeOutcomes.map(
          (outcome): M4BridgeOutcome =>
            outcome.bridgeKey === bridgeKey &&
            outcome.status === "owner_decision_received"
              ? {
                  ...outcome,
                  result: asFixtureJson({
                    ...record(outcome.result, "owner outcome fixture"),
                    requestDigest,
                  }),
                }
              : outcome,
        ),
      },
    },
  };
}

function reauthorizeMechanicalDenial(
  fixture: LiveM4MissionResult,
  mechanical: M4ApprovalRecord,
  ownerSourceIdentity: string,
): LiveM4MissionResult {
  const ownerDenial = fixture.mission.approvals.find(
    (approval) =>
      approval.source === "owner" && approval.decision === "deny",
  );
  assert.ok(ownerDenial);
  const sourceOutcome = fixture.mission.missionSnapshot.bridgeOutcomes.find(
    (outcome) =>
      outcome.bridgeKey === ownerDenial.bridgeKey &&
      outcome.status === "owner_decision_received",
  );
  assert.ok(sourceOutcome);
  const replacement: M4ApprovalRecord = {
    ...mechanical,
    source: "owner",
    ownerSourceIdentity,
  };
  const reauthorized = replaceLiveFixtureApproval(fixture, replacement);
  const action = reauthorized.mission.missionSnapshot.bridgeActions.find(
    (candidate) => candidate.bridgeKey === replacement.bridgeKey,
  );
  assert.ok(action);
  const sourceResult = record(sourceOutcome.result, "owner outcome fixture");
  const added: M4BridgeOutcome = {
    ...sourceOutcome,
    bridgeEventId: `${sourceOutcome.bridgeEventId}/reauthorized`,
    bridgeKey: replacement.bridgeKey,
    result: asFixtureJson({
      ...sourceResult,
      requestDigest: fixtureOwnerRequestDigest(
        action,
        reauthorized.mission.missionSnapshot.mission,
      ),
      ownerSourceIdentity,
    }),
  };
  return {
    ...reauthorized,
    mission: {
      ...reauthorized.mission,
      missionSnapshot: {
        ...reauthorized.mission.missionSnapshot,
        bridgeOutcomes: [
          ...reauthorized.mission.missionSnapshot.bridgeOutcomes,
          added,
        ],
      },
    },
  };
}

function removeLiveFixtureOutcome(
  fixture: LiveM4MissionResult,
  bridgeEventId: string,
): LiveM4MissionResult {
  return {
    ...fixture,
    mission: {
      ...fixture.mission,
      missionSnapshot: {
        ...fixture.mission.missionSnapshot,
        bridgeOutcomes: fixture.mission.missionSnapshot.bridgeOutcomes.filter(
          (outcome) => outcome.bridgeEventId !== bridgeEventId,
        ),
      },
    },
  };
}

function fixtureOwnerRequestDigest(
  action: M4BridgeAction,
  binding: M4MissionBinding,
): string {
  return fixtureDigest({
    missionId: action.missionId,
    trueforgeSessionId: action.trueforgeSessionId,
    trueforgeTurnId: action.trueforgeTurnId,
    trueforgeThreadId: action.trueforgeThreadId,
    trueforgeToolCallId: action.trueforgeToolCallId,
    toolName: action.toolName,
    arguments: action.arguments,
    m2DatabaseInstanceIdentity: binding.m2EnvironmentIdentity,
    factoryDatabaseInstanceIdentity: binding.factoryEnvironmentIdentity,
    phase:
      action.toolName === "select_portfolio_modification"
        ? "portfolio_modification"
        : action.toolName === "accept_promise"
          ? "promise_choice"
          : "consequential_effect",
  });
}

function fixtureDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex")}`;
}

function isFixtureConsequentialTool(toolName: string): boolean {
  return (
    toolName === "create_schedule_reservation" ||
    toolName === "submit_schedule_change"
  );
}

function asFixtureJson(value: unknown): JsonValue {
  return JSON.parse(canonicalSerialize(value)) as JsonValue;
}

function controlledWriteCount(result: DeterministicM4MissionResult): number {
  return (
    result.factoryExecution?.currentState.reservations.filter(
      (reservation) => reservation.sourceExecutionAttemptId !== null,
    ).length ?? 0
  );
}

function m2Snapshot(path: string): string {
  const store = createStore({ path });
  try {
    return canonicalSerialize({
      portfolio: store.getPortfolio(),
      admissions: store.getAdmissionHistory(),
      denials: store.getDenials(),
    });
  } finally {
    store.close();
  }
}

function storeAdmissionId(
  path: string,
  decision: "ADMITTABLE" | "REPLAN" | "REJECT",
  portfolioVersion: string,
): string {
  const store = createStore({ path });
  try {
    const admission = store
      .getAdmissionHistory()
      .find(
        (candidate) =>
          candidate.record.decision === decision &&
          candidate.record.portfolioVersion === portfolioVersion,
      );
    assert.ok(admission);
    return admission.record.admissionRecordId;
  } finally {
    store.close();
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${field} must be an object`,
  );
  return value as Record<string, unknown>;
}

function databaseIdentity(path: string): string {
  return `sha256:${createHash("sha256").update(path).digest("hex")}`;
}

function asyncPage<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}
