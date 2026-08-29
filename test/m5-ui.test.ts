import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  M5DemoCoordinator,
  parseJsonRejectingDuplicateKeys,
  startM5JudgeServer,
  type M5JudgeState,
  type RunningM5JudgeServer,
} from "../src/index.js";
import { parseM5CliArguments } from "../src/m5-cli.js";

const EXPECTED_APPROVAL_ROUTE = [
  ["select_portfolio_modification", "allow", "owner"],
  ["accept_promise", "allow", "owner"],
  ["create_schedule_reservation", "deny", "owner"],
  ["submit_schedule_change", "deny", "active_m2_denial"],
  ["create_schedule_reservation", "allow", "owner"],
] as const;

describe("M5 judge UI", { concurrency: false }, () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-test-"));
  let running!: RunningM5JudgeServer;
  let initial!: M5JudgeState;
  let terminal!: M5JudgeState;
  let ownerCalls = 0;
  let sessionId = "";
  let projectionDigest = "";

  before(async () => {
    running = await startM5JudgeServer({
      dataRoot: directory,
      port: 0,
      cleanupDataOnClose: false,
    });
    initial = await getState(running);
  });

  after(async () => {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("CLI fully validates options before allocating resources", () => {
    assert.deepEqual(parseM5CliArguments([]), { help: false, port: 4173, dataRoot: null });
    assert.deepEqual(parseM5CliArguments(["--port", "0", "--data-dir", directory]), {
      help: false,
      port: 0,
      dataRoot: directory,
    });
    for (const input of [
      ["--port"],
      ["--port", "--data-dir"],
      ["--port", "invalid"],
      ["--port", "4173", "--port", "5"],
      ["--data-dir"],
      ["--unknown"],
    ]) {
      assert.throws(() => parseM5CliArguments(input));
    }
  });

  test("initial projection is canonical REPLAN evidence rather than presentation fixtures", () => {
    assert.equal(initial.run.status, "idle");
    assert.equal(initial.hero.directDecision, "REPLAN");
    assert.deepEqual(
      initial.hero.capacity.map((item) => [
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
    assert.deepEqual(
      [initial.hero.winningModification.fromQuantity, initial.hero.winningModification.toQuantity],
      [10, 8],
    );
    assert.equal(initial.hero.protectedWorkUnchanged, true);
  });

  test("complete hero flow binds four owner calls and mechanically denies the alternate adapter", async () => {
    const startId = "judge-start-idempotency-0001";
    await postJson(running, "/api/mission", { operation: "start", requestId: startId });
    const replayedStart = await postJson(running, "/api/mission", {
      operation: "start",
      requestId: startId,
    });
    assert.equal(replayedStart["replayed"], true);

    let firstAction:
      | { missionId: string; actionIdentity: string; decision: "allow" | "deny"; reason: string | null }
      | null = null;
    while (true) {
      const current = await waitForState(
        running,
        (state) => state.pendingApproval !== null || isTerminal(state),
      );
      if (isTerminal(current)) {
        terminal = current;
        break;
      }
      const pending = current.pendingApproval;
      assert.ok(pending);
      ownerCalls += 1;
      const decision = pending.recommendedDecision;
      const action = {
        missionId: pending.missionId,
        actionIdentity: pending.actionIdentity,
        decision,
        reason:
          decision === "deny"
            ? "The primary interval conflicts with protected production commitments"
            : null,
      } as const;
      firstAction ??= action;
      if (ownerCalls === 1) {
        const stale = await postJsonResponse(running, "/api/approval", {
          ...action,
          actionIdentity: `${action.actionIdentity}-stale`,
          requestId: "judge-stale-action-0001",
        });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json() as Record<string, unknown>)["error"], "stale_action");
      }
      const approvalId = `judge-approval-${String(ownerCalls).padStart(4, "0")}`;
      await postJson(running, "/api/approval", { ...action, requestId: approvalId });
      const replay = await postJson(running, "/api/approval", {
        ...action,
        requestId: approvalId,
      });
      assert.equal(replay["replayed"], true);
      const semanticReplay = await postJson(running, "/api/approval", {
        ...action,
        requestId: `judge-semantic-retry-${String(ownerCalls).padStart(4, "0")}`,
      });
      assert.equal(semanticReplay["replayed"], true);
      await waitForState(
        running,
        (next) =>
          next.run.status === "failed" ||
          next.run.status === "verified" ||
          next.pendingApproval?.actionIdentity !== pending.actionIdentity,
      );
    }

    assert.equal(ownerCalls, 4);
    assert.ok(firstAction);
    const conflicting = await postJsonResponse(running, "/api/approval", {
      ...firstAction,
      decision: "deny",
      reason: "Conflicting stale decision",
      requestId: "judge-stale-conflict-0001",
    });
    assert.equal(conflicting.status, 409);
    assert.equal((await conflicting.json() as Record<string, unknown>)["error"], "approval_conflict");
    assert.deepEqual(
      terminal.approvals.map((item) => [item.toolName, item.decision, item.source]),
      EXPECTED_APPROVAL_ROUTE,
    );
    sessionId = terminal.mission.sessionId as string;
    projectionDigest = terminal.mission.terminalProjectionDigest as string;
  });

  test("verified projection proves one authorized effect, receipt, read-back, and actuals", () => {
    assert.equal(terminal.run.status, "verified");
    assert.equal(terminal.run.ownerCallsThisProcess, 4);
    assert.deepEqual(terminal.safety, {
      ownerCallCount: 4,
      mechanicalDenialCount: 1,
      duplicateApprovalCount: 0,
      duplicateEffectCount: 0,
      unauthorizedMutationCount: 0,
    });
    assert.deepEqual(
      {
        acceptance: terminal.execution.acceptanceCount,
        attempt: terminal.execution.attemptCount,
        mutation: terminal.execution.mutationCount,
        receipt: terminal.execution.receiptCount,
        actuals: terminal.execution.actualFactCount,
        terminal: terminal.execution.terminalStatus,
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
    assert.equal(terminal.execution.independentReadBackObserved, true);
    assert.match(terminal.execution.approvedInterval ?? "", /09:40.*10:10/u);
    assert.deepEqual(
      terminal.execution.actualFacts.map((item) => [item.resourceKey, item.value]),
      [
        ["agent_work_units", 6],
        ["production_cell_minutes", 30],
      ],
    );
    assert.equal(terminal.hero.protectedWorkUnchanged, true);
    assert.equal(terminal.activity.subagents.length, 3);
    assert.equal(terminal.activity.sandboxExecutions, 1);
    assert.equal(terminal.activity.mcpServers.length, 4);
  });

  test("refresh returns the durable projection without repeating effects", async () => {
    const refreshed = await getState(running);
    assert.equal(refreshed.mission.sessionId, sessionId);
    assert.equal(refreshed.mission.terminalProjectionDigest, projectionDigest);
    assert.equal(refreshed.execution.mutationCount, 1);
    assert.equal(refreshed.run.ownerCallsThisProcess, 4);
  });

  test("HTTP control boundary rejects origin, method, content type, and malformed JSON", async () => {
    const wrongOrigin = await fetch(`${running.url}/api/mission`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.invalid" },
      body: JSON.stringify({ operation: "reset", requestId: "judge-security-origin-01" }),
    });
    assert.equal(wrongOrigin.status, 403);
    const missingOrigin = await fetch(`${running.url}/api/mission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "reset", requestId: "judge-security-origin-02" }),
    });
    assert.equal(missingOrigin.status, 403);
    const wrongMethod = await fetch(`${running.url}/api/state`, { method: "POST", headers: { Origin: running.url } });
    assert.equal(wrongMethod.status, 405);
    const wrongType = await fetch(`${running.url}/api/mission`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: running.url },
      body: "not json",
    });
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(`${running.url}/api/mission`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: running.url },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    const extraField = await postJsonResponse(running, "/api/mission", {
      operation: "reset",
      requestId: "judge-security-shape-01",
      unexpected: true,
    });
    assert.equal(extraField.status, 400);
    assert.equal((await getState(running)).execution.mutationCount, 1);
  });

  test("server restart replays the terminal mission without owner calls or execution", async () => {
    await running.close();
    running = await startM5JudgeServer({
      dataRoot: directory,
      port: 0,
      cleanupDataOnClose: false,
    });
    await postJson(running, "/api/mission", {
      operation: "start",
      requestId: "judge-restart-replay-0001",
    });
    const replay = await waitForState(running, isTerminal);
    assert.equal(replay.run.status, "verified");
    assert.equal(replay.run.ownerCallsThisProcess, 0);
    assert.equal(replay.mission.sessionId, sessionId);
    assert.equal(replay.mission.terminalProjectionDigest, projectionDigest);
    assert.equal(replay.mission.disconnectedAndResumed, true);
    assert.equal(replay.execution.mutationCount, 1);
    assert.equal(replay.execution.receiptCount, 1);
    assert.equal(replay.execution.attemptCount, 1);
  });

  test("reset removes only invocation-owned durable state", async () => {
    await postJson(running, "/api/mission", {
      operation: "reset",
      requestId: "judge-reset-owned-0001",
    });
    const reset = await getState(running);
    assert.equal(reset.run.status, "idle");
    assert.equal(reset.execution.mutationCount, 0);
    for (const file of ["m2.sqlite", "factory.sqlite", "mission.sqlite", "trueforge.sqlite"]){
      assert.equal(existsSync(join(directory, file)), false);
    }
    assert.equal(existsSync(join(directory, ".flakebrake-m5-owned-v1")), true);
  });

  test("critical controls and responsive document landmarks are accessible", () => {
    const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
    assert.match(document, /<meta name="viewport"/u);
    assert.match(document, /<main id="main">/u);
    assert.match(document, /aria-live="polite"/u);
    assert.match(document, /id="start-button"[^>]*type="button"/u);
    assert.match(document, /id="allow-button"[^>]*type="button"/u);
    assert.match(document, /id="deny-button"[^>]*type="button"/u);
    assert.match(document, /aria-labelledby="approval-title"/u);
    const stylesheet = readFileSync(join(process.cwd(), "ui/m5/styles.css"), "utf8");
    assert.match(stylesheet, /@media \(max-width: 980px\)/u);
    assert.match(stylesheet, /:focus-visible/u);
    assert.doesNotThrow(() => parseJsonRejectingDuplicateKeys(JSON.stringify(initial)));
  });
});

async function getState(running: RunningM5JudgeServer): Promise<M5JudgeState> {
  const response = await fetch(`${running.url}/api/state`);
  assert.equal(response.status, 200);
  return (await response.json()) as M5JudgeState;
}

async function postJson(
  running: RunningM5JudgeServer,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJsonResponse(running, path, body);
  if (response.status !== 200) {
    throw new Error(`Expected HTTP 200, received ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function postJsonResponse(
  running: RunningM5JudgeServer,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: running.url },
    body: JSON.stringify(body),
  });
}

async function waitForState(
  running: RunningM5JudgeServer,
  predicate: (state: M5JudgeState) => boolean,
): Promise<M5JudgeState> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await getState(running);
    if (predicate(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("M5 state did not reach the expected bounded condition");
}

function isTerminal(state: M5JudgeState): boolean {
  return state.run.status === "verified" || state.run.status === "failed";
}

test("M5 coordinator rejects unowned data roots without mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-unowned-"));
  const sentinel = join(directory, "sentinel.txt");
  try {
    writeFileSync(sentinel, "preserve\n");
    assert.throws(() => new M5DemoCoordinator({ dataRoot: directory }), /not empty/u);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
