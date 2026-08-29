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
import {
  armSessionErrorCapture,
  armSessionNetworkCapture,
  CONTROLLED_ERROR_PROBE_URL,
  formatFailedResponse,
  type BrowserNetworkObserver,
  type BrowserScriptErrorObserver,
  type ObserverSessionBrowser,
} from "./m5-error-capture.js";

describe("M5 judge-readiness audit F-01 through F-26", () => {
  const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
  const application = readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8");
  const stylesheet = readFileSync(join(process.cwd(), "ui/m5/styles.css"), "utf8");
  const projection = readFileSync(join(process.cwd(), "src/m5-ui.ts"), "utf8");

  test("F-01 exposes exactly one dynamically recommended approval action", () => {
    assert.match(application, /setRecommendedAction/u);
    assert.doesNotMatch(document, /id="allow-button"[^>]*button-approve/u);
  });

  test("F-02 separates agent identity from truthful status chips", () => {
    assert.match(application, /agent-name/u);
    assert.match(application, /agent-status status-chip/u);
  });

  test("F-03 contains capacity cards throughout the intermediate-width range", () => {
    assert.match(stylesheet, /@media \(max-width: 1120px\)/u);
    assert.match(stylesheet, /\.capacity-item[^}]*min-width:\s*0/u);
  });

  test("F-04 labels mechanical denial as an active-policy auto-block", () => {
    assert.match(application, /Auto-blocked · active policy/u);
  });

  test("F-05 preserves the ordered mutation, read-back, and verification proof", () => {
    assert.match(document, /id="proof-stages"/u);
    assert.match(application, /Independent read-back pending/u);
    assert.match(application, /Read-back matched · verified/u);
  });

  test("F-06 pins the timeline only while the judge remains near its latest entry", () => {
    assert.match(application, /timelinePinned/u);
    assert.match(application, /isTimelineNearLatest/u);
  });

  test("F-07 wraps durable identities without horizontal overflow", () => {
    assert.match(stylesheet, /\.technical-identity[^}]*overflow-wrap:\s*anywhere/u);
  });

  test("F-08 consolidates correlated approval evidence and settles its status", () => {
    assert.match(projection, /#upsertEvidence/u);
    assert.match(application, /evidence-details/u);
  });

  test("F-09 distinguishes the original REPLAN basis from its bounded resolution", () => {
    assert.match(document, /Original promise basis/u);
    assert.match(application, /Resolved through bounded replan/u);
  });

  test("F-10 keeps judge-facing promise acceptance in human language", () => {
    assert.match(projection, /Accept the fresh capacity-safe promise/u);
    assert.doesNotMatch(projection, /return `Accept fresh ADMITTABLE/u);
  });

  test("F-11 explains the safe alternative and the owner's denial rationale", () => {
    assert.match(application, /Primary denial rationale/u);
    assert.match(application, /starts after the protected interval/u);
  });

  test("F-12 explains that the schedule conflict is interval-specific", () => {
    assert.match(document, /interval-specific/u);
  });

  test("F-13 uses one semantic capacity baseline", () => {
    assert.match(application, /capacity-baseline/u);
  });

  test("F-14 labels accepted work accurately and resolves proposal duplication", () => {
    assert.match(document, /Accepted workload after bounded replan/u);
    assert.match(application, /acceptedProposal/u);
  });

  test("F-15 distinguishes live completion from a durable browser re-attach", () => {
    assert.match(application, /Mission complete/u);
    assert.match(application, /Durable replay restored/u);
  });

  test("F-16 keeps the approval region mounted between decisions", () => {
    assert.match(application, /approval-panel.*is-continuing/u);
    assert.doesNotMatch(application, /approval-panel.*is-hidden/u);
  });

  test("F-17 moves focus and announces new approval and decision state politely", () => {
    assert.match(document, /id="decision-announcer"[^>]*aria-live="polite"/u);
    assert.match(document, /id="approval-title"[^>]*tabindex="-1"/u);
  });

  test("F-18 formats the verified interval for judges", () => {
    assert.match(application, /formatFriendlyInterval/u);
  });

  test("F-19 humanizes ledger facts with explanatory subtitles", () => {
    assert.match(application, /resourcePresentation/u);
    assert.match(application, /fact-subtitle/u);
  });

  test("F-20 keeps the hero promise phrase together", () => {
    assert.match(document, /class="hero-line">One safe promise\.<\/span>/u);
  });

  test("F-21 shares one topbar and content gutter", () => {
    assert.match(stylesheet, /--content-gutter/u);
  });

  test("F-22 explains the idle canonical basis and the Start action", () => {
    assert.match(document, /precomputed canonical basis/u);
  });

  test("F-23 preserves the full turn identity and a working fallback", () => {
    assert.match(application, /currentTurnId \?\? "Not started"/u);
  });

  test("F-24 uses restrained dark-theme scrollbars", () => {
    assert.match(stylesheet, /scrollbar-color/u);
  });

  test("F-25 exposes only state-backed agent activity with clear status chips", () => {
    assert.match(application, /truthfulAgentStatus/u);
    assert.match(stylesheet, /\.status-chip/u);
  });

  test("F-26 uses CSP-compliant semantic progress with actual values", () => {
    assert.match(application, /<progress/u);
    assert.doesNotMatch(application, /style="width:/u);
  });
});

describe("Qodo Round 2: executable session error-capture arming", () => {
  test("arming registers the observer before any navigation and clears the probe", async () => {
    const session = createFakeBrowserSession();
    const capture = await armSessionErrorCapture(session.script, session.browser);
    await capture.openApplication("http://application.invalid/");
    assert.deepEqual(session.events, [
      `register:${String(capture.handlerId)}`,
      "navigate:probe",
      "refresh",
      "navigate:http://application.invalid/",
    ]);
    assert.equal(capture.capturedErrorCount(), 0, "the controlled probe errors are cleared after arming");
  });

  test("the same session observer covers later application loads and reloads", async () => {
    const session = createFakeBrowserSession();
    const capture = await armSessionErrorCapture(session.script, session.browser);
    await capture.openApplication("http://application.invalid/");
    assert.equal(session.registeredHandlerCount(), 1);
    assert.equal(session.emitSessionError(), 1);
    await session.browser.refresh();
    assert.equal(session.emitSessionError(), 1);
    assert.equal(capture.capturedErrorCount(), 2);
    await capture.dispose();
    assert.equal(session.registeredHandlerCount(), 0);
    assert.equal(session.emitSessionError(), 0);
    assert.equal(capture.capturedErrorCount(), 2);
    assert.equal(session.events[session.events.length - 1], `remove:${String(capture.handlerId)}`);
  });

  test("an observer that never observes errors fails closed before application navigation", async () => {
    const session = createFakeBrowserSession({ deliverLoadErrors: false });
    await assert.rejects(
      armSessionErrorCapture(session.script, session.browser),
      /did not capture the controlled load-time probe error/u,
    );
    assert.deepEqual(
      session.events.filter((event) => event.startsWith("navigate:")),
      ["navigate:probe"],
    );
  });

  test("a page-scoped observer lost on refresh fails closed", async () => {
    const session = createFakeBrowserSession({ dropHandlersOnRefresh: true });
    await assert.rejects(
      armSessionErrorCapture(session.script, session.browser),
      /did not keep capturing the probe error across refresh/u,
    );
  });
});

describe("M5 live review regressions", { concurrency: false }, () => {
  const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
  const stylesheet = readFileSync(join(process.cwd(), "ui/m5/styles.css"), "utf8");
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-live-review-"));
  let coordinator!: M5DemoCoordinator;
  let idle!: M5JudgeState;

  before(() => {
    coordinator = new M5DemoCoordinator({ dataRoot: directory, cleanupDataOnClose: false });
    idle = coordinator.state();
  });

  after(async () => {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const denialApproval = {
    toolName: "create_schedule_reservation",
    decision: "deny",
    source: "owner",
    ownerSourceIdentity: "owner/judge-ui",
    actionIdentity: `sha256:${"c".repeat(64)}`,
    effect: "Reserve proposal/rush-aerospace on cell-alpha, 09:10–09:40",
    reason: "The primary interval conflicts with protected production commitments",
    denialId: null,
  } as const;
  const mechanicalApproval = {
    toolName: "submit_schedule_change",
    decision: "deny",
    source: "active_m2_denial",
    ownerSourceIdentity: null,
    actionIdentity: `sha256:${"d".repeat(64)}`,
    effect: "Reserve proposal/rush-aerospace on cell-alpha, 09:10–09:40",
    reason: "Equivalent representation of the denied action",
    denialId: "m4-denial/live-review",
  } as const;

  test("static safeguards for the live-review corrections", () => {
    assert.match(document, /<link rel="icon" href="data:image\/svg\+xml/u);
    assert.match(document, /id="capacity-grid"[^>]*role="group"/u);
    assert.match(document, /id="basis-note"/u);
    assert.match(stylesheet, /\.policy-decision strong[^}]*display:\s*block/u);
    assert.match(stylesheet, /\.policy-decision span[^}]*display:\s*block/u);
    assert.match(stylesheet, /\.candidate > div strong, \.candidate > div span/u);
    assert.match(stylesheet, /\.action-name\.is-status[^}]*text-transform:\s*none/u);
    assert.match(stylesheet, /\.topbar[^}]*rgb\(9 16 12 \/ 96%\)/u);
    assert.match(stylesheet, /\.capacity-item header[^}]*min-height/u);
  });

  test("status sentences and captions are status-aware at idle", async () => {
    const harness = await createPollingHarness(idle, []);
    assert.equal(harness.hasClass("approval-tool", "is-status"), true);
    assert.equal(harness.text("approval-guidance"), "This region activates at the first owner decision.");
    assert.match(harness.evaluate("document.getElementById('basis-note').innerHTML"), /Before you start:/u);
  });

  test("tool names keep their label styling while announcements use human verbs", async () => {
    const pending = uiProjection(idle, 2, "awaiting_approval");
    const harness = await createPollingHarness(idle, [Promise.resolve(pending)]);
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.hasClass("approval-tool", "is-status"), false);
    assert.equal(harness.text("approval-tool"), "create schedule reservation");
    assert.match(harness.text("decision-announcer"), /Deny is recommended\.$/u);
  });

  test("the appended denial rationale ends with terminal punctuation", async () => {
    const base = uiProjection(idle, 2, "awaiting_approval");
    const withDenial: M5JudgeState = {
      ...base,
      approvals: [denialApproval],
      pendingApproval: {
        ...(base.pendingApproval as NonNullable<M5JudgeState["pendingApproval"]>),
        recommendedDecision: "allow",
      },
    };
    const harness = await createPollingHarness(idle, [Promise.resolve(withDenial)]);
    await harness.evaluate<Promise<void>>("refresh()");
    assert.match(harness.text("approval-guidance"), /protected production commitments\.$/u);
    assert.match(
      harness.evaluate<string>("document.getElementById('policy-decision').innerHTML"),
      /commitments\.<\/span>/u,
    );
  });

  test("terminal presentation reports completion rather than pending or mechanical captions", async () => {
    const pending = uiProjection(idle, 2, "awaiting_approval");
    const verifiedBase = uiProjection(idle, 3, "verified");
    const terminal: M5JudgeState = {
      ...verifiedBase,
      approvals: [denialApproval, mechanicalApproval],
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const harness = await createPollingHarness(idle, [Promise.resolve(pending), Promise.resolve(terminal)]);
    await harness.evaluate<Promise<void>>("refresh()");
    await harness.evaluate<Promise<void>>("refresh()");
    const proofStages = harness.evaluate<string>("document.getElementById('proof-stages').innerHTML");
    assert.match(proofStages, /Independent read-back observed/u);
    assert.doesNotMatch(proofStages, /Independent read-back pending/u);
    assert.equal(
      harness.text("approval-guidance"),
      "All decisions and evidence above are durable; the mission is complete.",
    );
    assert.match(harness.text("decision-announcer"), /Mission complete and independently verified\.$/u);
    const agentTree = harness.evaluate<string>("document.getElementById('agent-tree').innerHTML");
    assert.match(agentTree, /status-chip status-complete">Complete/u);
    assert.doesNotMatch(agentTree, /status-chip">Complete/u);
    assert.match(harness.evaluate<string>("document.getElementById('basis-note').innerHTML"), /verified mission/u);
  });

  test("the active verification stage stays labeled pending until read-back is observed", async () => {
    const verifying: M5JudgeState = {
      ...idle,
      revision: 2,
      run: { ...idle.run, status: "running" },
      execution: { ...idle.execution, acceptanceCount: 1, attemptCount: 1, mutationCount: 1, receiptCount: 1 },
    };
    const harness = await createPollingHarness(idle, [Promise.resolve(verifying)]);
    await harness.evaluate<Promise<void>>("refresh()");
    const proofStages = harness.evaluate<string>("document.getElementById('proof-stages').innerHTML");
    assert.match(proofStages, /proof-active/u);
    assert.match(proofStages, /Independent read-back pending/u);
  });

  test("a transient poll failure recovers its label on the next successful poll", async () => {
    const failure = deferred<unknown>();
    const recovery = deferred<unknown>();
    const harness = await createPollingHarness(idle, [failure.promise, recovery.promise]);
    const failedPoll = harness.evaluate<Promise<void>>("refresh()");
    failure.reject(new Error("controlled transient failure"));
    await failedPoll;
    assert.equal(harness.text("connection-label"), "Reconnecting…");
    const recoveredPoll = harness.evaluate<Promise<void>>("refresh()");
    recovery.resolve({ ...idle });
    await recoveredPoll;
    assert.equal(harness.text("connection-label"), "Ready on loopback");
  });

  test("the durable-replay label does not survive a reset into a live rerun", async () => {
    const verifiedBase = uiProjection(idle, 2, "verified");
    const replayed: M5JudgeState = {
      ...verifiedBase,
      run: { ...verifiedBase.run, connection: "replayed" },
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const afterReset: M5JudgeState = {
      ...idle,
      revision: 3,
      run: { ...idle.run, generation: replayed.run.generation + 1 },
    };
    const liveVerified = uiProjection(idle, 4, "verified");
    const liveTerminal: M5JudgeState = {
      ...liveVerified,
      run: { ...liveVerified.run, generation: afterReset.run.generation },
      execution: { ...liveVerified.execution, independentReadBackObserved: true },
    };
    const harness = await createPollingHarness(replayed, [
      Promise.resolve({ state: afterReset }),
      Promise.resolve(liveTerminal),
    ]);
    assert.equal(harness.text("connection-label"), "Durable replay restored");
    await harness.evaluate<Promise<void>>(
      'mutate("/api/mission", {operation: "reset", requestId: "live-review-reset"})',
    );
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.text("connection-label"), "Mission complete");
  });

  test("a back-forward cache restore restarts polling", async () => {
    const harness = await createPollingHarness(idle, [Promise.resolve({ ...idle })]);
    assert.equal(harness.counters.setIntervalCalls, 1);
    assert.deepEqual(harness.activeIntervalIds(), [1]);
    harness.fireWindow("pagehide", {});
    assert.deepEqual(harness.activeIntervalIds(), [], "pagehide clears the active poller");
    assert.deepEqual(harness.counters.clearedIntervals, [1]);
    harness.fireWindow("pageshow", { persisted: true });
    assert.equal(harness.counters.setIntervalCalls, 2);
    assert.deepEqual(harness.activeIntervalIds(), [2], "exactly one active poller after a persisted restore");
    assert.deepEqual(harness.counters.clearedIntervals, [1, 1], "the restore defensively clears the prior poller id");
    harness.fireWindow("pageshow", { persisted: false });
    assert.equal(harness.counters.setIntervalCalls, 2);
    assert.deepEqual(harness.activeIntervalIds(), [2]);
  });

  test("error toasts do not inherit stale hide timers", async () => {
    const harness = await createPollingHarness(idle, []);
    harness.evaluate("showError('first controlled error')");
    harness.evaluate("showError('second controlled error')");
    assert.equal(harness.counters.clearedTimeouts.length >= 1, true);
    assert.equal(harness.hasClass("toast", "visible"), true);
    assert.equal(harness.text("toast"), "second controlled error");
  });
});

describe("Qodo Round 3: executable session network-failure capture", () => {
  const NETWORK_PROBE_URL = "http://application.invalid/m5-controlled-missing-resource-probe";

  test("arming registers the observer before navigation and clears probe evidence", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL);
    const capture = await armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL);
    assert.deepEqual(session.events, ["register", "navigate:probe", "refresh"]);
    assert.deepEqual(capture.failedResponses(), []);
  });

  test("a failure recorded before refresh persists across refresh and later navigation", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL);
    const capture = await armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL);
    await session.browser.get("http://application.invalid/");
    assert.equal(session.emitFailedResponse("http://application.invalid/asset.js", 500), 1);
    await session.browser.refresh();
    await session.browser.get("http://application.invalid/deep");
    assert.deepEqual(capture.failedResponses(), [
      formatFailedResponse("http://application.invalid/asset.js", 500),
    ]);
  });

  test("an observer that never observes failures fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, { deliverResponses: false });
    await assert.rejects(
      armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL),
      /did not observe the controlled missing-resource probe/u,
    );
  });

  test("a page-scoped observer lost on refresh fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, { dropHandlersOnRefresh: true });
    await assert.rejects(
      armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL),
      /did not keep observing the missing-resource probe across refresh/u,
    );
  });

  test("dispose removes the failure observation channel", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL);
    const capture = await armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL);
    await capture.dispose();
    assert.equal(session.registeredHandlerCount(), 0);
    assert.equal(session.emitFailedResponse("http://application.invalid/late.js", 503), 0);
    assert.deepEqual(capture.failedResponses(), []);
  });
});

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
    const decisionEvidence = terminal.evidenceTimeline.filter((item) => item.kind.startsWith("approval:"));
    assert.equal(decisionEvidence.length, terminal.approvals.length);
    assert.equal(decisionEvidence.some((item) => item.status === "pending"), false);
    assert.equal(
      decisionEvidence.filter((item) => item.title === "Auto-blocked · active policy").length,
      1,
    );
    const receiptIndex = terminal.evidenceTimeline.findIndex((item) => item.kind === "receipt");
    const readBackIndex = terminal.evidenceTimeline.findIndex((item) => item.kind === "read-back");
    const terminalIndex = terminal.evidenceTimeline.findIndex((item) => item.kind === "terminal");
    assert.equal(decisionEvidence.every((item) => item.sequence < (terminal.evidenceTimeline[receiptIndex]?.sequence ?? 0)), true);
    assert.equal(receiptIndex < readBackIndex && readBackIndex < terminalIndex, true);
    assert.match(
      terminal.approvals.find((item) => item.source === "owner" && item.decision === "deny")?.reason ?? "",
      /protected production commitments/u,
    );
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
    assert.equal(harness.hasClass("approval-panel", "is-continuing"), true);
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
    assert.equal(harness.hasClass("approval-panel", "is-continuing"), true);
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
    assert.equal(harness.hasClass("approval-panel", "is-continuing"), true);
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
    assert.equal(harness.hasClass("approval-panel", "is-continuing"), false);
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
    assert.equal(harness.hasClass("approval-panel", "is-continuing"), true);
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
      technicalSubject: null,
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
  counters: { setIntervalCalls: number; readonly clearedTimeouts: number[]; readonly clearedIntervals: number[] };
  activeIntervalIds(): readonly number[];
  fireWindow(name: string, event?: unknown): void;
}> {
  const nodeMap = new Map<string, FakeNode>();
  const responseQueue = [Promise.resolve(initial), ...responses];
  const counters = { setIntervalCalls: 0, clearedTimeouts: [] as number[], clearedIntervals: [] as number[] };
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const activeIntervals = new Set<number>();
  let intervalSequence = 0;
  let timerSequence = 100;
  const context = createContext({
    console,
    Date,
    document: { getElementById: (id: string) => fakeNode(nodeMap, id) },
    fetch: async () => ({ ok: true, json: async () => await (responseQueue.shift() as Promise<unknown>) }),
    setInterval: () => {
      intervalSequence += 1;
      counters.setIntervalCalls += 1;
      activeIntervals.add(intervalSequence);
      return intervalSequence;
    },
    clearInterval: (id: number) => {
      counters.clearedIntervals.push(id);
      activeIntervals.delete(id);
    },
    setTimeout: () => {
      timerSequence += 1;
      return timerSequence;
    },
    clearTimeout: (id: number) => {
      counters.clearedTimeouts.push(id);
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      const existing = windowListeners.get(name) ?? [];
      existing.push(listener);
      windowListeners.set(name, existing);
    },
  });
  (context as Record<string, unknown>)["window"] = context;
  runInContext(readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8"), context);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  return {
    evaluate: <T>(source: string): T => runInContext(source, context) as T,
    enqueue: (...items): void => { responseQueue.push(...items); },
    text: (id: string): string => fakeNode(nodeMap, id).textContent,
    hasClass: (id: string, className: string): boolean => fakeNode(nodeMap, id).classList.values.has(className),
    counters,
    activeIntervalIds: (): readonly number[] => [...activeIntervals].sort((left, right) => left - right),
    fireWindow: (name, event): void => {
      for (const listener of windowListeners.get(name) ?? []) listener(event);
    },
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

interface FakeBrowserSession {
  readonly script: BrowserScriptErrorObserver;
  readonly browser: ObserverSessionBrowser;
  readonly events: readonly string[];
  registeredHandlerCount(): number;
  emitSessionError(): number;
}

function createFakeBrowserSession(options?: {
  readonly deliverLoadErrors?: boolean;
  readonly dropHandlersOnRefresh?: boolean;
}): FakeBrowserSession {
  const deliverLoadErrors = options?.deliverLoadErrors ?? true;
  const dropHandlersOnRefresh = options?.dropHandlersOnRefresh ?? false;
  const events: string[] = [];
  const handlers = new Map<number, (entry: unknown) => void>();
  let nextHandlerId = 41;
  let currentUrl: string | null = null;
  const deliverToRegisteredHandlers = (): number => {
    const active = [...handlers.values()];
    for (const handler of active) handler({ type: "javascript-error" });
    return active.length;
  };
  const deliverProbeLoadError = (): void => {
    if (deliverLoadErrors && currentUrl === CONTROLLED_ERROR_PROBE_URL) deliverToRegisteredHandlers();
  };
  return {
    script: {
      addJavaScriptErrorHandler: async (callback) => {
        const handlerId = nextHandlerId;
        nextHandlerId += 1;
        handlers.set(handlerId, callback);
        events.push(`register:${String(handlerId)}`);
        return handlerId;
      },
      removeJavaScriptErrorHandler: async (handlerId) => {
        handlers.delete(handlerId);
        events.push(`remove:${String(handlerId)}`);
      },
    },
    browser: {
      get: async (url) => {
        currentUrl = url;
        events.push(url === CONTROLLED_ERROR_PROBE_URL ? "navigate:probe" : `navigate:${url}`);
        deliverProbeLoadError();
      },
      refresh: async () => {
        events.push("refresh");
        if (dropHandlersOnRefresh) handlers.clear();
        deliverProbeLoadError();
      },
      wait: async (condition, _timeoutMs, message) => {
        for (let turn = 0; turn < 5; turn += 1) {
          if (condition()) return;
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
        throw new Error(message);
      },
    },
    events,
    registeredHandlerCount: () => handlers.size,
    emitSessionError: deliverToRegisteredHandlers,
  };
}

interface FakeNetworkSession {
  readonly observer: BrowserNetworkObserver;
  readonly browser: ObserverSessionBrowser;
  readonly events: readonly string[];
  registeredHandlerCount(): number;
  emitFailedResponse(url: string, status: number): number;
}

function createFakeNetworkSession(probeUrl: string, options?: {
  readonly deliverResponses?: boolean;
  readonly dropHandlersOnRefresh?: boolean;
}): FakeNetworkSession {
  const deliverResponses = options?.deliverResponses ?? true;
  const dropHandlersOnRefresh = options?.dropHandlersOnRefresh ?? false;
  const events: string[] = [];
  const handlers = new Set<(entry: { url: string; status: number }) => void>();
  let currentUrl: string | null = null;
  const deliverToRegisteredHandlers = (url: string, status: number): number => {
    const active = [...handlers];
    for (const handler of active) handler({ url, status });
    return active.length;
  };
  const deliverProbeResponse = (): void => {
    if (deliverResponses && currentUrl === probeUrl) deliverToRegisteredHandlers(probeUrl, 404);
  };
  return {
    observer: {
      addFailedResponseHandler: async (callback) => {
        handlers.add(callback);
        events.push("register");
      },
      removeFailedResponseHandlers: async () => {
        handlers.clear();
        events.push("remove");
      },
    },
    browser: {
      get: async (url) => {
        currentUrl = url;
        events.push(url === probeUrl ? "navigate:probe" : `navigate:${url}`);
        deliverProbeResponse();
      },
      refresh: async () => {
        events.push("refresh");
        if (dropHandlersOnRefresh) handlers.clear();
        deliverProbeResponse();
      },
      wait: async (condition, _timeoutMs, message) => {
        for (let turn = 0; turn < 8; turn += 1) {
          if (condition()) return;
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
        throw new Error(message);
      },
    },
    events,
    registeredHandlerCount: () => handlers.size,
    emitFailedResponse: deliverToRegisteredHandlers,
  };
}
