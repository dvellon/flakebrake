import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SyntheticFactoryEnvironment } from "../src/factory-environment.js";
import {
  HERO_HORIZON_END,
  createHeroInitialState,
} from "../src/hero-fixture.js";
import { startDeterministicM4Model } from "../src/m4-deterministic-model.js";
import {
  DeterministicM4RunnerOwnership,
  m4RunnerCleanupFailures,
  retainM4RunnerCleanupDiagnostics,
} from "../src/m4-runner-lifecycle.js";
import {
  runDeterministicM4Mission,
  type DeterministicM4MissionOptions,
} from "../src/m4-runner.js";
import type { M4MissionCheckpoint } from "../src/m4-mission-controller.js";
import { startFactoryMcpHttpService } from "../src/mcp-http.js";
import { createStore } from "../src/store.js";

const OBJECT_ABORT_MARKER = "private-object-cancellation-payload";
let objectAbortStringifications = 0;
const objectAbortReason = {
  kind: "deterministic cancellation",
  toString: () => {
    objectAbortStringifications += 1;
    return OBJECT_ABORT_MARKER;
  },
};

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

test(
  "MCP abort owns a pending handler, bounds its drain, and joins explicit teardown",
  { timeout: 15_000 },
  async (context) => {
    const fixture = createHttpFixture("flakebrake-mcp-abort-handler-");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([context.signal, cancellation.signal]);
    const observer = observeIncomingBody();
    const socket = new Socket();
    socket.on("error", () => undefined);
    const service = await startFactoryMcpHttpService(
      "factory-change-control",
      httpServiceOptions(fixture, signal),
    );
    const server = serverForPort(service.port);
    const originalClose = server.close;
    let closeCalls = 0;
    let closeObserved = false;
    server.once("close", () => {
      closeObserved = true;
    });
    server.close = function (callback?: (error?: Error) => void): Server {
      closeCalls += 1;
      return originalClose.call(this, callback);
    };
    try {
      await connectSocket(socket, service.port, service.host);
      const body = mcpRequestBody();
      const split = Math.floor(body.length / 2);
      writeHttpRequest(socket, service.host, body, body.slice(0, split));
      await observer.started;
      assert.equal(await connectionCount(server), 1);

      const abortStarted = Date.now();
      cancellation.abort(new Error("pending MCP handler cancellation"));
      await waitFor(() => !server.listening, 2_000, context.signal);
      assert.equal(
        observer.requestClosed(),
        false,
        "stopping admission is not handler settlement",
      );
      assert.equal(await connectionCount(server), 1);
      assert.equal(closeObserved, false);

      const first = service.close();
      const second = service.close();
      assert.equal(first, second);
      await Promise.all([first, second]);
      assert.ok(
        Date.now() - abortStarted >= 400,
        "the pending handler receives its bounded drain before force settlement",
      );
      assert.equal(closeCalls, 1);
      assert.equal(closeObserved, true);
      assert.equal(observer.requestClosed(), true);
      assert.equal(await connectionCount(server), 0);
      assert.equal(socket.destroyed, true);

      await service.close();
      assert.equal(closeCalls, 1);
    } finally {
      observer.restore();
      server.close = originalClose;
      socket.destroy();
      cancellation.abort();
      await service.close().catch(() => undefined);
      fixture.remove();
    }
  },
);

test(
  "MCP abort closes an accepted keep-alive socket without touching an unrelated listener",
  { timeout: 10_000 },
  async (context) => {
    const fixture = createHttpFixture("flakebrake-mcp-abort-socket-");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([context.signal, cancellation.signal]);
    const unrelated = createServer((_request, response) => response.end("unrelated"));
    await listen(unrelated);
    const socket = new Socket();
    socket.on("error", () => undefined);
    const service = await startFactoryMcpHttpService(
      "factory-change-control",
      httpServiceOptions(fixture, signal),
    );
    const server = serverForPort(service.port);
    try {
      await connectSocket(socket, service.port, service.host);
      socket.resume();
      assert.equal(await connectionCount(server), 1);
      cancellation.abort(new Error("keep-alive cancellation"));
      await Promise.all([service.close(), service.close()]);
      assert.equal(await connectionCount(server), 0);
      await waitFor(() => socket.destroyed, 1_000, context.signal);
      assert.equal(socket.destroyed, true);
      assert.equal(unrelated.listening, true);
      assert.equal(await connectionCount(unrelated), 0);
    } finally {
      socket.destroy();
      cancellation.abort();
      await service.close().catch(() => undefined);
      await closeServer(unrelated);
      fixture.remove();
    }
  },
);

test(
  "MCP close permits bounded handler drain before force settlement",
  { timeout: 10_000 },
  async () => {
    const fixture = createHttpFixture("flakebrake-mcp-drain-");
    const observer = observeIncomingBody();
    const socket = new Socket();
    socket.on("error", () => undefined);
    const service = await startFactoryMcpHttpService(
      "factory-change-control",
      httpServiceOptions(fixture),
    );
    try {
      await connectSocket(socket, service.port, service.host);
      const body = "{\"jsonrpc\":!}";
      const split = Math.floor(body.length / 2);
      writeHttpRequest(socket, service.host, body, body.slice(0, split));
      await observer.started;
      const closeStarted = Date.now();
      const closing = service.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.write(body.slice(split));
      await closing;
      assert.equal(observer.requestClosed(), true);
      assert.ok(
        Date.now() - closeStarted < 450,
        "a handler that settles inside the drain window is not held to timeout",
      );
    } finally {
      observer.restore();
      socket.destroy();
      await service.close().catch(() => undefined);
      fixture.remove();
    }
  },
);

test(
  "MCP forced drain cancels a completed-body handler without injecting a stream error",
  { timeout: 15_000 },
  async (context) => {
    const fixture = createHttpFixture("flakebrake-mcp-complete-body-stall-");
    const stalled = installStalledMcpTransport();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([context.signal, cancellation.signal]);
    const primary = new Error("completed-body handler cancellation");
    const client = new Socket();
    client.on("error", () => undefined);
    const service = await startFactoryMcpHttpService(
      "factory-change-control",
      httpServiceOptions(fixture, signal),
    );
    const server = serverForPort(service.port);
    const acceptedSocket = nextConnection(server);
    const originalClose = server.close;
    let closeCalls = 0;
    server.close = function (callback?: (error?: Error) => void): Server {
      closeCalls += 1;
      return originalClose.call(this, callback);
    };
    try {
      await connectSocket(client, service.port, service.host);
      const body = mcpRequestBody();
      writeHttpRequest(client, service.host, body, body);
      const socket = await acceptedSocket;
      await stalled.started;
      assert.equal(stalled.request()?.complete, true);
      assert.equal(stalled.request()?.readableEnded, true);
      const socketErrorListenersWithLifecycle = socket.listenerCount("error");
      const requestErrorListeners = stalled.request()?.listenerCount("error");
      const responseErrorListeners = stalled.response()?.listenerCount("error");

      const abortStarted = Date.now();
      cancellation.abort(primary);
      const first = service.close();
      const second = service.close();
      assert.equal(first, second);
      await Promise.all([first, second]);
      assert.ok(Date.now() - abortStarted >= 400);
      assert.equal(closeCalls, 1);
      assert.equal(stalled.transportCloseCalls(), 1);
      assert.equal(stalled.handlerSettled(), true);
      assert.equal(stalled.request()?.destroyed, true);
      assert.equal(stalled.response()?.destroyed, true);
      assert.equal(socket.destroyed, true);
      assert.equal(await connectionCount(server), 0);
      assert.equal(
        socket.listenerCount("error"),
        socketErrorListenersWithLifecycle - 1,
      );
      assert.equal(stalled.request()?.listenerCount("error"), requestErrorListeners);
      assert.equal(
        stalled.response()?.listenerCount("error"),
        responseErrorListeners,
      );
      const diagnostics = m4RunnerCleanupFailures(primary);
      assert.equal(diagnostics.length, 1);
      assert.match(
        String(diagnostics[0]),
        /shutdown aborted an incomplete request/u,
      );

      await service.close();
      assert.equal(closeCalls, 1);
    } finally {
      server.close = originalClose;
      client.destroy();
      cancellation.abort(primary);
      await service.close().catch(() => undefined);
      stalled.restore();
      fixture.remove();
    }
  },
);

test(
  "MCP forced drain normalizes every mission abort reason once",
  { timeout: 90_000 },
  async (context) => {
    const cases: readonly {
      readonly label: string;
      readonly abort: (controller: AbortController) => void;
      readonly originalReason?: unknown;
      readonly normalized: boolean;
      readonly forbiddenMessage?: string;
    }[] = [
      {
        label: "Error reason preserves identity",
        abort: (controller) =>
          controller.abort(new Error("authoritative Error cancellation")),
        normalized: false,
      },
      {
        label: "string reason has a safe diagnostic and exact cause",
        abort: (controller) => controller.abort("private string cancellation"),
        originalReason: "private string cancellation",
        normalized: true,
        forbiddenMessage: "private string cancellation",
      },
      {
        label: "object reason has a safe diagnostic and exact cause",
        abort: (controller) => controller.abort(objectAbortReason),
        originalReason: objectAbortReason,
        normalized: true,
        forbiddenMessage: OBJECT_ABORT_MARKER,
      },
      {
        label: "default reason remains diagnosable",
        abort: (controller) => controller.abort(),
        normalized: false,
      },
    ];
    for (const testCase of cases) {
      await context.test(testCase.label, async () => {
        const directory = mkdtempSync(
          join(tmpdir(), "flakebrake-mcp-non-error-abort-"),
        );
        const stalled = installStalledMcpTransport();
        const cancellation = new AbortController();
        const mission = runDeterministicM4Mission(
          missionOptions(directory, cancellation.signal),
        );
        const stringificationsBefore = objectAbortStringifications;
        try {
          await stalled.started;
          assert.equal(stalled.request()?.complete, true);
          assert.equal(stalled.request()?.readableEnded, true);
          testCase.abort(cancellation);
          const originalReason: unknown = cancellation.signal.reason;
          const failure = await mission.then(
            () => {
              throw new Error("aborted MCP mission unexpectedly completed");
            },
            (error: unknown) => error,
          );
          assert.ok(failure instanceof Error);
          if (testCase.normalized) {
            assert.equal(failure.name, "AbortError");
            assert.equal(failure.message, "The operation was aborted");
            assert.equal(failure.cause, testCase.originalReason);
            if (testCase.forbiddenMessage !== undefined) {
              assert.doesNotMatch(
                failure.message,
                new RegExp(testCase.forbiddenMessage, "u"),
              );
            }
          } else {
            assert.equal(failure, originalReason);
          }
          const diagnostics = m4RunnerCleanupFailures(failure);
          assert.equal(
            diagnostics.length,
            1,
            "the normalized mission abort must retain forced-drain diagnostics",
          );
          assert.match(
            String(diagnostics[0]),
            /shutdown aborted an incomplete request/u,
          );
          assert.ok(diagnostics[0] instanceof Error);
          assert.equal(diagnostics[0].cause, failure);
          assert.equal(objectAbortStringifications, stringificationsBefore);
        } finally {
          if (!cancellation.signal.aborted) cancellation.abort();
          await mission.catch(() => undefined);
          stalled.restore();
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "MCP completed-body forced drain exits a real subprocess without a stream crash",
  { timeout: 20_000 },
  async (context) => {
    const source = `
      import assert from "node:assert/strict";
      import { mkdtempSync, rmSync } from "node:fs";
      import { IncomingMessage, ServerResponse } from "node:http";
      import { Socket } from "node:net";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
      import { SyntheticFactoryEnvironment } from "./dist/src/factory-environment.js";
      import { HERO_HORIZON_END, createHeroInitialState } from "./dist/src/hero-fixture.js";
      import { m4RunnerCleanupFailures } from "./dist/src/m4-runner-lifecycle.js";
      import { startFactoryMcpHttpService } from "./dist/src/mcp-http.js";
      import { createStore } from "./dist/src/store.js";
      const root = mkdtempSync(join(tmpdir(), "flakebrake-forced-drain-child-"));
      const m2DatabasePath = join(root, "m2.sqlite");
      const factoryDatabasePath = join(root, "factory.sqlite");
      createStore({ path: m2DatabasePath, initialState: createHeroInitialState(), now: () => HERO_HORIZON_END }).close();
      new SyntheticFactoryEnvironment({ path: factoryDatabasePath, now: () => HERO_HORIZON_END }).close();
      const ordering = [];
      const record = (event, details = {}) => {
        ordering.push({ event, ...details });
        process.stdout.write(JSON.stringify(ordering.at(-1)) + "\\n");
      };
      process.on("uncaughtExceptionMonitor", (error, origin) => record("uncaught-exception", { origin, message: error.message }));
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      let release;
      const originalHandle = StreamableHTTPServerTransport.prototype.handleRequest;
      const originalTransportClose = StreamableHTTPServerTransport.prototype.close;
      StreamableHTTPServerTransport.prototype.handleRequest = async function (request, response) {
        assert.ok(request instanceof IncomingMessage);
        assert.ok(response instanceof ServerResponse);
        request.removeAllListeners("error");
        const originalDestroy = request.destroy.bind(request);
        request.destroy = function (error) {
          record("request-destroy", { injectedError: error?.message ?? null, errorListeners: this.listenerCount("error") });
          if (error !== undefined) queueMicrotask(() => this.emit("error", error));
          this.destroy = originalDestroy;
          return originalDestroy();
        };
        record("handler-stalled", { complete: request.complete, readableEnded: request.readableEnded, requestErrorListeners: request.listenerCount("error"), responseErrorListeners: response.listenerCount("error") });
        markStarted();
        await new Promise((resolve) => { release = resolve; });
        record("handler-settled");
      };
      StreamableHTTPServerTransport.prototype.close = async function () {
        record("transport-close");
        release?.();
        await originalTransportClose.call(this);
      };
      const controller = new AbortController();
      const primary = new Error("subprocess forced drain");
      const service = await startFactoryMcpHttpService("factory-change-control", {
        m2DatabasePath,
        factoryDatabasePath,
        now: () => HERO_HORIZON_END,
        enableM4Tools: true,
        signal: controller.signal,
      });
      const server = process._getActiveHandles().find((handle) => {
        if (handle?.constructor?.name !== "Server") return false;
        const address = handle.address?.();
        return typeof address === "object" && address?.port === service.port;
      });
      assert.ok(server);
      let accepted;
      let socketErrorListenersWithLifecycle = 0;
      server.once("connection", (socket) => {
        accepted = socket;
        socketErrorListenersWithLifecycle = socket.listenerCount("error");
        socket.once("close", () => record("server-socket-close"));
        record("server-socket-accepted");
      });
      server.once("close", () => record("server-close"));
      const client = new Socket();
      client.on("error", () => undefined);
      client.once("close", () => record("client-socket-close"));
      await new Promise((resolve, reject) => {
        client.once("error", reject);
        client.connect(service.port, service.host, resolve);
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_current_admission", arguments: {} } });
      client.write("POST /mcp HTTP/1.1\\r\\nHost: " + service.host + "\\r\\nContent-Type: application/json\\r\\nAccept: application/json, text/event-stream\\r\\nMCP-Protocol-Version: 2025-03-26\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\nConnection: keep-alive\\r\\n\\r\\n" + body);
      record("complete-request-written");
      await started;
      record("abort-triggered");
      controller.abort(primary);
      await service.close();
      record("close-completed");
      const deadline = Date.now() + 1000;
      while (!client.destroyed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(client.destroyed, true);
      assert.equal(accepted?.destroyed, true);
      assert.equal(accepted?.listenerCount("error"), socketErrorListenersWithLifecycle - 1);
      assert.equal(await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count))), 0);
      const diagnostics = m4RunnerCleanupFailures(primary);
      assert.equal(diagnostics.length, 1);
      assert.match(String(diagnostics[0]), /shutdown aborted an incomplete request/u);
      StreamableHTTPServerTransport.prototype.handleRequest = originalHandle;
      StreamableHTTPServerTransport.prototype.close = originalTransportClose;
      rmSync(root, { recursive: true, force: true });
      record("result", { ownedServers: 0, ownedSockets: 0, diagnostics: diagnostics.length });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: tmpdir(),
        TMP: tmpdir(),
        TEMP: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectChildOutput(child);
    const stopOnTestAbort = (): void => {
      child.kill("SIGTERM");
    };
    context.signal.addEventListener("abort", stopOnTestAbort, { once: true });
    try {
      const exit = await childExit(child);
      const captured = await output;
      assert.deepEqual(exit, { code: 0, signal: null }, captured.stderr);
      assert.doesNotMatch(captured.stdout, /uncaught-exception/u);
      assert.match(
        captured.stdout,
        /"event":"request-destroy","injectedError":null,"errorListeners":0/u,
      );
      assert.match(captured.stdout, /"handler-settled"/u);
      assert.match(captured.stdout, /"close-completed"/u);
      assert.match(
        captured.stdout,
        /"event":"result","ownedServers":0,"ownedSockets":0,"diagnostics":1/u,
      );
    } finally {
      context.signal.removeEventListener("abort", stopOnTestAbort);
    }
  },
);

test("unexpected MCP socket error remains visible and cleanup can retry", async () => {
  const fixture = createHttpFixture("flakebrake-mcp-socket-error-");
  const service = await startFactoryMcpHttpService(
    "factory-change-control",
    httpServiceOptions(fixture),
  );
  const server = serverForPort(service.port);
  const acceptedSocket = nextConnection(server);
  const client = new Socket();
  client.on("error", () => undefined);
  const failure = new Error("unexpected owned MCP socket error");
  try {
    await connectSocket(client, service.port, service.host);
    const socket = await acceptedSocket;
    const socketErrorListenersWithLifecycle = socket.listenerCount("error");
    socket.emit("error", failure);
    await assert.rejects(service.close(), (error: unknown) => error === failure);
    await service.close();
    await service.close();
    assert.equal(socket.destroyed, true);
    assert.equal(
      socket.listenerCount("error"),
      socketErrorListenersWithLifecycle - 1,
    );
  } finally {
    client.destroy();
    await service.close().catch(() => undefined);
    fixture.remove();
  }
});

test("client disconnect racing MCP forced drain settles only the owned socket", async () => {
  const fixture = createHttpFixture("flakebrake-mcp-disconnect-race-");
  const cancellation = new AbortController();
  const observer = observeIncomingBody();
  const unrelated = createServer((_request, response) => response.end("unrelated"));
  await listen(unrelated);
  const service = await startFactoryMcpHttpService(
    "factory-change-control",
    httpServiceOptions(fixture, cancellation.signal),
  );
  const server = serverForPort(service.port);
  const acceptedSocket = nextConnection(server);
  const client = new Socket();
  client.on("error", () => undefined);
  try {
    await connectSocket(client, service.port, service.host);
    const socket = await acceptedSocket;
    const socketErrorListenersWithLifecycle = socket.listenerCount("error");
    const body = mcpRequestBody();
    writeHttpRequest(client, service.host, body, body.slice(0, 1));
    await observer.started;
    cancellation.abort(new Error("client disconnect race"));
    client.destroy();
    await service.close();
    assert.equal(socket.destroyed, true);
    assert.equal(
      socket.listenerCount("error"),
      socketErrorListenersWithLifecycle - 1,
    );
    assert.equal(await connectionCount(server), 0);
    assert.equal(unrelated.listening, true);
  } finally {
    observer.restore();
    client.destroy();
    cancellation.abort();
    await service.close().catch(() => undefined);
    await closeServer(unrelated);
    fixture.remove();
  }
});

test("MCP close failure remains visible and retains ownership for retry", async () => {
  const fixture = createHttpFixture("flakebrake-mcp-close-retry-");
  const service = await startFactoryMcpHttpService(
    "factory-change-control",
    httpServiceOptions(fixture),
  );
  const server = serverForPort(service.port);
  const originalClose = server.close;
  const failure = Object.assign(new Error("planned MCP close failure"), {
    code: "ERR_SERVER_NOT_RUNNING",
  });
  let closeCalls = 0;
  server.close = function (callback?: (error?: Error) => void): Server {
    closeCalls += 1;
    if (closeCalls === 1) {
      queueMicrotask(() => callback?.(failure));
      return this;
    }
    return originalClose.call(this, callback);
  };
  try {
    await assert.rejects(service.close(), (error: unknown) => error === failure);
    assert.equal(server.listening, true);
    await service.close();
    await service.close();
    assert.equal(closeCalls, 2);
  } finally {
    server.close = originalClose;
    await service.close().catch(() => undefined);
    fixture.remove();
  }
});

test("model abort and natural completion share exactly one close operation", async () => {
  const fixture = createHttpFixture("flakebrake-model-abort-close-");
  const cancellation = new AbortController();
  const model = await startDeterministicM4Model({
    m2DatabasePath: fixture.m2DatabasePath,
    factoryDatabasePath: fixture.factoryDatabasePath,
    signal: cancellation.signal,
  });
  const server = serverForPort(model.port);
  const originalClose = server.close;
  let closeCalls = 0;
  server.close = function (callback?: (error?: Error) => void): Server {
    closeCalls += 1;
    return originalClose.call(this, callback);
  };
  try {
    const naturalClose = model.close();
    cancellation.abort(new Error("model close race"));
    const abortClose = model.close();
    assert.equal(naturalClose, abortClose);
    await Promise.all([naturalClose, abortClose]);
    await model.close();
    assert.equal(closeCalls, 1);
  } finally {
    server.close = originalClose;
    cancellation.abort();
    await model.close().catch(() => undefined);
    fixture.remove();
  }
});

test("model abort followed by owned close joins the abort-triggered operation", async () => {
  const fixture = createHttpFixture("flakebrake-model-abort-first-");
  const cancellation = new AbortController();
  const model = await startDeterministicM4Model({
    m2DatabasePath: fixture.m2DatabasePath,
    factoryDatabasePath: fixture.factoryDatabasePath,
    signal: cancellation.signal,
  });
  const server = serverForPort(model.port);
  const originalClose = server.close;
  let closeCalls = 0;
  server.close = function (callback?: (error?: Error) => void): Server {
    closeCalls += 1;
    return originalClose.call(this, callback);
  };
  try {
    cancellation.abort(new Error("model abort before owned close"));
    await waitFor(() => !server.listening, 1_000);
    await Promise.all([model.close(), model.close()]);
    assert.equal(closeCalls, 1);
  } finally {
    server.close = originalClose;
    cancellation.abort();
    await model.close().catch(() => undefined);
    fixture.remove();
  }
});

test("genuine model close failure is not normalized and can be retried", async () => {
  const fixture = createHttpFixture("flakebrake-model-close-retry-");
  const model = await startDeterministicM4Model({
    m2DatabasePath: fixture.m2DatabasePath,
    factoryDatabasePath: fixture.factoryDatabasePath,
  });
  const server = serverForPort(model.port);
  const originalClose = server.close;
  const failure = Object.assign(new Error("genuine model close failure"), {
    code: "ERR_SERVER_NOT_RUNNING",
  });
  let closeCalls = 0;
  server.close = function (callback?: (error?: Error) => void): Server {
    closeCalls += 1;
    if (closeCalls === 1) {
      queueMicrotask(() => callback?.(failure));
      return this;
    }
    return originalClose.call(this, callback);
  };
  try {
    await assert.rejects(model.close(), (error: unknown) => error === failure);
    assert.equal(server.listening, true);
    await model.close();
    await model.close();
    assert.equal(closeCalls, 2);
  } finally {
    server.close = originalClose;
    await model.close().catch(() => undefined);
    fixture.remove();
  }
});

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

interface HttpFixture {
  readonly directory: string;
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly remove: () => void;
}

function installStalledMcpTransport(): {
  readonly started: Promise<void>;
  readonly request: () => IncomingMessage | undefined;
  readonly response: () => ServerResponse | undefined;
  readonly handlerSettled: () => boolean;
  readonly transportCloseCalls: () => number;
  readonly restore: () => void;
} {
  const originalHandle = StreamableHTTPServerTransport.prototype.handleRequest;
  const originalClose = StreamableHTTPServerTransport.prototype.close;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseHandler: (() => void) | undefined;
  let capturedRequest: IncomingMessage | undefined;
  let capturedResponse: ServerResponse | undefined;
  let settled = false;
  let closeCalls = 0;
  StreamableHTTPServerTransport.prototype.handleRequest = async function (
    request,
    response,
  ) {
    capturedRequest = request;
    capturedResponse = response;
    markStarted?.();
    await new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    settled = true;
  };
  StreamableHTTPServerTransport.prototype.close = async function () {
    closeCalls += 1;
    releaseHandler?.();
    await originalClose.call(this);
  };
  return {
    started,
    request: () => capturedRequest,
    response: () => capturedResponse,
    handlerSettled: () => settled,
    transportCloseCalls: () => closeCalls,
    restore: () => {
      releaseHandler?.();
      StreamableHTTPServerTransport.prototype.handleRequest = originalHandle;
      StreamableHTTPServerTransport.prototype.close = originalClose;
    },
  };
}

function nextConnection(server: Server): Promise<Socket> {
  return new Promise((resolve) => {
    server.once("connection", resolve);
  });
}

function collectChildOutput(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.once("close", () => resolve({ stdout, stderr }));
  });
}

function childExit(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function createHttpFixture(prefix: string): HttpFixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const m2DatabasePath = join(directory, "m2.sqlite");
  const factoryDatabasePath = join(directory, "factory.sqlite");
  const store = createStore({
    path: m2DatabasePath,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_END,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  store.close();
  factory.close();
  return {
    directory,
    m2DatabasePath,
    factoryDatabasePath,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function httpServiceOptions(fixture: HttpFixture, signal?: AbortSignal) {
  return {
    m2DatabasePath: fixture.m2DatabasePath,
    factoryDatabasePath: fixture.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
    enableM4Tools: true,
    ...(signal === undefined ? {} : { signal }),
  };
}

function serverForPort(port: number): Server {
  const server = activeHandles().find((handle): handle is Server => {
    if (!(handle instanceof Server)) return false;
    const address = handle.address();
    return typeof address === "object" && address?.port === port;
  });
  assert.ok(server, `expected an owned HTTP server on port ${String(port)}`);
  return server;
}

function connectSocket(socket: Socket, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, host, resolve);
  });
}

function mcpRequestBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "record_current_admission", arguments: {} },
  });
}

function writeHttpRequest(
  socket: Socket,
  host: string,
  completeBody: string,
  initialBody: string,
): void {
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-03-26\r\nContent-Length: ${String(Buffer.byteLength(completeBody))}\r\nConnection: keep-alive\r\n\r\n${initialBody}`,
  );
}

function observeIncomingBody(): {
  readonly started: Promise<void>;
  readonly requestClosed: () => boolean;
  readonly restore: () => void;
} {
  const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let closed = false;
  IncomingMessage.prototype[Symbol.asyncIterator] = function () {
    this.once("close", () => {
      closed = true;
    });
    markStarted?.();
    return originalIterator.call(this);
  };
  return {
    started,
    requestClosed: () => closed,
    restore: () => {
      IncomingMessage.prototype[Symbol.asyncIterator] = originalIterator;
    },
  };
}

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
