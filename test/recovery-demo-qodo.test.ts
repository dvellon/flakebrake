import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createContext, runInContext } from "node:vm";

import {
  RecoveryDemoCoordinator,
  startRecoveryDemoServer,
  type RecoveryDemoBoundary,
  type RecoveryDemoState,
} from "../src/index.js";
import {
  createRecoveryBrowserCleanup,
  finishRecoveryBrowserSmoke,
} from "./recovery-demo-browser-lifecycle.js";

const temporaryDirectories: string[] = [];
const RECOVERY_SCENARIO = "deterministic_exact_once_recovery";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Qodo finding 1: exact idempotent Recovery responses", () => {
  for (const boundary of [
    "after_execution_fence_before_factory_mutation",
    "after_factory_commit_before_m2_binding",
  ] as const) {
    test(`retries retain the original response for ${boundary}`, async () => {
      const directory = temporaryDirectory("flakebrake-recovery-idempotency-");
      const running = await startRecoveryDemoServer({
        dataRoot: directory,
        port: 0,
        cleanupDataOnClose: false,
      });
      try {
        const requestId = `recovery:concurrent:${boundary}`;
        const attempts = await Promise.all(
          Array.from({ length: 6 }, async () =>
            await postRecovery(running.url, "interrupt", boundary, requestId)),
        );
        assert.equal(attempts.filter((item) => item.replayed === false).length, 1);
        assert.equal(attempts.filter((item) => item.replayed === true).length, 5);
        const original = attempts.find((item) => item.replayed === false);
        assert.notEqual(original, undefined);
        for (const attempt of attempts) assert.deepEqual(attempt.state, original?.state);

        const immediateBefore = await getRecovery(running.url);
        const immediate = await postRecovery(running.url, "interrupt", boundary, requestId);
        const immediateAfter = await getRecovery(running.url);
        assert.equal(immediate.replayed, true);
        assert.deepEqual(immediate.state, original?.state);
        assert.deepEqual(immediateAfter, immediateBefore);

        const conflict = await postRecoveryResponse(
          running.url,
          "restart",
          null,
          requestId,
        );
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body["error"], "idempotency_conflict");
        assert.deepEqual(await getRecovery(running.url), immediateBefore);

        await postRecovery(running.url, "restart", null, `recovery:restart:${boundary}`);
        const afterRestartBefore = await getRecovery(running.url);
        const afterRestart = await postRecovery(running.url, "interrupt", boundary, requestId);
        assert.equal(afterRestart.replayed, true);
        assert.deepEqual(afterRestart.state, original?.state);
        assert.deepEqual(await getRecovery(running.url), afterRestartBefore);

        await postRecovery(running.url, "recover", null, `recovery:recover:${boundary}`);
        const afterRecoveryBefore = await getRecovery(running.url);
        const afterRecovery = await postRecovery(running.url, "interrupt", boundary, requestId);
        assert.deepEqual(afterRecovery.state, original?.state);
        assert.deepEqual(await getRecovery(running.url), afterRecoveryBefore);
        assert.deepEqual(afterRecoveryBefore.recoveryAfterRestart?.counts, {
          acceptances: 1,
          attempts: 1,
          fences: 1,
          fenceBindings: 1,
          mutations: 1,
          receipts: 1,
          terminalEvents: 1,
          terminalFailures: 0,
          actualConsumptionFacts: 2,
        });
      } finally {
        await running.close();
      }
    });
  }
});

describe("Qodo finding 2: monotonic Recovery UI state", () => {
  test("an older poll cannot replace a newer action or terminal state", async () => {
    const idle = identifiedState("idle", 0);
    const interrupted = identifiedState(
      "interrupted",
      1,
      idle.runId,
      "after_execution_fence_before_factory_mutation",
    );
    const stalePoll = deferred<unknown>();
    const actionResponse = deferred<unknown>();
    const harness = await createRecoveryUiHarness(idle, [
      stalePoll.promise,
      actionResponse.promise,
    ]);
    harness.setScroll(420);
    const poll = harness.evaluate<Promise<void>>("refresh()");
    const action = harness.evaluate<Promise<void>>('act("interrupt")');
    actionResponse.resolve({ replayed: false, state: interrupted });
    await action;
    stalePoll.resolve(idle);
    await poll;
    assert.equal(harness.text("stage-pill"), "interrupted");
    assert.equal(
      harness.selectedBoundary(),
      "after_execution_fence_before_factory_mutation",
    );
    assert.equal(harness.scroll(), 420);

    const verified = identifiedState(
      "verified",
      4,
      idle.runId,
      interrupted.boundary,
      0,
    );
    harness.enqueue(Promise.resolve(verified));
    await harness.evaluate<Promise<void>>("refresh()");
    harness.enqueue(Promise.resolve({ ...interrupted, revision: 5, restartGeneration: 1 }));
    await harness.evaluate<Promise<void>>("refresh()");
    assert.equal(harness.text("stage-pill"), "verified");
  });

  test("scenario, boundary, run, restart, reset, and polling identities are bounded", async () => {
    const interrupted = identifiedState(
      "interrupted",
      1,
      "recovery-run/current",
      "after_factory_commit_before_m2_binding",
    );
    const harness = await createRecoveryUiHarness(interrupted, []);
    const invalid = [
      { ...interrupted, scenarioId: "another_scenario", revision: 9 },
      { ...interrupted, boundary: "after_execution_fence_before_factory_mutation", revision: 9 },
      { ...interrupted, runId: "recovery-run/other", revision: 9 },
      { ...interrupted, restartGeneration: 2, revision: 9 },
    ];
    for (const candidate of invalid) {
      harness.enqueue(Promise.resolve(candidate));
      await harness.evaluate<Promise<void>>("refresh()");
      assert.equal(harness.text("stage-pill"), "interrupted");
      assert.deepEqual(harness.identity(), {
        scenarioId: RECOVERY_SCENARIO,
        runId: interrupted.runId,
        boundary: interrupted.boundary,
        restartGeneration: interrupted.restartGeneration,
      });
    }

    const restarted = identifiedState(
      "restarted",
      2,
      interrupted.runId,
      interrupted.boundary,
      1,
    );
    harness.enqueue(Promise.resolve({ replayed: false, state: restarted }));
    await harness.evaluate<Promise<void>>('act("restart")');
    assert.equal(harness.text("stage-pill"), "restarted");

    const failed = { ...restarted, stage: "failed", revision: 3 };
    harness.enqueue(Promise.resolve(failed));
    await harness.evaluate<Promise<void>>("refresh()");
    const reset = identifiedState("idle", 4, "recovery-run/reset");
    harness.enqueue(Promise.resolve({ replayed: false, state: reset }));
    await harness.evaluate<Promise<void>>('act("reset")');
    assert.equal(harness.text("stage-pill"), "idle");

    assert.deepEqual(harness.activeIntervalIds(), [1]);
    harness.fireWindow("pagehide");
    assert.deepEqual(harness.activeIntervalIds(), []);
    harness.fireWindow("pageshow", { persisted: true });
    harness.fireWindow("pageshow", { persisted: true });
    assert.equal(harness.activeIntervalIds().length, 1);
  });
});

describe("Qodo finding 3: exhaustive browser cleanup", () => {
  test("a browser failure cannot skip server or directory cleanup", async () => {
    const attempts: string[] = [];
    const cleanup = createRecoveryBrowserCleanup([
      {
        name: "browser",
        run: async () => {
          attempts.push("browser");
          throw new Error("controlled browser quit failure");
        },
      },
      { name: "server", run: () => { attempts.push("server"); } },
      { name: "directory", run: () => { attempts.push("directory"); } },
    ]);
    const first = cleanup();
    const concurrent = cleanup();
    assert.equal(first, concurrent);
    await assert.rejects(first, /controlled browser quit failure/u);
    assert.deepEqual(attempts, ["browser", "server", "directory"]);
    await assert.rejects(cleanup(), /controlled browser quit failure/u);
    assert.deepEqual(attempts, ["browser", "server", "directory"]);
  });

  test("server failure cannot skip other cleanup and primary errors stay primary", async () => {
    const attempts: string[] = [];
    const primary = new Error("controlled primary runtime failure");
    const cleanup = createRecoveryBrowserCleanup([
      { name: "browser", run: () => { attempts.push("browser"); } },
      {
        name: "server",
        run: () => {
          attempts.push("server");
          throw new Error("controlled server close failure");
        },
      },
      { name: "directory", run: () => { attempts.push("directory"); } },
    ]);
    await assert.rejects(
      finishRecoveryBrowserSmoke(primary, cleanup),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.cause === primary &&
        error.errors[0] === primary &&
        String(error.errors[1]).includes("controlled server close failure"),
    );
    assert.deepEqual(attempts, ["browser", "server", "directory"]);
  });

  test("an injected Selenium quit rejection leaves no owned browser-smoke root", async () => {
    const parent = temporaryDirectory("flakebrake-recovery-browser-parent-");
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist/test/recovery-demo-browser-smoke.js")],
      {
        cwd: process.cwd(),
        env: {
          ...portableTemporaryEnvironment(parent),
          FLAKEBRAKE_RECOVERY_INJECT_DRIVER_QUIT_FAILURE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const result = await waitForChildExit(child, 120_000);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /injected Recovery Selenium shutdown failure/u);
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      await settleChild(child);
    }
  });
});

test("Qodo finding 4: a pre-bound 4177 collision cleans owned state and preserves the owner", async () => {
  const parent = temporaryDirectory("flakebrake-recovery-collision-parent-");
  const external = createServer((socket) => socket.end("external owner\n"));
  let externalClosed = false;
  await listen(external, 4177);
  try {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist/test/recovery-demo-browser-smoke.js")],
      {
        cwd: process.cwd(),
        env: portableTemporaryEnvironment(parent),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const result = await waitForChildExit(child, 15_000);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /EADDRINUSE/u);
      assert.equal(external.listening, true);
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      await settleChild(child);
    }

    await closeServer(external);
    externalClosed = true;
    const cleanDirectory = mkdtempSync(join(parent, "clean-run-"));
    const running = await startRecoveryDemoServer({
      dataRoot: cleanDirectory,
      port: 4177,
      cleanupDataOnClose: false,
    });
    await running.close();
    rmSync(cleanDirectory, { recursive: true, force: true });
  } finally {
    if (!externalClosed) await closeServer(external).catch(() => undefined);
  }
});

interface RecoveryApiResult {
  readonly replayed: boolean;
  readonly state: RecoveryDemoState;
}

async function postRecovery(
  url: string,
  operation: "interrupt" | "restart" | "recover" | "replay" | "reset",
  boundary: RecoveryDemoBoundary | null,
  requestId: string,
): Promise<RecoveryApiResult> {
  const response = await postRecoveryResponse(url, operation, boundary, requestId);
  assert.equal(response.status, 200);
  return response.body as unknown as RecoveryApiResult;
}

async function postRecoveryResponse(
  url: string,
  operation: "interrupt" | "restart" | "recover" | "replay" | "reset",
  boundary: RecoveryDemoBoundary | null,
  requestId: string,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ operation, boundary, requestId }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function getRecovery(url: string): Promise<RecoveryDemoState> {
  const response = await fetch(`${url}/api/recovery`);
  assert.equal(response.status, 200);
  return await response.json() as RecoveryDemoState;
}

interface IdentifiedRecoveryState extends RecoveryDemoState {
  readonly scenarioId: "deterministic_exact_once_recovery";
  readonly runId: string;
  readonly restartGeneration: number;
}

function identifiedState(
  stage: RecoveryDemoState["stage"],
  revision: number,
  runId = "recovery-run/initial",
  boundary: RecoveryDemoBoundary | null = null,
  restartGeneration = 0,
): IdentifiedRecoveryState {
  const directory = temporaryDirectory("flakebrake-recovery-ui-state-");
  const coordinator = new RecoveryDemoCoordinator({
    dataRoot: directory,
    cleanupDataOnClose: false,
  });
  const base = coordinator.state();
  coordinator.close();
  return {
    ...base,
    scenarioId: RECOVERY_SCENARIO,
    runId,
    restartGeneration,
    stage,
    revision,
    boundary,
    canInterrupt: stage === "idle",
    canRestart: stage === "interrupted",
    canRecover: stage === "restarted",
    canReplay: stage === "verified",
    canReset: stage !== "idle" && stage !== "closed",
  };
}

interface FakeNode {
  id: string;
  textContent: string;
  className: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  dataset: Record<string, string>;
  classList: {
    readonly values: Set<string>;
    add(...items: string[]): void;
    remove(...items: string[]): void;
    toggle(item: string, force?: boolean): boolean;
  };
  addEventListener(name: string, listener: () => void): void;
  querySelectorAll(selector: string): readonly FakeNode[];
  replaceChildren(...children: FakeNode[]): void;
  append(...children: FakeNode[]): void;
  focus(options?: { readonly preventScroll?: boolean }): void;
}

async function createRecoveryUiHarness(
  initial: IdentifiedRecoveryState,
  responses: readonly Promise<unknown>[],
): Promise<{
  evaluate<T>(source: string): T;
  enqueue(...responses: readonly Promise<unknown>[]): void;
  text(id: string): string;
  activeIntervalIds(): readonly number[];
  fireWindow(name: string, event?: unknown): void;
  identity(): {
    readonly scenarioId: string;
    readonly runId: string;
    readonly boundary: string | null;
    readonly restartGeneration: number;
  };
  selectedBoundary(): string | null;
  setScroll(value: number): void;
  scroll(): number;
}> {
  const html = readFileSync(join(process.cwd(), "ui/recovery/index.html"), "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1] as string);
  const nodes = new Map<string, FakeNode>();
  let scrollY = 0;
  const makeNode = (id: string, value = ""): FakeNode => {
    const values = new Set<string>();
    const children: FakeNode[] = [];
    const listeners = new Map<string, (() => void)[]>();
    return {
      id,
      textContent: "",
      className: "",
      disabled: false,
      checked: false,
      value,
      dataset: {},
      classList: {
        values,
        add: (...items) => { for (const item of items) values.add(item); },
        remove: (...items) => { for (const item of items) values.delete(item); },
        toggle: (item, force) => {
          const active = force ?? !values.has(item);
          if (active) values.add(item);
          else values.delete(item);
          return active;
        },
      },
      addEventListener: (name, listener) => {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      querySelectorAll: () => [],
      replaceChildren: (...items) => {
        children.length = 0;
        children.push(...items);
      },
      append: (...items) => { children.push(...items); },
      focus: (options) => {
        if (options?.preventScroll !== true) scrollY = 0;
      },
    };
  };
  for (const id of ids) nodes.set(id, makeNode(id));
  const boundaryInputs = [
    makeNode("boundary-fence", "after_execution_fence_before_factory_mutation"),
    makeNode("boundary-factory", "after_factory_commit_before_m2_binding"),
  ];
  boundaryInputs[0]!.checked = true;
  const responseQueue = [Promise.resolve(initial), ...responses];
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const activeIntervals = new Set<number>();
  let intervalSequence = 0;
  let timeoutSequence = 100;
  const context = createContext({
    console,
    Date,
    document: {
      querySelectorAll: (selector: string) =>
        selector === "[id]" ? [...nodes.values()] : boundaryInputs,
      querySelector: () => boundaryInputs.find((input) => input.checked) ?? null,
      createElement: (tag: string) => makeNode(tag),
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => await (responseQueue.shift() as Promise<unknown>),
    }),
    setInterval: () => {
      intervalSequence += 1;
      activeIntervals.add(intervalSequence);
      return intervalSequence;
    },
    clearInterval: (id: number) => { activeIntervals.delete(id); },
    setTimeout: () => {
      timeoutSequence += 1;
      return timeoutSequence;
    },
    clearTimeout: () => undefined,
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      const current = windowListeners.get(name) ?? [];
      current.push(listener);
      windowListeners.set(name, current);
    },
  });
  (context as Record<string, unknown>)["window"] = context;
  runInContext(readFileSync(join(process.cwd(), "ui/recovery/app.js"), "utf8"), context);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  return {
    evaluate: <T>(source: string): T => runInContext(source, context) as T,
    enqueue: (...items) => { responseQueue.push(...items); },
    text: (id) => nodes.get(id)?.textContent ?? "",
    activeIntervalIds: () => [...activeIntervals].sort((left, right) => left - right),
    fireWindow: (name, event) => {
      for (const listener of windowListeners.get(name) ?? []) listener(event);
    },
    identity: () => ({
      scenarioId: runInContext("state.scenarioId", context) as string,
      runId: runInContext("state.runId", context) as string,
      boundary: runInContext("state.boundary", context) as string | null,
      restartGeneration: runInContext("state.restartGeneration", context) as number,
    }),
    selectedBoundary: () =>
      boundaryInputs.find((input) => input.checked)?.value ?? null,
    setScroll: (value) => { scrollY = value; },
    scroll: () => scrollY,
  };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function portableTemporaryEnvironment(directory: string): NodeJS.ProcessEnv {
  const absolute = resolve(directory);
  if (!isAbsolute(absolute)) throw new TypeError("Recovery temporary root must be absolute");
  return { ...process.env, TMPDIR: absolute, TMP: absolute, TEMP: absolute };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForChildExit(
  child: ChildProcess,
  timeout: number,
): Promise<{ readonly code: number | null; readonly output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  if (child.exitCode !== null) return { code: child.exitCode, output };
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error("Recovery browser child did not exit promptly")),
      timeout,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit({ code, output });
    });
  });
}

async function settleChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForChildExit(child, 5_000).catch(() => undefined);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) rejectClose(error);
      else resolveClose();
    });
  });
}
