import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { canonicalSerialize } from "../src/canonical.js";
import {
  FACTORY_MCP_SERVICE_NAMES,
  FLAKEBRAKE_ROOT_AGENT_NAME,
  HERO_HORIZON_END,
  HERO_RESOURCE_KEYS,
  M4MissionStore,
  TRUEFORGE_SDK_VERSION,
  TRUEFORGE_SERVER_VERSION,
  SyntheticFactoryEnvironment,
  createHeroInitialState,
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
    } finally {
      store.close();
    }
  });
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
