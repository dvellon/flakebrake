import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  M4MissionStore,
  TRUEFORGE_SDK_VERSION,
  TRUEFORGE_SERVER_VERSION,
  SyntheticFactoryEnvironment,
  createHeroInitialState,
  createHeroProposal,
  createStore,
  flakeBrakeRootAgentSpec,
  runDeterministicM4Mission,
  startFactoryMcpHttpCluster,
  type DeterministicM4MissionOptions,
  type DeterministicM4MissionResult,
  type M4MissionCheckpoint,
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
        m2EnvironmentIdentity: databaseIdentity(m2Path),
        factoryEnvironmentIdentity: databaseIdentity(factoryPath),
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
        ownerDecisionProvider: () => ({ status: "allow" }),
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
      m2EnvironmentIdentity: databaseIdentity(m2Path),
      factoryEnvironmentIdentity: databaseIdentity(factoryPath),
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
      ownerDecisionProvider: () => ({ status: "allow" }),
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
      m2EnvironmentIdentity: databaseIdentity(m2Path),
      factoryEnvironmentIdentity: databaseIdentity(factoryPath),
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
      ownerDecisionProvider: () => ({ status: "allow" }),
    });
    await assert.rejects(
      controller.runToCompletion(),
      /planned grouped-approval continuation/u,
    );
    assert.equal(continuationCalls, 1);
    assert.equal(missionStore.getSnapshot(missionId).bridgeActions.length, 0);
    assert.equal(existsSync(m2Path), false);
    assert.equal(existsSync(factoryPath), false);
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
