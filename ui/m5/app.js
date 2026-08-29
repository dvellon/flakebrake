const nodes = Object.fromEntries(
  [
    "connection-dot", "connection-label", "start-button", "reset-button", "mission-id",
    "session-id", "turn-id", "outcome", "approval-panel", "approval-phase", "approval-tool",
    "approval-effect", "approval-mission", "approval-digest", "approval-source", "allow-button",
    "deny-button", "approval-guidance", "capacity-grid", "obligations", "proposal",
    "winning-change", "candidate-list", "model-requests", "agent-tree", "runtime-chips",
    "timeline", "verification-pill", "result-metrics", "actual-facts", "readback-note", "toast",
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortIdentity(value) {
  if (!value) return "—";
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
    if (applyState(candidate, token)) {
      nodes["connection-dot"].classList.add("connected");
    }
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
  if (state !== null) {
    if (candidate.run.generation < state.run.generation) return false;
    if (
      candidate.run.generation === state.run.generation &&
      candidate.revision < state.revision
    ) return false;
    if (candidate.mission.missionId !== state.mission.missionId) return false;

    const newerDurableGeneration =
      candidate.run.generation > state.run.generation && candidate.revision > state.revision;
    const tokenMatchesCurrentFailure =
      token.intent === "mission_start" &&
      token.sourceRevision === state.revision &&
      token.sourceRunGeneration === state.run.generation &&
      token.sourceMissionId === state.mission.missionId &&
      token.sourceSessionId === state.mission.sessionId;
    const recoverySessionMatches =
      state.mission.sessionId === null || candidate.mission.sessionId === state.mission.sessionId;
    const explicitRecovery =
      state.run.status === "failed" &&
      tokenMatchesCurrentFailure &&
      newerDurableGeneration &&
      recoverySessionMatches;
    const explicitReset =
      token.intent === "mission_reset" &&
      token.sourceRevision === state.revision &&
      token.sourceRunGeneration === state.run.generation &&
      token.sourceMissionId === state.mission.missionId &&
      newerDurableGeneration;

    if (state.run.status === "verified" && candidate.run.status !== "verified" && !explicitReset) {
      return false;
    }
    if (state.run.status === "failed" && candidate.run.status !== "failed" && !explicitRecovery && !explicitReset) {
      return false;
    }
    if (
      state.mission.sessionId !== null &&
      candidate.mission.sessionId !== null &&
      candidate.mission.sessionId !== state.mission.sessionId &&
      !explicitReset
    ) return false;
  }
  latestAppliedSequence = token.sequence;
  state = candidate;
  render();
  return true;
}

function render() {
  if (!state) return;
  renderHeader();
  renderApproval();
  renderHero();
  renderActivity();
  renderTimeline();
  renderExecution();
}

function renderHeader() {
  const running = ["running", "awaiting_approval", "verifying"].includes(state.run.status);
  const labels = {
    idle: "Ready on loopback", connected: "Mission connected", awaiting_owner: "Waiting for owner",
    replayed: "Durable replay restored", closed: "Server closed",
  };
  nodes["connection-label"].textContent = labels[state.run.connection] || "Mission connected";
  nodes["mission-id"].textContent = shortIdentity(state.mission.missionId);
  nodes["session-id"].textContent = shortIdentity(state.mission.sessionId) || "Not started";
  nodes["turn-id"].textContent = shortIdentity(state.mission.currentTurnId);
  const outcomeLabels = {
    idle: "Waiting", running: "Orchestrating", awaiting_approval: "Owner decision", verifying: "Verifying",
    verified: "Verified success", failed: "Stopped safely", closed: "Closed",
  };
  nodes.outcome.textContent = outcomeLabels[state.run.status];
  nodes.outcome.className = state.run.status === "verified" ? "tone-verified" : state.run.status === "failed" ? "tone-denied" : running ? "tone-pending" : "tone-neutral";
  nodes["start-button"].disabled = missionMutationInFlight || !state.run.canStart;
  nodes["start-button"].textContent = state.run.status === "failed" ? "Resume safely" : "Start hero mission";
  nodes["reset-button"].disabled = missionMutationInFlight || !state.run.canReset;
}

function renderApproval() {
  const approval = state.pendingApproval;
  nodes["approval-panel"].classList.toggle("is-hidden", approval === null);
  if (!approval) return;
  nodes["approval-phase"].textContent = approval.phase.replaceAll("_", " ");
  nodes["approval-tool"].textContent = approval.toolName.replaceAll("_", " ");
  nodes["approval-effect"].textContent = approval.expectedEffect;
  nodes["approval-mission"].textContent = approval.missionId;
  nodes["approval-digest"].textContent = approval.actionIdentity;
  nodes["approval-source"].textContent = approval.ownerSourceIdentity;
  nodes["approval-guidance"].textContent = approval.recommendedDecision === "deny"
    ? "Judge path: deny this overcommitted interval."
    : "Judge path: approve this bounded action.";
  nodes["allow-button"].classList.toggle("button-primary", approval.recommendedDecision === "allow");
  nodes["deny-button"].classList.toggle("button-primary", approval.recommendedDecision === "deny");
  const decisionPending = approvalMutationInFlight === approval.actionIdentity;
  nodes["allow-button"].disabled = decisionPending;
  nodes["deny-button"].disabled = decisionPending;
}

function renderHero() {
  nodes["capacity-grid"].innerHTML = state.hero.capacity.map((item) => {
    const usedAfter = Math.max(0, item.declaredCapacity - item.remainingCapacity);
    const width = Math.min(100, Math.round((usedAfter / item.declaredCapacity) * 100));
    return `<article class="capacity-item ${escapeHtml(item.status)}"><header><h3>${escapeHtml(item.label)}</h3><span>${escapeHtml(item.unit.replaceAll("_", " "))}</span></header><strong class="remaining">${item.remainingCapacity} remaining</strong><div class="capacity-bar" aria-label="${escapeHtml(item.label)} ${width}% committed"><span style="width:${width}%"></span></div><div class="capacity-breakdown"><span>Capacity ${item.declaredCapacity}</span><span>Existing ${item.existingUse}</span><span>Rush +${item.proposedConsumption}</span></div></article>`;
  }).join("");
  nodes.obligations.innerHTML = state.hero.obligations.map((item) => `<div class="obligation ${item.protected ? "protected" : ""}"><strong>${escapeHtml(item.objective)}</strong><span>${escapeHtml(item.obligationId)} · quantity ${item.quantity}${item.protected ? " · protected" : ""}</span></div>`).join("");
  nodes.proposal.innerHTML = `<div class="proposal-box"><strong>${escapeHtml(state.hero.proposal.objective)}</strong><span>${escapeHtml(state.hero.proposal.obligationId)} · quantity ${state.hero.proposal.quantity}</span></div>`;
  const winner = state.hero.winningModification;
  nodes["winning-change"].innerHTML = `<p class="eyebrow">Exact winner</p><strong>Quantity ${winner.fromQuantity} → ${winner.toQuantity}</strong><span>${escapeHtml(winner.obligationId)} · protected work ${state.hero.protectedWorkUnchanged ? "unchanged" : "changed"}</span>`;
  nodes["candidate-list"].innerHTML = state.hero.candidates.map((item, index) => `<div class="candidate"><span class="candidate-number">${index + 1}</span><div><strong>${escapeHtml(item.strategy.replaceAll("_", " "))}</strong><span>${escapeHtml(item.changedObligations.join(", ") || "No existing obligation changed")}</span></div><span class="pill ${item.recommended ? "pill-approved" : "pill-neutral"}">${item.recommended ? "Winner" : "Bounded"}</span></div>`).join("");
}

function renderActivity() {
  const activity = state.activity;
  nodes["model-requests"].textContent = `${activity.modelRequests} model request${activity.modelRequests === 1 ? "" : "s"}`;
  const root = activity.rootAgent ? `<div class="agent-node"><span class="agent-icon">R</span><div><strong>${escapeHtml(activity.rootAgent.name)}</strong><span>Root mission agent</span></div></div>` : `<div class="agent-node"><span class="agent-icon">R</span><div><strong>Root mission agent</strong><span>Starts with the mission</span></div></div>`;
  const children = activity.subagents.map((item) => `<div class="agent-node child"><span class="agent-icon">A</span><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.status)}</span></div></div>`).join("");
  nodes["agent-tree"].innerHTML = root + children;
  const chips = [
    ...activity.mcpServers.map((value) => `MCP · ${value}`),
    ...activity.toolCalls.map((value) => `Tool · ${value}`),
    ...(activity.sandboxExecutions > 0 ? [`Sandbox · ${activity.sandboxExecutions} verified`] : []),
  ];
  nodes["runtime-chips"].innerHTML = (chips.length ? chips : ["Runtime evidence appears after completion"]).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
}

function renderTimeline() {
  nodes.timeline.innerHTML = state.evidenceTimeline.map((item) => `<li class="${escapeHtml(item.status)}"><span class="timeline-marker" aria-hidden="true"></span><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></li>`).join("");
}

function renderExecution() {
  const result = state.execution;
  const verified = result.terminalStatus === "terminal_verified";
  nodes["verification-pill"].className = `pill ${verified ? "pill-verified" : result.mutationCount ? "pill-pending" : "pill-neutral"}`;
  nodes["verification-pill"].textContent = verified ? "Verified" : result.mutationCount ? "Read-back pending" : "Not executed";
  nodes["result-metrics"].innerHTML = [
    [result.acceptanceCount, "Acceptance"], [result.attemptCount, "Attempt"],
    [result.mutationCount, "Mutation"], [result.receiptCount, "Receipt"],
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  nodes["actual-facts"].innerHTML = result.actualFacts.length
    ? `<h3>Actual consumption</h3>${result.actualFacts.map((item) => `<div class="actual-fact"><span>${escapeHtml(item.resourceKey)} · ${escapeHtml(item.workClassKey)}</span><strong>${item.value}</strong></div>`).join("")}`
    : "";
  nodes["readback-note"].textContent = result.independentReadBackObserved
    ? `Independent read-back verified ${result.approvedInterval || "the approved interval"} before terminal completion.`
    : "Independent read-back has not yet occurred.";
}

function showError(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add("visible");
  window.setTimeout(() => nodes.toast.classList.remove("visible"), 5000);
}

nodes["start-button"].addEventListener("click", () => void mutate("/api/mission", { operation: "start", requestId: requestId("start") }));
nodes["reset-button"].addEventListener("click", () => void mutate("/api/mission", { operation: "reset", requestId: requestId("reset") }));
nodes["allow-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "allow", reason: null, requestId: requestId("allow") });
});
nodes["deny-button"].addEventListener("click", () => {
  if (!state?.pendingApproval) return;
  void mutate("/api/approval", { missionId: state.pendingApproval.missionId, actionIdentity: state.pendingApproval.actionIdentity, decision: "deny", reason: "The primary interval conflicts with protected production commitments", requestId: requestId("deny") });
});

void refresh();
poll = window.setInterval(() => void refresh(), 300);
window.addEventListener("pagehide", () => window.clearInterval(poll), { once: true });
