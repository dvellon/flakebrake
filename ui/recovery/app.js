"use strict";

window.__recoveryDemoErrors = [];
window.addEventListener("error", (event) => {
  window.__recoveryDemoErrors.push(String(event.error || event.message || "window error"));
});
window.addEventListener("unhandledrejection", (event) => {
  window.__recoveryDemoErrors.push(String(event.reason || "unhandled rejection"));
});

const nodes = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((node) => [node.id, node]),
);
const stageLabels = {
  idle: "Ready to demonstrate recovery",
  interrupted: "Runner closed at the deterministic boundary",
  restarted: "Fresh runner reopened durable state",
  verified: "Recovery converged exactly once",
  replayed: "Completed replay added nothing",
  failed: "Demonstration stopped safely",
  closed: "Demonstration closed",
};
let state = null;
let actionInFlight = false;
let requestSequence = 0;
let responseGeneration = 1;
let responseSequence = 0;
let latestAppliedSequence = 0;
let lastStage = null;
let toastTimer = null;
let poll = null;
const scenarioId = "deterministic_exact_once_recovery";
const stageOrder = {
  idle: 0,
  interrupted: 1,
  restarted: 2,
  verified: 3,
  replayed: 4,
  failed: 5,
  closed: 6,
};

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Request failed (${response.status})`);
  return body;
}

function requestId(operation) {
  requestSequence += 1;
  return `recovery:${operation}:${Date.now().toString(36)}:${requestSequence.toString(36)}`;
}

async function refresh(intent = "poll", boundary = null) {
  const token = responseToken(intent, boundary);
  try {
    const candidate = await api("/api/recovery");
    applyState(candidate, token);
    if (!isCurrentResponse(token)) return;
    nodes["connection-dot"].classList.add("connected");
    nodes["connection-label"].textContent = "Loopback connected";
  } catch (error) {
    if (!isCurrentResponse(token)) return;
    invalidateResponses();
    nodes["connection-dot"].classList.remove("connected");
    nodes["connection-label"].textContent = "Reconnecting…";
    showError(error instanceof Error ? error.message : "State refresh failed safely");
  }
}

async function act(operation) {
  if (actionInFlight || !state) return;
  actionInFlight = true;
  render();
  const boundary = operation === "interrupt"
    ? document.querySelector('input[name="boundary"]:checked')?.value ?? null
    : null;
  invalidateResponses();
  const token = responseToken(operation, boundary);
  try {
    const result = await api("/api/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, boundary, requestId: requestId(operation) }),
    });
    applyState(result.state, token);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Action failed safely");
    await refresh(operation, boundary);
  } finally {
    actionInFlight = false;
    render();
  }
}

function responseToken(intent, boundary = null) {
  responseSequence += 1;
  return {
    generation: responseGeneration,
    sequence: responseSequence,
    intent,
    boundary,
    sourceRevision: state?.revision ?? null,
    sourceRunId: state?.runId ?? null,
    sourceRestartGeneration: state?.restartGeneration ?? null,
    sourceBoundary: state?.boundary ?? null,
  };
}

function invalidateResponses() {
  responseGeneration += 1;
  latestAppliedSequence = 0;
}

function isCurrentResponse(token) {
  return token.generation === responseGeneration && token.sequence >= latestAppliedSequence;
}

function validRecoveryState(candidate) {
  return candidate !== null && typeof candidate === "object" &&
    candidate.mode === "recovery_demonstration" &&
    candidate.scenarioId === scenarioId &&
    typeof candidate.runId === "string" && candidate.runId.length > 0 &&
    Number.isSafeInteger(candidate.revision) && candidate.revision >= 0 &&
    Number.isSafeInteger(candidate.restartGeneration) && candidate.restartGeneration >= 0 &&
    Object.hasOwn(stageOrder, candidate.stage) &&
    (candidate.boundary === null || [
      "after_execution_fence_before_factory_mutation",
      "after_factory_commit_before_m2_binding",
    ].includes(candidate.boundary));
}

function tokenMatchesCurrent(token) {
  return state !== null &&
    token.sourceRevision === state.revision &&
    token.sourceRunId === state.runId &&
    token.sourceRestartGeneration === state.restartGeneration &&
    token.sourceBoundary === state.boundary;
}

function applyState(candidate, token) {
  if (!isCurrentResponse(token) || !validRecoveryState(candidate)) return false;
  if (state !== null) {
    const matchesCurrent = tokenMatchesCurrent(token);
    const explicitReset = token.intent === "reset" && matchesCurrent &&
      candidate.runId !== state.runId && candidate.boundary === null &&
      candidate.restartGeneration === 0 && candidate.revision > state.revision;
    if (candidate.runId !== state.runId) {
      if (!explicitReset) return false;
    } else {
      const explicitInterrupt = token.intent === "interrupt" && matchesCurrent &&
        state.stage === "idle" && state.boundary === null &&
        token.boundary === candidate.boundary;
      if (candidate.boundary !== state.boundary && !explicitInterrupt) return false;
      if (candidate.restartGeneration < state.restartGeneration) return false;
      if (candidate.restartGeneration > state.restartGeneration) {
        const explicitRestart = token.intent === "restart" && matchesCurrent &&
          candidate.restartGeneration === state.restartGeneration + 1;
        if (!explicitRestart) return false;
      }
      if (candidate.revision < state.revision) return false;
      if (candidate.revision === state.revision) {
        latestAppliedSequence = token.sequence;
        return false;
      }
      const currentTerminal = state.stage === "verified" || state.stage === "replayed";
      const candidateTerminal = candidate.stage === "verified" || candidate.stage === "replayed";
      if (currentTerminal && !candidateTerminal) return false;
      if (state.stage === "failed" && candidate.stage !== "failed") return false;
      if (stageOrder[candidate.stage] < stageOrder[state.stage]) return false;
    }
  }
  latestAppliedSequence = token.sequence;
  state = candidate;
  render();
  return true;
}

function render() {
  if (!state) return;
  const verified = state.stage === "verified" || state.stage === "replayed";
  nodes["stage-title"].textContent = stageLabels[state.stage] || state.stage;
  nodes["stage-pill"].textContent = state.stage;
  nodes["stage-pill"].className = `pill ${verified ? "verified" : state.stage === "idle" ? "" : "active"}`;
  nodes["runner-state"].textContent = state.runnerClosedAtBoundary
    ? state.stage === "interrupted" ? "Owning runner closed cleanly" : "Original runner closed · fresh owner used"
    : "Runner not started";

  for (const input of document.querySelectorAll('input[name="boundary"]')) {
    input.disabled = actionInFlight || !state.canInterrupt;
    if (state.boundary !== null) input.checked = input.value === state.boundary;
  }
  nodes["interrupt-button"].disabled = actionInFlight || !state.canInterrupt;
  nodes["restart-button"].disabled = actionInFlight || !state.canRestart;
  nodes["recover-button"].disabled = actionInFlight || !state.canRecover;
  nodes["replay-button"].disabled = actionInFlight || !state.canReplay;
  nodes["reset-button"].disabled = actionInFlight || !state.canReset;
  nodes["action-guidance"].textContent = guidance(state.stage);

  const statuses = new Map(state.timeline.map((item) => [item.phase, item.status]));
  for (const item of nodes["stage-list"].querySelectorAll("li")) {
    item.className = statuses.get(item.dataset.phase) || "";
  }

  nodes["durable-before"].textContent = state.explanation.durableBefore;
  nodes["recovered-after"].textContent = state.explanation.recoveredAfter;
  renderIdentity("before", state.durableBeforeInterruption);
  renderIdentity("after", state.recoveryAfterRestart);
  renderCounts("before", state.durableBeforeInterruption?.counts);
  renderCounts("after", state.recoveryAfterRestart?.counts);

  const after = state.recoveryAfterRestart;
  const converged = verified && after?.counts.mutations === 1 && after.counts.receipts === 1 &&
    after.counts.terminalEvents === 1 && after.counts.actualConsumptionFacts === 2;
  nodes["exact-once-pill"].textContent = converged ? "Exact-once verified" : "Pending";
  nodes["exact-once-pill"].className = `pill ${converged ? "verified" : ""}`;
  nodes["no-mixed-invariant"].classList.toggle("proved", after !== null && !after.mixedTerminalFailureAndMutation);
  const actuals = new Map((after?.actualConsumption || []).map((item) => [item.resourceKey, item.value]));
  nodes["actuals-invariant"].classList.toggle(
    "proved",
    actuals.get("agent_work_units") === 6 && actuals.get("production_cell_minutes") === 30,
  );
  nodes["replay-invariant"].classList.toggle("proved", state.completedReplay?.durableStateUnchanged === true);
  nodes["replay-proof"].textContent = state.explanation.replayProof;

  nodes.timeline.replaceChildren(...state.timeline.map((item) => {
    const row = document.createElement("li");
    const phase = document.createElement("span");
    phase.className = "phase";
    phase.textContent = `${item.sequence} · ${item.phase}`;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("p");
    detail.textContent = item.detail;
    copy.append(title, detail);
    row.append(phase, copy);
    return row;
  }));
  if (state.timeline.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No run has started.";
    nodes.timeline.append(empty);
  }

  if (lastStage !== null && state.stage !== lastStage) {
    nodes.announcer.textContent = stageLabels[state.stage] || state.stage;
    Promise.resolve().then(() => nodes["stage-title"].focus({ preventScroll: true }));
  }
  lastStage = state.stage;
}

function renderIdentity(prefix, evidence) {
  nodes[`${prefix}-fence`].textContent = evidence ? `${evidence.fenceStatus} · ${evidence.fenceId}` : "—";
  nodes[`${prefix}-receipt`].textContent = evidence?.receiptId ?? "None";
  nodes[`${prefix}-claim`].textContent = evidence?.claimState ?? "—";
}

function renderCounts(prefix, counts) {
  const values = counts || {};
  const mappings = {
    acceptances: "acceptances", attempts: "attempts", bindings: "fenceBindings",
    mutations: "mutations", receipts: "receipts", terminals: "terminalEvents", actuals: "actualConsumptionFacts",
  };
  for (const [id, key] of Object.entries(mappings)) {
    nodes[`${prefix}-${id}`].textContent = String(values[key] ?? 0);
  }
}

function guidance(stage) {
  if (stage === "idle") return "Select a boundary, then run until the deterministic stop.";
  if (stage === "interrupted") return "The owning runner is closed. Restart opens the same invocation-owned databases.";
  if (stage === "restarted") return "The fresh runner observed the retained nonterminal state. Continue through the existing recovery path.";
  if (stage === "verified") return "Convergence is verified. Replay once more to prove every durable table remains unchanged.";
  if (stage === "replayed") return "Demonstration complete. Reset to exercise the other deterministic boundary.";
  return "The demonstration stopped safely; reset to begin with fresh invocation-owned databases.";
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

nodes["interrupt-button"].addEventListener("click", () => void act("interrupt"));
nodes["restart-button"].addEventListener("click", () => void act("restart"));
nodes["recover-button"].addEventListener("click", () => void act("recover"));
nodes["replay-button"].addEventListener("click", () => void act("replay"));
nodes["reset-button"].addEventListener("click", () => void act("reset"));

function startPolling() {
  if (poll !== null) window.clearInterval(poll);
  poll = window.setInterval(() => void refresh(), 500);
}

function stopPolling() {
  if (poll === null) return;
  window.clearInterval(poll);
  poll = null;
}

void refresh();
startPolling();
window.addEventListener("pagehide", stopPolling);
window.addEventListener("pageshow", (event) => {
  if (event?.persisted !== true) return;
  startPolling();
  void refresh();
});
