import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  startM5BrowserSmokeInvocation,
  type BoundM5BrowserSmokeServer,
  type M5BrowserSmokeInvocation,
} from "./m5-browser-launcher.js";

test("the capacity browser smoke requests an invocation-owned dynamic port", () => {
  const smokeSource = readFileSync(resolve("test/m5-browser-smoke.ts"), "utf8");
  const launcherSource = readFileSync(resolve("test/m5-browser-launcher.ts"), "utf8");
  assert.doesNotMatch(`${smokeSource}\n${launcherSource}`, /port:\s*4176\b/u);
  assert.match(launcherSource, /port:\s*0\b/u);
});

test("an unrelated 4176 listener cannot affect the capacity smoke launcher", async () => {
  const unrelated = createServer();
  await listen(unrelated, 4176);
  let invocation: M5BrowserSmokeInvocation | null = null;
  try {
    invocation = await startM5BrowserSmokeInvocation();
    assert.notEqual(invocation.port, 4173);
    assert.notEqual(invocation.port, 4176);
    assert.equal(new URL(invocation.url).hostname, "127.0.0.1");
    await assertCapacityProjection(invocation, "blocked-4176");
    const selectedPort = invocation.port;
    const dataRoot = invocation.dataRoot;
    await invocation.close();
    invocation = null;
    assert.equal(unrelated.listening, true);
    assert.equal(existsSync(dataRoot), false);
    await assertPortAvailable(selectedPort);
  } finally {
    await invocation?.close();
    await close(unrelated);
  }
});

test("two concurrent capacity smoke launchers receive distinct ports and clean up", async () => {
  const [first, second] = await Promise.all([
    startM5BrowserSmokeInvocation(),
    startM5BrowserSmokeInvocation(),
  ]);
  try {
    assert.notEqual(first.port, 4173);
    assert.notEqual(second.port, 4173);
    assert.notEqual(first.port, second.port);
    assert.notEqual(first.dataRoot, second.dataRoot);
    await Promise.all([
      assertCapacityProjection(first, "concurrent-first"),
      assertCapacityProjection(second, "concurrent-second"),
    ]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  assert.equal(existsSync(first.dataRoot), false);
  assert.equal(existsSync(second.dataRoot), false);
  await Promise.all([assertPortAvailable(first.port), assertPortAvailable(second.port)]);
});

test("a post-bind startup failure releases its dynamic port before a clean retry", async () => {
  const primaryError = new Error("injected failure after authoritative port assignment");
  const failedBindings: BoundM5BrowserSmokeServer[] = [];
  await assert.rejects(
    startM5BrowserSmokeInvocation({
      afterBinding: (server) => {
        failedBindings.push(server);
        throw primaryError;
      },
    }),
    (error: unknown) => error === primaryError,
  );
  assert.equal(failedBindings.length, 1);
  const released = failedBindings[0] as BoundM5BrowserSmokeServer;
  assert.notEqual(released.port, 4173);
  assert.equal(existsSync(released.dataRoot), false);
  await assertPortAvailable(released.port);

  const retry = await startM5BrowserSmokeInvocation();
  try {
    assert.notEqual(retry.port, 4173);
    await assertCapacityProjection(retry, "post-failure-retry");
  } finally {
    await retry.close();
  }
  assert.equal(existsSync(retry.dataRoot), false);
  await assertPortAvailable(retry.port);
});

test("cleanup diagnostics retain the test failure as the primary error", async () => {
  const invocation = await startM5BrowserSmokeInvocation();
  const primaryError = new Error("primary browser assertion failure");
  const cleanupError = new Error("injected cleanup diagnostic");
  invocation.own(async () => {
    throw cleanupError;
  });
  await assert.rejects(invocation.fail(primaryError), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primaryError);
    assert.equal(error.errors[0], primaryError);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.equal((error.errors[1] as AggregateError).errors[0], cleanupError);
    return true;
  });
  assert.equal(existsSync(invocation.dataRoot), false);
  await assertPortAvailable(invocation.port);
});

async function assertCapacityProjection(
  server: BoundM5BrowserSmokeServer,
  requestSuffix: string,
): Promise<void> {
  const response = await fetch(`${server.url}/api/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: server.url },
    body: JSON.stringify({
      scenarioId: "capacity-shock",
      requestId: `dynamic-port-${requestSuffix}`,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    readonly state: {
      readonly scenario: {
        readonly scenarioId: string;
        readonly initialDecision: string;
        readonly currentCapacityPlanVersion: string;
      };
    };
  };
  assert.equal(body.state.scenario.scenarioId, "capacity-shock");
  assert.equal(body.state.scenario.initialDecision, "ADMITTABLE");
  assert.equal(body.state.scenario.currentCapacityPlanVersion, "capacity-plan/v2");
}

async function assertPortAvailable(port: number): Promise<void> {
  const probe = createServer();
  try {
    await listen(probe, port);
  } finally {
    await close(probe);
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}
