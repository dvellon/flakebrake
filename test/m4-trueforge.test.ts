import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { IncomingMessage, Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type LiveM4MissionOptions,
  type M4MissionCheckpoint,
  type M4OwnerApprovalRequest,
  type RunningFactoryMcpHttpCluster,
} from "../src/index.js";

const WINNER =
  "replan-plan/sha256:68fe99d3402893002930fa143b1089629e4722215d1624af5924d628430aafe2";

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
    const options = {
      ...seedOptions,
      m0TrueForgeDatabasePath: provenM0Path,
      ownerDecisionProvider: (request: M4OwnerApprovalRequest) =>
        m4OwnerDecisionResponse(request, "test-owner/qodo-live-resume", {
          status: "allow",
        }),
    } satisfies LiveM4MissionOptions;
    try {
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
