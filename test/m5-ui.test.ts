import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createContext, runInContext } from "node:vm";

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

test("M5 Round 1 reproduction: CLI close failure still removes its temporary root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "flakebrake M5 CLI close "));
  const child = spawn(process.execPath, [join(process.cwd(), "dist/src/m5-cli.js"), "--port", "0"], {
    cwd: process.cwd(),
    env: portableTemporaryEnvironment(parent),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForChildOutput(child, "FlakeBrake judge UI ready:");
    const roots = readdirSync(parent);
    assert.equal(roots.length, 1);
    writeFileSync(join(parent, roots[0] as string, ".flakebrake-m5-owned-v1"), "invalid\n");
    child.kill("SIGTERM");
    await waitForChildExit(child);
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("M5 Round 1 reproduction: a driver quit failure cannot skip server and data cleanup", async () => {
  const parent = mkdtempSync(join(tmpdir(), "flakebrake M5 driver close "));
  const child = spawn(process.execPath, [join(process.cwd(), "dist/test/m5-browser-smoke.js")], {
    cwd: process.cwd(),
    env: {
      ...portableTemporaryEnvironment(parent),
      FLAKEBRAKE_M5_INJECT_DRIVER_QUIT_FAILURE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const result = await waitForChildExit(child, 120_000);
    assert.notEqual(result.code, 0);
    assert.deepEqual(findOwnedM5Roots(parent), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("M5 Round 1 reproduction: stale poll responses cannot regress newer UI state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-poll-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const idle = coordinator.state();
    const pending = uiProjection(idle, 2, "awaiting_approval");
    const terminal = uiProjection(idle, 3, "verified");
    const oldResponse = deferred<M5JudgeState>();
    const newResponse = deferred<M5JudgeState>();
    const harness = await createPollingHarness(idle, [oldResponse.promise, newResponse.promise]);
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    const newPoll = harness.evaluate<Promise<void>>("refresh()");
    newResponse.resolve(terminal);
    await newPoll;
    oldResponse.resolve(pending);
    await oldPoll;
    assert.equal(harness.text("outcome"), "Verified success");
    assert.equal(harness.hasClass("approval-panel", "is-hidden"), true);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 1 reproduction: fragmented accepted requests cannot block bounded shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-fragment-"));
  const running = await startM5JudgeServer({ dataRoot: directory, port: 0, cleanupDataOnClose: false });
  let socket: Socket | null = null;
  try {
    ({ socket } = await acceptedFragmentedRequest(running));
    const close = running.close();
    const result = await Promise.race([
      close.then(() => "closed" as const),
      new Promise<"timed_out">((resolveTimeout) => setTimeout(() => resolveTimeout("timed_out"), 2_000)),
    ]);
    if (result === "timed_out") socket.destroy();
    await close;
    assert.equal(result, "closed");
  } finally {
    socket?.destroy();
    await running.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 1: shutdown rejects an accepted mutation and close is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-post-close-"));
  const running = await startM5JudgeServer({ dataRoot: directory, port: 0, cleanupDataOnClose: false });
  let socket: Socket | null = null;
  try {
    const fragmented = await acceptedFragmentedRequest(running);
    socket = fragmented.socket;
    const generation = running.coordinator.state().run.generation;
    const close = running.close();
    socket.write(fragmented.remainder);
    await close;
    await running.close();
    assert.equal(running.coordinator.state().run.generation, generation);
    await assert.rejects(fetch(running.url), /fetch failed|ECONNREFUSED/u);
  } finally {
    socket?.destroy();
    await running.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 1: mutation and reset generations discard older responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-mutation-race-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const idle = coordinator.state();
    const firstApproval = uiProjection(idle, 2, "awaiting_approval");
    const nextApproval = {
      ...uiProjection(idle, 3, "awaiting_approval"),
      pendingApproval: {
        ...(uiProjection(idle, 3, "awaiting_approval").pendingApproval as NonNullable<M5JudgeState["pendingApproval"]>),
        actionIdentity: `sha256:${"b".repeat(64)}`,
        expectedEffect: "Reserve the safe alternative",
      },
    };
    const staleMutation = deferred<unknown>();
    const freshPoll = deferred<unknown>();
    const harness = await createPollingHarness(idle, [staleMutation.promise, freshPoll.promise]);
    const mutation = harness.evaluate<Promise<void>>(
      `mutate("/api/approval", {missionId: ${JSON.stringify(idle.mission.missionId)}, actionIdentity: ${JSON.stringify(firstApproval.pendingApproval?.actionIdentity)}, decision: "deny", reason: "bounded", requestId: "race-approval"})`,
    );
    const poll = harness.evaluate<Promise<void>>("refresh()");
    freshPoll.resolve(nextApproval);
    await poll;
    staleMutation.resolve({ state: firstApproval });
    await mutation;
    assert.equal(harness.text("approval-digest"), nextApproval.pendingApproval?.actionIdentity);

    const stalePoll = deferred<unknown>();
    const resetResponse = deferred<unknown>();
    harness.enqueue(stalePoll.promise, resetResponse.promise);
    const pollBeforeReset = harness.evaluate<Promise<void>>("refresh()");
    const reset = harness.evaluate<Promise<void>>(
      'mutate("/api/mission", {operation: "reset", requestId: "race-reset"})',
    );
    resetResponse.resolve({ state: { ...idle, revision: 4, run: { ...idle.run, generation: idle.run.generation + 1 } } });
    await reset;
    stalePoll.resolve(nextApproval);
    await pollBeforeReset;
    assert.equal(harness.text("outcome"), "Waiting");
    assert.equal(harness.hasClass("approval-panel", "is-hidden"), true);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 1: reconnect generation invalidates responses issued before disconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-reconnect-race-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const idle = coordinator.state();
    const stale = deferred<unknown>();
    const disconnected = deferred<unknown>();
    const terminal = uiProjection(idle, 5, "verified");
    const harness = await createPollingHarness(idle, [stale.promise, disconnected.promise]);
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    const reconnect = harness.evaluate<Promise<void>>("refresh()");
    disconnected.reject(new Error("controlled disconnect"));
    await reconnect;
    harness.enqueue(Promise.resolve(terminal));
    await harness.evaluate<Promise<void>>("refresh()");
    stale.resolve(uiProjection(idle, 2, "awaiting_approval"));
    await oldPoll;
    assert.equal(harness.text("outcome"), "Verified success");
    assert.equal(harness.hasClass("approval-panel", "is-hidden"), true);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 2 reproduction: an authoritative failed mission retry becomes actionable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-recovery-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const idle = coordinator.state();
    const failed: M5JudgeState = {
      ...idle,
      revision: 2,
      run: { ...idle.run, status: "failed", generation: 1, errorCode: "controlled_failure" },
      mission: { ...idle.mission, sessionId: "session/ui-recovery", currentTurnId: "turn/failed" },
    };
    const resumed: M5JudgeState = {
      ...uiProjection(failed, 3, "awaiting_approval"),
      run: { ...failed.run, status: "awaiting_approval", generation: 2, errorCode: null },
      mission: { ...failed.mission, currentTurnId: "turn/resumed" },
    };
    const harness = await createPollingHarness(failed, [Promise.resolve({ state: resumed })]);
    await harness.evaluate<Promise<void>>(
      'mutate("/api/mission", {operation: "start", requestId: "judge-recover-0001"})',
    );
    assert.equal(harness.text("outcome"), "Owner decision");
    assert.equal(harness.hasClass("approval-panel", "is-hidden"), false);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 2 reproduction: coordinator cleanup waits for an accepted handler", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-handler-order-"));
  const running = await startM5JudgeServer({
    dataRoot: directory,
    port: 0,
    cleanupDataOnClose: false,
    requestDrainTimeoutMs: 5_000,
  });
  let socket: Socket | null = null;
  try {
    const fragmented = await acceptedFragmentedRequest(running);
    socket = fragmented.socket;
    const close = running.close();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.notEqual(running.coordinator.state().run.status, "closed");
    socket.write(fragmented.remainder);
    await close;
  } finally {
    socket?.destroy();
    await running.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 2 reproduction: subprocess temp ownership is portable", () => {
  const directory = resolve(tmpdir(), "flakebrake M5 portable temp fixture");
  const environment = portableTemporaryEnvironment(directory);
  assert.equal(isAbsolute(directory), true);
  assert.equal(environment["TMPDIR"], directory);
  assert.equal(environment["TMP"], directory);
  assert.equal(environment["TEMP"], directory);
});

test("M5 Round 2: stale failures and fake recovery evidence cannot replace resumed state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-recovery-races-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const idle = coordinator.state();
    const failed: M5JudgeState = {
      ...idle,
      revision: 2,
      run: { ...idle.run, status: "failed", generation: 1, errorCode: "controlled_failure" },
      mission: { ...idle.mission, sessionId: "session/ui-recovery", currentTurnId: "turn/failed" },
    };
    const resumed: M5JudgeState = {
      ...uiProjection(failed, 3, "awaiting_approval"),
      run: { ...failed.run, status: "awaiting_approval", generation: 2, errorCode: null },
      mission: { ...failed.mission, currentTurnId: "turn/resumed" },
    };
    const staleFailure = deferred<unknown>();
    const recoveryResponse = deferred<unknown>();
    const harness = await createPollingHarness(failed, [staleFailure.promise, recoveryResponse.promise]);
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    const recovery = harness.evaluate<Promise<void>>(
      'mutate("/api/mission", {operation: "start", requestId: "judge-recover-race-0001"})',
    );
    recoveryResponse.resolve({ state: resumed });
    await recovery;
    staleFailure.resolve({ ...failed, revision: 4 });
    await oldPoll;
    assert.equal(harness.text("outcome"), "Owner decision");
    assert.equal(harness.text("approval-digest"), resumed.pendingApproval?.actionIdentity);

    const fakeRetry = {
      ...resumed,
      revision: 5,
      run: { ...resumed.run, generation: 3, status: "running" as const },
    };
    const fakeHarness = await createPollingHarness(failed, [Promise.resolve(fakeRetry)]);
    await fakeHarness.evaluate<Promise<void>>("refresh()");
    assert.equal(fakeHarness.text("outcome"), "Stopped safely");

    const terminal = {
      ...uiProjection(resumed, 6, "verified"),
      mission: resumed.mission,
    };
    harness.enqueue(Promise.resolve(terminal));
    await harness.evaluate<Promise<void>>("refresh()");
    harness.enqueue(Promise.resolve({ ...resumed, revision: 7, run: { ...resumed.run, generation: 3 } }));
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.text("outcome"), "Verified success");
    assert.equal(harness.hasClass("approval-panel", "is-hidden"), true);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 2: a failed durable coordinator retry advances its recovery generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-durable-retry-"));
  const coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
  try {
    const trueforgePath = join(directory, "trueforge.sqlite");
    writeFileSync(trueforgePath, "controlled invalid SQLite fixture\n");
    const started = coordinator.start();
    assert.equal(started.run.generation, 1);
    const failed = await waitForCoordinatorState(coordinator, (state) => state.run.status === "failed");
    assert.equal(failed.run.generation, 1);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${trueforgePath}${suffix}`, { force: true });

    const retry = coordinator.start();
    assert.equal(retry.run.generation, 2);
    const resumed = await waitForCoordinatorState(
      coordinator,
      (state) => state.run.status === "awaiting_approval",
    );
    assert.equal(resumed.run.generation, 2);
    assert.ok(resumed.pendingApproval);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 2: unsettled handlers retain durable ownership and a later close retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-stuck-handler-"));
  const releaseSettlement = deferred<void>();
  let blockSettlement = false;
  const running = await startM5JudgeServer({
    dataRoot: directory,
    port: 0,
    cleanupDataOnClose: true,
    requestDrainTimeoutMs: 25,
    beforeHandlerSettlement: async ({ pathname }) => {
      if (blockSettlement && pathname === "/api/mission") await releaseSettlement.promise;
    },
  });
  let socket: Socket | null = null;
  try {
    await postJson(running, "/api/mission", {
      operation: "start",
      requestId: "judge-stuck-handler-start-0001",
    });
    await waitForState(running, (state) => state.pendingApproval !== null);
    assert.equal(existsSync(join(directory, "m2.sqlite")), true);
    blockSettlement = true;
    const fragmented = await acceptedFragmentedRequest(running);
    socket = fragmented.socket;
    const close = running.close();
    socket.write(fragmented.remainder);
    await assert.rejects(close, /handler shutdown did not settle safely/u);
    assert.equal(running.coordinator.state().run.status, "awaiting_approval");
    assert.equal(existsSync(join(directory, "m2.sqlite")), true);

    releaseSettlement.resolve();
    await running.close();
    await running.close();
    assert.equal(running.coordinator.state().run.status, "closed");
    assert.equal(existsSync(join(directory, "m2.sqlite")), false);
    assert.equal(existsSync(join(directory, "factory.sqlite")), false);
  } finally {
    releaseSettlement.resolve();
    socket?.destroy();
    await running.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 3 reproduction: malformed request targets stay inside the handler lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-malformed-target-"));
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { startM5JudgeServer } from ${JSON.stringify(moduleUrl)};
        const running = await startM5JudgeServer({
          dataRoot: ${JSON.stringify(directory)},
          port: 0,
          cleanupDataOnClose: true,
        });
        process.send?.({ type: "ready", port: running.port });
        process.on("message", async (message) => {
          if (message !== "close") return;
          await running.close();
          process.send?.({ type: "closed" });
          process.disconnect();
        });
      `,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  try {
    const ready = await waitForChildProtocolMessage(child, "ready");
    assert.equal(typeof ready["port"], "number");
    const port = ready["port"] as number;
    const malformed = await rawHttpExchange(
      port,
      `GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(malformed, /^HTTP\/1\.1 400 /u);
    assert.match(malformed, /"error":"invalid_request_target"/u);

    const valid = await rawHttpExchange(
      port,
      `GET /api/state?after=malformed HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(valid, /^HTTP\/1\.1 200 /u);
    child.send("close");
    await waitForChildProtocolMessage(child, "closed");
    const exited = await waitForChildExit(child);
    assert.equal(exited.code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 3: request targets are strict origin-form and settle without effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-target-validation-"));
  const running = await startM5JudgeServer({
    dataRoot: directory,
    port: 0,
    cleanupDataOnClose: true,
  });
  try {
    const invalidTargets = [
      { target: "/api/state?malformed=%ZZ", applicationRejected: true },
      { target: "//[::1", applicationRejected: true },
      {
        target: `http://127.0.0.1:${String(running.port)}/api/state`,
        applicationRejected: true,
      },
      {
        target: `127.0.0.1:${String(running.port)}`,
        applicationRejected: false,
      },
      { target: "*", applicationRejected: true },
    ];
    for (const { target, applicationRejected } of invalidTargets) {
      const response = await rawHttpExchange(
        running.port,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(running.port)}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(response, /^HTTP\/1\.1 400 /u, target);
      if (applicationRejected) {
        assert.match(response, /"error":"invalid_request_target"/u, target);
      }
      await waitForActiveRequestCount(running, 0);
    }

    const valid = await rawHttpExchange(
      running.port,
      `GET /api/state?path=%2Fjudge%20flow&mode=read HTTP/1.1\r\nHost: 127.0.0.1:${String(running.port)}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(valid, /^HTTP\/1\.1 200 /u);
    await waitForActiveRequestCount(running, 0);
    const state = running.coordinator.state();
    assert.equal(state.run.status, "idle");
    assert.equal(state.execution.mutationCount, 0);
    assert.deepEqual(readdirSync(directory).sort(), [".flakebrake-m5-owned-v1"]);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("M5 Round 3: malformed requests settle during bounded shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-malformed-close-"));
  const settlementEntered = deferred<void>();
  const releaseSettlement = deferred<void>();
  const running = await startM5JudgeServer({
    dataRoot: directory,
    port: 0,
    cleanupDataOnClose: true,
    requestDrainTimeoutMs: 100,
    beforeHandlerSettlement: async ({ pathname }) => {
      if (pathname !== "<invalid-request-target>") return;
      settlementEntered.resolve();
      await releaseSettlement.promise;
    },
  });
  try {
    const malformed = rawHttpExchange(
      running.port,
      `GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${String(running.port)}\r\nConnection: close\r\n\r\n`,
    );
    await settlementEntered.promise;
    assert.equal(running.activeRequestCount(), 1);
    const close = running.close();
    releaseSettlement.resolve();
    assert.match(await malformed, /^HTTP\/1\.1 400 /u);
    await close;
    assert.equal(running.activeRequestCount(), 0);
    const state = running.coordinator.state();
    assert.equal(state.run.status, "closed");
    assert.equal(state.execution.mutationCount, 0);
    for (const name of ["m2.sqlite", "factory.sqlite", "mission.sqlite", "trueforge.sqlite"]) {
      assert.equal(existsSync(join(directory, name)), false);
    }
  } finally {
    releaseSettlement.resolve();
    await running.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

async function acceptedFragmentedRequest(running: RunningM5JudgeServer): Promise<{ socket: Socket; remainder: string }> {
  const socket = createConnection({ host: "127.0.0.1", port: running.port });
  await once(socket, "connect");
  const body = JSON.stringify({ operation: "reset", requestId: "judge-fragmented-close-0001" });
  const fragmentLength = 3;
  socket.write(
    `POST /api/mission HTTP/1.1\r\nHost: 127.0.0.1:${running.port}\r\nOrigin: ${running.url}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\nConnection: keep-alive\r\n\r\n${body.slice(0, fragmentLength)}`,
  );
  let response = "";
  while (!response.includes("100 Continue")) {
    const [chunk] = await once(socket, "data") as [Buffer];
    response += chunk.toString("utf8");
  }
  return { socket, remainder: body.slice(fragmentLength) };
}

async function rawHttpExchange(port: number, request: string): Promise<string> {
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  socket.setEncoding("utf8");
  return await new Promise<string>((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResponse(new Error("raw HTTP exchange did not settle"));
    }, 5_000);
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      if (error !== undefined && response.length === 0) rejectResponse(error);
      else resolveResponse(response);
    };
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("connect", () => socket.end(request));
    socket.once("error", settle);
    socket.once("close", () => settle());
  });
}

async function waitForActiveRequestCount(
  running: RunningM5JudgeServer,
  expected: number,
): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (running.activeRequestCount() === expected) return;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  assert.equal(running.activeRequestCount(), expected);
}

async function waitForChildProtocolMessage(
  child: ChildProcess,
  expectedType: string,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(
      () => rejectMessage(new Error(`child did not report ${expectedType}`)),
      5_000,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record["type"] !== expectedType) return;
      cleanup();
      resolveMessage(record);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectMessage(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectMessage(
        new Error(`child exited before ${expectedType} (${String(code)}/${String(signal)})`),
      );
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForChildOutput(child: ChildProcess, text: string, timeout = 20_000): Promise<void> {
  let output = "";
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`child did not report ${text}`)), timeout);
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(text)) {
        clearTimeout(timer);
        child.stdout?.off("data", inspect);
        resolveReady();
      }
    };
    child.stdout?.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`child exited before readiness (${String(code)}/${String(signal)})`));
    });
  });
}

async function waitForCoordinatorState(
  coordinator: M5DemoCoordinator,
  predicate: (state: M5JudgeState) => boolean,
): Promise<M5JudgeState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = coordinator.state();
    if (predicate(state)) return state;
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 10));
  }
  throw new Error("M5 coordinator did not reach the expected bounded state");
}

async function waitForChildExit(child: ChildProcess, timeout = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("child did not exit")), timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function findOwnedM5Roots(parent: string): readonly string[] {
  return readdirSync(parent)
    .map((entry) => join(parent, entry))
    .filter((path) => existsSync(join(path, ".flakebrake-m5-owned-v1")));
}

function portableTemporaryEnvironment(directory: string): NodeJS.ProcessEnv {
  const absolute = resolve(directory);
  if (!isAbsolute(absolute)) throw new TypeError("M5 temporary fixture directory must be absolute");
  return { ...process.env, TMPDIR: absolute, TMP: absolute, TEMP: absolute };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function uiProjection(base: M5JudgeState, revision: number, status: "awaiting_approval" | "verified"): M5JudgeState {
  return {
    ...base,
    revision,
    run: { ...base.run, status, connection: status === "verified" ? "connected" : "awaiting_owner" },
    mission: { ...base.mission, sessionId: "session/ui-race", currentTurnId: "turn/ui-race" },
    pendingApproval: status === "verified" ? null : {
      missionId: base.mission.missionId,
      actionIdentity: `sha256:${"a".repeat(64)}`,
      phase: "consequential_effect",
      toolName: "create_schedule_reservation",
      expectedEffect: "Reserve the primary interval",
      recommendedDecision: "deny",
      ownerSourceIdentity: "owner/judge-ui",
    },
    execution: status === "verified"
      ? { ...base.execution, terminalStatus: "terminal_verified", mutationCount: 1, receiptCount: 1, attemptCount: 1, acceptanceCount: 1, actualFactCount: 2 }
      : base.execution,
  };
}

async function createPollingHarness(initial: M5JudgeState, responses: readonly Promise<unknown>[]): Promise<{
  evaluate<T>(source: string): T;
  enqueue(...responses: readonly Promise<unknown>[]): void;
  text(id: string): string;
  hasClass(id: string, className: string): boolean;
}> {
  const nodeMap = new Map<string, FakeNode>();
  const responseQueue = [Promise.resolve(initial), ...responses];
  const context = createContext({
    console,
    Date,
    document: { getElementById: (id: string) => fakeNode(nodeMap, id) },
    fetch: async () => ({ ok: true, json: async () => await (responseQueue.shift() as Promise<unknown>) }),
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
  });
  (context as Record<string, unknown>)["window"] = context;
  runInContext(readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8"), context);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  return {
    evaluate: <T>(source: string): T => runInContext(source, context) as T,
    enqueue: (...items): void => { responseQueue.push(...items); },
    text: (id: string): string => fakeNode(nodeMap, id).textContent,
    hasClass: (id: string, className: string): boolean => fakeNode(nodeMap, id).classList.values.has(className),
  };
}

interface FakeNode {
  textContent: string;
  innerHTML: string;
  className: string;
  disabled: boolean;
  classList: { readonly values: Set<string>; add(...values: string[]): void; remove(...values: string[]): void; toggle(value: string, force?: boolean): boolean };
  addEventListener(): void;
}

function fakeNode(nodes: Map<string, FakeNode>, id: string): FakeNode {
  const existing = nodes.get(id);
  if (existing !== undefined) return existing;
  const values = new Set<string>();
  const node: FakeNode = {
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    classList: {
      values,
      add: (...items) => { for (const item of items) values.add(item); },
      remove: (...items) => { for (const item of items) values.delete(item); },
      toggle: (item, force) => {
        const active = force ?? !values.has(item);
        if (active) values.add(item); else values.delete(item);
        return active;
      },
    },
    addEventListener: () => undefined,
  };
  nodes.set(id, node);
  return node;
}
