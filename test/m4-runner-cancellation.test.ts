import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DeterministicM4RunnerOwnership,
  retainM4RunnerCleanupDiagnostics,
} from "../src/m4-runner-lifecycle.js";
import {
  runDeterministicM4Mission,
  type DeterministicM4MissionOptions,
} from "../src/m4-runner.js";
import type { M4MissionCheckpoint } from "../src/m4-mission-controller.js";

test(
  "deterministic runner aborts after four MCP listeners and the model listener",
  { timeout: 30_000 },
  async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-cancel-five-"));
    const serversBefore = new Set(activeServerHandles());
    const childrenBefore = new Set(activeChildProcessHandles());
    const cancellation = new AbortController();
    const signal = AbortSignal.any([context.signal, cancellation.signal]);
    const reason = new Error("test timeout after deterministic listener acquisition");
    const mission = runDeterministicM4Mission(missionOptions(directory, signal));
    try {
      await waitFor(
        () => newServerHandles(serversBefore).length === 5,
        15_000,
        context.signal,
      );
      assert.equal(newServerHandles(serversBefore).length, 5);
      cancellation.abort(reason);
      await rejectsPromptly(mission, reason, 2_000);
      await waitFor(
        () =>
          newServerHandles(serversBefore).length === 0 &&
          newChildHandles(childrenBefore).length === 0,
        10_000,
        context.signal,
      );
    } finally {
      cancellation.abort(reason);
      await mission.catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "deterministic runner aborts after all six runtime listeners and preserves an unrelated listener",
  { timeout: 45_000 },
  async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-m4-cancel-six-"));
    const unrelated = createServer((_request, response) => response.end("unrelated"));
    await listen(unrelated);
    const unrelatedAddress = unrelated.address();
    assert.ok(unrelatedAddress !== null && typeof unrelatedAddress !== "string");
    const serversBefore = new Set(activeServerHandles());
    const childrenBefore = new Set(activeChildProcessHandles());
    const cancellation = new AbortController();
    const signal = AbortSignal.any([context.signal, cancellation.signal]);
    const reason = new Error("test timeout after TrueForge readiness");
    let checkpoint: M4MissionCheckpoint | undefined;
    let parentRuntimeListenersAtCheckpoint = 0;
    let trueForgeChildrenAtCheckpoint = 0;
    const mission = runDeterministicM4Mission({
      ...missionOptions(directory, signal),
      checkpointObserver: (observed) => {
        if (checkpoint !== undefined) return;
        checkpoint = observed;
        parentRuntimeListenersAtCheckpoint = newServerHandles(serversBefore).length;
        trueForgeChildrenAtCheckpoint = newChildHandles(childrenBefore).length;
        cancellation.abort(reason);
      },
    });
    try {
      await rejectsPromptly(mission, reason, 15_000);
      assert.ok(checkpoint, "a post-TrueForge-readiness checkpoint must be reached");
      assert.equal(parentRuntimeListenersAtCheckpoint, 5);
      assert.equal(trueForgeChildrenAtCheckpoint, 1);
      assert.equal(newServerHandles(serversBefore).length, 0);
      await waitFor(
        () => newChildHandles(childrenBefore).length === 0,
        10_000,
        context.signal,
      );
      assert.equal(unrelated.listening, true);
      assert.equal(await connectionCount(unrelated), 0);
    } finally {
      cancellation.abort(reason);
      await mission.catch(() => undefined);
      await closeServer(unrelated);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("late acquisition settlement closes immediately and late rejection is observed", async () => {
  const cancellation = new AbortController();
  const ownership = new DeterministicM4RunnerOwnership(cancellation.signal);
  const acquisition = deferred<{ readonly name: string }>();
  const reason = new Error("abandoned acquisition");
  let closeCount = 0;
  const pending = ownership.acquire(
    () => acquisition.promise,
    async () => {
      closeCount += 1;
    },
  );
  cancellation.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  await ownership.close();
  acquisition.resolve({ name: "late runtime" });
  await waitFor(() => closeCount === 1, 1_000);

  const rejectionCancellation = new AbortController();
  const rejectionOwnership = new DeterministicM4RunnerOwnership(
    rejectionCancellation.signal,
  );
  const lateRejection = deferred<{ readonly name: string }>();
  const unhandled: unknown[] = [];
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", observeUnhandled);
  try {
    const rejectedAcquisition = rejectionOwnership.acquire(
      () => lateRejection.promise,
      async () => undefined,
    );
    rejectionCancellation.abort(reason);
    await assert.rejects(
      rejectedAcquisition,
      (error: unknown) => error === reason,
    );
    lateRejection.reject(new Error("late startup rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", observeUnhandled);
    await rejectionOwnership.close();
  }
});

test("cleanup rejection retains the primary abort and does not short-circuit reverse teardown", async () => {
  const cancellation = new AbortController();
  const ownership = new DeterministicM4RunnerOwnership(cancellation.signal);
  const order: string[] = [];
  ownership.own("first", async (name) => {
    order.push(name);
  });
  ownership.own("second", async (name) => {
    order.push(name);
    throw new Error("second close failed");
  });
  ownership.own("third", async (name) => {
    order.push(name);
  });
  const reason = new Error("authoritative timeout");
  const primary = retainM4RunnerCleanupDiagnostics(
    reason,
    ownership.cleanupFailures,
  );
  cancellation.abort(reason);
  const failures = await ownership.close();
  assert.equal(primary, reason);
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /second close failed/u);
  assert.deepEqual(primary.cleanupFailures, failures);
});

test("repeated and concurrent teardown close each owned resource exactly once", async () => {
  const ownership = new DeterministicM4RunnerOwnership();
  let closeCount = 0;
  ownership.own("runtime", async () => {
    closeCount += 1;
    await Promise.resolve();
  });
  const first = ownership.close();
  const second = ownership.close();
  assert.equal(first, second);
  const [firstFailures, secondFailures] = await Promise.all([first, second]);
  assert.equal(firstFailures, secondFailures);
  assert.deepEqual(firstFailures, []);
  assert.deepEqual(await ownership.close(), []);
  assert.equal(closeCount, 1);
});

test("concurrent abort and completion converge on one terminal ownership result", async () => {
  const cancellation = new AbortController();
  const ownership = new DeterministicM4RunnerOwnership(cancellation.signal);
  const completion = deferred<string>();
  let closeCount = 0;
  ownership.own("runtime", async () => {
    closeCount += 1;
  });
  const reason = new Error("concurrent cancellation");
  const pending = ownership.wait(() => completion.promise);
  completion.resolve("complete");
  cancellation.abort(reason);
  const outcome = await pending.then(
    (value) => ({ kind: "completed" as const, value }),
    (error: unknown) => ({ kind: "aborted" as const, error }),
  );
  if (outcome.kind === "completed") assert.equal(outcome.value, "complete");
  else assert.equal(outcome.error, reason);
  await Promise.all([ownership.close(), ownership.close()]);
  assert.equal(closeCount, 1);
});

test(
  "cancelled deterministic runner exits naturally with zero invocation-owned handles",
  { timeout: 30_000 },
  async (context) => {
    const source = `
      import assert from "node:assert/strict";
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { runDeterministicM4Mission } from "./dist/src/m4-runner.js";
      const handles = () => process._getActiveHandles();
      const servers = () => handles().filter((handle) => handle?.constructor?.name === "Server" && handle.listening === true);
      const children = () => handles().filter((handle) => handle?.constructor?.name === "ChildProcess");
      const root = mkdtempSync(join(tmpdir(), "flakebrake-natural-exit-"));
      const serversBefore = new Set(servers());
      const childrenBefore = new Set(children());
      const controller = new AbortController();
      const reason = new Error("natural-exit cancellation");
      const mission = runDeterministicM4Mission({
        m2DatabasePath: join(root, "m2.sqlite"),
        factoryDatabasePath: join(root, "factory.sqlite"),
        missionDatabasePath: join(root, "mission.sqlite"),
        trueforgeDatabasePath: join(root, "trueforge.sqlite"),
        localSandboxRootParent: join(root, "trueforge-data"),
        signal: controller.signal,
      });
      const deadline = Date.now() + 15000;
      while (servers().filter((handle) => !serversBefore.has(handle)).length !== 5 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      controller.abort(reason);
      await assert.rejects(mission, (error) => error === reason);
      const cleanupDeadline = Date.now() + 10000;
      while (Date.now() < cleanupDeadline) {
        const ownedServers = servers().filter((handle) => !serversBefore.has(handle));
        const ownedChildren = children().filter((handle) => !childrenBefore.has(handle));
        if (ownedServers.length === 0 && ownedChildren.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ownedServers = servers().filter((handle) => !serversBefore.has(handle)).length;
      const ownedChildren = children().filter((handle) => !childrenBefore.has(handle)).length;
      rmSync(root, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ ownedServers, ownedChildren }) + "\\n");
      assert.equal(ownedServers, 0);
      assert.equal(ownedChildren, 0);
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: tmpdir(),
          TMP: tmpdir(),
          TEMP: tmpdir(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stopOnTestAbort = (): void => {
      child.kill("SIGTERM");
    };
    context.signal.addEventListener("abort", stopOnTestAbort, { once: true });
    try {
      const exit = await new Promise<{ readonly code: number | null; readonly signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      assert.deepEqual(exit, { code: 0, signal: null }, stderr);
      assert.match(stdout, /"ownedServers":0,"ownedChildren":0/u);
    } finally {
      context.signal.removeEventListener("abort", stopOnTestAbort);
    }
  },
);

function missionOptions(
  directory: string,
  signal: AbortSignal,
): DeterministicM4MissionOptions {
  return {
    m2DatabasePath: join(directory, "m2.sqlite"),
    factoryDatabasePath: join(directory, "factory.sqlite"),
    missionDatabasePath: join(directory, "mission.sqlite"),
    trueforgeDatabasePath: join(directory, "trueforge.sqlite"),
    localSandboxRootParent: join(directory, "trueforge-data"),
    signal,
  };
}

function activeServerHandles(): Server[] {
  return activeHandles().filter(
    (handle): handle is Server => handle instanceof Server && handle.listening,
  );
}

function activeChildProcessHandles(): unknown[] {
  return activeHandles().filter(
    (handle) =>
      typeof handle === "object" &&
      handle !== null &&
      (handle as { constructor?: { name?: string } }).constructor?.name ===
        "ChildProcess",
  );
}

function activeHandles(): readonly unknown[] {
  return (
    process as unknown as { _getActiveHandles: () => readonly unknown[] }
  )._getActiveHandles();
}

function newServerHandles(before: ReadonlySet<Server>): Server[] {
  return activeServerHandles().filter((handle) => !before.has(handle));
}

function newChildHandles(before: ReadonlySet<unknown>): unknown[] {
  return activeChildProcessHandles().filter((handle) => !before.has(handle));
}

async function rejectsPromptly(
  promise: Promise<unknown>,
  reason: unknown,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  assert.notEqual(outcome.kind, "timeout", "runner did not settle promptly after abort");
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (signal?.aborted === true) throw signal.reason;
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle boundary");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function connectionCount(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}
