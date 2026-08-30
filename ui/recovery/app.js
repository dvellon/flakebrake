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
let lastStage = null;
let toastTimer = null;

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

async function refresh() {
  try {
    const candidate = await api("/api/recovery");
    state = candidate;
    nodes["connection-dot"].classList.add("connected");
    nodes["connection-label"].textContent = "Loopback connected";
    render();
  } catch (error) {
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
  try {
    const result = await api("/api/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, boundary, requestId: requestId(operation) }),
    });
    state = result.state;
    render();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Action failed safely");
    await refresh();
  } finally {
    actionInFlight = false;
    render();
  }
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

void refresh();
const poll = window.setInterval(() => void refresh(), 500);
window.addEventListener("pagehide", () => window.clearInterval(poll));
