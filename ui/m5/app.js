const nodes = Object.fromEntries(
  [
    "connection-dot", "connection-label", "start-button", "reset-button", "mission-id",
    "session-id", "turn-id", "outcome", "approval-panel", "approval-title", "approval-phase",
    "approval-tool", "approval-effect", "approval-mission", "approval-digest", "approval-source",
    "approval-subject", "approval-subject-row", "approval-details", "allow-button", "deny-button",
    "approval-guidance", "decision-announcer", "policy-decision", "capacity-grid", "obligations",
    "proposal", "basis-note", "basis-resolution", "winning-change", "candidate-list", "model-requests",
    "agent-tree", "runtime-chips", "timeline", "verification-pill", "result-metrics",
    "actual-facts", "proof-stages", "readback-note", "proof-center-lead",
    "proof-center-status", "proof-direct-result", "proof-direct-note", "proof-winner-result",
    "proof-winner-note", "proof-owner-result", "proof-owner-note", "proof-outcome-result",
    "proof-outcome-note", "proof-control-summary", "proof-decisions", "proof-capacity-summary",
    "proof-capacity-impact", "proof-durable-summary", "proof-durable-proof",
    "proof-technical-evidence", "counterfactual-copy", "harness-state", "harness-provider",
    "harness-session", "harness-turn", "harness-runtime", "harness-mcp", "harness-sandbox",
    "harness-subagents", "harness-gate", "harness-replay-row", "harness-replay",
    "harness-pause", "evidence-bundle", "evidence-download", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

let state = null;
let poll = null;
let requestCounter = 0;
let missionMutationInFlight = false;
let approvalMutationInFlight = null;
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
  human_review_decisions: ["Owner decisions", "Explicit external approval capacity"],
  production_cell_minutes: ["Production cell", "Scheduled factory execution time"],
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
  } else {
    if (missionMutationInFlight) return;
    missionMutationInFlight = true;
  }
  invalidateResponses();
  const intent = path === "/api/mission"
    ? body.operation === "reset" ? "mission_reset" : "mission_start"
    : "approval";
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
    if (candidate.mission.missionId !== state.mission.missionId) return false;
    const newerDurableGeneration =
      candidate.run.generation > state.run.generation && candidate.revision > state.revision;
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
    if (state.run.status === "verified" && candidate.run.status !== "verified" && !explicitReset) return false;
    if (state.run.status === "failed" && candidate.run.status !== "failed" && !explicitRecovery && !explicitReset) return false;
    if (state.mission.sessionId !== null && candidate.mission.sessionId !== null &&
      candidate.mission.sessionId !== state.mission.sessionId && !explicitReset) return false;
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
  renderHeader();
  renderHarness();
  renderProofCenter();
  renderApproval();
  renderHero();
  renderActivity();
  renderTimeline();
  renderExecution();
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

  nodes["proof-direct-result"].textContent = state.hero.directDecision;
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
  nodes["proof-outcome-note"].textContent = `${state.execution.receiptCount} receipt · ${state.execution.terminalEventCount} terminal event · ${state.execution.actualFactCount} actual facts`;

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
    ? `${result.mutationCount} mutation · ${result.receiptCount} receipt · ${result.terminalEventCount} terminal event · ${result.actualFactCount} facts`
    : result.receiptCount > 0 ? "Receipt present · independent verification still required" : "Mutation is not verified success";
  const readBackStatus = result.independentReadBackObserved ? "Observed before terminal completion" : "Not yet observed";
  const terminalStatus = result.terminalStatus === "terminal_verified" ? "terminal_verified recorded" : "Not recorded";
  const replayCopy = verified
    ? `${replayed ? "This browser is attached to a durable replay." : "The verified projection is durable across refresh and restart."} This process made ${state.run.ownerCallsThisProcess} owner call${state.run.ownerCallsThisProcess === 1 ? "" : "s"}; the durable effect count remains ${result.mutationCount}.`
    : "Refresh and recovery read the same durable records; neither may turn a receipt into success or repeat an effect.";
  nodes["proof-durable-proof"].innerHTML = `<div class="proof-counts"><div><strong>${result.mutationCount}</strong><span>Mutation</span></div><div><strong>${result.receiptCount}</strong><span>Receipt</span></div><div><strong>${result.terminalEventCount}</strong><span>Terminal event</span></div><div><strong>${result.actualFactCount}</strong><span>Actual facts</span></div></div><ol class="durable-chain"><li class="${result.receiptCount ? "complete" : "waiting"}"><span>1</span><div><strong>Mutation receipt</strong><p>A receipt proves the fenced factory command committed. By itself, it is not verified success.</p></div></li><li class="${result.independentReadBackObserved ? "complete" : result.receiptCount ? "active" : "waiting"}"><span>2</span><div><strong>Independent read-back</strong><p>${readBackStatus}${result.approvedInterval ? ` · ${escapeHtml(formatFriendlyInterval(result.approvedInterval))}` : ""}</p></div></li><li class="${verified ? "complete" : "waiting"}"><span>3</span><div><strong>Verified terminal event</strong><p>${terminalStatus}. Only this state is presented as success.</p></div></li></ol><p class="replay-proof">${escapeHtml(replayCopy)}</p>`;
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
  nodes["start-button"].disabled = missionMutationInFlight || !state.run.canStart;
  nodes["start-button"].textContent = state.run.status === "failed" ? "Resume safely" : "Start hero mission";
  nodes["start-button"].classList.toggle("button-primary", state.run.canStart && !missionMutationInFlight);
  nodes["start-button"].classList.toggle("button-quiet", !state.run.canStart || missionMutationInFlight);
  nodes["reset-button"].disabled = missionMutationInFlight || !state.run.canReset;
  nodes["basis-note"].innerHTML = state.run.status === "idle"
    ? "<strong>Before you start:</strong> this is the precomputed canonical basis. Start runs the real deterministic mission against invocation-owned stores."
    : state.run.status === "verified"
      ? "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence for the verified mission."
      : state.run.status === "failed"
        ? "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence. Resume safely continues against the same invocation-owned stores."
        : "<strong>Canonical basis:</strong> the precomputed evaluation above remains durable audit evidence while the live mission runs against invocation-owned stores.";
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
    nodes["policy-decision"].innerHTML = `${primaryDenial ? `<div><strong>Owner denied primary interval</strong><span>Primary denial rationale: ${escapeHtml(primaryDenial.reason)}.</span></div>` : ""}${mechanical ? `<div><strong>Auto-blocked · active policy</strong><span>${escapeHtml(mechanical.effect)}. Equivalent scheduling representations cannot bypass the active denial.</span></div>` : ""}`;
  }
  if (approval === null) {
    const verified = state.run.status === "verified";
    const failed = state.run.status === "failed";
    nodes["approval-title"].textContent = verified ? "Mission complete" : failed ? "Mission paused safely" : "Orchestration continuing";
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
    ? "Recommended: Deny — 09:10–09:40 overlaps protected production work."
    : approval.phase === "consequential_effect"
      ? `Recommended: Approve — 09:40–10:10 starts after the protected interval and fits the bound grant.${primaryDenial ? ` Primary denial rationale: ${primaryDenial.reason}.` : ""}`
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
    ? "Resolved through bounded replan: the original over-capacity basis remains visible for audit, while the accepted alternative is verified."
    : "Original rush basis requires a bounded replan before any promise can be accepted.";
  nodes["basis-resolution"].classList.toggle("is-resolved", state.run.status === "verified");
  nodes["capacity-grid"].innerHTML = state.hero.capacity.map((item) => {
    const usedAfter = Math.max(0, item.existingUse + item.proposedConsumption);
    const progressValue = Math.min(item.declaredCapacity, usedAfter);
    const overBy = Math.max(0, usedAfter - item.declaredCapacity);
    return `<article class="capacity-item ${escapeHtml(item.status)}"><header><h3>${escapeHtml(item.label)}</h3><span>${escapeHtml(item.unit.replaceAll("_", " "))}</span></header><strong class="remaining">${item.remainingCapacity} remaining</strong><progress class="capacity-baseline" max="${item.declaredCapacity}" value="${progressValue}" aria-label="${escapeHtml(item.label)}: ${usedAfter} of ${item.declaredCapacity} units requested">${progressValue}/${item.declaredCapacity}</progress><div class="capacity-breakdown"><span><small>Declared</small>${item.declaredCapacity}</span><span><small>Existing</small>${item.existingUse}</span><span><small>Rush</small>+${item.proposedConsumption}</span></div>${overBy > 0 ? `<p class="overage">Original basis exceeds capacity by ${overBy}.</p>` : ""}</article>`;
  }).join("");
  const acceptedProposal = state.hero.obligations.some((item) => item.obligationId === state.hero.proposal.obligationId);
  const acceptedWork = state.hero.obligations.filter((item) => item.obligationId !== state.hero.proposal.obligationId);
  nodes.obligations.innerHTML = acceptedWork.map((item) => `<div class="obligation ${item.protected ? "protected" : ""}"><strong>${escapeHtml(item.objective)}</strong><span>${escapeHtml(item.obligationId)} · quantity ${item.quantity}${item.protected ? " · protected and unchanged" : ""}</span></div>`).join("");
  nodes.proposal.innerHTML = `<div class="proposal-box"><strong>${escapeHtml(state.hero.proposal.objective)}</strong><span>${escapeHtml(state.hero.proposal.obligationId)} · quantity ${state.hero.proposal.quantity}</span><em>${acceptedProposal ? "Accepted only after the bounded replan" : "Awaiting a safe promise basis"}</em></div>`;
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
  const root = `<div class="agent-node"><span class="agent-icon root-icon" aria-hidden="true">R</span><div class="agent-copy"><strong class="agent-name">${escapeHtml(rootName)}</strong><span class="agent-role">Root mission agent</span></div><span class="agent-status status-chip${state.run.status === "verified" ? " status-complete" : ""}">${escapeHtml(truthfulAgentStatus())}</span></div>`;
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
  assignPreservingDisclosure(nodes.timeline, state.evidenceTimeline.map((item) => `<li class="${escapeHtml(item.status)}"><span class="timeline-marker" aria-hidden="true"></span><div class="timeline-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p>${item.technicalIdentity ? `<details class="evidence-details"><summary>Durable evidence</summary><code>${escapeHtml(item.technicalIdentity)}</code></details>` : ""}</div><span class="timeline-status">${escapeHtml(item.status === "informational" ? "recorded" : item.status)}</span></li>`).join(""));
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
    ? `<h3>Actual consumption facts</h3>${result.actualFacts.map((item) => { const presentation = resourcePresentation[item.resourceKey] ?? [item.resourceKey, item.workClassKey]; return `<div class="actual-fact"><span><b>${escapeHtml(presentation[0])}</b><small class="fact-subtitle">${escapeHtml(presentation[1])} · ${escapeHtml(item.workClassKey.replaceAll("_", " "))}</small><details class="fact-details"><summary>Technical fact</summary><code>${escapeHtml(item.resourceKey)} · ${escapeHtml(item.workClassKey)}</code></details></span><strong>${item.value}</strong></div>`; }).join("")}`
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
  const evidenceReady = state.run.status === "verified" && verified && result.receiptCount === 1;
  if (nodes["evidence-bundle"] && nodes["evidence-download"]) {
    nodes["evidence-bundle"].hidden = !evidenceReady;
    nodes["evidence-download"].setAttribute?.("aria-disabled", String(!evidenceReady));
  }
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
nodes["start-button"].addEventListener("click", () => {
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/mission", { operation: "start", requestId: requestId("start") });
});
nodes["reset-button"].addEventListener("click", () => {
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/mission", { operation: "reset", requestId: requestId("reset") });
});
nodes["allow-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "allow", reason: null, requestId: requestId("allow") });
});
nodes["deny-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  nodes["approval-title"].focus?.({ preventScroll: true });
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "deny", reason: "The primary interval conflicts with protected production commitments", requestId: requestId("deny") });
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
