const nodes = Object.fromEntries(
  [
    "connection-dot", "connection-label", "start-button", "reset-button", "mission-id",
    "session-id", "turn-id", "outcome", "approval-panel", "approval-title", "approval-phase",
    "approval-tool", "approval-effect", "approval-mission", "approval-digest", "approval-source",
    "approval-subject", "approval-subject-row", "approval-details", "allow-button", "deny-button",
    "approval-guidance", "decision-announcer", "policy-decision", "capacity-grid", "obligations",
    "proposal", "basis-note", "basis-resolution", "winning-change", "candidate-list", "model-requests",
    "agent-tree", "runtime-chips", "timeline", "verification-pill", "result-metrics",
    "actual-facts", "proof-stages", "readback-note", "challenge-title", "challenge-status",
    "challenge-button", "challenge-summary", "challenge-results", "proof-center-lead",
    "proof-center-status", "proof-direct-result", "proof-direct-note", "proof-winner-result",
    "proof-winner-note", "proof-owner-result", "proof-owner-note", "proof-outcome-result",
    "proof-outcome-note", "proof-control-summary", "proof-decisions", "proof-capacity-summary",
    "proof-capacity-impact", "proof-durable-summary", "proof-durable-proof",
    "proof-technical-evidence", "counterfactual-copy", "harness-state", "harness-provider",
    "harness-session", "harness-turn", "harness-runtime", "harness-mcp", "harness-sandbox",
    "harness-subagents", "harness-gate", "harness-replay-row", "harness-replay",
    "harness-pause", "harness-plain", "chain-mission", "chain-agents", "chain-tools",
    "chain-sandbox", "chain-pause", "chain-resume", "chain-verified", "guided-heading",
    "guided-what", "guided-why", "guided-mechanical", "guided-next", "guided-number-display",
    "guided-number-protected", "guided-number-mutations", "guided-number-mutations-note",
    "trust-recheck", "trust-empty", "trust-rows", "trust-technical-list",
    "evidence-bundle", "evidence-download", "toast", "scenario-select",
    "hero-eyebrow", "hero-title", "hero-lead", "hero-result", "hero-copy",
    "scenario-transition", "basis-context", "proposal-heading", "activity-title",
    "runtime-heading", "guided-story", "harness-ribbon", "agent-trust", "proof-center",
    "challenge-lab",
  ].map((id) => [id, document.getElementById(id)]),
);

let state = null;
let poll = null;
let requestCounter = 0;
let missionMutationInFlight = false;
let approvalMutationInFlight = null;
let challengeMutationInFlight = false;
let responseGeneration = 1;
let responseSequence = 0;
let latestAppliedSequence = 0;
let lastApprovalIdentity = null;
let timelinePinned = true;
let reattachedTerminal = false;
let toastTimer = null;
const navigationWasReload = typeof performance !== "undefined" &&
  performance.getEntriesByType?.("navigation")?.[0]?.type === "reload";

const resourcePresentation = {
  agent_work_units: ["Agent work", "Planning and orchestration effort"],
  human_review_decisions: ["Human decisions", "Explicit human approval capacity"],
  production_cell_minutes: ["Production cell", "Scheduled factory execution time"],
};

const originalHeroPresentation = {
  unresolvedBasis: "The original rush basis needs the safest workable plan (a bounded replan) before any promise can be accepted.",
  resolvedBasis: "Resolved through the safest workable plan (a bounded replan): the original over-capacity basis remains visible for audit, while the accepted alternative is verified.",
  alternativeGuidance: "Recommended: Approve — 09:40–10:10 starts after the protected interval and fits the bound grant.",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function assignPreservingDisclosure(node, html) {
  const openStates = Array.from(node.querySelectorAll?.("details") ?? [], (item) => item.open);
  node.innerHTML = html;
  Array.from(node.querySelectorAll?.("details") ?? []).forEach((item, index) => {
    if (openStates[index] === true) item.open = true;
  });
}

function shortIdentity(value) {
  if (!value) return "Not started";
  return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-9)}` : value;
}

function requestId(prefix) {
  requestCounter += 1;
  return `judge-${prefix}-${Date.now()}-${requestCounter}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || "Request failed safely");
  return body;
}

async function refresh() {
  const token = responseToken("poll");
  try {
    const candidate = await api("/api/state");
    const applied = applyState(candidate, token);
    if (!isCurrentResponse(token)) return;
    nodes["connection-dot"].classList.add("connected");
    if (!applied && state !== null) renderHeader();
  } catch (error) {
    if (!isCurrentResponse(token)) return;
    invalidateResponses();
    nodes["connection-dot"].classList.remove("connected");
    nodes["connection-label"].textContent = "Reconnecting…";
    showError(error instanceof Error ? error.message : "State refresh failed safely");
  }
}

async function mutate(path, body) {
  const approvalIdentity = path === "/api/approval" ? body.actionIdentity : null;
  if (approvalIdentity !== null) {
    if (approvalMutationInFlight === approvalIdentity) return;
    approvalMutationInFlight = approvalIdentity;
  } else if (path === "/api/challenge") {
    if (challengeMutationInFlight) return;
    challengeMutationInFlight = true;
  } else {
    if (missionMutationInFlight) return;
    missionMutationInFlight = true;
  }
  invalidateResponses();
  const intent = path === "/api/mission"
    ? body.operation === "reset" ? "mission_reset" : "mission_start"
    : path === "/api/scenario" ? "scenario_switch"
      : path === "/api/challenge" ? "challenge_run" : "approval";
  const token = responseToken(intent);
  render();
  try {
    const response = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    applyState(response.state, token);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Request failed safely");
    await refresh();
  } finally {
    if (approvalIdentity !== null) approvalMutationInFlight = null;
    else if (path === "/api/challenge") challengeMutationInFlight = false;
    else missionMutationInFlight = false;
    render();
  }
}

function responseToken(intent) {
  responseSequence += 1;
  return {
    generation: responseGeneration,
    sequence: responseSequence,
    intent,
    sourceRevision: state?.revision ?? null,
    sourceRunGeneration: state?.run.generation ?? null,
    sourceMissionId: state?.mission.missionId ?? null,
    sourceSessionId: state?.mission.sessionId ?? null,
    sourceScenarioId: state?.scenario.scenarioId ?? null,
  };
}

function invalidateResponses() {
  responseGeneration += 1;
  latestAppliedSequence = 0;
}

function isCurrentResponse(token) {
  return token.generation === responseGeneration && token.sequence >= latestAppliedSequence;
}

function applyState(candidate, token) {
  if (!isCurrentResponse(token)) return false;
  if (state === null && candidate.run.status === "verified" &&
    (candidate.run.connection === "replayed" || navigationWasReload)) {
    reattachedTerminal = true;
  }
  if (state !== null) {
    if (candidate.run.generation < state.run.generation) return false;
    if (candidate.run.generation === state.run.generation && candidate.revision < state.revision) return false;
    const newerDurableGeneration =
      candidate.run.generation > state.run.generation && candidate.revision > state.revision;
    const explicitScenarioSwitch =
      token.intent === "scenario_switch" &&
      token.sourceRevision === state.revision &&
      token.sourceRunGeneration === state.run.generation &&
      token.sourceScenarioId === state.scenario.scenarioId &&
      newerDurableGeneration;
    if (candidate.scenario.scenarioId !== state.scenario.scenarioId && !explicitScenarioSwitch) return false;
    if (candidate.mission.missionId !== state.mission.missionId && !explicitScenarioSwitch) return false;
    const tokenMatchesCurrentFailure =
      token.intent === "mission_start" && token.sourceRevision === state.revision &&
      token.sourceRunGeneration === state.run.generation &&
      token.sourceMissionId === state.mission.missionId &&
      token.sourceSessionId === state.mission.sessionId;
    const recoverySessionMatches =
      state.mission.sessionId === null || candidate.mission.sessionId === state.mission.sessionId;
    const explicitRecovery =
      state.run.status === "failed" && tokenMatchesCurrentFailure &&
      newerDurableGeneration && recoverySessionMatches;
    const explicitReset =
      token.intent === "mission_reset" && token.sourceRevision === state.revision &&
      token.sourceRunGeneration === state.run.generation &&
      token.sourceMissionId === state.mission.missionId && newerDurableGeneration;
    if (state.run.status === "verified" && candidate.run.status !== "verified" && !explicitReset && !explicitScenarioSwitch) return false;
    if (state.run.status === "failed" && candidate.run.status !== "failed" && !explicitRecovery && !explicitReset && !explicitScenarioSwitch) return false;
    if (state.challengeLab.status === "complete" && candidate.challengeLab.status !== "complete" && !explicitScenarioSwitch) return false;
    if (state.challengeLab.status === "failed" && candidate.challengeLab.status !== "failed" && !explicitScenarioSwitch) return false;
    if (state.mission.sessionId !== null && candidate.mission.sessionId !== null &&
      candidate.mission.sessionId !== state.mission.sessionId && !explicitReset && !explicitScenarioSwitch) return false;
    if (candidate.run.generation === state.run.generation && candidate.revision === state.revision) {
      latestAppliedSequence = token.sequence;
      return false;
    }
  }
  if (candidate.run.status !== "verified") reattachedTerminal = false;
  latestAppliedSequence = token.sequence;
  state = candidate;
  render();
  return true;
}

function render() {
  if (!state) return;
  const capacityShock = state.scenario.scenarioId === "capacity-shock";
  renderHeader();
  for (const id of ["guided-story", "harness-ribbon", "agent-trust", "proof-center", "challenge-lab"]) {
    nodes[id].hidden = capacityShock;
  }
  if (capacityShock) {
    nodes["hero-title"].setAttribute?.("role", "heading");
    nodes["hero-title"].setAttribute?.("aria-level", "1");
  } else {
    nodes["hero-title"].removeAttribute?.("role");
    nodes["hero-title"].removeAttribute?.("aria-level");
    renderGuidedStory();
    renderAgentTrust();
    renderHarness();
    renderProofCenter();
  }
  renderApproval();
  renderHero();
  renderActivity();
  renderTimeline();
  renderExecution();
  if (!capacityShock) renderChallengeLab();
}

const trustResultPresentation = {
  recorded: ["Recommendation recorded", "pill-neutral"],
  allowed: ["Allowed", "pill-approved"],
  blocked: ["Blocked", "pill-denied"],
  pending_verification: ["Pending verification", "pill-pending"],
  verified: ["Verified result", "pill-verified"],
};

function renderAgentTrust() {
  const trust = state.agentTrust ?? { recommendationsRecorded: false, checks: [] };
  nodes["trust-recheck"].hidden = !trust.recommendationsRecorded;
  nodes["trust-empty"].hidden = trust.checks.length > 0;
  nodes["trust-rows"].innerHTML = trust.checks
    .map((check) => {
      const [label, pill] = trustResultPresentation[check.result] ?? ["Recorded", "pill-neutral"];
      const checkPrefix = check.kind === "recommendation" ? "Provenance" : "Authoritative effect check";
      return `<li><div class="trust-row-head"><strong>${escapeHtml(check.source)}</strong><span class="pill ${pill}">${label}</span></div><p class="trust-claim">${escapeHtml(check.claim)}</p><p class="trust-check">${checkPrefix}: ${escapeHtml(check.check)}</p><small class="trust-why">${escapeHtml(check.why)}</small></li>`;
    })
    .join("");
  nodes["trust-technical-list"].innerHTML = trust.checks
    .filter((check) => check.technicalEvidence !== null)
    .map((check) => `<li><span>${escapeHtml(check.source)}</span><code>${escapeHtml(check.technicalEvidence)}</code></li>`)
    .join("");
}

// Single presentation classifier over authoritative durable facts. Precedence:
// verified > mutation-pending-verification > failed-without-mutation >
// approval-pending > running > idle. A committed mutation therefore always
// outranks a stopped run, so failure copy can never hide durable effects.
function classifyMissionPhase() {
  if (state.run.status === "verified") return "verified";
  if (state.execution.mutationCount > 0) return "mutation_pending";
  if (state.run.status === "failed") return "failed";
  if (state.pendingApproval !== null) return "approval_pending";
  if (state.run.status === "idle") return "idle";
  return "running";
}

// The only verified-success discriminant: the durable reservation reached
// exactly terminal_verified. terminal_* alone includes reconciled and failed
// terminals and must never be presented as verified completion.
function verifiedCompletionEvidence() {
  return state.execution.terminalStatus === "terminal_verified";
}

function renderGuidedStory() {
  const winner = state.hero.winningModification;
  const protectedObligation = state.hero.obligations.find((item) => item.protected);
  const shortBy = new Map(state.hero.capacity.map((item) => [item.resourceKey, Math.max(0, -item.remainingCapacity)]));
  const agentShort = shortBy.get("agent_work_units") ?? 0;
  const humanShort = shortBy.get("human_review_decisions") ?? 0;
  const mechanical = state.approvals.some((item) => item.source === "active_m2_denial");
  const verified = state.run.status === "verified";
  const replayEvidence = state.mission.disconnectedAndResumed || state.run.connection === "replayed" ||
    (verified && reattachedTerminal);
  const pending = state.pendingApproval;
  const saferPlan = `FlakeBrake found a safer plan: reduce the lower-priority display order from ${winner.fromQuantity} to ${winner.toQuantity}, while the protected medical order and the rush-order quantity stay unchanged.`;
  const doesNotFit = `This rush order doesn’t fit yet: it needs ${agentShort} more agent-work units and ${humanShort} more human decision${humanShort === 1 ? "" : "s"} than are currently available — production minutes alone are not the only constraint.`;
  const phase = classifyMissionPhase();
  let heading;
  let what;
  let why;
  let next;
  if (phase === "verified") {
    heading = "Done—and independently verified";
    what = `The lower-priority display order changed ${winner.fromQuantity} → ${winner.toQuantity}; the protected medical and rush work stayed intact; exactly one factory mutation occurred and was independently read back.`;
    why = replayEvidence
      ? "You are viewing the same completed TrueForge session — no decisions, owner calls, or factory effects were repeated."
      : "Refresh or restart will not repeat owner decisions or factory effects.";
    next = "Open the proofs below for the exact evidence, or reset to run it again.";
  } else if (phase === "mutation_pending") {
    const stopped = state.run.status === "failed";
    heading = "The change is recorded—but it is not verified yet";
    what = stopped
      ? "The run stopped before independent verification completed — one factory change was already recorded durably."
      : "One authorized factory change and its receipt are saved durably.";
    why = stopped
      ? "A recorded change is not success. No further change happened, and nothing is presented as complete until FlakeBrake verifies the recorded one independently."
      : "A recorded change is not success — FlakeBrake is independently reading the factory state back before declaring it.";
    next = stopped
      ? "Choose Resume safely to continue the same mission and finish verification."
      : "No action needed — verification runs automatically.";
  } else if (phase === "failed") {
    heading = "The mission stopped safely";
    what = "A controlled problem stopped the run before any unsafe effect.";
    why = "No consequential change was recorded, and every decision so far is saved durably.";
    next = "Choose Resume safely to continue the same mission.";
  } else if (pending && pending.toolName === "select_portfolio_modification") {
    heading = "Your approval is required";
    what = `Approving changes the lower-priority display order from ${winner.fromQuantity} to ${winner.toQuantity} — nothing else.`;
    why = "The protected medical order and the rush-order quantity remain exactly as they are.";
    next = "Approve action is the recommended choice; Deny action keeps the schedule unchanged.";
  } else if (pending && pending.toolName === "accept_promise") {
    heading = "Your approval is required";
    what = "Capacity was recalculated after the approved change — the revised promise now fits.";
    why = "Nothing executes until you explicitly accept this recalculated promise.";
    next = "Approve action accepts the revised promise; Deny action stops here safely.";
  } else if (pending && pending.recommendedDecision === "deny") {
    heading = "This time slot conflicts with protected work";
    what = "The requested 09:10–09:40 slot overlaps time already committed to the protected medical order.";
    why = "Approving would put protected work at risk — the aggregate minutes fit, but this specific time does not.";
    next = "Deny action is the recommended choice — a safe alternative comes next.";
  } else if (pending) {
    heading = "A safe time slot is available";
    what = "The 09:40–10:10 slot starts after the protected commitment ends and fits the approved grant.";
    why = "Approving authorizes exactly one factory reservation in that slot — nothing else.";
    next = "Approve action authorizes the safe reservation.";
  } else if (state.run.status === "idle") {
    heading = "A rush order is waiting";
    what = "A rush aerospace order wants space in the factory schedule. FlakeBrake will check whether it fits without disrupting protected work.";
    why = `${doesNotFit} ${saferPlan}`;
    next = "Start the mission to watch FlakeBrake negotiate it safely.";
  } else if (mechanical) {
    heading = "The same unsafe request was blocked automatically";
    what = "The denied action was submitted again in another technical representation, and FlakeBrake recognized it as the same effect.";
    why = "No additional owner decision was used — the active denial did the work.";
    next = "A safe alternative is being prepared.";
  } else {
    heading = "FlakeBrake found a safer plan";
    what = saferPlan;
    why = doesNotFit;
    next = "TrueForge is working — your next decision will appear here.";
  }
  nodes["guided-heading"].textContent = heading;
  nodes["guided-what"].textContent = what;
  nodes["guided-why"].textContent = why;
  nodes["guided-next"].textContent = next;
  const mechanicalVisible = Boolean(mechanical) && !verified;
  nodes["guided-mechanical"].hidden = !mechanicalVisible;
  if (mechanicalVisible) {
    nodes["guided-mechanical"].textContent =
      "The same unsafe request was blocked automatically — FlakeBrake recognized the denied action in another technical representation, and no additional owner decision was used.";
  }
  nodes["guided-number-display"].textContent = `${winner.fromQuantity} → ${winner.toQuantity}`;
  nodes["guided-number-protected"].textContent = String(protectedObligation?.quantity ?? "—");
  nodes["guided-number-mutations"].textContent = String(state.execution.mutationCount);
  nodes["guided-number-mutations-note"].textContent = verified && verifiedCompletionEvidence()
    ? "verified"
    : state.execution.mutationCount > 0
      ? state.run.status === "failed" ? "recorded — not verified" : "recorded — verifying"
      : "none yet";
}

function renderHarness() {
  const harness = state.harness;
  const stateLabels = {
    idle: "Ready",
    running: "Running",
    awaiting_approval: "Paused for human",
    verifying: "Running",
    verified: "Verified",
    failed: "Failed",
    closed: "Closed",
  };
  const active = ["running", "awaiting_approval", "verifying"].includes(state.run.status);
  nodes["harness-state"].textContent = stateLabels[state.run.status] ?? "Ready";
  nodes["harness-state"].className = `pill harness-state ${state.run.status === "verified" ? "pill-verified" : state.run.status === "failed" ? "pill-denied" : active ? "pill-pending" : "pill-neutral"}`;
  nodes["harness-provider"].textContent = harness.providerProfile;
  nodes["harness-session"].textContent = state.mission.sessionId ?? "Not started";
  nodes["harness-turn"].textContent = state.mission.currentTurnId ?? "—";
  nodes["harness-runtime"].textContent = `TrueForge ${harness.serverVersion} · SDK ${harness.sdkVersion}`;
  const reachedServices = state.activity.mcpServers.length;
  nodes["harness-mcp"].textContent = reachedServices > 0
    ? `${reachedServices}/${harness.mcpConfigured.length} services reached`
    : `${harness.mcpConfigured.length} services configured`;
  nodes["harness-sandbox"].textContent = state.activity.sandboxExecutions > 0
    ? `${state.activity.sandboxExecutions} executed`
    : harness.sandboxConfigured ? "Configured" : "—";
  nodes["harness-subagents"].textContent = state.activity.subagents.length > 0
    ? `${state.activity.subagents.length} threads evidenced`
    : harness.dynamicSubagentsConfigured ? "Dynamic · configured" : "—";
  nodes["harness-gate"].textContent = state.pendingApproval
    ? "Holding this turn"
    : state.run.ownerCallsThisProcess > 0
      ? `Native · ${state.run.ownerCallsThisProcess} owner call${state.run.ownerCallsThisProcess === 1 ? "" : "s"}`
      : `Native · ${harness.approvalGatedToolCount} gated tool${harness.approvalGatedToolCount === 1 ? "" : "s"}`;
  const replayEvidence = state.mission.disconnectedAndResumed || state.run.connection === "replayed" ||
    (state.run.status === "verified" && reattachedTerminal);
  nodes["harness-replay-row"].hidden = !replayEvidence;
  nodes["harness-replay"].textContent = !replayEvidence
    ? "—"
    : state.mission.disconnectedAndResumed ? "Durable session replayed" : "Reconnected to durable session";
  nodes["harness-pause"].hidden = state.pendingApproval === null;

  const subagentEvidence = state.activity.subagents.length;
  const sandboxEvidence = state.activity.sandboxExecutions;
  const missionObserved = state.run.status !== "idle";
  const verifiedNow = state.run.status === "verified";
  const setChain = (id, status) => {
    nodes[id].textContent = status;
    nodes[id].className = `chain-${status === "Verified" ? "verified" : status === "Observed" ? "observed" : status === "Configured" ? "configured" : "waiting"}`;
  };
  // Station evidence is durable/authoritative only: approval-bridge records
  // prove factory-change-control tool use and human pauses across restarts,
  // and the TrueForge sandbox checkpoint proves sandbox use mid-run. The
  // process-local owner-call counter and elapsed UI state promote nothing.
  const durablePauseEvidence = state.pendingApproval !== null || state.safety.ownerCallCount > 0;
  const factoryToolEvidence =
    reachedServices > 0 || state.approvals.length > 0 || state.pendingApproval !== null;
  const sandboxObserved =
    sandboxEvidence > 0 || state.evidenceTimeline.some((item) => item.kind === "sandbox");
  setChain("chain-mission", verifiedNow ? "Verified" : missionObserved ? "Observed" : "Configured");
  setChain("chain-agents", subagentEvidence > 0 ? "Observed" : "Configured");
  setChain("chain-tools", factoryToolEvidence ? "Observed" : "Configured");
  setChain("chain-sandbox", sandboxObserved ? "Observed" : "Configured");
  setChain("chain-pause", durablePauseEvidence ? "Observed" : "Configured");
  setChain("chain-resume", replayEvidence ? "Observed" : "Configured");
  setChain("chain-verified", verifiedNow ? "Verified" : "—");
  if (verifiedNow) {
    nodes["harness-plain"].textContent = replayEvidence
      ? "TrueForge coordinated 3 specialist agents, connected 4 factory tools, ran a sandbox check, paused for your decisions, and resumed the same durable session."
      : "TrueForge coordinated 3 specialist agents, connected 4 factory tools, ran a sandbox check, paused for your decisions, and kept one durable session.";
  } else if (!missionObserved) {
    nodes["harness-plain"].textContent = "TrueForge is ready to coordinate specialist agents, connect 4 factory tools, run a sandbox check, and pause for your decisions.";
  } else {
    const clauses = [
      subagentEvidence > 0 ? `${subagentEvidence} specialist agents observed` : "coordinating specialist agents",
      reachedServices > 0 ? `${reachedServices}/4 factory tools reached` : "connecting 4 factory tools",
      sandboxEvidence > 0 ? "sandbox check executed" : "sandbox check ready",
      state.pendingApproval !== null ? "paused for your decision" : "pausing for your decisions when needed",
    ];
    nodes["harness-plain"].textContent = `TrueForge is running the mission: ${clauses.join(", ")}.`;
  }
}

function rationalText(value) {
  if (!value) return "—";
  return value.denominator === 1 ? String(value.numerator) : `${value.numerator}/${value.denominator}`;
}

function actionLabel(toolName) {
  const labels = {
    select_portfolio_modification: "Select the exact portfolio modification",
    accept_promise: "Accept the fresh capacity-safe promise",
    create_schedule_reservation: "Create the bound schedule reservation",
    submit_schedule_change: "Submit the alternate schedule representation",
  };
  return labels[toolName] ?? toolName.replaceAll("_", " ");
}

function renderProofCenter() {
  const winner = state.hero.winningModification;
  const winnerCandidate = state.hero.candidates.find((item) => item.candidatePlanId === winner.candidatePlanId);
  const winnerObligation = state.hero.obligations.find((item) => item.obligationId === winner.obligationId);
  const winnerObjective = winnerObligation?.objective ?? winner.obligationId;
  const directViolations = state.hero.capacity.filter((item) => item.remainingCapacity < 0);
  const ownerDecisions = state.approvals.filter((item) => item.source === "owner");
  const ownerAllowed = ownerDecisions.filter((item) => item.decision === "allow");
  const ownerDenied = ownerDecisions.filter((item) => item.decision === "deny");
  const mechanicalDenials = state.approvals.filter((item) => item.source === "active_m2_denial");
  const verified = state.execution.terminalStatus === "terminal_verified" && state.execution.independentReadBackObserved;
  const replayed = verified &&
    (state.run.connection === "replayed" || state.mission.disconnectedAndResumed || reattachedTerminal);

  nodes["proof-center-status"].className = `pill ${verified ? "pill-verified" : state.execution.mutationCount > 0 ? "pill-pending" : "pill-neutral"}`;
  nodes["proof-center-status"].textContent = verified ? "Verified record" : state.execution.mutationCount > 0 ? "Read-back pending" : "Canonical basis";
  nodes["proof-center-lead"].textContent = verified
    ? `The direct promise stayed blocked, the bounded ${winner.fromQuantity}→${winner.toQuantity} change to “${winnerObjective}” was authorized, and exactly ${state.execution.mutationCount} factory mutation was independently verified.`
    : `The direct rush plan is blocked on ${directViolations.length} finite capacity limits. The safe basis changes “${winnerObjective}” from ${winner.fromQuantity} to ${winner.toQuantity} and leaves protected work unchanged.`;

  nodes["proof-direct-result"].textContent =
    state.hero.directDecision === "REPLAN" ? "Doesn’t fit yet" : state.hero.directDecision;
  nodes["proof-direct-note"].textContent = directViolations.map((item) => `${item.label} over by ${Math.abs(item.remainingCapacity)}`).join(" · ");
  nodes["proof-winner-result"].textContent = `${winner.fromQuantity} → ${winner.toQuantity}`;
  nodes["proof-winner-note"].textContent = `${winnerObjective} · protected work ${state.hero.protectedWorkUnchanged ? "unchanged" : "changed"}`;
  nodes["proof-owner-result"].textContent = ownerDecisions.length
    ? `${ownerAllowed.length} allowed · ${ownerDenied.length} denied`
    : state.pendingApproval ? "Decision required" : "0 recorded";
  nodes["proof-owner-note"].textContent = mechanicalDenials.length
    ? `${mechanicalDenials.length} equivalent action mechanically blocked`
    : state.pendingApproval ? actionLabel(state.pendingApproval.toolName) : "Exact action ledger populates during the mission";
  nodes["proof-outcome-result"].textContent = verified
    ? `${state.execution.mutationCount} mutation · verified`
    : state.execution.mutationCount > 0 ? `${state.execution.mutationCount} mutation · not yet success` : "No factory effect";
  nodes["proof-outcome-note"].textContent = `${state.execution.receiptCount} receipt · ${state.execution.terminalEventCount} ${verifiedCompletionEvidence() ? "verified completion" : "terminal event"} · ${state.execution.actualFactCount} measured facts`;

  renderProofDecisions(ownerDecisions, mechanicalDenials);
  renderProofCapacity(winnerCandidate, directViolations);
  renderDurableProof(verified, replayed);
  renderTechnicalProof(winnerCandidate);
  renderCounterfactual(ownerDenied, mechanicalDenials, verified);
}

function renderProofDecisions(ownerDecisions, mechanicalDenials) {
  const pending = state.pendingApproval;
  nodes["proof-control-summary"].textContent = `${ownerDecisions.length} owner decision${ownerDecisions.length === 1 ? "" : "s"} · ${mechanicalDenials.length} mechanical block${mechanicalDenials.length === 1 ? "" : "s"}`;
  const recorded = ownerDecisions.map((item, index) => `<article class="proof-decision ${escapeHtml(item.decision)}"><span class="decision-index">${index + 1}</span><div><p>${item.decision === "allow" ? "Owner allowed" : "Owner denied"}</p><strong>${escapeHtml(actionLabel(item.toolName))}</strong><span>${escapeHtml(item.effect)}</span>${item.decision === "deny" ? `<small>Reason: ${escapeHtml(item.reason)}</small>` : ""}<details><summary>Exact action identity</summary><code>${escapeHtml(item.actionIdentity)}</code></details></div><span class="pill ${item.decision === "allow" ? "pill-approved" : "pill-denied"}">${escapeHtml(item.decision)}</span></article>`).join("");
  const waiting = pending && !ownerDecisions.some((item) => item.actionIdentity === pending.actionIdentity)
    ? `<article class="proof-decision pending"><span class="decision-index">${ownerDecisions.length + 1}</span><div><p>Owner decision required now</p><strong>${escapeHtml(actionLabel(pending.toolName))}</strong><span>${escapeHtml(pending.expectedEffect)}</span><details><summary>Exact action identity</summary><code>${escapeHtml(pending.actionIdentity)}</code></details></div><span class="pill pill-pending">pending</span></article>`
    : "";
  const mechanical = mechanicalDenials.map((item) => `<article class="mechanical-proof"><span aria-hidden="true">↳</span><div><p>Mechanically blocked · no owner decision</p><strong>${escapeHtml(actionLabel(item.toolName))}</strong><span>${escapeHtml(item.effect)}. The active denial bound the equivalent representation without another owner call.</span><code>${escapeHtml(item.actionIdentity)}</code></div></article>`).join("");
  assignPreservingDisclosure(nodes["proof-decisions"], recorded + waiting + mechanical || `<p class="proof-empty">No owner action has been presented yet. Start the mission to populate the exact allow/deny ledger.</p>`);
}

function renderProofCapacity(winnerCandidate, directViolations) {
  const safeRemaining = new Map((winnerCandidate?.remainingCapacity ?? []).map((item) => [item.resourceKey, item.value]));
  nodes["proof-capacity-summary"].textContent = directViolations.map((item) => `${item.label} −${Math.abs(item.remainingCapacity)}`).join(" · ");
  const rows = state.hero.capacity.map((item) => {
    const beforeRush = item.declaredCapacity - item.existingUse;
    const overBy = Math.max(0, -item.remainingCapacity);
    const safeAfter = safeRemaining.get(item.resourceKey);
    return `<div class="proof-capacity-row" role="row"><strong role="cell">${escapeHtml(item.label)}</strong><span role="cell"><small>Before rush</small>${beforeRush}</span><span role="cell"><small>Direct plan</small><b class="${item.remainingCapacity < 0 ? "tone-denied" : "tone-neutral"}">${item.remainingCapacity}</b></span><span role="cell"><small>Over limit</small>${overBy || "—"}</span><span role="cell"><small>Safe winner</small><b class="tone-verified">${safeAfter ?? "—"}</b></span></div>`;
  }).join("");
  const alternative = state.hero.candidates.find((item) => item.strategy === "modify_proposal");
  const allProtect = state.hero.candidates.every((item) => item.rank.protectedObligationViolations === 0);
  const rankReason = winnerCandidate && alternative
    ? `<div class="rank-explanation"><p class="eyebrow">Why this wins lexicographically</p><p>${allProtect ? "Every feasible candidate preserves all protected obligations." : "Protected-obligation preservation differs between candidates."} The first differentiating coordinate is exact criticality-weighted service degradation: <strong>${rationalText(winnerCandidate.rank.criticalityWeightedServiceDegradation)}</strong> for the best-effort display change versus <strong>${rationalText(alternative.rank.criticalityWeightedServiceDegradation)}</strong> for reducing the important rush order. That criterion is evaluated before existing promises changed (${winnerCandidate.rank.previouslyAcceptedObligationsChanged} versus ${alternative.rank.previouslyAcceptedObligationsChanged}).</p></div>`
    : "";
  nodes["proof-capacity-impact"].innerHTML = `<p class="proof-explanation">The direct basis requests more agent work and owner-decision capacity than declared. Production remains within its aggregate limit; the separate interval conflict is enforced at the owner boundary.</p><div class="proof-capacity-table" role="table" aria-label="Remaining capacity before the rush order, under the direct plan, and after the safe winner"><div class="proof-capacity-header" role="row"><span role="columnheader">Resource</span><span role="columnheader">Before rush</span><span role="columnheader">Direct plan</span><span role="columnheader">Over limit</span><span role="columnheader">Safe winner</span></div>${rows}</div>${rankReason}`;
}

function renderDurableProof(verified, replayed) {
  const result = state.execution;
  nodes["proof-durable-summary"].textContent = verified
    ? `${result.mutationCount} mutation · ${result.receiptCount} receipt · ${result.terminalEventCount} ${verifiedCompletionEvidence() ? "verified completion" : "terminal event"} · ${result.actualFactCount} measured facts`
    : result.receiptCount > 0 ? "Receipt present · independent verification still required" : "Mutation is not verified success";
  const readBackStatus = result.independentReadBackObserved ? "Observed before terminal completion" : "Not yet observed";
  const terminalStatus = result.terminalStatus === "terminal_verified" ? "terminal_verified recorded" : "Not recorded";
  const replayCopy = verified
    ? `${replayed ? "This browser is attached to a durable replay." : "The verified projection is durable across refresh and restart."} This process made ${state.run.ownerCallsThisProcess} owner call${state.run.ownerCallsThisProcess === 1 ? "" : "s"}; the durable effect count remains ${result.mutationCount}.`
    : "Refresh and recovery read the same durable records; neither may turn a receipt into success or repeat an effect.";
  nodes["proof-durable-proof"].innerHTML = `<div class="proof-counts"><div><strong>${result.mutationCount}</strong><span>Mutation</span></div><div><strong>${result.receiptCount}</strong><span>Receipt</span></div><div><strong>${result.terminalEventCount}</strong><span>${verifiedCompletionEvidence() ? "Verified completion" : "Terminal event"}</span></div><div><strong>${result.actualFactCount}</strong><span>Measured facts</span></div></div><ol class="durable-chain"><li class="${result.receiptCount ? "complete" : "waiting"}"><span>1</span><div><strong>Mutation receipt</strong><p>A receipt proves the fenced factory command committed. By itself, it is not verified success.</p></div></li><li class="${result.independentReadBackObserved ? "complete" : result.receiptCount ? "active" : "waiting"}"><span>2</span><div><strong>Independent read-back</strong><p>${readBackStatus}${result.approvedInterval ? ` · ${escapeHtml(formatFriendlyInterval(result.approvedInterval))}` : ""}</p></div></li><li class="${verified ? "complete" : "waiting"}"><span>3</span><div><strong>Verified completion</strong><p>${terminalStatus}. Only this state is presented as success.</p></div></li></ol><p class="replay-proof">${escapeHtml(replayCopy)}</p>`;
}

function renderTechnicalProof(winnerCandidate) {
  const candidateRows = state.hero.candidates.map((item) => `<div class="technical-candidate"><strong>${item.recommended ? "Winner" : "Candidate"} · ${escapeHtml(item.strategy)}</strong><code>${escapeHtml(item.candidatePlanId)}</code><span>protected violations ${item.rank.protectedObligationViolations} · weighted degradation ${rationalText(item.rank.criticalityWeightedServiceDegradation)} · accepted obligations changed ${item.rank.previouslyAcceptedObligationsChanged} · bottleneck slack ${rationalText(item.rank.bottleneckSlack)} · owner approvals required ${item.requiredOwnerApprovalCount}</span></div>`).join("");
  const identities = [
    ["Portfolio version", state.hero.portfolioVersion],
    ["Selected plan", winnerCandidate?.candidatePlanId ?? null],
    ["Execution attempt", state.execution.attemptId],
    ["Mutation receipt", state.execution.receiptId],
    ["Terminal projection", state.mission.terminalProjectionDigest],
  ];
  nodes["proof-technical-evidence"].innerHTML = `<dl class="technical-proof-grid">${identities.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "Not recorded")}</dd></div>`).join("")}</dl><div class="technical-candidates">${candidateRows}</div>`;
}

function renderCounterfactual(ownerDenied, mechanicalDenials, verified) {
  const overages = state.hero.capacity.filter((item) => item.remainingCapacity < 0).map((item) => `${item.label} by ${Math.abs(item.remainingCapacity)}`);
  let copy = `Accepting the direct basis would exceed ${overages.join(" and ")}. The selected replan keeps the protected medical order at quantity 10 and changes the best-effort display order from 10 to 8.`;
  if (ownerDenied.length && mechanicalDenials.length) {
    copy += verified
      ? ` The denied 09:10–09:40 interval and its equivalent alternate representation did not become the factory result; the only mutation is the approved ${formatFriendlyInterval(state.execution.approvedInterval)} interval.`
      : " The denied 09:10–09:40 interval and its equivalent alternate representation remain blocked without a second owner decision.";
  }
  nodes["counterfactual-copy"].textContent = copy;
}

function renderHeader() {
  const running = ["running", "awaiting_approval", "verifying"].includes(state.run.status);
  const durableReplay = state.run.status === "verified" &&
    reattachedTerminal;
  const labels = {
    idle: "Ready on loopback", connected: "Mission connected", awaiting_owner: "Waiting for owner",
    replayed: "Durable replay restored", closed: "Server closed",
  };
  nodes["connection-label"].textContent = durableReplay
    ? "Durable replay restored"
    : state.run.status === "verified"
      ? "Mission complete"
      : labels[state.run.connection] || "Mission connected";
  nodes["mission-id"].textContent = shortIdentity(state.mission.missionId);
  nodes["session-id"].textContent = shortIdentity(state.mission.sessionId);
  nodes["turn-id"].textContent = state.mission.currentTurnId ?? "Not started";
  const outcomeLabels = {
    idle: "Waiting", running: "Orchestrating", awaiting_approval: "Owner decision", verifying: "Verifying",
    verified: "Verified success", failed: "Stopped safely", closed: "Closed",
  };
  nodes.outcome.textContent = outcomeLabels[state.run.status];
  nodes.outcome.className = state.run.status === "verified" ? "tone-verified" :
    state.run.status === "failed" ? "tone-denied" : running ? "tone-pending" : "tone-neutral";
  nodes["scenario-select"].value = state.scenario.scenarioId;
  nodes["scenario-select"].disabled = missionMutationInFlight || !state.scenario.selectorEnabled;
  nodes["hero-eyebrow"].textContent = state.scenario.eyebrow;
  nodes["hero-lead"].textContent = state.scenario.headlineLead;
  nodes["hero-result"].textContent = state.scenario.headlineResult;
  nodes["hero-copy"].textContent = state.scenario.summary;
  nodes["scenario-transition"].hidden = state.scenario.transitionReason === null;
  nodes["scenario-transition"].textContent = state.scenario.transitionReason ?? "";
  const capacityShock = state.scenario.scenarioId === "capacity-shock";
  nodes["basis-context"].textContent = capacityShock
    ? "The authoritative spindle calibration hold reduces the plan by 10 production minutes; the old capacity-plan version is stale even though it was previously admissible."
    : "The conflict is interval-specific: aggregate production headroom can remain positive while the requested 09:10–09:40 slot overlaps protected work.";
  nodes["proposal-heading"].textContent = capacityShock ? "Planned quality-fixture batch" : "Original rush request";
  nodes["activity-title"].textContent = capacityShock ? "Durable scenario activity" : "TrueForge activity";
  nodes["runtime-heading"].textContent = capacityShock ? "Kernel & durable evidence" : "Sandbox & MCP evidence";
  nodes["start-button"].disabled = missionMutationInFlight || !state.run.canStart;
  nodes["start-button"].textContent = state.run.status === "failed" ? "Resume safely" : state.scenario.startLabel;
  nodes["start-button"].classList.toggle("button-primary", state.run.canStart && !missionMutationInFlight);
  nodes["start-button"].classList.toggle("button-quiet", !state.run.canStart || missionMutationInFlight);
  nodes["reset-button"].disabled = missionMutationInFlight || !state.run.canReset;
  nodes["basis-note"].innerHTML = state.scenario.scenarioId === "rush-order"
    ? state.run.status === "idle"
      ? "<strong>Before you start:</strong> this is the precomputed canonical basis. Start runs the real deterministic mission against invocation-owned stores."
      : state.run.status === "verified"
        ? "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence for the verified mission."
        : state.run.status === "failed"
          ? "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence. Resume safely continues against the same invocation-owned stores."
          : "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence while the live mission runs against invocation-owned stores."
    : state.run.status === "idle"
      ? "<strong>Before you start:</strong> capacity-plan/v1 was admissible; the view below is the authoritative capacity-plan/v2 replan basis."
      : state.run.status === "verified"
        ? "<strong>Current basis:</strong> capacity-plan/v2 and the stale v1 rejection remain durable audit evidence for the verified mission."
        : "<strong>Current basis:</strong> capacity-plan/v2 remains authoritative while the mission advances.";
}

function setRecommendedAction(recommendedDecision) {
  for (const [decision, node] of [["deny", nodes["deny-button"]], ["allow", nodes["allow-button"]]]) {
    const recommended = decision === recommendedDecision;
    node.classList.toggle("button-primary", recommended);
    node.classList.toggle("button-quiet", !recommended);
    node.setAttribute?.("aria-label", `${node.textContent}${recommended ? " — recommended" : ""}`);
  }
}

function renderApproval() {
  const approval = state.pendingApproval;
  const previousIdentity = lastApprovalIdentity;
  nodes["approval-panel"].classList.toggle("is-continuing", approval === null);
  nodes["approval-tool"].classList.toggle("is-status", approval === null);
  nodes["policy-decision"].hidden = true;
  const primaryDenial = state.approvals.find((item) => item.source === "owner" && item.decision === "deny");
  const mechanical = [...state.approvals].reverse().find((item) => item.source === "active_m2_denial");
  if (primaryDenial || mechanical) {
    nodes["policy-decision"].hidden = false;
    nodes["policy-decision"].innerHTML = `${primaryDenial ? `<div><strong>Owner denied primary interval</strong><span>Primary denial rationale: ${escapeHtml(primaryDenial.reason)}.</span></div>` : ""}${mechanical ? `<div><strong>Blocked automatically — same denied action</strong><span>${escapeHtml(mechanical.effect)}. Equivalent scheduling representations cannot bypass the active denial (active M2 policy).</span></div>` : ""}`;
  }
  if (approval === null) {
    const verified = state.run.status === "verified";
    const failed = state.run.status === "failed";
    nodes["approval-title"].textContent = verified
      ? "Mission complete"
      : failed
        ? "Mission paused safely"
        : state.run.status === "idle"
          ? "Mission controls ready"
          : "Orchestration continuing";
    nodes["approval-phase"].textContent = verified ? "Verified" : failed ? "Stopped" : state.run.status === "idle" ? "Standing by" : "Continuing";
    nodes["approval-phase"].className = `pill ${verified ? "pill-verified" : failed ? "pill-denied" : "pill-neutral"}`;
    nodes["approval-tool"].textContent = state.run.status === "idle" ? "No mission started" : "No owner action is currently waiting";
    nodes["approval-effect"].textContent = verified
      ? "One authorized factory change is independently verified."
      : failed ? "No unverified success or unauthorized effect was exposed."
        : state.run.status === "idle" ? "Start the mission to reach the first owner decision."
          : "The recorded decision is durable; the mission is advancing to its next bounded phase.";
    nodes["approval-details"].hidden = true;
    nodes["allow-button"].disabled = true;
    nodes["deny-button"].disabled = true;
    setRecommendedAction(null);
    nodes["approval-guidance"].textContent = verified
      ? "All decisions and evidence above are durable; the mission is complete."
      : failed
        ? "Recorded decisions stay durable. Resume safely to continue the mission."
        : state.run.status === "idle"
          ? "This region activates at the first owner decision."
          : mechanical
            ? "The mechanical denial required no extra owner call and caused no mutation."
            : "This region remains stable while orchestration continues.";
    if (previousIdentity !== null) {
      nodes["decision-announcer"].textContent = verified
        ? "Decision recorded. Mission complete and independently verified."
        : failed
          ? "Decision recorded. Mission stopped safely."
          : "Decision recorded. Orchestration continuing safely.";
    }
    lastApprovalIdentity = null;
    return;
  }
  nodes["approval-title"].textContent = "Your decision is required";
  nodes["approval-phase"].textContent = approval.phase.replaceAll("_", " ");
  nodes["approval-phase"].className = "pill pill-pending";
  nodes["approval-tool"].textContent = approval.toolName.replaceAll("_", " ");
  nodes["approval-effect"].textContent = approval.expectedEffect;
  nodes["approval-mission"].textContent = approval.missionId;
  nodes["approval-digest"].textContent = approval.actionIdentity;
  nodes["approval-source"].textContent = approval.ownerSourceIdentity;
  nodes["approval-subject-row"].hidden = approval.technicalSubject === null;
  nodes["approval-subject"].textContent = approval.technicalSubject ?? "";
  nodes["approval-details"].hidden = false;
  nodes["approval-guidance"].textContent = approval.recommendedDecision === "deny"
    ? state.scenario.primaryGuidance
    : approval.phase === "consequential_effect"
      ? `${state.scenario.scenarioId === "rush-order" ? originalHeroPresentation.alternativeGuidance : state.scenario.alternativeGuidance}${primaryDenial ? ` Primary denial rationale: ${primaryDenial.reason}.` : ""}`
      : "Recommended: Approve — this bounded step preserves the canonical promise basis.";
  setRecommendedAction(approval.recommendedDecision);
  const decisionPending = approvalMutationInFlight === approval.actionIdentity;
  nodes["allow-button"].disabled = decisionPending;
  nodes["deny-button"].disabled = decisionPending;
  if (approval.actionIdentity !== previousIdentity) {
    nodes["decision-announcer"].textContent = `New approval required. ${approval.expectedEffect}. ${approval.recommendedDecision === "deny" ? "Deny" : "Approve"} is recommended.`;
    Promise.resolve().then(() => nodes["approval-title"].focus?.({ preventScroll: true }));
  }
  lastApprovalIdentity = approval.actionIdentity;
}

function renderHero() {
  nodes["basis-resolution"].textContent = state.run.status === "verified"
    ? state.scenario.scenarioId === "rush-order"
      ? originalHeroPresentation.resolvedBasis
      : state.scenario.resolvedBasis
    : state.scenario.scenarioId === "rush-order"
      ? originalHeroPresentation.unresolvedBasis
      : state.scenario.unresolvedBasis;
  nodes["basis-resolution"].classList.toggle("is-resolved", state.run.status === "verified");
  nodes["capacity-grid"].innerHTML = state.hero.capacity.map((item) => {
    const usedAfter = Math.max(0, item.existingUse + item.proposedConsumption);
    const progressValue = Math.min(item.declaredCapacity, usedAfter);
    const overBy = Math.max(0, usedAfter - item.declaredCapacity);
    return `<article class="capacity-item ${escapeHtml(item.status)}"><header><h3>${escapeHtml(item.label)}</h3><span>${escapeHtml(item.unit.replaceAll("_", " "))}</span></header><strong class="remaining">${item.remainingCapacity} remaining</strong><progress class="capacity-baseline" max="${item.declaredCapacity}" value="${progressValue}" aria-label="${escapeHtml(item.label)}: ${usedAfter} of ${item.declaredCapacity} units requested">${progressValue}/${item.declaredCapacity}</progress><div class="capacity-breakdown"><span><small>Declared</small>${item.declaredCapacity}</span><span><small>Existing</small>${item.existingUse}</span><span><small>${escapeHtml(state.scenario.proposalCapacityLabel)}</small>+${item.proposedConsumption}</span></div>${overBy > 0 ? `<p class="overage">Original basis exceeds capacity by ${overBy}.</p>` : ""}</article>`;
  }).join("");
  const acceptedProposal = state.hero.obligations.some((item) => item.obligationId === state.hero.proposal.obligationId);
  const acceptedWork = state.hero.obligations.filter((item) => item.obligationId !== state.hero.proposal.obligationId);
  nodes.obligations.innerHTML = acceptedWork.map((item) => `<div class="obligation ${item.protected ? "protected" : ""}"><strong>${escapeHtml(item.objective)}</strong><span>${escapeHtml(item.obligationId)} · quantity ${item.quantity}${item.protected ? " · protected and unchanged" : ""}</span></div>`).join("");
  nodes.proposal.innerHTML = `<div class="proposal-box"><strong>${escapeHtml(state.hero.proposal.objective)}</strong><span>${escapeHtml(state.hero.proposal.obligationId)} · quantity ${state.hero.proposal.quantity}</span><em>${acceptedProposal ? "Accepted only after the safest workable plan" : "Awaiting a safe promise basis"}</em></div>`;
  const winner = state.hero.winningModification;
  nodes["winning-change"].innerHTML = `<p class="eyebrow">Exact winner</p><strong>Quantity ${winner.fromQuantity} → ${winner.toQuantity}</strong><span>${escapeHtml(winner.obligationId)} · protected work ${state.hero.protectedWorkUnchanged ? "unchanged" : "changed"}</span>`;
  nodes["candidate-list"].innerHTML = state.hero.candidates.map((item, index) => `<div class="candidate"><span class="candidate-number">${index + 1}</span><div><strong>${escapeHtml(item.strategy.replaceAll("_", " "))}</strong><span>${escapeHtml(item.changedObligations.join(", ") || "No existing obligation changed")}</span></div><span class="pill ${item.recommended ? "pill-approved" : "pill-neutral"}">${item.recommended ? "Winner" : "Bounded"}</span></div>`).join("");
}

function truthfulAgentStatus() {
  return state.run.status === "idle" ? "Ready" : state.run.status === "awaiting_approval" ? "Waiting for owner" :
    state.run.status === "verifying" ? "Verifying evidence" : state.run.status === "verified" ? "Complete" :
      state.run.status === "failed" ? "Stopped safely" : "Coordinating";
}

function renderActivity() {
  const activity = state.activity;
  nodes["model-requests"].textContent = `${activity.modelRequests} model request${activity.modelRequests === 1 ? "" : "s"}`;
  const rootName = activity.rootAgent?.name ?? "TrueForge root agent";
  const rootRole = state.scenario.scenarioId === "rush-order" ? "Root mission agent" : "Deterministic mission coordinator";
  const root = `<div class="agent-node"><span class="agent-icon root-icon" aria-hidden="true">R</span><div class="agent-copy"><strong class="agent-name">${escapeHtml(rootName)}</strong><span class="agent-role">${rootRole}</span></div><span class="agent-status status-chip${state.run.status === "verified" ? " status-complete" : ""}">${escapeHtml(truthfulAgentStatus())}</span></div>`;
  const children = activity.subagents.map((item) => `<div class="agent-node child"><span class="agent-icon subagent-icon" aria-hidden="true">A</span><div class="agent-copy"><strong class="agent-name">${escapeHtml(item.title)}</strong><span class="agent-role">TrueForge subagent</span></div><span class="agent-status status-chip status-complete">Complete</span></div>`).join("");
  nodes["agent-tree"].innerHTML = root + children;
  const chips = [
    ...activity.mcpServers.map((value) => `MCP · ${value}`),
    ...activity.toolCalls.map((value) => `Tool · ${value}`),
    ...(activity.sandboxExecutions > 0 ? [`Sandbox · ${activity.sandboxExecutions} verified`] : []),
  ];
  nodes["runtime-chips"].innerHTML = (chips.length ? chips : ["Runtime evidence appears when the durable mission records it"]).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
}

function isTimelineNearLatest() {
  const scrollHeight = Number(nodes.timeline.scrollHeight ?? 0);
  const scrollTop = Number(nodes.timeline.scrollTop ?? 0);
  const clientHeight = Number(nodes.timeline.clientHeight ?? 0);
  return scrollHeight - scrollTop - clientHeight <= 28;
}

function renderTimeline() {
  const shouldPin = timelinePinned;
  assignPreservingDisclosure(nodes.timeline, state.evidenceTimeline.map((item) => `<li class="${escapeHtml(item.status)}"><span class="timeline-marker" aria-hidden="true"></span><div class="timeline-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p>${item.technicalIdentity ? `<details class="evidence-details"><summary>Saved proof</summary><code>${escapeHtml(item.technicalIdentity)}</code></details>` : ""}</div><span class="timeline-status">${escapeHtml(item.status === "informational" ? "recorded" : item.status)}</span></li>`).join(""));
  if (shouldPin && typeof nodes.timeline.scrollTo === "function") {
    nodes.timeline.scrollTo({ top: nodes.timeline.scrollHeight, behavior: "auto" });
  }
}

function formatFriendlyInterval(value) {
  if (!value) return "the approved interval";
  const parts = value.match(/T(\d{2}:\d{2})[^—]*—[^T]*T(\d{2}:\d{2})/u);
  return parts ? `${parts[1]}–${parts[2]}` : value.replaceAll(" — ", "–");
}

function renderExecution() {
  const result = state.execution;
  const verified = result.terminalStatus === "terminal_verified";
  nodes["verification-pill"].className = `pill ${verified ? "pill-verified" : result.mutationCount ? "pill-pending" : "pill-neutral"}`;
  nodes["verification-pill"].textContent = verified ? "Verified" : result.mutationCount ? "Read-back pending" : "Not executed";
  const metrics = [
    [result.acceptanceCount, "Promise accepted", "Fresh capacity-safe basis"],
    [result.attemptCount, "Execution attempt", "One fenced factory command"],
    [result.mutationCount, "Factory mutation", "Authorized schedule effect"],
    [result.receiptCount, "Mutation receipt", "Durable command evidence"],
  ];
  nodes["result-metrics"].innerHTML = metrics.map(([value, label, subtitle]) => `<div class="metric"><strong>${value}</strong><span>${label}</span><small>${subtitle}</small></div>`).join("");
  assignPreservingDisclosure(nodes["actual-facts"], result.actualFacts.length
    ? `<h3>Measured resource use</h3>${result.actualFacts.map((item) => { const presentation = resourcePresentation[item.resourceKey] ?? [item.resourceKey, item.workClassKey]; return `<div class="actual-fact"><span><b>${escapeHtml(presentation[0])}</b><small class="fact-subtitle">${escapeHtml(presentation[1])} · ${escapeHtml(item.workClassKey.replaceAll("_", " "))}</small><details class="fact-details"><summary>Technical fact</summary><code>${escapeHtml(item.resourceKey)} · ${escapeHtml(item.workClassKey)}</code></details></span><strong>${item.value}</strong></div>`; }).join("")}`
    : "");
  const stages = [
    ["Mutation committed", result.mutationCount === 1 ? "complete" : "waiting"],
    [
      result.independentReadBackObserved ? "Independent read-back observed" : "Independent read-back pending",
      result.mutationCount === 1 && !result.independentReadBackObserved ? "active" : result.independentReadBackObserved ? "complete" : "waiting",
    ],
    ["Read-back matched · verified", verified && result.independentReadBackObserved ? "complete" : "waiting"],
  ];
  nodes["proof-stages"].innerHTML = stages.map(([label, status], index) => `<li class="proof-${status}"><span>${index + 1}</span><strong>${label}</strong><small>${status === "complete" ? "Durable evidence present" : status === "active" ? "Verification in progress" : "Awaiting prior stage"}</small></li>`).join("");
  nodes["readback-note"].textContent = result.independentReadBackObserved
    ? `Independent read-back verified ${formatFriendlyInterval(result.approvedInterval)} before terminal completion.`
    : "Independent read-back has not yet occurred.";
  const evidenceReady = state.scenario.scenarioId === "rush-order" &&
    state.run.status === "verified" && verified && result.receiptCount === 1;
  if (nodes["evidence-bundle"] && nodes["evidence-download"]) {
    nodes["evidence-bundle"].hidden = !evidenceReady;
    nodes["evidence-download"].setAttribute?.("aria-disabled", String(!evidenceReady));
  }
}

function renderChallengeLab() {
  const lab = state.challengeLab;
  const labels = {
    idle: "Not run",
    running: "Running bounded challenges",
    complete: lab.allPassed ? "6 / 6 passed" : "Attention required",
    failed: "Stopped safely",
    closed: "Closed",
  };
  nodes["challenge-status"].textContent = labels[lab.status];
  nodes["challenge-status"].className = `pill ${lab.status === "complete" && lab.allPassed ? "pill-verified" : lab.status === "failed" ? "pill-denied" : lab.status === "running" ? "pill-pending" : "pill-neutral"}`;
  nodes["challenge-button"].disabled = challengeMutationInFlight || !lab.canRun;
  nodes["challenge-button"].textContent = lab.status === "running" ? "Running optional challenge lab…" : lab.status === "complete" ? "Challenge lab complete" : lab.status === "failed" ? "Challenge stopped safely" : "Run optional challenge lab";
  if (lab.status === "idle") {
    nodes["challenge-summary"].innerHTML = "<strong>Ready when requested.</strong> The hero mission and its Evidence Bundle remain independent; this optional lab uses six separate owned ledger pairs.";
    nodes["challenge-results"].innerHTML = "";
    return;
  }
  if (lab.status === "running") {
    nodes["challenge-summary"].innerHTML = "<strong>Trying six bounded actions in separate demo records.</strong> Each decision still comes from the canonical stores or public change-control adapter.";
    nodes["challenge-results"].innerHTML = "";
    return;
  }
  if (lab.status === "failed") {
    nodes["challenge-summary"].innerHTML = "<strong>Lab stopped safely.</strong> No pass is claimed because the complete evidence set could not be assembled.";
    nodes["challenge-results"].innerHTML = "";
    return;
  }
  if (lab.status === "closed") return;
  nodes["challenge-summary"].innerHTML = lab.allPassed
    ? `<strong>PASS · ${lab.challenges.length} / ${lab.challenges.length}</strong> Five invalid requests were blocked without any new effect. The allowed replay returned the original result and created no duplicate effect.`
    : "<strong>NOT PASSED.</strong> At least one control did not establish zero unauthorized effects.";
  const countLabels = [
    ["admissions", "Admissions"], ["grants", "Grants"], ["attempts", "Attempts"],
    ["fences", "Fences"], ["mutations", "Mutations"], ["receipts", "Receipts"],
    ["terminalEvents", "Terminal events"], ["actualFacts", "Actual facts"],
  ];
  assignPreservingDisclosure(nodes["challenge-results"], lab.challenges.map((challenge, index) => {
    const counts = countLabels.map(([key, label]) => {
      const before = challenge.before.counts[key];
      const after = challenge.after.counts[key];
      return `<div class="challenge-count"><span>${escapeHtml(label)}</span><strong>${before} → ${after}</strong></div>`;
    }).join("");
    const replay = challenge.replayProof === null ? "" : `<div class="replay-proof" role="group" aria-label="Replay proof"><span>Replayed: ${challenge.replayProof.replayed ? "yes" : "no"}</span><span>Original result: ${challenge.replayProof.originalResultReturned ? "same" : "different"}</span><span>Original receipt: ${challenge.replayProof.originalReceiptReturned ? "same" : "different"}</span><span>Second mutation: ${challenge.replayProof.noSecondMutation ? "none" : "detected"}</span><span>Duplicate facts: ${challenge.replayProof.noDuplicateFacts ? "none" : "detected"}</span></div>`;
    const reasonLabel = challenge.control === "positive" ? "Why it was allowed" : "Why it was blocked";
    const effect = challenge.control === "positive"
      ? "No duplicate effect occurred; the original result and receipt were returned."
      : "No unauthorized effect occurred; every durable count and row stayed the same.";
    return `<article class="challenge-case ${challenge.zeroUnauthorizedEffects ? "challenge-pass" : "challenge-fail"}" aria-labelledby="challenge-case-${index}"><div class="challenge-case-heading"><div><p class="eyebrow">${challenge.control === "positive" ? "Allowed replay control" : "Blocked request"}</p><h3 id="challenge-case-${index}">${escapeHtml(challenge.title)}</h3></div><span class="pill ${challenge.zeroUnauthorizedEffects ? "pill-verified" : "pill-denied"}">${challenge.zeroUnauthorizedEffects ? "Zero unauthorized effects" : "Not proven"}</span></div><dl class="challenge-explanation"><div><dt>What was attempted · redacted</dt><dd>${escapeHtml(challenge.attemptedAction)}</dd></div><div><dt>${reasonLabel}</dt><dd>${escapeHtml(challenge.authoritativeReason)}</dd></div><div><dt>Did any effect occur?</dt><dd>${effect}</dd></div><div><dt>Authoritative boundary</dt><dd>${escapeHtml(challenge.rule)}</dd></div></dl><details class="challenge-technical"><summary>Inspect technical adapter path</summary><code>${escapeHtml(challenge.adapterPath)}</code></details><div class="challenge-counts" role="group" aria-label="Before and after durable counts">${counts}</div>${replay}<details class="snapshot-proof"><summary>Complete durable snapshot equality</summary><dl><div><dt>Before</dt><dd>${escapeHtml(challenge.before.snapshotDigest)}</dd></div><div><dt>After</dt><dd>${escapeHtml(challenge.after.snapshotDigest)}</dd></div></dl><strong>${challenge.snapshotEqual ? "Equal · every table and row matched" : "Different · zero mutation not established"}</strong></details></article>`;
  }).join(""));
}

function showError(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add("visible");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    nodes.toast.classList.remove("visible");
  }, 5000);
}

nodes["timeline"].addEventListener("scroll", () => { timelinePinned = isTimelineNearLatest(); }, { passive: true });
nodes["scenario-select"].addEventListener("change", () => {
  const scenarioId = nodes["scenario-select"].value;
  void mutate("/api/scenario", { scenarioId, requestId: requestId("scenario") });
});
nodes["start-button"].addEventListener("click", () => {
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/mission", { operation: "start", requestId: requestId("start") });
});
nodes["reset-button"].addEventListener("click", () => {
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/mission", { operation: "reset", requestId: requestId("reset") });
});
nodes["challenge-button"].addEventListener("click", () => {
  nodes["challenge-title"].focus?.({ preventScroll: true });
  void mutate("/api/challenge", { operation: "run", requestId: requestId("challenge") });
});
nodes["allow-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "allow", reason: null, requestId: requestId("allow") });
});
nodes["deny-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "deny", reason: state.scenario.denialReason, requestId: requestId("deny") });
});
nodes["evidence-download"]?.addEventListener("click", (event) => {
  if (nodes["evidence-download"].getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});

void refresh();
poll = window.setInterval(() => void refresh(), 300);
window.addEventListener("pagehide", () => window.clearInterval(poll));
window.addEventListener("pageshow", (event) => {
  if (event?.persisted !== true) return;
  window.clearInterval(poll);
  poll = window.setInterval(() => void refresh(), 300);
  void refresh();
});
