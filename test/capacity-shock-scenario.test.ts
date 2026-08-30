import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  CAPACITY_SHOCK_ATTEMPT_ID,
  CAPACITY_SHOCK_MISSION_ID,
  createCapacityShockEvaluationInput,
} from "../src/capacity-shock-fixture.js";
import { runCapacityShockMission } from "../src/capacity-shock-runner.js";
import { canonicalSerialize } from "../src/canonical.js";
import { evaluateAdmission } from "../src/kernel.js";
import { m4OwnerDecisionResponse } from "../src/m4-mission-controller.js";
import {
  startM5JudgeServer,
  type M5JudgeState,
  type RunningM5JudgeServer,
} from "../src/m5-ui.js";

describe("capacity-shock deterministic fixture", () => {
  test("v1 is admissible and v2 produces the exact bounded deterministic winner", () => {
    const initial = evaluateAdmission(createCapacityShockEvaluationInput(false));
    assert.equal(initial.decision, "ADMITTABLE");
    assert.deepEqual(
      initial.directPlan.capacityAfter.map((item) => [item.resourceKey, item.value]),
      [
        ["agent_work_units", 0],
        ["human_review_decisions", 1],
        ["production_cell_minutes", 4],
      ],
    );

    const shocked = evaluateAdmission(createCapacityShockEvaluationInput());
    assert.equal(shocked.decision, "REPLAN");
    if (shocked.decision !== "REPLAN" || shocked.recommendedCandidate === null) {
      throw new Error("capacity-shock REPLAN winner missing");
    }
    assert.deepEqual(
      shocked.directPlan.capacityAfter.map((item) => [item.resourceKey, item.value]),
      [
        ["agent_work_units", 0],
        ["human_review_decisions", 1],
        ["production_cell_minutes", -6],
      ],
    );
    assert.deepEqual(
      shocked.candidates.map((candidate) => [
        candidate.strategy,
        candidate.feasible,
        candidate.affectedObligations.map((item) => item.optionId),
        candidate.capacity.capacityAfter,
      ]),
      [
        [
          "modify_existing",
          true,
          ["training-trays/reduce-to-8"],
          [
            { resourceKey: "agent_work_units", value: 1 },
            { resourceKey: "human_review_decisions", value: 1 },
            { resourceKey: "production_cell_minutes", value: 0 },
          ],
        ],
        [
          "modify_proposal",
          true,
          ["quality-fixtures/reduce-to-6"],
          [
            { resourceKey: "agent_work_units", value: 1 },
            { resourceKey: "human_review_decisions", value: 1 },
            { resourceKey: "production_cell_minutes", value: 0 },
          ],
        ],
        [
          "modify_both",
          true,
          ["training-trays/reduce-to-8", "quality-fixtures/reduce-to-6"],
          [
            { resourceKey: "agent_work_units", value: 2 },
            { resourceKey: "human_review_decisions", value: 1 },
            { resourceKey: "production_cell_minutes", value: 6 },
          ],
        ],
      ],
    );
    const winner = shocked.recommendedCandidate.affectedObligations;
    assert.deepEqual(
      winner.map((item) => [
        item.obligationId,
        item.optionId,
        item.previousServiceLevel,
        item.proposedServiceLevel,
      ]),
      [
        [
          "order/best-effort-training-trays",
          "training-trays/reduce-to-8",
          [{ field: "quantity", value: 10 }],
          [{ field: "quantity", value: 8 }],
        ],
      ],
    );
    const repeated = evaluateAdmission(createCapacityShockEvaluationInput());
    assert.equal(repeated.decision, "REPLAN");
    if (repeated.decision !== "REPLAN") throw new Error("repeat was not REPLAN");
    assert.equal(
      repeated.recommendedCandidate?.candidatePlanId,
      shocked.recommendedCandidate.candidatePlanId,
    );
    assert.equal(canonicalSerialize(repeated), canonicalSerialize(shocked));
  });
});

describe("capacity-shock durable mission", { concurrency: false }, () => {
  test("records exact decisions and one effect, then replays without duplication", async () => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-capacity-shock-runner-test-"));
    let ownerCalls = 0;
    try {
      const paths = {
        m2DatabasePath: join(root, "m2.sqlite"),
        factoryDatabasePath: join(root, "factory.sqlite"),
        missionDatabasePath: join(root, "mission.sqlite"),
      };
      const first = await runCapacityShockMission({
        ...paths,
        ownerDecisionProvider: (request) => {
          ownerCalls += 1;
          const deny =
            request.toolName === "create_schedule_reservation" &&
            canonicalSerialize(request.arguments).includes("09:12:00");
          return m4OwnerDecisionResponse(
            request,
            "owner/test-capacity-shock",
            deny
              ? {
                  status: "deny",
                  reason: "The primary interval overlaps the spindle calibration hold",
                }
              : { status: "allow" },
          );
        },
      });
      assert.equal(ownerCalls, 4);
      assert.equal(first.mission.missionId, CAPACITY_SHOCK_MISSION_ID);
      assert.equal(first.mission.disconnectedAndResumed, false);
      assert.deepEqual(
        first.mission.approvals.map((item) => [
          item.toolName,
          item.decision,
          item.source,
        ]),
        [
          ["select_portfolio_modification", "allow", "owner"],
          ["accept_promise", "allow", "owner"],
          ["create_schedule_reservation", "deny", "owner"],
          ["submit_schedule_change", "deny", "active_m2_denial"],
          ["create_schedule_reservation", "allow", "owner"],
        ],
      );
      assert.equal(first.staleBasisRejectionCount, 1);
      assert.equal(first.finalAttempt.executionAttemptId, CAPACITY_SHOCK_ATTEMPT_ID);
      assert.equal(first.factoryExecution.result.canonicalCommand.quantity, 8);
      assert.equal(first.factoryExecution.result.canonicalCommand.start, "2026-08-26T09:36:00.000Z");
      assert.equal(first.activeDenials.length, 1);
      assert.equal(first.actualConsumptionFacts, 2);

      const second = await runCapacityShockMission({
        ...paths,
        ownerDecisionProvider: () => {
          throw new Error("durable replay must not call the owner");
        },
      });
      assert.equal(second.mission.disconnectedAndResumed, true);
      assert.equal(second.mission.trueforgeSessionId, first.mission.trueforgeSessionId);
      assert.equal(second.mission.projectionDigest, first.mission.projectionDigest);
      assert.equal(
        second.factoryExecution.result.receipt.receiptId,
        first.factoryExecution.result.receipt.receiptId,
      );
      assert.equal(second.mission.approvals.length, 5);
      assert.equal(second.actualConsumptionFacts, 2);
      assert.equal(second.staleBasisRejectionCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M5 scenario selection and isolation", { concurrency: false }, () => {
  test("defaults to the unchanged hero and reattaches isolated capacity state", async () => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-capacity-shock-m5-test-"));
    let running: RunningM5JudgeServer | null = null;
    try {
      running = await startM5JudgeServer({
        dataRoot: root,
        port: 0,
        cleanupDataOnClose: false,
      });
      const heroBefore = await getState(running);
      assertOriginalHeroProjection(heroBefore);

      await post(running, "/api/scenario", {
        scenarioId: "capacity-shock",
        requestId: "capacity-selector-0001",
      });
      const capacityInitial = await getState(running);
      assert.equal(capacityInitial.scenario.initialDecision, "ADMITTABLE");
      assert.equal(capacityInitial.scenario.currentCapacityPlanVersion, "capacity-plan/v2");
      assert.deepEqual(
        capacityInitial.hero.capacity.map((item) => [
          item.resourceKey,
          item.declaredCapacity,
          item.existingUse,
          item.proposedConsumption,
          item.remainingCapacity,
        ]),
        [
          ["agent_work_units", 10, 7, 3, 0],
          ["human_review_decisions", 4, 1, 2, 1],
          ["production_cell_minutes", 90, 72, 24, -6],
        ],
      );
      assert.equal(capacityInitial.hero.winningModification.optionId, "training-trays/reduce-to-8");

      await post(running, "/api/mission", {
        operation: "start",
        requestId: "capacity-start-0001",
      });
      const firstTerminal = await completeRecommendedFlow(running);
      assert.equal(firstTerminal.run.status, "verified");
      assert.equal(firstTerminal.run.ownerCallsThisProcess, 4);
      assert.equal(firstTerminal.scenario.staleBasisRejectionCount, 1);
      assert.deepEqual(firstTerminal.safety, {
        ownerCallCount: 4,
        mechanicalDenialCount: 1,
        duplicateApprovalCount: 0,
        duplicateEffectCount: 0,
        unauthorizedMutationCount: 0,
      });
      assert.deepEqual(
        {
          acceptance: firstTerminal.execution.acceptanceCount,
          attempt: firstTerminal.execution.attemptCount,
          mutation: firstTerminal.execution.mutationCount,
          receipt: firstTerminal.execution.receiptCount,
          actuals: firstTerminal.execution.actualFactCount,
          terminal: firstTerminal.execution.terminalStatus,
        },
        {
          acceptance: 1,
          attempt: 1,
          mutation: 1,
          receipt: 1,
          actuals: 2,
          terminal: "terminal_verified",
        },
      );
      assert.deepEqual(
        firstTerminal.execution.actualFacts.map((item) => [item.resourceKey, item.value]),
        [
          ["agent_work_units", 3],
          ["production_cell_minutes", 24],
        ],
      );
      assert.equal(firstTerminal.execution.independentReadBackObserved, true);
      assert.equal(firstTerminal.hero.protectedWorkUnchanged, true);
      assert.equal(existsSync(join(root, "m2.sqlite")), false);
      assert.equal(existsSync(join(root, "factory.sqlite")), false);
      assert.equal(existsSync(join(root, "capacity-shock-m2.sqlite")), true);
      assert.equal(existsSync(join(root, "capacity-shock-factory.sqlite")), true);

      const sessionId = firstTerminal.mission.sessionId;
      const projectionDigest = firstTerminal.mission.terminalProjectionDigest;
      const receiptId = firstTerminal.execution.receiptId;
      await running.close();
      running = await startM5JudgeServer({
        dataRoot: root,
        port: 0,
        cleanupDataOnClose: false,
      });
      assertOriginalHeroProjection(await getState(running));
      await post(running, "/api/scenario", {
        scenarioId: "capacity-shock",
        requestId: "capacity-selector-restart-0001",
      });
      await post(running, "/api/mission", {
        operation: "start",
        requestId: "capacity-start-restart-0001",
      });
      const replay = await waitForState(
        running,
        (state) => state.run.status === "verified" || state.run.status === "failed",
      );
      assert.equal(replay.run.status, "verified");
      assert.equal(replay.run.ownerCallsThisProcess, 0);
      assert.equal(replay.mission.sessionId, sessionId);
      assert.equal(replay.mission.terminalProjectionDigest, projectionDigest);
      assert.equal(replay.execution.receiptId, receiptId);
      assert.equal(replay.execution.mutationCount, 1);
      assert.equal(replay.execution.attemptCount, 1);
      assert.equal(replay.execution.receiptCount, 1);
      assert.equal(replay.scenario.staleBasisRejectionCount, 1);

      await post(running, "/api/scenario", {
        scenarioId: "rush-order",
        requestId: "hero-selector-after-capacity-0001",
      });
      assertOriginalHeroProjection(await getState(running));
      assert.equal(existsSync(join(root, "capacity-shock-m2.sqlite")), true);
    } finally {
      await running?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function assertOriginalHeroProjection(state: M5JudgeState): void {
  assert.equal(state.scenario.scenarioId, "rush-order");
  assert.equal(state.mission.missionId, "mission/flakebrake-m4-hero");
  assert.equal(state.hero.directDecision, "REPLAN");
  assert.deepEqual(
    state.hero.capacity.map((item) => [
      item.resourceKey,
      item.declaredCapacity,
      item.existingUse,
      item.proposedConsumption,
      item.remainingCapacity,
    ]),
    [
      ["agent_work_units", 12, 8, 6, -2],
      ["human_review_decisions", 4, 2, 3, -1],
      ["production_cell_minutes", 110, 70, 30, 10],
    ],
  );
  assert.equal(state.hero.winningModification.optionId, "best-effort-order/reduce-to-8");
  assert.deepEqual(
    [
      state.hero.winningModification.fromQuantity,
      state.hero.winningModification.toQuantity,
    ],
    [10, 8],
  );
  assert.equal(state.hero.protectedWorkUnchanged, true);
}

async function completeRecommendedFlow(
  running: RunningM5JudgeServer,
): Promise<M5JudgeState> {
  let ownerCall = 0;
  while (true) {
    const state = await waitForState(
      running,
      (candidate) =>
        candidate.pendingApproval !== null ||
        candidate.run.status === "verified" ||
        candidate.run.status === "failed",
    );
    if (state.run.status === "verified" || state.run.status === "failed") return state;
    const pending = state.pendingApproval;
    if (pending === null) throw new Error("pending approval disappeared");
    ownerCall += 1;
    await post(running, "/api/approval", {
      missionId: pending.missionId,
      actionIdentity: pending.actionIdentity,
      decision: pending.recommendedDecision,
      reason:
        pending.recommendedDecision === "deny" ? state.scenario.denialReason : null,
      requestId: `capacity-owner-${String(ownerCall).padStart(4, "0")}`,
    });
    await waitForState(
      running,
      (candidate) =>
        candidate.pendingApproval?.actionIdentity !== pending.actionIdentity ||
        candidate.run.status === "verified" ||
        candidate.run.status === "failed",
    );
  }
}

async function getState(running: RunningM5JudgeServer): Promise<M5JudgeState> {
  const response = await fetch(`${running.url}/api/state`);
  assert.equal(response.status, 200);
  return (await response.json()) as M5JudgeState;
}

async function post(
  running: RunningM5JudgeServer,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${running.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: running.url },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
}

async function waitForState(
  running: RunningM5JudgeServer,
  predicate: (state: M5JudgeState) => boolean,
): Promise<M5JudgeState> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await getState(running);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("M5 capacity-shock state did not reach the expected condition");
}
