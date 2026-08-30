import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
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
  formatTransportFailure,
  sessionCleanupStack,
  type BrowserNetworkObserver,
  type BrowserScriptErrorObserver,
  type ObserverSessionBrowser,
  type SessionTransportProbe,
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

  test("F-04 labels mechanical denial as an automatic block of the same denied action", () => {
    assert.match(application, /Blocked automatically — same denied action/u);
    assert.match(application, /active M2 policy/u);
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
    assert.match(application, /Resolved through the safest workable plan \(a bounded replan\)/u);
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
    assert.match(document, /Accepted workload after the safest workable plan/u);
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

describe("M5 operator proof center", () => {
  const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
  const application = readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8");

  test("keeps the executive proof visible and progressively discloses exact evidence", () => {
    assert.match(document, /Operator proof center/u);
    assert.match(document, /aria-label="Executive proof summary"/u);
    assert.match(document, /Show decision history/u);
    assert.match(document, /Show exact capacity math/u);
    assert.match(document, /Show durable ledger/u);
    assert.match(document, /Show technical identifiers/u);
    assert.match(document, /What FlakeBrake prevented/u);
  });

  test("derives proof claims from state without adding a mutating endpoint", () => {
    assert.match(application, /criticalityWeightedServiceDegradation/u);
    assert.match(application, /terminalEventCount/u);
    assert.match(application, /state\.approvals\.filter/u);
    assert.match(application, /state\.hero\.capacity\.filter/u);
    assert.doesNotMatch(application, /api\/proof/u);
  });

  test("states the receipt, verification, and replay boundary directly", () => {
    assert.match(application, /By itself, it is not verified success/u);
    assert.match(application, /Only this state is presented as success/u);
    assert.match(application, /durable effect count remains/u);
  });
});

describe("M5 plain-language guided story", () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-guided-"));
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

  const pendingFor = (
    toolName: string,
    recommendedDecision: "allow" | "deny",
    revision: number,
  ): M5JudgeState => {
    const base = uiProjection(idle, revision, "awaiting_approval");
    return {
      ...base,
      pendingApproval: {
        ...(base.pendingApproval as NonNullable<M5JudgeState["pendingApproval"]>),
        toolName,
        recommendedDecision,
      },
    };
  };

  test("idle answers what, why, and next in plain language", async () => {
    const harness = await createPollingHarness(idle, []);
    assert.equal(harness.text("guided-heading"), "A rush order is waiting");
    assert.match(harness.text("guided-what"), /check whether it fits without disrupting protected work/u);
    assert.match(harness.text("guided-why"), /This rush order doesn’t fit yet/u);
    assert.match(harness.text("guided-why"), /2 more agent-work units and 1 more human decision/u);
    assert.match(harness.text("guided-why"), /production minutes alone are not the only constraint/u);
    assert.match(harness.text("guided-why"), /FlakeBrake found a safer plan/u);
    assert.match(harness.text("guided-why"), /display order from 10 to 8/u);
    assert.match(harness.text("guided-why"), /protected medical order and the rush-order quantity stay unchanged/u);
    assert.match(harness.text("guided-next"), /Start the mission/u);
  });

  test("each approval states exactly what approving or denying will do", async () => {
    const portfolio = await createPollingHarness(
      pendingFor("select_portfolio_modification", "allow", 2),
      [],
    );
    assert.equal(portfolio.text("guided-heading"), "Your approval is required");
    assert.match(portfolio.text("guided-what"), /display order from 10 to 8 — nothing else/u);
    assert.match(portfolio.text("guided-why"), /protected medical order and the rush-order quantity remain exactly/u);

    const promise = await createPollingHarness(pendingFor("accept_promise", "allow", 2), []);
    assert.equal(promise.text("guided-heading"), "Your approval is required");
    assert.match(promise.text("guided-what"), /Capacity was recalculated after the approved change/u);
    assert.match(promise.text("guided-why"), /Nothing executes until you explicitly accept/u);

    const conflict = await createPollingHarness(
      pendingFor("create_schedule_reservation", "deny", 2),
      [],
    );
    assert.equal(conflict.text("guided-heading"), "This time slot conflicts with protected work");
    assert.match(conflict.text("guided-what"), /09:10–09:40 slot overlaps time already committed/u);
    assert.match(conflict.text("guided-next"), /Deny action is the recommended choice/u);

    const alternative = await createPollingHarness(
      pendingFor("create_schedule_reservation", "allow", 2),
      [],
    );
    assert.equal(alternative.text("guided-heading"), "A safe time slot is available");
    assert.match(alternative.text("guided-what"), /09:40–10:10 slot starts after the protected commitment/u);
    assert.match(alternative.text("guided-next"), /Approve action authorizes the safe reservation/u);
  });

  test("the mechanical block gets its own story and stays visible at the next approval", async () => {
    const mechanicalGap: M5JudgeState = {
      ...idle,
      revision: 3,
      run: { ...idle.run, status: "running", generation: 1, ownerCallsThisProcess: 3 },
      approvals: [
        {
          toolName: "submit_schedule_change",
          decision: "deny",
          source: "active_m2_denial",
          ownerSourceIdentity: null,
          actionIdentity: `sha256:${"d".repeat(64)}`,
          effect: "Reserve proposal/rush-aerospace on cell-alpha, 09:10–09:40",
          reason: "Equivalent representation of the denied action",
          denialId: "m4-denial/guided",
        },
      ],
    };
    const gap = await createPollingHarness(mechanicalGap, []);
    assert.equal(gap.text("guided-heading"), "The same unsafe request was blocked automatically");
    assert.match(gap.text("guided-what"), /another technical representation/u);
    assert.match(gap.text("guided-why"), /No additional owner decision was used/u);

    const nextApproval: M5JudgeState = {
      ...pendingFor("create_schedule_reservation", "allow", 4),
      approvals: mechanicalGap.approvals,
    };
    const next = await createPollingHarness(nextApproval, []);
    assert.equal(next.text("guided-heading"), "A safe time slot is available");
    assert.equal(
      next.evaluate("document.getElementById('guided-mechanical').hidden"),
      false,
      "the mechanical-block fact stays visible when the next approval arrives",
    );
    assert.match(next.text("guided-mechanical"), /no additional owner decision was used/iu);
  });

  test("mutation, verification, and replay states tell the durable story", async () => {
    const mutated: M5JudgeState = {
      ...idle,
      revision: 5,
      run: { ...idle.run, status: "verifying", generation: 1 },
      execution: { ...idle.execution, acceptanceCount: 1, attemptCount: 1, mutationCount: 1, receiptCount: 1 },
    };
    const pendingVerify = await createPollingHarness(mutated, []);
    assert.equal(pendingVerify.text("guided-heading"), "The change is recorded—but it is not verified yet");
    assert.match(pendingVerify.text("guided-why"), /independently reading the factory state/u);

    const verifiedBase = uiProjection(idle, 6, "verified");
    const verified: M5JudgeState = {
      ...verifiedBase,
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const done = await createPollingHarness(verified, []);
    assert.equal(done.text("guided-heading"), "Done—and independently verified");
    assert.match(done.text("guided-what"), /display order changed 10 → 8/u);
    assert.match(done.text("guided-what"), /exactly one factory mutation/u);
    assert.match(done.text("guided-why"), /will not repeat owner decisions or factory effects/u);

    const replayed: M5JudgeState = {
      ...verified,
      revision: 7,
      mission: { ...verified.mission, disconnectedAndResumed: true },
    };
    const replay = await createPollingHarness(replayed, []);
    assert.match(replay.text("guided-why"), /same completed TrueForge session/u);
    assert.match(replay.text("guided-why"), /no decisions, owner calls, or factory effects were repeated/iu);
  });

  test("stale polls and cross-mission responses cannot regress the guided story", async () => {
    const verifiedBase = uiProjection(idle, 6, "verified");
    const verified: M5JudgeState = {
      ...verifiedBase,
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const stalePending = uiProjection(idle, 2, "awaiting_approval");
    const stale = deferred<unknown>();
    const harness = await createPollingHarness(verified, [stale.promise]);
    assert.equal(harness.text("guided-heading"), "Done—and independently verified");
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    stale.resolve(stalePending);
    await oldPoll;
    assert.equal(
      harness.text("guided-heading"),
      "Done—and independently verified",
      "a stale pending poll cannot regress the verified story",
    );
  });

  test("guided numbers derive from durable counts", async () => {
    const harness = await createPollingHarness(idle, []);
    assert.equal(harness.text("guided-number-display"), "10 → 8");
    assert.equal(harness.text("guided-number-protected"), "10");
    assert.equal(harness.text("guided-number-mutations"), "0");
    const verifiedBase = uiProjection(idle, 6, "verified");
    const done = await createPollingHarness(
      { ...verifiedBase, execution: { ...verifiedBase.execution, independentReadBackObserved: true } },
      [],
    );
    assert.equal(done.text("guided-number-mutations"), "1");
  });
});

interface TrustCheckRow {
  readonly key: string;
  readonly kind: string;
  readonly source: string;
  readonly claim: string;
  readonly check: string;
  readonly result: string;
  readonly why: string;
  readonly technicalEvidence: string | null;
}

interface TrustProjection {
  readonly recommendationsRecorded: boolean;
  readonly checks: readonly TrustCheckRow[];
}

interface TrustApprovalRecordLike {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly source: "owner" | "active_m2_denial";
  readonly ownerSourceIdentity: string | null;
  readonly bridgeKey: string;
  readonly denialId: string | null;
  readonly executionAttemptId: string | null;
}

describe("M5 agent trust — agents checking agents", () => {
  const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-trust-"));
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

  const loadProjection = async (): Promise<(input: Record<string, unknown>) => TrustProjection> => {
    const module_ = (await import("../src/m5-ui.js")) as Record<string, unknown>;
    const projection = module_["agentTrustProjection"];
    assert.equal(typeof projection, "function", "src/m5-ui.ts exports agentTrustProjection");
    return projection as (input: Record<string, unknown>) => TrustProjection;
  };

  const approvalRecord = (overrides: Partial<TrustApprovalRecordLike>): TrustApprovalRecordLike => ({
    toolName: "create_schedule_reservation",
    toolCallId: "call/approve-alternative",
    turnId: "turn/root-1",
    threadId: "thread/root",
    decision: "allow",
    reason: "owner approved",
    source: "owner",
    ownerSourceIdentity: "owner/judge-ui",
    bridgeKey: "bridge/reservation-alternative",
    denialId: null,
    executionAttemptId: "attempt/m4-approved-alternative",
    ...overrides,
  });

  const trustInput = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    approvals: [],
    approvalEffectText: (approval: TrustApprovalRecordLike) => `effect ${approval.bridgeKey}`,
    execution: idle.execution,
    subagentTitles: [],
    subagentThreadIds: [],
    admission: null,
    sessionId: null,
    disconnectedAndResumed: false,
    runStatus: "running",
    ...overrides,
  });

  const specialists = {
    subagentTitles: [
      "Portfolio and order analyst",
      "Capacity and schedule analyst",
      "Assurance and simulation engineer",
    ],
    subagentThreadIds: ["thread/sub-portfolio", "thread/sub-capacity", "thread/sub-assurance"],
  };

  const trustState = (base: M5JudgeState, trust: TrustProjection): M5JudgeState =>
    ({ ...(base as unknown as Record<string, unknown>), agentTrust: trust }) as unknown as M5JudgeState;

  const recommendationRow: TrustCheckRow = {
    key: "specialist-recommendations",
    kind: "recommendation",
    source: "Specialist subagents — Portfolio and order analyst, Capacity and schedule analyst, Assurance and simulation engineer",
    claim: "Provided read-only analyses and recommendations to the root agent.",
    check: "TrueForge thread record — provenance linkage only; the prose is recorded, not semantically verified",
    result: "recorded",
    why: "Agents can propose anything; they cannot make it true. A recommendation authorizes nothing until the root proposes the exact action and it passes the authoritative checks below.",
    technicalEvidence: "thread thread/sub-capacity",
  };

  test("markup carries the exact primary explanation and the trust sequence", () => {
    assert.match(document, /Agents checking agents/u);
    assert.ok(
      document.includes(
        "Agents can propose anything; they cannot make it true. Every consequential effect must pass current-state checks, authorization, fenced execution, and independent verification.",
      ),
      "the exact primary agent-trust sentence is present",
    );
    assert.ok(
      document.includes("recorded, not semantically verified"),
      "the provenance line states recording without semantic verification",
    );
    const chain = [
      "Specialist recommendation recorded",
      "Root proposes exact action",
      "FlakeBrake checks authoritative state",
      "Human approval when required",
      "Fenced execution",
      "Independent read-back",
    ];
    let cursor = -1;
    for (const label of chain) {
      const next = document.indexOf(label);
      assert.ok(next > cursor, `trust sequence lists ${label} in order`);
      cursor = next;
    }
    assert.doesNotMatch(document, /rechecked the specialists/u, "no blanket recommendation-recheck claim");
    assert.doesNotMatch(document, /verify_agent_claim/u, "no invented generic claim-verification tool");
  });

  test("idle exposes an empty agent-trust projection and renders no rows", async () => {
    const trust = (idle as unknown as { agentTrust?: TrustProjection }).agentTrust;
    assert.ok(trust !== undefined, "M5 state exposes agentTrust");
    assert.deepEqual(trust.checks, []);
    assert.equal(trust.recommendationsRecorded, false);
    const harness = await createPollingHarness(idle, []);
    assert.equal(harness.evaluate("document.getElementById('trust-rows').innerHTML"), "");
    assert.equal(harness.evaluate("document.getElementById('trust-empty').hidden"), false);
    assert.equal(harness.evaluate("document.getElementById('trust-recheck').hidden"), true);
  });

  test("rows render source, claim, authoritative check, result, and why — identities only behind the disclosure", async () => {
    const verified = uiProjection(idle, 5, "verified");
    const rows: TrustProjection = {
      recommendationsRecorded: true,
      checks: [
        recommendationRow,
        {
          key: "owner:bridge/reservation-alternative",
          kind: "owner_gate",
          source: "Root agent — proposed a schedule reservation",
          claim: "Reserve the safe 09:40–10:10 slot.",
          check: "factory-change-control/create_schedule_reservation — exact action reevaluated against current authoritative state at the TrueForge approval gate",
          result: "allowed",
          why: "Nothing ran on a recommendation alone: the exact action digest was bound to current M1–M4 state and to your recorded decision before the tool executed.",
          technicalEvidence: "bridge bridge/reservation-alternative · turn turn/root-1 · call call/approve-alternative",
        },
        {
          key: "m2:bridge/reservation-equivalent",
          kind: "mechanical_block",
          source: "Root agent — the same denied action in another technical representation",
          claim: "Reserve the denied 09:10–09:40 slot through a different tool shape.",
          check: "factory-change-control/submit_schedule_change — M2 canonical-equivalence check against the active denial",
          result: "blocked",
          why: "FlakeBrake recognized the same effect behind a different tool shape and blocked it mechanically — no additional owner decision was used.",
          technicalEvidence: "bridge bridge/reservation-equivalent · denial m4-denial/primary",
        },
        {
          key: "execution-claim",
          kind: "execution",
          source: "Root agent — executor success claim",
          claim: "The approved change was written to the factory.",
          check: "factory-change-control/verify_schedule_execution — independent authoritative read-back",
          result: "pending_verification",
          why: "A recorded change is not success yet — FlakeBrake reads the factory back independently before anything is presented as verified.",
          technicalEvidence: "attempt attempt/m4-approved-alternative",
        },
      ],
    };
    const harness = await createPollingHarness(trustState(verified, rows), []);
    const rendered = harness.evaluate<string>("document.getElementById('trust-rows').innerHTML");
    assert.match(rendered, /Specialist subagents — Portfolio and order analyst/u);
    assert.match(rendered, /Recommendation recorded/u);
    assert.match(rendered, /Provenance: TrueForge thread record/u);
    assert.match(rendered, /Root agent — proposed a schedule reservation/u);
    assert.match(rendered, /Authoritative effect check: factory-change-control\/create_schedule_reservation/u);
    assert.match(rendered, /Allowed/u);
    assert.match(rendered, /Blocked/u);
    assert.match(rendered, /Pending verification/u);
    assert.doesNotMatch(rendered, /Verified result/u);
    assert.doesNotMatch(rendered, /bridge\/reservation-alternative/u, "raw identities stay out of the visible rows");
    assert.doesNotMatch(rendered, /turn\/root-1/u);
    assert.doesNotMatch(rendered, /thread\/sub-capacity/u);
    const technical = harness.evaluate<string>("document.getElementById('trust-technical-list').innerHTML");
    assert.match(technical, /bridge\/reservation-alternative/u);
    assert.match(technical, /m4-denial\/primary/u);
    assert.match(technical, /thread\/sub-capacity/u);
    assert.equal(harness.evaluate("document.getElementById('trust-empty').hidden"), true);
    assert.equal(harness.evaluate("document.getElementById('trust-recheck').hidden"), false);
  });

  test("no agent-trust row appears without authoritative source evidence", async () => {
    const agentTrustProjection = await loadProjection();
    assert.deepEqual(agentTrustProjection(trustInput({})).checks, []);
    const noMutation = agentTrustProjection(
      trustInput({ execution: { ...idle.execution, mutationCount: 0 } }),
    );
    assert.ok(!noMutation.checks.some((row) => row.kind === "execution"));
    const runningReplay = agentTrustProjection(
      trustInput({ disconnectedAndResumed: true, sessionId: "session/live", runStatus: "running" }),
    );
    assert.ok(!runningReplay.checks.some((row) => row.kind === "replay"));
    const sessionlessReplay = agentTrustProjection(
      trustInput({ disconnectedAndResumed: true, sessionId: null, runStatus: "verified" }),
    );
    assert.ok(!sessionlessReplay.checks.some((row) => row.kind === "replay"));
    const noThreads = agentTrustProjection(trustInput({ subagentTitles: [], subagentThreadIds: [] }));
    assert.ok(!noThreads.checks.some((row) => row.kind === "recommendation"));
  });

  test("stale or cross-thread evidence cannot populate rows", async () => {
    const agentTrustProjection = await loadProjection();
    const missingIdentity = agentTrustProjection(
      trustInput({ approvals: [approvalRecord({ turnId: "" })] }),
    );
    assert.deepEqual(missingIdentity.checks, [], "an approval without TrueForge identities yields no row");
    const crossThread = agentTrustProjection(
      trustInput({
        approvals: [approvalRecord({ threadId: "thread/sub-capacity" })],
        ...specialists,
      }),
    );
    assert.ok(
      !crossThread.checks.some((row) => row.kind === "owner_gate"),
      "a specialist-thread record cannot populate a root-attributed effect row",
    );
    const duplicated = agentTrustProjection(
      trustInput({ approvals: [approvalRecord({}), approvalRecord({})] }),
    );
    assert.equal(duplicated.checks.filter((row) => row.kind === "owner_gate").length, 1);
    const verifiedRows: TrustProjection = {
      recommendationsRecorded: false,
      checks: [
        {
          key: "execution-claim",
          kind: "execution",
          source: "Root agent — executor success claim",
          claim: "The approved change was written to the factory.",
          check: "factory-change-control/verify_schedule_execution — independent authoritative read-back",
          result: "verified",
          why: "Success is presented only because FlakeBrake independently read the factory back.",
          technicalEvidence: null,
        },
      ],
    };
    const verified = trustState(
      { ...uiProjection(idle, 6, "verified"), execution: { ...idle.execution, mutationCount: 1 } },
      verifiedRows,
    );
    const stale = deferred<unknown>();
    const harness = await createPollingHarness(verified, [stale.promise]);
    assert.match(harness.evaluate<string>("document.getElementById('trust-rows').innerHTML"), /Verified result/u);
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    stale.resolve(trustState(uiProjection(idle, 2, "awaiting_approval"), { recommendationsRecorded: false, checks: [] }));
    await oldPoll;
    assert.match(
      harness.evaluate<string>("document.getElementById('trust-rows').innerHTML"),
      /Verified result/u,
      "a stale poll cannot clear or regress rendered trust rows",
    );
  });

  test("recorded specialist prose is never labeled verified", async () => {
    const agentTrustProjection = await loadProjection();
    const projection = agentTrustProjection(trustInput({ ...specialists }));
    const recommendation = projection.checks.find((row) => row.kind === "recommendation");
    assert.ok(recommendation !== undefined, "recorded specialist threads yield a recommendation row");
    assert.equal(recommendation.result, "recorded");
    assert.match(recommendation.check, /recorded, not semantically verified/u);
    assert.doesNotMatch(recommendation.why, /verified success|semantically verified prose/u);
    const harness = await createPollingHarness(
      trustState(uiProjection(idle, 4, "awaiting_approval"), {
        recommendationsRecorded: true,
        checks: [recommendationRow],
      }),
      [],
    );
    const rendered = harness.evaluate<string>("document.getElementById('trust-rows').innerHTML");
    assert.match(rendered, /Recommendation recorded/u);
    assert.doesNotMatch(rendered, /pill-verified|pill-approved/u, "recorded prose never renders a verified or allowed badge");
    assert.doesNotMatch(rendered, /Verified result|>Allowed</u);
  });

  test("a recommendation alone cannot produce an allowed or verified effect", async () => {
    const agentTrustProjection = await loadProjection();
    const recommendationOnly = agentTrustProjection(trustInput({ ...specialists }));
    assert.equal(recommendationOnly.checks.length, 1, "specialist evidence alone yields only the recorded row");
    assert.ok(
      !recommendationOnly.checks.some((row) => row.result === "allowed" || row.result === "verified"),
      "no allowed or verified row exists without approval, execution, or replay evidence",
    );
    const withApproval = agentTrustProjection(
      trustInput({ ...specialists, approvals: [approvalRecord({})] }),
    );
    assert.equal(withApproval.checks.filter((row) => row.result === "allowed").length, 1);
    assert.equal(
      withApproval.checks.filter((row) => row.result === "allowed")[0]?.kind,
      "owner_gate",
      "allowed results attach only to approval-bridge evidence",
    );
  });

  test("provenance linkage is never conflated with semantic verification", async () => {
    const agentTrustProjection = await loadProjection();
    const projection = agentTrustProjection(trustInput({ ...specialists }));
    const recommendation = projection.checks.find((row) => row.kind === "recommendation");
    assert.ok(recommendation !== undefined);
    assert.match(recommendation.check, /provenance linkage only/u);
    assert.match(recommendation.why, /cannot make it true/u);
    assert.equal(projection.recommendationsRecorded, true);
    const bare = agentTrustProjection(trustInput({}));
    assert.equal(bare.recommendationsRecorded, false, "the provenance sentence needs thread evidence");
  });

  test("equivalent denied effects remain blocked", async () => {
    const agentTrustProjection = await loadProjection();
    const mechanical = approvalRecord({
      toolName: "submit_schedule_change",
      toolCallId: "call/deny-equivalent-alternate",
      decision: "deny",
      source: "active_m2_denial",
      ownerSourceIdentity: null,
      bridgeKey: "bridge/equivalent",
      denialId: "m4-denial/primary",
      executionAttemptId: null,
    });
    for (const runStatus of ["running", "verified"]) {
      const projection = agentTrustProjection(trustInput({ approvals: [mechanical], runStatus }));
      const row = projection.checks.find((item) => item.kind === "mechanical_block");
      assert.ok(row !== undefined, `mechanical row exists while ${runStatus}`);
      assert.equal(row.result, "blocked");
      assert.match(row.why, /no additional owner decision/u);
      assert.match(row.check, /factory-change-control\/submit_schedule_change/u);
    }
  });

  test("an executor's claimed success cannot render verified before read-back", async () => {
    const agentTrustProjection = await loadProjection();
    const committed = {
      ...idle.execution,
      mutationCount: 1,
      receiptCount: 1,
      attemptId: "attempt/m4-approved-alternative",
      receiptId: "receipt/m4",
      mutationStatus: "committed",
    };
    const beforeReadBack = agentTrustProjection(trustInput({ execution: committed }));
    assert.equal(beforeReadBack.checks.find((row) => row.kind === "execution")?.result, "pending_verification");
    const readBackWithoutTerminal = agentTrustProjection(
      trustInput({ execution: { ...committed, independentReadBackObserved: true } }),
    );
    assert.equal(
      readBackWithoutTerminal.checks.find((row) => row.kind === "execution")?.result,
      "pending_verification",
    );
    const verified = agentTrustProjection(
      trustInput({
        execution: { ...committed, independentReadBackObserved: true, terminalStatus: "terminal_verified" },
        runStatus: "verified",
      }),
    );
    assert.equal(verified.checks.find((row) => row.kind === "execution")?.result, "verified");
  });

  test("refresh and reconnect cannot invent or duplicate a handoff", async () => {
    const agentTrustProjection = await loadProjection();
    const base = trustInput({
      approvals: [approvalRecord({})],
      execution: {
        ...idle.execution,
        mutationCount: 1,
        independentReadBackObserved: true,
        terminalStatus: "terminal_verified",
      },
      ...specialists,
      sessionId: "session/durable",
      runStatus: "verified",
    });
    const first = agentTrustProjection(base);
    const second = agentTrustProjection(base);
    assert.deepEqual(second, first, "re-projection of identical evidence is identical");
    assert.ok(!first.checks.some((row) => row.kind === "replay"), "no replay row without a resume claim");
    const replayed = agentTrustProjection({ ...base, disconnectedAndResumed: true });
    assert.equal(replayed.checks.filter((row) => row.kind === "replay").length, 1);
    assert.equal(replayed.checks.length, first.checks.length + 1, "a resume adds exactly the replay row");
    const replayRow = replayed.checks.find((row) => row.kind === "replay");
    assert.ok(replayRow !== undefined);
    assert.equal(replayRow.result, "verified");
    assert.match(replayRow.why, /1 mutation|one mutation/iu);
  });

  test("wording matches the actual caller and checker", async () => {
    const agentTrustProjection = await loadProjection();
    const projection = agentTrustProjection(
      trustInput({
        approvals: [approvalRecord({})],
        admission: { admissionRecordId: "admission/m4-direct", decision: "REPLAN" },
        execution: { ...idle.execution, mutationCount: 1 },
        ...specialists,
      }),
    );
    const owner = projection.checks.find((row) => row.kind === "owner_gate");
    assert.ok(owner !== undefined);
    assert.match(owner.source, /^Root agent — proposed/u, "the root agent proposes every consequential action");
    assert.match(owner.check, /factory-change-control\/create_schedule_reservation/u);
    assert.match(owner.check, /reevaluated against current authoritative state/u);
    assert.match(owner.technicalEvidence ?? "", /admission admission\/m4-direct/u, "the recorded admission basis anchors the reevaluation evidence");
    const recommendation = projection.checks.find((row) => row.kind === "recommendation");
    assert.ok(recommendation !== undefined);
    assert.match(recommendation.source, /Capacity and schedule analyst/u);
    assert.doesNotMatch(recommendation.check, /record_current_admission/u, "no blanket claim that prose is rechecked through an MCP call");
    const execution = projection.checks.find((row) => row.kind === "execution");
    assert.ok(execution !== undefined);
    assert.match(execution.check, /verify_schedule_execution/u);
  });
});

interface MarkerSeamLike {
  readonly openSync: (path: string, flags: string, mode?: number) => number;
  readonly writeSync: (descriptor: number, payload: Uint8Array, offset?: number) => number;
  readonly fsyncSync: (descriptor: number) => void;
  readonly closeSync: (descriptor: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly rmSync: (path: string, options?: { readonly force?: boolean }) => void;
}

describe("Qodo PR16 Round 5: collision-safe temporaries and the platform durability contract", () => {
  const HERO_MISSION_ID = "mission/flakebrake-m4-hero";
  const MARKER_NAME = "m5-sandbox-evidence.json";
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-round5-"));
    roots.push(root);
    return root;
  };

  const ownRoot = async (root: string): Promise<void> => {
    const owner = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    await owner.close();
  };

  const bindHeroMission = async (root: string, sessionId: string): Promise<void> => {
    const { M4MissionStore } = await import("../src/m4-mission-store.js");
    const store = new M4MissionStore({ path: join(root, "mission.sqlite") });
    try {
      store.bindMission({
        missionId: HERO_MISSION_ID,
        environmentId: "env/hero-microfactory",
        trueforgeAgentId: "agent/test",
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: "m2/test",
        factoryEnvironmentIdentity: "factory/test",
      });
    } finally {
      store.close();
    }
  };

  const validMarker = (sessionId: string): string =>
    `${JSON.stringify({ missionId: HERO_MISSION_ID, trueforgeSessionId: sessionId, trueforgeTurnId: "turn/test" })}\n`;

  type PublishResult = string | undefined;

  const loadPublisher = async (): Promise<
    (destination: string, serialized: string, filesystem?: Record<string, unknown>) => PublishResult
  > => {
    const module_ = (await import("../src/m5-ui.js")) as Record<string, unknown>;
    const publisher = module_["publishJsonFileAtomically"];
    assert.equal(typeof publisher, "function");
    return publisher as (
      destination: string,
      serialized: string,
      filesystem?: Record<string, unknown>,
    ) => PublishResult;
  };

  interface Round5Seam {
    readonly seam: Record<string, unknown>;
    readonly log: string[];
    readonly suffixCalls: () => number;
    readonly createdTemporaries: () => readonly string[];
    readonly directoryDescriptor: () => number | null;
  }

  const round5Seam = (
    root: string,
    options?: {
      readonly suffixes?: readonly string[];
      readonly platform?: string;
      readonly directoryFsyncError?: () => Error;
      readonly renameError?: () => Error;
    },
  ): Round5Seam => {
    const log: string[] = [];
    let suffixIndex = 0;
    let directoryDescriptor: number | null = null;
    const created: string[] = [];
    const seam: Record<string, unknown> = {
      openSync: (path: string, flags: string, mode?: number) => {
        if (resolve(path) === resolve(root)) {
          const descriptor = openSync(path, flags, mode);
          directoryDescriptor = descriptor;
          log.push("open-directory");
          return descriptor;
        }
        const descriptor = openSync(path, flags, mode);
        if (flags === "wx") {
          created.push(path);
          log.push(`create:${path}`);
        }
        return descriptor;
      },
      writeSync: (descriptor: number, payload: Uint8Array, offset?: number) => writeSync(descriptor, payload, offset),
      fsyncSync: (descriptor: number) => {
        if (descriptor === directoryDescriptor) {
          log.push("fsync-directory");
          const failure = options?.directoryFsyncError?.();
          if (failure !== undefined) throw failure;
          fsyncSync(descriptor);
          return;
        }
        fsyncSync(descriptor);
      },
      closeSync: (descriptor: number) => closeSync(descriptor),
      renameSync: (from: string, to: string) => {
        const failure = options?.renameError?.();
        if (failure !== undefined) throw failure;
        log.push(`rename:${from}`);
        renameSync(from, to);
      },
      rmSync: (path: string, removeOptions?: { readonly force?: boolean }) => {
        log.push(`rm:${path}`);
        rmSync(path, removeOptions);
      },
      randomSuffix: () => {
        const suffixes = options?.suffixes ?? [];
        const value = suffixes[suffixIndex] ?? `fallback-${String(suffixIndex)}`;
        suffixIndex += 1;
        return value;
      },
    };
    if (options?.platform !== undefined) seam["platform"] = options.platform;
    return {
      seam,
      log,
      suffixCalls: () => suffixIndex,
      createdTemporaries: () => created,
      directoryDescriptor: () => directoryDescriptor,
    };
  };

  const errnoError = (code: string, message: string): Error => {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  test("reproduction 1: a colliding crash orphan must not drop the checkpoint or be deleted", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    // Learn the exact candidate name the current scheme will choose next, so
    // the crash orphan collides deterministically on the legacy pid.sequence
    // naming; under the injected-suffix contract the stub's first identity is
    // pre-created instead.
    const learn = round5Seam(root, { suffixes: ["learn-1"] });
    publish(join(root, "learning.json"), validMarker("session/current"), learn.seam);
    const learned = learn.createdTemporaries()[0] ?? "";
    const legacyMatch = /\.(\d+)\.(\d+)\.tmp$/u.exec(learned);
    const predicted =
      legacyMatch === null
        ? `${destination}.collide-1.tmp`
        : `${destination}.${legacyMatch[1] ?? ""}.${String(Number(legacyMatch[2] ?? "0") + 1)}.tmp`;
    const foreignContent = "another writer's in-flight publication";
    writeFileSync(predicted, foreignContent);
    const recorder = round5Seam(root, { suffixes: ["collide-1", "collide-2"] });
    assert.doesNotThrow(
      () => publish(destination, validMarker("session/current"), recorder.seam),
      "a collision with a crash orphan must retry a fresh identity instead of dropping the checkpoint",
    );
    assert.equal(
      readFileSync(predicted, "utf8"),
      foreignContent,
      "the pre-existing colliding file stays byte-identical — never deleted by an invocation that did not create it",
    );
    assert.equal(readFileSync(destination, "utf8"), validMarker("session/current"));
    assert.ok(recorder.suffixCalls() >= 2, "the injected randomness seam supplies each candidate identity");
  });

  test("reproduction 2: the Windows unsupported directory-sync signature must not reject publication", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    const recorder = round5Seam(root, {
      suffixes: ["win-1"],
      platform: "win32",
      directoryFsyncError: () => errnoError("EPERM", "EPERM: operation not permitted, fsync"),
    });
    let result: PublishResult;
    assert.doesNotThrow(() => {
      result = publish(destination, validMarker("session/current"), recorder.seam);
    }, "Windows's authoritative unsupported directory-fsync signature must not reject an otherwise complete publication");
    assert.equal(
      result,
      "file-durable-atomic-replacement",
      "the narrower established guarantee is represented explicitly instead of claiming full directory durability",
    );
    assert.equal(readFileSync(destination, "utf8"), validMarker("session/current"));
  });

  test("bounded collisions advance identities and exhaustion fails closed without deleting foreign files", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    for (const suffix of ["c-1", "c-2", "c-3"]) {
      writeFileSync(`${destination}.${suffix}.tmp`, `foreign ${suffix}`);
    }
    const advancing = round5Seam(root, { suffixes: ["c-1", "c-2", "c-3", "c-4"] });
    publish(destination, validMarker("session/current"), advancing.seam);
    assert.equal(advancing.suffixCalls(), 4, "each collision advances to a new identity under the bound");
    for (const suffix of ["c-1", "c-2", "c-3"]) {
      assert.equal(readFileSync(`${destination}.${suffix}.tmp`, "utf8"), `foreign ${suffix}`);
    }
    assert.equal(readFileSync(destination, "utf8"), validMarker("session/current"));

    const exhaustedRoot = newRoot();
    const exhaustedDestination = join(exhaustedRoot, MARKER_NAME);
    writeFileSync(`${exhaustedDestination}.same.tmp`, "foreign same");
    const constant = round5Seam(exhaustedRoot, {
      suffixes: ["same", "same", "same", "same", "same", "same", "same", "same"],
    });
    assert.throws(
      () => publish(exhaustedDestination, validMarker("session/current"), constant.seam),
      "exhausting the collision bound fails closed",
    );
    assert.equal(readFileSync(`${exhaustedDestination}.same.tmp`, "utf8"), "foreign same");
    assert.equal(existsSync(exhaustedDestination), false);
    assert.equal(
      constant.log.some((entry) => entry.startsWith("rm:")),
      false,
      "exhaustion deletes nothing — no foreign file was created by this invocation",
    );
  });

  test("failure cleanup removes only a temporary this invocation created", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    writeFileSync(`${destination}.bystander.tmp`, "foreign bystander");
    const failing = round5Seam(root, {
      suffixes: ["mine-1"],
      renameError: () => errnoError("EIO", "injected rename failure"),
    });
    assert.throws(() => publish(destination, validMarker("session/current"), failing.seam));
    const removed = failing.log.filter((entry) => entry.startsWith("rm:"));
    assert.deepEqual(
      removed,
      [`rm:${destination}.mine-1.tmp`],
      "cleanup targets exactly the invocation-owned temporary",
    );
    assert.equal(readFileSync(`${destination}.bystander.tmp`, "utf8"), "foreign bystander");
  });

  test("the platform durability contract distinguishes unsupported signatures from genuine failures", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const fullResult = publish(join(root, "full.json"), validMarker("session/current"), round5Seam(root, { suffixes: ["f-1"] }).seam);
    assert.equal(fullResult, "directory-durable", "a supported-platform directory fsync yields the full durability result");

    const linuxEperm = round5Seam(root, {
      suffixes: ["l-1"],
      platform: "linux",
      directoryFsyncError: () => errnoError("EPERM", "EPERM on a supported platform"),
    });
    assert.throws(
      () => publish(join(root, "linux-eperm.json"), validMarker("session/current"), linuxEperm.seam),
      "EPERM on a supported platform remains fail-closed and never bypasses durability",
    );

    const windowsEio = round5Seam(root, {
      suffixes: ["w-1"],
      platform: "win32",
      directoryFsyncError: () => errnoError("EIO", "genuine I/O failure on Windows"),
    });
    assert.throws(
      () => publish(join(root, "win-eio.json"), validMarker("session/current"), windowsEio.seam),
      "genuine I/O errors remain failures on every platform",
    );
  });

  test("restart restores the committed observation under both durability outcomes", async () => {
    const publish = await loadPublisher();
    const directoryDurableRoot = newRoot();
    await ownRoot(directoryDurableRoot);
    await bindHeroMission(directoryDurableRoot, "session/current");
    publish(
      join(directoryDurableRoot, MARKER_NAME),
      validMarker("session/current"),
      round5Seam(directoryDurableRoot, { suffixes: ["dd-1"] }).seam,
    );
    const fileDurableRoot = newRoot();
    await ownRoot(fileDurableRoot);
    await bindHeroMission(fileDurableRoot, "session/current");
    publish(
      join(fileDurableRoot, MARKER_NAME),
      validMarker("session/current"),
      round5Seam(fileDurableRoot, {
        suffixes: ["fd-1"],
        platform: "win32",
        directoryFsyncError: () => errnoError("EPERM", "EPERM: operation not permitted, fsync"),
      }).seam,
    );
    for (const root of [directoryDurableRoot, fileDurableRoot]) {
      const coordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
      try {
        assert.equal(
          coordinator.state().evidenceTimeline.some((item) => item.kind === "sandbox"),
          true,
          "the committed mission/session-bound observation restores after restart",
        );
      } finally {
        await coordinator.close();
      }
    }
  });
});

describe("Qodo PR16 Round 4: crash-durable publication and temporary ownership", () => {
  const HERO_MISSION_ID = "mission/flakebrake-m4-hero";
  const MARKER_NAME = "m5-sandbox-evidence.json";
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-round4-"));
    roots.push(root);
    return root;
  };

  const ownRoot = async (root: string): Promise<void> => {
    const owner = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    await owner.close();
  };

  const bindHeroMission = async (root: string, sessionId: string): Promise<void> => {
    const { M4MissionStore } = await import("../src/m4-mission-store.js");
    const store = new M4MissionStore({ path: join(root, "mission.sqlite") });
    try {
      store.bindMission({
        missionId: HERO_MISSION_ID,
        environmentId: "env/hero-microfactory",
        trueforgeAgentId: "agent/test",
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: "m2/test",
        factoryEnvironmentIdentity: "factory/test",
      });
    } finally {
      store.close();
    }
  };

  const validMarker = (sessionId: string): string =>
    `${JSON.stringify({ missionId: HERO_MISSION_ID, trueforgeSessionId: sessionId, trueforgeTurnId: "turn/test" })}\n`;

  const loadPublisher = async (): Promise<
    (destination: string, serialized: string, filesystem?: MarkerSeamLike) => void
  > => {
    const module_ = (await import("../src/m5-ui.js")) as Record<string, unknown>;
    const publisher = module_["publishJsonFileAtomically"];
    assert.equal(typeof publisher, "function");
    return publisher as (destination: string, serialized: string, filesystem?: MarkerSeamLike) => void;
  };

  interface SeamRecorder {
    readonly seam: MarkerSeamLike;
    readonly log: string[];
    directoryDescriptor: () => number | null;
    temporaryPaths: () => readonly string[];
  }

  const recordingSeam = (root: string, overrides?: Partial<MarkerSeamLike>): SeamRecorder => {
    const log: string[] = [];
    let directoryDescriptor: number | null = null;
    const temporaries: string[] = [];
    const base: MarkerSeamLike = {
      openSync: (path, flags, mode) => {
        const descriptor = openSync(path, flags, mode);
        if (resolve(path) === resolve(root)) {
          directoryDescriptor = descriptor;
          log.push(`open-directory:${resolve(path)}`);
        } else {
          if (flags === "wx") temporaries.push(path);
          log.push(`open-file:${path}`);
        }
        return descriptor;
      },
      writeSync: (descriptor, payload, offset) => {
        log.push("write");
        return writeSync(descriptor, payload, offset);
      },
      fsyncSync: (descriptor) => {
        log.push(descriptor === directoryDescriptor ? "fsync-directory" : "fsync-file");
        fsyncSync(descriptor);
      },
      closeSync: (descriptor) => {
        log.push(descriptor === directoryDescriptor ? "close-directory" : "close-file");
        closeSync(descriptor);
      },
      renameSync: (from, to) => {
        log.push(`rename:${from}→${to}`);
        renameSync(from, to);
      },
      rmSync: (path, options) => {
        log.push(`rm:${path}`);
        rmSync(path, options);
      },
    };
    return {
      seam: { ...base, ...overrides },
      log,
      directoryDescriptor: () => directoryDescriptor,
      temporaryPaths: () => temporaries,
    };
  };

  test("reproduction 1: publication must not report success without directory-entry durability", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    const recorder = recordingSeam(root);
    publish(destination, validMarker("session/current"), recorder.seam);
    const renameIndex = recorder.log.findIndex((entry) => entry.startsWith("rename:"));
    const directoryOpenIndex = recorder.log.indexOf(`open-directory:${resolve(root)}`);
    const directoryFsyncIndex = recorder.log.indexOf("fsync-directory");
    assert.ok(renameIndex >= 0, "the publication path runs through the injected filesystem seam");
    assert.ok(
      directoryOpenIndex > renameIndex,
      "after rename, the containing directory is opened for durability",
    );
    assert.ok(
      directoryFsyncIndex > directoryOpenIndex,
      "the directory entry is fsynced before persistence is acknowledged",
    );
    assert.ok(recorder.log.indexOf("close-directory") > directoryFsyncIndex);

    const failing = recordingSeam(root);
    const fsyncFailure = new Error("injected directory fsync failure");
    const failingSeam: MarkerSeamLike = {
      ...failing.seam,
      fsyncSync: (descriptor) => {
        if (descriptor === failing.directoryDescriptor()) throw fsyncFailure;
        failing.seam.fsyncSync(descriptor);
      },
    };
    assert.throws(
      () => publish(join(root, "second.json"), validMarker("session/current"), failingSeam),
      (error: unknown) => error === fsyncFailure,
      "a failed directory fsync must fail the publication instead of claiming durable success",
    );
  });

  test("reproduction 2: constructor restore must not delete an active publication temporary", async () => {
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    const destination = join(root, MARKER_NAME);
    const activeTemporary = `${destination}.99991.3.tmp`;
    writeFileSync(activeTemporary, validMarker("session/current"));
    const restored = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      restored.state();
    } finally {
      await restored.close();
    }
    assert.equal(
      existsSync(activeTemporary),
      true,
      "another writer's in-flight temporary survives a concurrent constructor restore",
    );
    renameSync(activeTemporary, destination);
    assert.equal(readFileSync(destination, "utf8"), validMarker("session/current"));
    const verifier = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      assert.equal(
        verifier.state().evidenceTimeline.some((item) => item.kind === "sandbox"),
        true,
        "the resumed publication completes and restores the observation",
      );
    } finally {
      await verifier.close();
    }
  });

  test("directory durability failures fail closed with preserved diagnostics", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const openFailure = new Error("injected directory open failure");
    const openFailing = recordingSeam(root);
    const openFailingSeam: MarkerSeamLike = {
      ...openFailing.seam,
      openSync: (path, flags, mode) => {
        if (resolve(path) === resolve(root)) throw openFailure;
        return openFailing.seam.openSync(path, flags, mode);
      },
    };
    assert.throws(
      () => publish(join(root, MARKER_NAME), validMarker("session/current"), openFailingSeam),
      (error: unknown) => error === openFailure,
      "a directory-open failure is never reported as durable success",
    );

    const closeFailure = new Error("injected directory close failure");
    const closeFailing = recordingSeam(root);
    const closeFailingSeam: MarkerSeamLike = {
      ...closeFailing.seam,
      closeSync: (descriptor) => {
        if (descriptor === closeFailing.directoryDescriptor()) throw closeFailure;
        closeFailing.seam.closeSync(descriptor);
      },
    };
    assert.throws(
      () => publish(join(root, "close-case.json"), validMarker("session/current"), closeFailingSeam),
      (error: unknown) => error === closeFailure,
      "a directory-close failure keeps its diagnostic instead of false success",
    );

    const bothFsync = new Error("injected fsync failure");
    const bothClose = new Error("injected close failure");
    const bothFailing = recordingSeam(root);
    const bothSeam: MarkerSeamLike = {
      ...bothFailing.seam,
      fsyncSync: (descriptor) => {
        if (descriptor === bothFailing.directoryDescriptor()) throw bothFsync;
        bothFailing.seam.fsyncSync(descriptor);
      },
      closeSync: (descriptor) => {
        if (descriptor === bothFailing.directoryDescriptor()) throw bothClose;
        bothFailing.seam.closeSync(descriptor);
      },
    };
    assert.throws(
      () => publish(join(root, "both-case.json"), validMarker("session/current"), bothSeam),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors[0] === bothFsync &&
        error.errors.includes(bothClose) &&
        error.cause === bothFsync,
      "the primary durability error is preserved with cleanup diagnostics attached secondarily",
    );
  });

  test("publishers own only their invocation's temporary files", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    const foreignTemporary = `${destination}.55555.9.tmp`;
    writeFileSync(foreignTemporary, "another writer's in-flight publication");
    const renameFailure = new Error("injected rename failure");
    const failing = recordingSeam(root);
    const failingSeam: MarkerSeamLike = {
      ...failing.seam,
      renameSync: () => {
        throw renameFailure;
      },
    };
    assert.throws(
      () => publish(destination, validMarker("session/current"), failingSeam),
      (error: unknown) => error === renameFailure,
    );
    const ownTemporaries = failing.temporaryPaths();
    assert.equal(ownTemporaries.length, 1);
    const removed = failing.log.filter((entry) => entry.startsWith("rm:"));
    assert.deepEqual(removed, [`rm:${ownTemporaries[0] ?? ""}`], "failure cleanup removes only the owned temporary");
    assert.equal(existsSync(foreignTemporary), true, "a foreign in-flight temporary is never deleted or stolen");
    assert.equal(existsSync(destination), false);

    const first = recordingSeam(root);
    publish(destination, validMarker("session/current"), first.seam);
    const second = recordingSeam(root);
    publish(destination, validMarker("session/next"), second.seam);
    assert.notEqual(first.temporaryPaths()[0], second.temporaryPaths()[0], "each invocation owns a unique temporary");
  });

  test("orphan temporaries are inert for restore and ordinary close", async () => {
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    const destination = join(root, MARKER_NAME);
    writeFileSync(destination, validMarker("session/current"));
    const orphan = `${destination}.44444.2.tmp`;
    writeFileSync(orphan, "crash-orphaned partial {");
    const cleanupCoordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: true });
    let observed = false;
    try {
      observed = cleanupCoordinator.state().evidenceTimeline.some((item) => item.kind === "sandbox");
    } finally {
      await cleanupCoordinator.close();
    }
    assert.equal(observed, true, "the committed marker stays authoritative despite orphan temporaries");
    assert.equal(existsSync(destination), false, "owned close cleanup removes the committed marker");
    assert.equal(
      existsSync(orphan),
      true,
      "ordinary close never glob-deletes unknown temporaries that may belong to an active writer",
    );
  });

  test("a separate server process restores the exact mission/session-bound evidence", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    publish(join(root, MARKER_NAME), validMarker("session/current"));
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address === null || typeof address === "string") {
          probe.close(() => rejectPort(new Error("no ephemeral port")));
          return;
        }
        probe.close(() => resolvePort(address.port));
      });
    });
    const spawnServer = async (): Promise<ChildProcess> => {
      const child = spawn(process.execPath, ["dist/src/m5-cli.js", "--port", String(port), "--data-dir", root], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (output.includes("judge UI ready")) return child;
        if (child.exitCode !== null) throw new Error(`M5 server exited early: ${output}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      child.kill("SIGKILL");
      throw new Error(`M5 server did not become ready: ${output}`);
    };
    const readSandboxObserved = async (): Promise<boolean> => {
      const state = (await fetch(`http://127.0.0.1:${String(port)}/api/state`).then((response) =>
        response.json(),
      )) as { readonly evidenceTimeline: readonly { readonly kind: string }[] };
      return state.evidenceTimeline.some((item) => item.kind === "sandbox");
    };
    const first = await spawnServer();
    try {
      assert.equal(await readSandboxObserved(), true, "a separate process restores the durable observation");
    } finally {
      const exited = once(first, "exit");
      first.kill("SIGKILL");
      await exited;
    }
    const second = await spawnServer();
    try {
      assert.equal(await readSandboxObserved(), true, "a full process restart keeps the observation");
    } finally {
      const exited = once(second, "exit");
      second.kill("SIGKILL");
      await exited;
    }
  });
});

describe("Qodo PR16 Round 3: atomic sandbox marker publication", () => {
  const HERO_MISSION_ID = "mission/flakebrake-m4-hero";
  const MARKER_NAME = "m5-sandbox-evidence.json";
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-round3-"));
    roots.push(root);
    return root;
  };

  const ownRoot = async (root: string): Promise<void> => {
    const owner = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    await owner.close();
  };

  const bindHeroMission = async (root: string, sessionId: string): Promise<void> => {
    const { M4MissionStore } = await import("../src/m4-mission-store.js");
    const store = new M4MissionStore({ path: join(root, "mission.sqlite") });
    try {
      store.bindMission({
        missionId: HERO_MISSION_ID,
        environmentId: "env/hero-microfactory",
        trueforgeAgentId: "agent/test",
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: "m2/test",
        factoryEnvironmentIdentity: "factory/test",
      });
    } finally {
      store.close();
    }
  };

  const validMarker = (sessionId: string): string =>
    `${JSON.stringify({ missionId: HERO_MISSION_ID, trueforgeSessionId: sessionId, trueforgeTurnId: "turn/test" })}\n`;

  const sandboxObserved = async (root: string): Promise<boolean> => {
    const coordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      return coordinator.state().evidenceTimeline.some((item) => item.kind === "sandbox");
    } finally {
      await coordinator.close();
    }
  };

  const loadPublisher = async (): Promise<(destination: string, serialized: string) => void> => {
    const module_ = (await import("../src/m5-ui.js")) as Record<string, unknown>;
    const publisher = module_["publishJsonFileAtomically"];
    assert.equal(
      typeof publisher,
      "function",
      "src/m5-ui.ts exposes the atomic marker publisher (the in-place writer cannot satisfy the torn-write contract)",
    );
    return publisher as (destination: string, serialized: string) => void;
  };

  test("reproduction: an in-place torn write loses an acknowledged sandbox observation", async () => {
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    writeFileSync(join(root, MARKER_NAME), validMarker("session/current"));
    assert.equal(await sandboxObserved(root), true, "the acknowledged observation restores as Observed");
    // The exact crash aftermath of the eea5d52 in-place writer: open(O_TRUNC)
    // succeeded, the process died before the JSON landed.
    writeFileSync(join(root, MARKER_NAME), "");
    assert.equal(
      await sandboxObserved(root),
      false,
      "a torn committed marker silently loses the observation — the writer must make this state unreachable",
    );
    await loadPublisher();
  });

  test("a failed publication leaves the prior valid committed marker byte-identical", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    const destination = join(root, MARKER_NAME);
    publish(destination, validMarker("session/current"));
    const before = readFileSync(destination);
    const { chmodSync } = await import("node:fs");
    chmodSync(root, 0o500);
    try {
      assert.throws(
        () => publish(destination, validMarker("session/next")),
        "publication into an unwritable directory fails closed",
      );
    } finally {
      chmodSync(root, 0o700);
    }
    assert.deepEqual(readFileSync(destination), before, "the committed marker was never opened or truncated in place");
    assert.equal(await sandboxObserved(root), true, "the surviving marker still restores Observed");
    const leftovers = readdirSync(root).filter((name) => name.startsWith(`${MARKER_NAME}.`));
    assert.deepEqual(leftovers, [], "no temporary residue survives a failed publication");
  });

  test("crash aftermath between temporary write and publication keeps the committed marker authoritative", async () => {
    await loadPublisher();
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    const destination = join(root, MARKER_NAME);
    writeFileSync(destination, validMarker("session/current"));
    writeFileSync(`${destination}.99999.7.tmp`, validMarker("session/other"));
    writeFileSync(`${destination}.99999.8.tmp`, "not json {");
    assert.equal(
      await sandboxObserved(root),
      true,
      "only the committed marker is authoritative; unpublished temporaries change nothing",
    );
    assert.equal(readFileSync(destination, "utf8"), validMarker("session/current"));
    const leftovers = readdirSync(root).filter((name) => name.startsWith(`${MARKER_NAME}.`));
    assert.equal(
      leftovers.length,
      2,
      "unpublished temporaries are inert and left in place — they may belong to an active writer",
    );

    const orphanRoot = newRoot();
    await ownRoot(orphanRoot);
    await bindHeroMission(orphanRoot, "session/current");
    writeFileSync(join(orphanRoot, `${MARKER_NAME}.42.1.tmp`), validMarker("session/current"));
    assert.equal(
      await sandboxObserved(orphanRoot),
      false,
      "a complete but unpublished temporary never promotes the station",
    );
  });

  test("successful publication is complete, valid, restrictive, and exactly mission/session bound", async () => {
    const publish = await loadPublisher();
    const root = newRoot();
    const destination = join(root, MARKER_NAME);
    publish(destination, validMarker("session/current"));
    const stats = statSync(destination);
    assert.equal(stats.mode & 0o777, 0o600, "the committed marker keeps restrictive permissions");
    const parsed = parseJsonRejectingDuplicateKeys(readFileSync(destination, "utf8")) as Record<string, unknown>;
    assert.deepEqual({ ...parsed }, {
      missionId: HERO_MISSION_ID,
      trueforgeSessionId: "session/current",
      trueforgeTurnId: "turn/test",
    });
    publish(destination, validMarker("session/replaced"));
    const replaced = parseJsonRejectingDuplicateKeys(readFileSync(destination, "utf8")) as Record<string, unknown>;
    assert.equal(replaced["trueforgeSessionId"], "session/replaced", "replacement is atomic and complete");
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith(`${MARKER_NAME}.`)),
      [],
      "publication leaves no temporary residue",
    );
  });

  test("reset removes the prior mission's evidence without contaminating the next mission", async () => {
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/current");
    writeFileSync(join(root, MARKER_NAME), validMarker("session/current"));
    const coordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      assert.equal(coordinator.state().evidenceTimeline.some((item) => item.kind === "sandbox"), true);
      coordinator.reset();
      assert.equal(existsSync(join(root, MARKER_NAME)), false, "reset deletes the committed marker");
      assert.equal(
        coordinator.state().evidenceTimeline.some((item) => item.kind === "sandbox"),
        false,
        "the next mission starts without inherited sandbox evidence",
      );
    } finally {
      await coordinator.close();
    }
  });
});

describe("Qodo PR16 Round 2: durable sandbox evidence survives restart", () => {
  const HERO_MISSION_ID = "mission/flakebrake-m4-hero";
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-round2-"));
    roots.push(root);
    return root;
  };

  const bindHeroMission = async (root: string, sessionId: string): Promise<void> => {
    const { M4MissionStore } = await import("../src/m4-mission-store.js");
    const store = new M4MissionStore({ path: join(root, "mission.sqlite") });
    try {
      store.bindMission({
        missionId: HERO_MISSION_ID,
        environmentId: "env/hero-microfactory",
        trueforgeAgentId: "agent/test",
        trueforgeSessionId: sessionId,
        m2EnvironmentIdentity: "m2/test",
        factoryEnvironmentIdentity: "factory/test",
      });
    } finally {
      store.close();
    }
  };

  const ownRoot = async (root: string): Promise<void> => {
    const owner = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    await owner.close();
  };

  const sandboxEntryOf = (state: M5JudgeState): M5JudgeState["evidenceTimeline"][number] | undefined =>
    state.evidenceTimeline.find((item) => item.kind === "sandbox");

  test("regression 1+5: sandbox evidence observed live survives a complete coordinator restart identically", async () => {
    const root = newRoot();
    const live = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    let liveState: M5JudgeState | null = null;
    try {
      live.start();
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const current = live.state();
        if (sandboxEntryOf(current) !== undefined) {
          liveState = current;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
    } finally {
      await live.close();
    }
    assert.ok(liveState !== null, "the live mission produced authoritative sandbox.created evidence");
    assert.ok(liveState.mission.sessionId !== null, "the mission bound a durable TrueForge session");
    const liveEntry = sandboxEntryOf(liveState);
    assert.ok(liveEntry !== undefined);
    const liveHarness = await createPollingHarness(liveState, []);
    assert.equal(liveHarness.text("chain-sandbox"), "Observed");

    const restarted = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      const resumed = restarted.state();
      const resumedEntry = sandboxEntryOf(resumed);
      assert.ok(
        resumedEntry !== undefined,
        "a full coordinator restart must not regress durable sandbox evidence to Configured",
      );
      assert.equal(resumedEntry.title, liveEntry.title, "live and restarted projections converge");
      assert.equal(resumedEntry.detail, liveEntry.detail);
      assert.equal(resumed.mission.sessionId, liveState.mission.sessionId, "same durable session");
      const resumedHarness = await createPollingHarness(resumed, []);
      assert.equal(
        resumedHarness.text("chain-sandbox"),
        "Observed",
        "the resumed Sandbox station stays Observed for this mission/session",
      );
      assert.equal(resumedHarness.text("chain-agents"), "Configured", "no invented agent evidence appears");
    } finally {
      await restarted.close();
    }
  });

  test("regression 2: a restart before any sandbox evidence stays Configured", async () => {
    const root = newRoot();
    await ownRoot(root);
    await bindHeroMission(root, "session/pre-sandbox");
    const restarted = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    try {
      const resumed = restarted.state();
      assert.equal(sandboxEntryOf(resumed), undefined);
      const harness = await createPollingHarness(resumed, []);
      assert.equal(harness.text("chain-sandbox"), "Configured");
    } finally {
      await restarted.close();
    }
  });

  test("regression 3: evidence from another mission or session never promotes", async () => {
    const crossSession = newRoot();
    await ownRoot(crossSession);
    await bindHeroMission(crossSession, "session/current");
    writeFileSync(
      join(crossSession, "m5-sandbox-evidence.json"),
      JSON.stringify({
        missionId: HERO_MISSION_ID,
        trueforgeSessionId: "session/another",
        trueforgeTurnId: "turn/foreign",
      }),
    );
    const crossSessionCoordinator = new M5DemoCoordinator({ dataRoot: crossSession, cleanupDataOnClose: false });
    try {
      assert.equal(
        sandboxEntryOf(crossSessionCoordinator.state()),
        undefined,
        "another session's sandbox evidence cannot promote this mission",
      );
    } finally {
      await crossSessionCoordinator.close();
    }
    const crossMission = newRoot();
    await ownRoot(crossMission);
    await bindHeroMission(crossMission, "session/current");
    writeFileSync(
      join(crossMission, "m5-sandbox-evidence.json"),
      JSON.stringify({
        missionId: "mission/some-other",
        trueforgeSessionId: "session/current",
        trueforgeTurnId: "turn/foreign",
      }),
    );
    const crossMissionCoordinator = new M5DemoCoordinator({ dataRoot: crossMission, cleanupDataOnClose: false });
    try {
      assert.equal(sandboxEntryOf(crossMissionCoordinator.state()), undefined);
    } finally {
      await crossMissionCoordinator.close();
    }
    const malformed = newRoot();
    await ownRoot(malformed);
    await bindHeroMission(malformed, "session/current");
    writeFileSync(join(malformed, "m5-sandbox-evidence.json"), "not json {");
    const malformedCoordinator = new M5DemoCoordinator({ dataRoot: malformed, cleanupDataOnClose: false });
    try {
      assert.equal(sandboxEntryOf(malformedCoordinator.state()), undefined, "a malformed marker fails closed");
    } finally {
      await malformedCoordinator.close();
    }
  });

  test("regression 4: a stale poll cannot regress the observed Sandbox station", async () => {
    const root = newRoot();
    const coordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    let idle!: M5JudgeState;
    try {
      idle = coordinator.state();
    } finally {
      await coordinator.close();
    }
    const observed: M5JudgeState = {
      ...uiProjection(idle, 6, "awaiting_approval"),
      evidenceTimeline: [
        ...idle.evidenceTimeline,
        {
          sequence: idle.evidenceTimeline.length + 1,
          kind: "sandbox",
          title: "Assurance sandbox created",
          detail: "TrueForge Code Mode opened an isolated deterministic assurance run.",
          technicalIdentity: null,
          status: "informational",
        },
      ],
    };
    const stale = deferred<unknown>();
    const harness = await createPollingHarness(observed, [stale.promise]);
    assert.equal(harness.text("chain-sandbox"), "Observed");
    const oldPoll = harness.evaluate<Promise<void>>("refresh()");
    stale.resolve(uiProjection(idle, 2, "awaiting_approval"));
    await oldPoll;
    assert.equal(
      harness.text("chain-sandbox"),
      "Observed",
      "a stale cross-generation projection cannot regress or contaminate the station",
    );
  });

  test("regressions 6+7: terminal rules and replay keep truthful stations without new owner calls", async () => {
    const root = newRoot();
    const coordinator = new M5DemoCoordinator({ dataRoot: root, cleanupDataOnClose: false });
    let idle!: M5JudgeState;
    try {
      idle = coordinator.state();
    } finally {
      await coordinator.close();
    }
    const sandboxEntry = {
      sequence: idle.evidenceTimeline.length + 1,
      kind: "sandbox",
      title: "Assurance sandbox created",
      detail: "TrueForge Code Mode opened an isolated deterministic assurance run.",
      technicalIdentity: null,
      status: "informational" as const,
    };
    const verifiedBase = uiProjection(idle, 6, "verified");
    const replayed: M5JudgeState = {
      ...verifiedBase,
      run: { ...verifiedBase.run, ownerCallsThisProcess: 0 },
      mission: { ...verifiedBase.mission, disconnectedAndResumed: true },
      activity: { ...verifiedBase.activity, sandboxExecutions: 1 },
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const replayHarness = await createPollingHarness(replayed, []);
    assert.equal(replayHarness.text("chain-sandbox"), "Observed", "replay preserves sandbox observation");
    assert.equal(replayHarness.text("chain-sandbox"), "Observed");
    assert.notEqual(replayHarness.text("chain-sandbox"), "Verified", "sandbox observation alone is never Verified");
    assert.equal(replayHarness.text("chain-verified"), "Verified", "exact terminal verification promotes the verified station");
    assert.equal(replayHarness.text("chain-resume"), "Observed");
    const failedTerminal: M5JudgeState = {
      ...idle,
      revision: 9,
      run: { ...idle.run, status: "failed" },
      evidenceTimeline: [...idle.evidenceTimeline, sandboxEntry],
      execution: { ...idle.execution, mutationCount: 1, terminalEventCount: 1, terminalStatus: "terminal_reconciled" },
    };
    const failedHarness = await createPollingHarness(failedTerminal, []);
    assert.equal(failedHarness.text("chain-sandbox"), "Observed", "a terminal failure does not erase sandbox evidence");
    assert.equal(failedHarness.text("chain-verified"), "—", "terminal reconciliation alone never promotes Verified");
  });
});

describe("Qodo PR16 Round 1: truthful failure, terminal, and chain evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-round1-"));
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

  const ownerApproval = (actionIdentity: string): M5JudgeState["approvals"][number] => ({
    toolName: "select_portfolio_modification",
    decision: "allow",
    source: "owner",
    ownerSourceIdentity: "owner/judge-ui",
    actionIdentity,
    effect: "Modify order/best-effort-display: quantity 10 → 8",
    reason: "owner approved",
    denialId: null,
  });

  test("finding 1: a failure after a committed mutation never claims nothing was mutated", async () => {
    const failedAfterMutation: M5JudgeState = {
      ...idle,
      revision: 3,
      run: { ...idle.run, status: "failed", canStart: true },
      execution: {
        ...idle.execution,
        acceptanceCount: 1,
        attemptCount: 1,
        mutationCount: 1,
        receiptCount: 1,
        attemptId: "attempt/m4-approved-alternative",
      },
    };
    const harness = await createPollingHarness(failedAfterMutation, []);
    assert.doesNotMatch(harness.text("guided-why"), /Nothing was mutated/u);
    assert.doesNotMatch(harness.text("guided-what"), /before any unsafe effect/u);
    assert.equal(
      harness.text("guided-heading"),
      "The change is recorded—but it is not verified yet",
      "a committed mutation outranks the stopped-run story",
    );
    assert.match(harness.text("guided-what"), /stopped before independent verification/u);
    assert.match(harness.text("guided-what"), /already recorded durably/u);
    assert.match(harness.text("guided-why"), /recorded change is not success/iu);
    assert.match(harness.text("guided-next"), /Resume safely/u);
    assert.equal(harness.text("guided-number-mutations"), "1");
    assert.equal(harness.text("guided-number-mutations-note"), "recorded — not verified");
    const failedClean: M5JudgeState = {
      ...idle,
      revision: 4,
      run: { ...idle.run, status: "failed", canStart: true },
    };
    const clean = await createPollingHarness(failedClean, []);
    assert.equal(clean.text("guided-heading"), "The mission stopped safely");
    assert.match(clean.text("guided-why"), /No consequential change was recorded/u);
  });

  test("finding 2: terminal counts render verified completion only for terminal_verified", async () => {
    const reconciledFailure: M5JudgeState = {
      ...idle,
      revision: 5,
      run: { ...idle.run, status: "failed" },
      execution: {
        ...idle.execution,
        mutationCount: 1,
        receiptCount: 1,
        terminalEventCount: 1,
        terminalStatus: "terminal_reconciled",
      },
    };
    const harness = await createPollingHarness(reconciledFailure, []);
    assert.doesNotMatch(
      harness.text("proof-outcome-note"),
      /verified completion/u,
      "a non-verified terminal event must not be labeled a verified completion",
    );
    assert.match(harness.text("proof-outcome-note"), /1 terminal event/u);
    const durable = harness.evaluate<string>("document.getElementById('proof-durable-proof').innerHTML");
    assert.doesNotMatch(durable, /<strong>1<\/strong><span>Verified completion<\/span>/u);
    assert.match(durable, /<strong>1<\/strong><span>Terminal event<\/span>/u);
    const verifiedBase = uiProjection(idle, 6, "verified");
    const verified: M5JudgeState = {
      ...verifiedBase,
      execution: {
        ...verifiedBase.execution,
        independentReadBackObserved: true,
        terminalEventCount: 1,
      },
    };
    const done = await createPollingHarness(verified, []);
    assert.match(done.text("proof-outcome-note"), /1 verified completion/u);
    assert.match(
      done.evaluate<string>("document.getElementById('proof-durable-proof').innerHTML"),
      /<strong>1<\/strong><span>Verified completion<\/span>/u,
    );
  });

  test("finding 3: agent-trust verified result requires the exact terminal_verified discriminant", async () => {
    const module_ = (await import("../src/m5-ui.js")) as Record<string, unknown>;
    const agentTrustProjection = module_["agentTrustProjection"] as (
      input: Record<string, unknown>,
    ) => { readonly checks: readonly { readonly kind: string; readonly result: string }[] };
    assert.equal(typeof agentTrustProjection, "function");
    const projectionFor = (terminalStatus: string | null): string | undefined =>
      agentTrustProjection({
        approvals: [],
        approvalEffectText: () => "effect",
        execution: {
          ...idle.execution,
          mutationCount: 1,
          receiptCount: 1,
          independentReadBackObserved: true,
          terminalStatus,
        },
        subagentTitles: [],
        subagentThreadIds: [],
        admission: null,
        sessionId: null,
        disconnectedAndResumed: false,
        runStatus: "verifying",
      }).checks.find((row) => row.kind === "execution")?.result;
    assert.equal(projectionFor("terminal_reconciled"), "pending_verification", "terminal_reconciled is not verified success");
    assert.equal(projectionFor("terminal_failed"), "pending_verification", "a terminal failure is not verified success");
    assert.equal(projectionFor("claimed_pending"), "pending_verification", "an incomplete claim is not verified success");
    assert.equal(projectionFor(null), "pending_verification");
    assert.equal(projectionFor("terminal_verified"), "verified");
  });

  test("finding 4: the human-pause station relies on durable approvals, not the process counter", async () => {
    const verifiedBase = uiProjection(idle, 6, "verified");
    const restartedReplay: M5JudgeState = {
      ...verifiedBase,
      run: { ...verifiedBase.run, ownerCallsThisProcess: 0 },
      approvals: [ownerApproval("sha256:restart-durable-approval")],
      safety: { ...idle.safety, ownerCallCount: 1 },
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const harness = await createPollingHarness(restartedReplay, []);
    assert.equal(
      harness.text("chain-pause"),
      "Observed",
      "durable approvals keep the pause station Observed after a zero-owner-call restart",
    );
    const inventedTerminal: M5JudgeState = {
      ...uiProjection(idle, 7, "verified"),
      run: { ...verifiedBase.run, ownerCallsThisProcess: 0 },
      approvals: [],
      safety: { ...idle.safety, ownerCallCount: 0 },
    };
    const invented = await createPollingHarness(inventedTerminal, []);
    assert.equal(
      invented.text("chain-pause"),
      "Configured",
      "a generic terminal state must not invent approval evidence",
    );
  });

  test("finding 5: tool and sandbox stations observe authoritative mid-run evidence", async () => {
    const pendingBase = uiProjection(idle, 5, "awaiting_approval");
    const midRun: M5JudgeState = {
      ...pendingBase,
      approvals: [ownerApproval("sha256:mid-run-durable-approval")],
      safety: { ...idle.safety, ownerCallCount: 1 },
      evidenceTimeline: [
        ...idle.evidenceTimeline,
        {
          sequence: idle.evidenceTimeline.length + 1,
          kind: "sandbox",
          title: "Assurance sandbox created",
          detail: "TrueForge Code Mode opened an isolated deterministic assurance run.",
          technicalIdentity: null,
          status: "informational",
        },
      ],
    };
    const harness = await createPollingHarness(midRun, []);
    assert.equal(
      harness.text("chain-tools"),
      "Observed",
      "durable approval-bridge records prove factory tool use before the terminal projection exists",
    );
    assert.equal(
      harness.text("chain-sandbox"),
      "Observed",
      "the authoritative sandbox checkpoint proves sandbox use mid-run",
    );
    assert.equal(
      harness.text("chain-agents"),
      "Configured",
      "no mid-run thread evidence exists, so the agents station honestly stays Configured",
    );
    const idleHarness = await createPollingHarness(idle, []);
    assert.equal(idleHarness.text("chain-tools"), "Configured");
    assert.equal(idleHarness.text("chain-sandbox"), "Configured");
    assert.equal(idleHarness.text("chain-pause"), "Configured");
  });
});

describe("M5 TrueForge harness ribbon", () => {
  const document = readFileSync(join(process.cwd(), "ui/m5/index.html"), "utf8");
  const application = readFileSync(join(process.cwd(), "ui/m5/app.js"), "utf8");
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-m5-harness-"));
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

  test("names the harness, the pause, and the ownership boundary without unsupported claims", () => {
    assert.match(document, /class="harness-name">TrueForge harness</u);
    assert.match(document, /id="harness-pause"[^>]*hidden>TrueForge paused this turn for your decision\.</u);
    assert.match(document, /Why TrueForge matters/u);
    assert.match(
      document,
      /TrueForge owns sessions and turns, MCP routing, sandbox execution, subagents, approval pauses, and reconnect\. FlakeBrake owns admission policy, exact authorization, mechanical alternate-representation denial, fenced mutation, and independent verification\./u,
    );
    assert.doesNotMatch(document, /OpenAI|Daytona/u);
    assert.doesNotMatch(application, /OpenAI|Daytona/u);
    assert.match(application, /services configured/u);
    assert.match(application, /services reached/u);
  });

  test("projects only authoritative harness facts", () => {
    assert.deepEqual(idle.harness, {
      framework: "TrueForge",
      serverVersion: "0.1.4",
      sdkVersion: "0.1.3",
      providerProfile: "Deterministic judge profile",
      modelName: "flakebrake-deterministic/m4-mission",
      rootAgentName: "flakebrake-root-obligation-commander",
      mcpConfigured: [
        "factory-orders",
        "factory-capacity",
        "factory-simulator",
        "factory-change-control",
      ],
      sandboxConfigured: true,
      dynamicSubagentsConfigured: true,
      approvalGatedToolCount: 4,
    });
  });

  test("reports state, pause, and configured-versus-evidenced wording from state alone", async () => {
    const pending = uiProjection(idle, 2, "awaiting_approval");
    const verifiedBase = uiProjection(idle, 3, "verified");
    const terminal: M5JudgeState = {
      ...verifiedBase,
      run: { ...verifiedBase.run, ownerCallsThisProcess: 4 },
      activity: {
        ...idle.activity,
        mcpServers: [...idle.harness.mcpConfigured].sort(),
        sandboxExecutions: 1,
        subagents: [
          { threadId: "thread/a", title: "Portfolio and order analyst", status: "done" },
          { threadId: "thread/b", title: "Capacity and schedule analyst", status: "done" },
          { threadId: "thread/c", title: "Assurance and simulation engineer", status: "done" },
        ],
      },
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const replayed: M5JudgeState = {
      ...terminal,
      revision: 4,
      mission: { ...terminal.mission, disconnectedAndResumed: true },
    };
    const harness = await createPollingHarness(idle, [
      Promise.resolve(pending),
      Promise.resolve(terminal),
      Promise.resolve(replayed),
    ]);
    assert.equal(harness.text("harness-state"), "Ready");
    assert.equal(harness.text("harness-mcp"), "4 services configured");
    assert.equal(harness.text("harness-sandbox"), "Configured");
    assert.equal(harness.text("harness-subagents"), "Dynamic · configured");
    assert.equal(harness.text("harness-gate"), "Native · 4 gated tools");
    assert.equal(harness.evaluate("document.getElementById('harness-pause').hidden"), true);
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.text("harness-state"), "Paused for human");
    assert.equal(harness.text("harness-gate"), "Holding this turn");
    assert.equal(harness.evaluate("document.getElementById('harness-pause').hidden"), false);
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.text("harness-state"), "Verified");
    assert.equal(harness.text("harness-mcp"), "4/4 services reached");
    assert.equal(harness.text("harness-sandbox"), "1 executed");
    assert.equal(harness.text("harness-subagents"), "3 threads evidenced");
    assert.equal(harness.text("harness-gate"), "Native · 4 owner calls");
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.evaluate("document.getElementById('harness-replay-row').hidden"), false);
    assert.equal(harness.text("harness-replay"), "Durable session replayed");

    const failedState: M5JudgeState = {
      ...idle,
      revision: 2,
      run: { ...idle.run, status: "failed", generation: 1, errorCode: "controlled_failure" },
    };
    const failedHarness = await createPollingHarness(failedState, []);
    assert.equal(failedHarness.text("harness-state"), "Failed");
  });

  test("the proof center counts a genuine disconnect-resume as replay evidence", async () => {
    const verifiedBase = uiProjection(idle, 2, "verified");
    const resumedTerminal: M5JudgeState = {
      ...verifiedBase,
      mission: { ...verifiedBase.mission, disconnectedAndResumed: true },
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const resumed = await createPollingHarness(resumedTerminal, []);
    assert.match(
      resumed.evaluate<string>("document.getElementById('proof-durable-proof').innerHTML"),
      /attached to a durable replay/u,
      "server-side disconnect-and-resume evidence marks continuity as observed",
    );

    const liveTerminal: M5JudgeState = {
      ...verifiedBase,
      execution: { ...verifiedBase.execution, independentReadBackObserved: true },
    };
    const live = await createPollingHarness(liveTerminal, []);
    const liveProof = live.evaluate<string>("document.getElementById('proof-durable-proof').innerHTML");
    assert.doesNotMatch(liveProof, /attached to a durable replay/u, "a live completion does not invent a disconnect");
    assert.match(liveProof, /durable across refresh and restart/u);
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
  const TRANSPORT_PROBE_URL = "http://transport.invalid/m5-controlled-transport-failure-probe";

  const arm = (session: FakeNetworkSession): ReturnType<typeof armSessionNetworkCapture> =>
    armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL, session.transportProbe);

  test("arming registers both channels before navigation and clears probe evidence", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL);
    const capture = await arm(session);
    assert.deepEqual(session.events, [
      "register-response",
      "register-fetch-error",
      "transport-probe",
      "navigate:probe",
      "refresh",
      "transport-probe",
    ]);
    assert.deepEqual(capture.failedResponses(), []);
  });

  test("an HTTP failure recorded before refresh persists across refresh and later navigation", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL);
    const capture = await arm(session);
    await session.browser.get("http://application.invalid/");
    assert.equal(session.emitFailedResponse("http://application.invalid/asset.js", 500), 1);
    await session.browser.refresh();
    await session.browser.get("http://application.invalid/deep");
    assert.deepEqual(capture.failedResponses(), [
      formatFailedResponse("http://application.invalid/asset.js", 500),
    ]);
  });

  test("a transport failure recorded before refresh persists unless cleared as probe evidence", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL);
    const capture = await arm(session);
    await session.browser.get("http://application.invalid/");
    assert.equal(session.emitTransportFailure("http://application.invalid/api/state", "NS_ERROR_NET_RESET"), 1);
    await session.browser.refresh();
    await session.browser.get("http://application.invalid/deep");
    assert.deepEqual(capture.failedResponses(), [
      formatTransportFailure("http://application.invalid/api/state", "NS_ERROR_NET_RESET"),
    ]);
  });

  test("an observer that never observes HTTP failures fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, { deliverResponses: false });
    await assert.rejects(arm(session), /did not observe the controlled missing-resource probe/u);
  });

  test("an observer that ignores fetchError events fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, { deliverTransportEvents: false });
    await assert.rejects(arm(session), /did not observe the controlled transport-failure probe/u);
  });

  test("an unavailable fetchError subscription fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, { registerFetchError: false });
    await assert.rejects(arm(session), /did not observe the controlled transport-failure probe/u);
  });

  test("a page-scoped HTTP observer lost on refresh fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, { dropHandlersOnRefresh: true });
    await assert.rejects(arm(session), /did not keep observing the missing-resource probe across refresh/u);
  });

  test("fetchError coverage lost on refresh fails closed", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, {
      dropFetchErrorHandlersOnRefresh: true,
    });
    await assert.rejects(arm(session), /did not keep observing the transport-failure probe across refresh/u);
  });

  test("dispose removes both failure observation channels", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL);
    const capture = await arm(session);
    await capture.dispose();
    assert.equal(session.registeredHandlerCount(), 0);
    assert.equal(session.registeredFetchErrorHandlerCount(), 0);
    assert.equal(session.emitFailedResponse("http://application.invalid/late.js", 503), 0);
    assert.equal(session.emitTransportFailure("http://application.invalid/late-poll", "NS_ERROR_NET_RESET"), 0);
    assert.deepEqual(capture.failedResponses(), []);
  });
});

describe("Qodo Round 4: failure-atomic capture arming", () => {
  const NETWORK_PROBE_URL = "http://application.invalid/m5-controlled-missing-resource-probe";
  const TRANSPORT_PROBE_URL = "http://transport.invalid/m5-controlled-transport-failure-probe";

  const armNetwork = (session: FakeNetworkSession): ReturnType<typeof armSessionNetworkCapture> =>
    armSessionNetworkCapture(session.observer, session.browser, NETWORK_PROBE_URL, session.transportProbe);

  test("the cleanup stack releases in reverse order and a successful release is terminal", async () => {
    const order: string[] = [];
    const stack = sessionCleanupStack();
    stack.own(async () => {
      order.push("first");
    });
    stack.own(async () => {
      order.push("second");
    });
    stack.own(async () => {
      order.push("third");
    });
    await stack.release();
    assert.deepEqual(order, ["third", "second", "first"]);
    await stack.release();
    assert.deepEqual(order, ["third", "second", "first"], "a released stack never reruns callbacks");
    assert.throws(
      () => stack.own(async () => undefined),
      /cannot own a release after cleanup has started/u,
      "ownership after release fails closed",
    );
  });

  test("error-capture arming failures release the observer at every boundary", async () => {
    const boundaries = [
      { label: "probe navigation", options: { failNavigationToProbe: true }, message: /controlled probe navigation failure/u },
      { label: "load observation", options: { deliverLoadErrors: false }, message: /did not capture the controlled load-time probe error/u },
      { label: "refresh", options: { failRefresh: true }, message: /controlled refresh failure/u },
      { label: "refresh re-observation", options: { dropHandlersOnRefresh: true }, message: /did not keep capturing the probe error across refresh/u },
    ];
    for (const boundary of boundaries) {
      const session = createFakeBrowserSession(boundary.options);
      await assert.rejects(armSessionErrorCapture(session.script, session.browser), boundary.message, boundary.label);
      assert.equal(session.registeredHandlerCount(), 0, `${boundary.label}: observer released`);
      assert.equal(
        session.events.filter((event) => event.startsWith("remove:")).length,
        1,
        `${boundary.label}: exactly one removal`,
      );
    }
  });

  test("error-capture cleanup failure is preserved alongside the arming failure", async () => {
    const session = createFakeBrowserSession({ deliverLoadErrors: false, failRemoval: true });
    await assert.rejects(armSessionErrorCapture(session.script, session.browser), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.match(String(aggregate.errors[0]), /did not capture the controlled load-time probe error/u);
      const cleanupFailure = aggregate.errors[1] as AggregateError;
      assert.match(String(cleanupFailure.errors[0]), /controlled removal failure/u);
      assert.match(String((aggregate.cause as Error).message), /did not capture the controlled load-time probe error/u);
      return true;
    });
  });

  test("error-capture dispose is exact-once and idempotent", async () => {
    const session = createFakeBrowserSession();
    const capture = await armSessionErrorCapture(session.script, session.browser);
    await capture.dispose();
    await capture.dispose();
    assert.equal(session.registeredHandlerCount(), 0);
    assert.equal(session.events.filter((event) => event.startsWith("remove:")).length, 1);
  });

  test("network arming failures release both channels at every boundary", async () => {
    const boundaries = [
      { label: "fetch-error registration", options: { failFetchErrorRegistration: true }, message: /controlled fetch-error registration failure/u },
      { label: "first transport trigger", options: { failTransportTriggerOnCall: 1 }, message: /controlled transport trigger failure/u },
      { label: "transport observation", options: { deliverTransportEvents: false }, message: /did not observe the controlled transport-failure probe/u },
      { label: "probe navigation", options: { failNavigation: true }, message: /controlled probe navigation failure/u },
      { label: "missing-resource observation", options: { deliverResponses: false }, message: /did not observe the controlled missing-resource probe/u },
      { label: "refresh", options: { failRefresh: true }, message: /controlled refresh failure/u },
      { label: "missing-resource re-observation", options: { dropHandlersOnRefresh: true }, message: /did not keep observing the missing-resource probe across refresh/u },
      { label: "transport re-observation", options: { dropFetchErrorHandlersOnRefresh: true }, message: /did not keep observing the transport-failure probe across refresh/u },
      { label: "second transport trigger", options: { failTransportTriggerOnCall: 2 }, message: /controlled transport trigger failure/u },
      { label: "evidence settling", options: { rejectWaitMessageMatching: /did not settle/u }, message: /did not settle before clearing/u },
    ];
    for (const boundary of boundaries) {
      const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, boundary.options);
      await assert.rejects(armNetwork(session), boundary.message, boundary.label);
      assert.equal(session.registeredHandlerCount(), 0, `${boundary.label}: response channel released`);
      assert.equal(session.registeredFetchErrorHandlerCount(), 0, `${boundary.label}: fetch-error channel released`);
      assert.equal(
        session.events.filter((event) => event === "remove").length,
        1,
        `${boundary.label}: exactly one removal`,
      );
    }
  });

  test("network cleanup failure is preserved alongside the arming failure", async () => {
    const session = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, {
      deliverTransportEvents: false,
      failRemoval: true,
    });
    await assert.rejects(armNetwork(session), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.match(String(aggregate.errors[0]), /did not observe the controlled transport-failure probe/u);
      const cleanupFailure = aggregate.errors[1] as AggregateError;
      assert.match(String(cleanupFailure.errors[0]), /controlled removal failure/u);
      assert.match(String((aggregate.cause as Error).message), /did not observe the controlled transport-failure probe/u);
      return true;
    });
  });

  test("network dispose is exact-once and a rejected arming releases exactly once", async () => {
    const healthy = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL);
    const capture = await armNetwork(healthy);
    await capture.dispose();
    await capture.dispose();
    assert.equal(healthy.events.filter((event) => event === "remove").length, 1);
    const failing = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, {
      deliverTransportEvents: false,
    });
    await assert.rejects(armNetwork(failing), /did not observe the controlled transport-failure probe/u);
    assert.equal(failing.events.filter((event) => event === "remove").length, 1);
    assert.equal(failing.registeredHandlerCount(), 0);
    assert.equal(failing.registeredFetchErrorHandlerCount(), 0);
  });
});

describe("Qodo Round 5: cleanup-stack lifecycle state machine", () => {
  const NETWORK_PROBE_URL = "http://application.invalid/m5-controlled-missing-resource-probe";
  const TRANSPORT_PROBE_URL = "http://transport.invalid/m5-controlled-transport-failure-probe";

  function flakyRelease(log: string[], name: string, failuresBeforeSuccess: number): () => Promise<void> {
    let remainingFailures = failuresBeforeSuccess;
    return async () => {
      log.push(name);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(`controlled ${name} release failure`);
      }
    };
  }

  test("a failed release keeps failed callbacks owned and a retry runs only those", async () => {
    const log: string[] = [];
    const stack = sessionCleanupStack();
    stack.own(flakyRelease(log, "first", 1));
    stack.own(flakyRelease(log, "second", 0));
    stack.own(flakyRelease(log, "third", 0));
    await assert.rejects(stack.release(), /session capture cleanup failed/u);
    assert.deepEqual(log, ["third", "second", "first"], "the first attempt is exhaustive and reverse ordered");
    await stack.release();
    assert.deepEqual(log, ["third", "second", "first", "first"], "the retry runs only the failed callback");
    await stack.release();
    assert.deepEqual(log, ["third", "second", "first", "first"], "a successful release makes later releases no-ops");
  });

  test("repeated retry failures keep rejecting until every callback succeeds", async () => {
    const log: string[] = [];
    const stack = sessionCleanupStack();
    stack.own(flakyRelease(log, "stubborn", 2));
    stack.own(flakyRelease(log, "reliable", 0));
    await assert.rejects(stack.release(), /session capture cleanup failed/u);
    assert.deepEqual(log, ["reliable", "stubborn"]);
    await assert.rejects(stack.release(), /session capture cleanup failed/u);
    assert.deepEqual(log, ["reliable", "stubborn", "stubborn"]);
    await stack.release();
    assert.deepEqual(log, ["reliable", "stubborn", "stubborn", "stubborn"]);
    await stack.release();
    assert.deepEqual(log, ["reliable", "stubborn", "stubborn", "stubborn"]);
  });

  test("multiple failures aggregate in execution order and stay owned for retry", async () => {
    const log: string[] = [];
    const stack = sessionCleanupStack();
    const firstFailure = new Error("controlled first release failure", { cause: new Error("first root cause") });
    const thirdFailure = new Error("controlled third release failure");
    let firstAttempts = 0;
    let thirdAttempts = 0;
    stack.own(async () => {
      log.push("first");
      firstAttempts += 1;
      if (firstAttempts === 1) throw firstFailure;
    });
    stack.own(flakyRelease(log, "second", 0));
    stack.own(async () => {
      log.push("third");
      thirdAttempts += 1;
      if (thirdAttempts === 1) throw thirdFailure;
    });
    await assert.rejects(stack.release(), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.equal(aggregate.errors[0], thirdFailure, "failures aggregate in execution order");
      assert.equal(aggregate.errors[1], firstFailure);
      assert.equal((aggregate.errors[1] as Error).cause instanceof Error, true, "underlying causes are preserved");
      return true;
    });
    assert.deepEqual(log, ["third", "second", "first"]);
    await stack.release();
    assert.deepEqual(log, ["third", "second", "first", "third", "first"], "the retry runs only failed callbacks, reverse ordered");
  });

  test("concurrent releases share one in-flight cleanup and settle together", async () => {
    const stack = sessionCleanupStack();
    const gate = deferred<void>();
    let runs = 0;
    stack.own(async () => {
      runs += 1;
      await gate.promise;
    });
    let firstSettled = false;
    let secondSettled = false;
    const first = stack.release().then(() => {
      firstSettled = true;
    });
    const second = stack.release().then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(runs, 1, "concurrent callers do not start a second cleanup run");
    assert.equal(firstSettled, false, "the first caller waits for the in-flight cleanup");
    assert.equal(secondSettled, false, "the concurrent caller waits for the in-flight cleanup");
    gate.resolve();
    await first;
    await second;
    assert.equal(firstSettled && secondSettled, true);
    await stack.release();
    assert.equal(runs, 1, "a released stack never reruns callbacks");
  });

  test("concurrent releases reject together when the shared cleanup fails, then retry", async () => {
    const stack = sessionCleanupStack();
    const gate = deferred<void>();
    let runs = 0;
    stack.own(async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
    });
    const outcomes: unknown[] = [];
    const first = stack.release().catch((error: unknown) => {
      outcomes.push(error);
    });
    const second = stack.release().catch((error: unknown) => {
      outcomes.push(error);
    });
    gate.reject(new Error("controlled shared release failure"));
    await first;
    await second;
    assert.equal(outcomes.length, 2, "every concurrent waiter observes the failure");
    assert.equal(outcomes[0], outcomes[1], "both waiters receive the same cleanup failure");
    assert.match(String((outcomes[0] as AggregateError).errors[0]), /controlled shared release failure/u);
    await stack.release();
    assert.equal(runs, 2, "the failed callback stays owned and the retry reruns it");
  });

  test("owning a release during an in-flight cleanup fails closed", async () => {
    const stack = sessionCleanupStack();
    const gate = deferred<void>();
    stack.own(async () => {
      await gate.promise;
    });
    const inFlight = stack.release();
    assert.throws(
      () => stack.own(async () => undefined),
      /cannot own a release after cleanup has started/u,
    );
    gate.resolve();
    await inFlight;
  });

  test("a failed capture dispose retains ownership and a retry completes it", async () => {
    const networkSession = createFakeNetworkSession(NETWORK_PROBE_URL, TRANSPORT_PROBE_URL, { failRemovalTimes: 1 });
    const networkCapture = await armSessionNetworkCapture(
      networkSession.observer,
      networkSession.browser,
      NETWORK_PROBE_URL,
      networkSession.transportProbe,
    );
    await assert.rejects(networkCapture.dispose(), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(String((error as AggregateError).errors[0]), /controlled removal failure/u);
      return true;
    });
    assert.equal(networkSession.registeredHandlerCount(), 1, "a failed dispose leaves the channel owned, not lost");
    assert.equal(networkSession.registeredFetchErrorHandlerCount(), 1);
    await networkCapture.dispose();
    assert.equal(networkSession.registeredHandlerCount(), 0);
    assert.equal(networkSession.registeredFetchErrorHandlerCount(), 0);
    assert.equal(networkSession.events.filter((event) => event === "remove").length, 1);

    const errorSession = createFakeBrowserSession({ failRemovalTimes: 1 });
    const errorCapture = await armSessionErrorCapture(errorSession.script, errorSession.browser);
    await assert.rejects(errorCapture.dispose(), /session capture cleanup failed/u);
    assert.equal(errorSession.registeredHandlerCount(), 1);
    await errorCapture.dispose();
    assert.equal(errorSession.registeredHandlerCount(), 0);
    assert.equal(errorSession.events.filter((event) => event.startsWith("remove:")).length, 1);
  });
});

describe("Qodo Round 6: reentrant release safety", () => {
  test("synchronous callback reentry does not duplicate cleanup", async () => {
    const stack = sessionCleanupStack();
    let firstCalls = 0;
    let reentrantCalls = 0;
    let reentrantError: unknown = null;
    stack.own(async () => {
      firstCalls += 1;
    });
    stack.own(async () => {
      reentrantCalls += 1;
      if (reentrantCalls === 1) {
        stack.release().catch((error: unknown) => {
          reentrantError = error;
        });
      }
    });
    await stack.release();
    assert.equal(firstCalls, 1, "callbacks execute exactly once despite synchronous reentry");
    assert.equal(reentrantCalls, 1);
    assert.match(String(reentrantError), /release cannot be requested from within a cleanup callback/u);
    await stack.release();
    assert.equal(firstCalls, 1, "the released stack stays idempotent");
    assert.equal(reentrantCalls, 1);
  });

  test("a callback that returns a reentrant release fails closed without deadlock", async () => {
    const stack = sessionCleanupStack();
    let survivorCalls = 0;
    let reentrantCalls = 0;
    stack.own(async () => {
      survivorCalls += 1;
    });
    stack.own(() => {
      reentrantCalls += 1;
      if (reentrantCalls === 1) return stack.release();
      return Promise.resolve();
    });
    await assert.rejects(stack.release(), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(
        String((error as AggregateError).errors[0]),
        /release cannot be requested from within a cleanup callback/u,
      );
      return true;
    });
    assert.equal(survivorCalls, 1, "the other callback still ran exactly once");
    assert.equal(reentrantCalls, 1);
    await stack.release();
    assert.equal(reentrantCalls, 2, "the failed callback stays owned and the retry reruns only it");
    assert.equal(survivorCalls, 1, "successful callbacks are not rerun during retry");
    await stack.release();
    assert.equal(reentrantCalls, 2, "a successful final release remains idempotent");
  });

  test("an external concurrent release during callback execution joins the active operation", async () => {
    const stack = sessionCleanupStack();
    const gate = deferred<void>();
    let runs = 0;
    stack.own(async () => {
      runs += 1;
      await gate.promise;
    });
    let firstSettled = false;
    let secondSettled = false;
    const first = stack.release().then(() => {
      firstSettled = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(runs, 1, "the callback is already executing");
    const second = stack.release().then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(runs, 1, "the external caller joins rather than starting a second pass");
    assert.equal(firstSettled || secondSettled, false, "neither caller settles before the cleanup finishes");
    gate.resolve();
    await first;
    await second;
    assert.equal(firstSettled && secondSettled, true);
  });

  test("reentry combined with cleanup failure retains failed ownership for retry", async () => {
    const stack = sessionCleanupStack();
    let stableCalls = 0;
    let faultyCalls = 0;
    let reentrantError: unknown = null;
    stack.own(async () => {
      stableCalls += 1;
    });
    stack.own(async () => {
      faultyCalls += 1;
      if (faultyCalls === 1) {
        stack.release().catch((error: unknown) => {
          reentrantError = error;
        });
        throw new Error("controlled faulty release failure");
      }
    });
    await assert.rejects(stack.release(), (error: unknown) => {
      assert.match(String((error as AggregateError).errors[0]), /controlled faulty release failure/u);
      return true;
    });
    assert.match(String(reentrantError), /within a cleanup callback/u);
    assert.equal(stableCalls, 1);
    await stack.release();
    assert.equal(faultyCalls, 2, "only the failed callback is retried");
    assert.equal(stableCalls, 1, "successful callbacks are not rerun during retry");
  });
});

describe("Qodo Round 7: asynchronous reentry provenance", () => {
  test("asynchronous self-reentry rejects promptly without deadlock or duplication", async () => {
    const stack = sessionCleanupStack();
    let firstCalls = 0;
    let reentrantCalls = 0;
    let reentrantError: unknown = null;
    stack.own(async () => {
      firstCalls += 1;
    });
    stack.own(async () => {
      reentrantCalls += 1;
      await Promise.resolve();
      try {
        await stack.release();
      } catch (error: unknown) {
        reentrantError = error;
      }
    });
    let deadlockTimer!: NodeJS.Timeout;
    const outcome = await Promise.race([
      stack.release().then(() => "released"),
      new Promise<string>((resolveTimeout) => {
        deadlockTimer = setTimeout(() => resolveTimeout("deadlocked"), 2_000);
      }),
    ]);
    clearTimeout(deadlockTimer);
    assert.equal(outcome, "released", "the outer release settles promptly despite async self-reentry");
    assert.match(String(reentrantError), /release cannot be requested from within a cleanup callback/u);
    assert.equal(firstCalls, 1, "no callback executed twice");
    assert.equal(reentrantCalls, 1);
    await stack.release();
    assert.equal(firstCalls, 1, "the released stack stays idempotent");
  });

  test("a propagated async self-reentry failure stays owned and retries to success", async () => {
    const stack = sessionCleanupStack();
    let survivorCalls = 0;
    let reentrantCalls = 0;
    stack.own(async () => {
      survivorCalls += 1;
    });
    stack.own(async () => {
      reentrantCalls += 1;
      if (reentrantCalls === 1) {
        await Promise.resolve();
        await stack.release();
      }
    });
    await assert.rejects(stack.release(), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(
        String((error as AggregateError).errors[0]),
        /release cannot be requested from within a cleanup callback/u,
      );
      return true;
    });
    assert.equal(survivorCalls, 1, "the other callback still ran exactly once");
    await stack.release();
    assert.equal(reentrantCalls, 2, "the failed callback stays owned and the retry reruns only it");
    assert.equal(survivorCalls, 1, "successful callbacks are not rerun during retry");
    await stack.release();
    assert.equal(reentrantCalls, 2, "a successful final release remains idempotent");
  });

  test("provenance clears after callbacks so independent releases stay normal", async () => {
    const stack = sessionCleanupStack();
    let flakyCalls = 0;
    stack.own(async () => {
      flakyCalls += 1;
      await Promise.resolve();
      if (flakyCalls === 1) throw new Error("controlled first-pass failure");
    });
    await assert.rejects(stack.release(), /session capture cleanup failed/u);
    await stack.release();
    assert.equal(flakyCalls, 2, "the independent retry is not misclassified as callback reentry");
    await stack.release();
    assert.equal(flakyCalls, 2);
  });

  test("cleanup activity in one stack does not block releasing another", async () => {
    const inner = sessionCleanupStack();
    let innerReleased = false;
    inner.own(async () => {
      innerReleased = true;
    });
    const outer = sessionCleanupStack();
    let crossOutcome: string | null = null;
    outer.own(async () => {
      await Promise.resolve();
      await inner.release();
      crossOutcome = innerReleased ? "inner released from outer callback" : "inner did not run";
    });
    await outer.release();
    assert.equal(crossOutcome, "inner released from outer callback", "provenance is scoped per stack");
    assert.equal(innerReleased, true);
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
    const winner = initial.hero.candidates.find((item) => item.recommended);
    const proposalAlternative = initial.hero.candidates.find((item) => item.strategy === "modify_proposal");
    assert.ok(winner);
    assert.ok(proposalAlternative);
    assert.deepEqual(winner.changes, [{
      obligationId: "order/best-effort-display",
      optionId: "best-effort-order/reduce-to-8",
      criticality: "best_effort",
      fromQuantity: 10,
      toQuantity: 8,
      serviceLoss: { numerator: 2, denominator: 5 },
    }]);
    assert.deepEqual(winner.rank, {
      protectedObligationViolations: 0,
      criticalityWeightedServiceDegradation: { numerator: 2, denominator: 5 },
      previouslyAcceptedObligationsChanged: 1,
      bottleneckSlack: { numerator: 0, denominator: 1 },
    });
    assert.deepEqual(proposalAlternative.rank.criticalityWeightedServiceDegradation, {
      numerator: 5,
      denominator: 1,
    });
    assert.deepEqual(winner.remainingCapacity, [
      { resourceKey: "agent_work_units", value: 1 },
      { resourceKey: "human_review_decisions", value: 0 },
      { resourceKey: "production_cell_minutes", value: 20 },
    ]);
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
        terminalEvents: terminal.execution.terminalEventCount,
        actuals: terminal.execution.actualFactCount,
        terminal: terminal.execution.terminalStatus,
      },
      {
        acceptance: 1,
        attempt: 1,
        mutation: 1,
        receipt: 1,
        terminalEvents: 1,
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
    assert.deepEqual(
      [...terminal.activity.mcpServers].sort(),
      [...terminal.harness.mcpConfigured].sort(),
      "every configured MCP service is evidenced as reached at terminal",
    );
    const decisionEvidence = terminal.evidenceTimeline.filter((item) => item.kind.startsWith("approval:"));
    assert.equal(decisionEvidence.length, terminal.approvals.length);
    assert.equal(decisionEvidence.some((item) => item.status === "pending"), false);
    assert.equal(
      decisionEvidence.filter((item) => item.title === "Blocked automatically — same denied action").length,
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
    assert.equal(refreshed.execution.terminalEventCount, 1);
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
    assert.equal(replay.execution.terminalEventCount, 1);
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
  readonly failNavigationToProbe?: boolean;
  readonly failRefresh?: boolean;
  readonly failRemoval?: boolean;
  readonly failRemovalTimes?: number;
}): FakeBrowserSession {
  const deliverLoadErrors = options?.deliverLoadErrors ?? true;
  const dropHandlersOnRefresh = options?.dropHandlersOnRefresh ?? false;
  const failNavigationToProbe = options?.failNavigationToProbe ?? false;
  const failRefresh = options?.failRefresh ?? false;
  const failRemoval = options?.failRemoval ?? false;
  let remainingRemovalFailures = options?.failRemovalTimes ?? 0;
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
        if (failRemoval) throw new Error("controlled removal failure");
        if (remainingRemovalFailures > 0) {
          remainingRemovalFailures -= 1;
          throw new Error("controlled removal failure");
        }
        handlers.delete(handlerId);
        events.push(`remove:${String(handlerId)}`);
      },
    },
    browser: {
      get: async (url) => {
        currentUrl = url;
        events.push(url === CONTROLLED_ERROR_PROBE_URL ? "navigate:probe" : `navigate:${url}`);
        if (failNavigationToProbe && url === CONTROLLED_ERROR_PROBE_URL) {
          throw new Error("controlled probe navigation failure");
        }
        deliverProbeLoadError();
      },
      refresh: async () => {
        events.push("refresh");
        if (failRefresh) throw new Error("controlled refresh failure");
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
  readonly transportProbe: SessionTransportProbe;
  readonly events: readonly string[];
  registeredHandlerCount(): number;
  registeredFetchErrorHandlerCount(): number;
  emitFailedResponse(url: string, status: number): number;
  emitTransportFailure(url: string, errorText: string): number;
}

function createFakeNetworkSession(probeUrl: string, transportProbeUrl: string, options?: {
  readonly deliverResponses?: boolean;
  readonly deliverTransportEvents?: boolean;
  readonly registerFetchError?: boolean;
  readonly dropHandlersOnRefresh?: boolean;
  readonly dropFetchErrorHandlersOnRefresh?: boolean;
  readonly failFetchErrorRegistration?: boolean;
  readonly failTransportTriggerOnCall?: number;
  readonly failNavigation?: boolean;
  readonly failRefresh?: boolean;
  readonly failRemoval?: boolean;
  readonly failRemovalTimes?: number;
  readonly rejectWaitMessageMatching?: RegExp;
}): FakeNetworkSession {
  const deliverResponses = options?.deliverResponses ?? true;
  const deliverTransportEvents = options?.deliverTransportEvents ?? true;
  const registerFetchError = options?.registerFetchError ?? true;
  const dropHandlersOnRefresh = options?.dropHandlersOnRefresh ?? false;
  const dropFetchErrorHandlersOnRefresh = options?.dropFetchErrorHandlersOnRefresh ?? false;
  const failFetchErrorRegistration = options?.failFetchErrorRegistration ?? false;
  const failTransportTriggerOnCall = options?.failTransportTriggerOnCall ?? 0;
  const failNavigation = options?.failNavigation ?? false;
  const failRefresh = options?.failRefresh ?? false;
  const failRemoval = options?.failRemoval ?? false;
  const rejectWaitMessageMatching = options?.rejectWaitMessageMatching ?? null;
  let remainingRemovalFailures = options?.failRemovalTimes ?? 0;
  let transportTriggerCalls = 0;
  const events: string[] = [];
  const handlers = new Set<(entry: { url: string; status: number }) => void>();
  const fetchErrorHandlers = new Set<(entry: { url: string; errorText: string }) => void>();
  let currentUrl: string | null = null;
  const deliverToRegisteredHandlers = (url: string, status: number): number => {
    const active = [...handlers];
    for (const handler of active) handler({ url, status });
    return active.length;
  };
  const deliverToFetchErrorHandlers = (url: string, errorText: string): number => {
    const active = [...fetchErrorHandlers];
    for (const handler of active) handler({ url, errorText });
    return active.length;
  };
  const deliverProbeResponse = (): void => {
    if (deliverResponses && currentUrl === probeUrl) deliverToRegisteredHandlers(probeUrl, 404);
  };
  return {
    observer: {
      addFailedResponseHandler: async (callback) => {
        handlers.add(callback);
        events.push("register-response");
      },
      addFetchErrorHandler: async (callback) => {
        if (failFetchErrorRegistration) throw new Error("controlled fetch-error registration failure");
        if (registerFetchError) fetchErrorHandlers.add(callback);
        events.push("register-fetch-error");
      },
      removeNetworkHandlers: async () => {
        if (failRemoval) throw new Error("controlled removal failure");
        if (remainingRemovalFailures > 0) {
          remainingRemovalFailures -= 1;
          throw new Error("controlled removal failure");
        }
        handlers.clear();
        fetchErrorHandlers.clear();
        events.push("remove");
      },
    },
    browser: {
      get: async (url) => {
        currentUrl = url;
        events.push(url === probeUrl ? "navigate:probe" : `navigate:${url}`);
        if (failNavigation && url === probeUrl) throw new Error("controlled probe navigation failure");
        deliverProbeResponse();
      },
      refresh: async () => {
        events.push("refresh");
        if (failRefresh) throw new Error("controlled refresh failure");
        if (dropHandlersOnRefresh) handlers.clear();
        if (dropFetchErrorHandlersOnRefresh) fetchErrorHandlers.clear();
        deliverProbeResponse();
      },
      wait: async (condition, _timeoutMs, message) => {
        if (rejectWaitMessageMatching?.test(message) === true) throw new Error(message);
        for (let turn = 0; turn < 8; turn += 1) {
          if (condition()) return;
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
        throw new Error(message);
      },
    },
    transportProbe: {
      url: transportProbeUrl,
      trigger: async () => {
        transportTriggerCalls += 1;
        events.push("transport-probe");
        if (failTransportTriggerOnCall === transportTriggerCalls) {
          throw new Error("controlled transport trigger failure");
        }
        if (deliverTransportEvents) deliverToFetchErrorHandlers(transportProbeUrl, "NS_ERROR_NET_RESET");
      },
    },
    events,
    registeredHandlerCount: () => handlers.size,
    registeredFetchErrorHandlerCount: () => fetchErrorHandlers.size,
    emitFailedResponse: deliverToRegisteredHandlers,
    emitTransportFailure: deliverToFetchErrorHandlers,
  };
}
