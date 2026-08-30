import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TrueForge,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";

import { FACTORY_MCP_SERVICE_NAMES } from "./mcp.js";
import type { RunningFactoryMcpHttpCluster } from "./mcp-http.js";
import { retainM4RunnerCleanupDiagnostics } from "./m4-runner-lifecycle.js";

export const TRUEFORGE_SERVER_VERSION = "0.1.4";
export const TRUEFORGE_SDK_VERSION = "0.1.3";
export const FLAKEBRAKE_ROOT_AGENT_NAME =
  "flakebrake-root-obligation-commander";
export const DETERMINISTIC_MODEL_PROVIDER_NAME =
  "flakebrake-deterministic";
export const DETERMINISTIC_MODEL_NAME = "m4-mission";

export interface TrueForgeServerOptions {
  readonly sqlitePath: string;
  readonly localSandboxRootParent: string;
  readonly port?: number;
  readonly signal?: AbortSignal;
}

export interface RunningTrueForgeServer {
  readonly version: "0.1.4";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly baseUrl: string;
  readonly client: TrueForge;
  readonly process: ChildProcessWithoutNullStreams;
  readonly safeDiagnosticLog: () => string;
  readonly close: () => Promise<void>;
}

export async function startTrueForgeServer(
  options: TrueForgeServerOptions,
): Promise<RunningTrueForgeServer> {
  requirePath(options.sqlitePath, "sqlitePath");
  requirePath(options.localSandboxRootParent, "localSandboxRootParent");
  throwIfAborted(options.signal);
  const port = options.port ?? (await allocateLoopbackPort(options.signal));
  const cliPath = fileURLToPath(
    new URL(
      "../../node_modules/@truefoundry/trueforge/dist/cli.js",
      import.meta.url,
    ),
  );
  const codeModeTempRoot = `/tmp/fbtf-${String(port)}`;
  const logs = new BoundedProcessLog();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let localSandboxCompatibility: LocalSandboxCompatibility | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await mkdir(codeModeTempRoot, { recursive: true, mode: 0o700 });
    throwIfAborted(options.signal);
    localSandboxCompatibility = await prepareLocalSandboxCompatibility(
      options.localSandboxRootParent,
    );
    throwIfAborted(options.signal);
    child = spawn(process.execPath, [cliPath, "--port", String(port)], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        SQLITE_PATH: options.sqlitePath,
        XDG_DATA_HOME: options.localSandboxRootParent,
        TMPDIR: codeModeTempRoot,
        TMP: codeModeTempRoot,
        TEMP: codeModeTempRoot,
        NODE_ENV: "production",
        STANDALONE: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => logs.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => logs.append(chunk));
    await waitForTrueForge(baseUrl, child, logs, options.signal);
  } catch (error: unknown) {
    const cleanupFailures = await closeTrueForgeResources(
      child,
      localSandboxCompatibility,
      codeModeTempRoot,
      options.signal?.aborted === true,
    );
    if (error instanceof Error) {
      retainM4RunnerCleanupDiagnostics(error, cleanupFailures);
    }
    throw error;
  }
  const runningChild = child;
  const runningSandboxCompatibility = localSandboxCompatibility;
  const client = new TrueForge({ baseUrl, auth: false, maxRetries: 0 });
  let closePromise: Promise<void> | undefined;
  return {
    version: TRUEFORGE_SERVER_VERSION,
    host: "127.0.0.1",
    port,
    baseUrl,
    client,
    process: runningChild,
    safeDiagnosticLog: () => logs.safeText(),
    close: async () => {
      closePromise ??= (async () => {
        const cleanupFailures = await closeTrueForgeResources(
          runningChild,
          runningSandboxCompatibility,
          codeModeTempRoot,
          options.signal?.aborted === true,
        );
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            cleanupFailures,
            "TrueForge deterministic runtime teardown failed",
          );
        }
      })();
      await closePromise;
    },
  };
}

interface LocalSandboxCompatibility {
  readonly close: () => Promise<void>;
}

/**
 * TrueForge 0.1.4's local fallback creates an isolated venv and unconditionally
 * imports Pydantic, although its bundled Code Mode client is explicitly
 * stdlib-only. Offline deterministic tests therefore add the smallest possible
 * import marker to each newly created, genuine local sandbox. The marker lives
 * inside the sandbox root, is never imported by generated mission code, and
 * does not intercept sandbox execution or MCP traffic.
 */
async function prepareLocalSandboxCompatibility(
  xdgDataHome: string,
): Promise<LocalSandboxCompatibility> {
  const sandboxParent = join(xdgDataHome, "trueforge", "sandboxes");
  await mkdir(sandboxParent, { recursive: true, mode: 0o700 });
  let stopped = false;
  let failure: unknown;
  const loop = (async () => {
    while (!stopped) {
      try {
        const sessionDirectories = await readdir(sandboxParent, {
          withFileTypes: true,
        });
        const sandboxRoots = (
          await Promise.all(
            sessionDirectories
              .filter(
                (child) =>
                  child.isDirectory() && /^[0-9a-z]{26}$/u.test(child.name),
              )
              .map(async (sessionDirectory) => {
                const sessionRoot = join(sandboxParent, sessionDirectory.name);
                const children = await readdir(sessionRoot, {
                  withFileTypes: true,
                });
                return children
                  .filter(
                    (child) =>
                      child.isDirectory() &&
                      /^[0-9a-z]{26}$/u.test(child.name),
                  )
                  .map((child) => join(sessionRoot, child.name));
              }),
          )
        ).flat();
        await Promise.all(
          sandboxRoots.map((sandboxRoot) =>
            installLocalPydanticImportMarker(sandboxRoot),
          ),
        );
      } catch (error: unknown) {
        if (!stopped) {
          failure = error;
          break;
        }
      }
      await delay(2);
    }
  })();
  return {
    close: async () => {
      stopped = true;
      await loop;
      if (failure !== undefined) throw failure;
    },
  };
}

async function installLocalPydanticImportMarker(
  sandboxRoot: string,
): Promise<void> {
  const moduleDirectory = join(sandboxRoot, "pydantic");
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      join(moduleDirectory, "__init__.py"),
      '__version__ = "2.0.0-trueforge-stdlib-compat"\n',
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function registerFactoryMcpConnectors(
  client: TrueForge,
  cluster: RunningFactoryMcpHttpCluster,
): Promise<ReadonlyMap<(typeof FACTORY_MCP_SERVICE_NAMES)[number], string>> {
  const registered = new Map<
    (typeof FACTORY_MCP_SERVICE_NAMES)[number],
    string
  >();
  for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
    const service = cluster.services.get(serviceName);
    if (service === undefined) throw new Error(`Missing ${serviceName} HTTP service`);
    const response = await client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: serviceName,
        description: connectorDescription(serviceName),
        type: "remote",
        url: service.url,
      },
    });
    if (response.data.manifest.url !== service.url) {
      throw new Error(`TrueForge registered an unexpected URL for ${serviceName}`);
    }
    registered.set(serviceName, service.url);
  }
  return registered;
}

export async function configureDeterministicModelProvider(
  client: TrueForge,
  baseUrl: string,
): Promise<void> {
  const manifest: TrueForgeApi.ModelProviderManifest = {
    type: "custom",
    name: DETERMINISTIC_MODEL_PROVIDER_NAME,
    baseUrl,
    models: [
      {
        name: DETERMINISTIC_MODEL_NAME,
        modelId: DETERMINISTIC_MODEL_NAME,
        properties: {
          contextLength: 64_000,
          maxOutputTokens: 8_192,
        },
      },
    ],
  };
  await client.settings.modelProviders.createOrUpdate({ manifest });
}

export async function ensureFlakeBrakeRootAgent(
  client: TrueForge,
  modelName = `${DETERMINISTIC_MODEL_PROVIDER_NAME}/${DETERMINISTIC_MODEL_NAME}`,
): Promise<TrueForgeApi.Agent> {
  const manifest = flakeBrakeRootAgentSpec(modelName);
  const listed = await client.agents.list();
  const existing = listed.data.find(
    (candidate) => candidate.name === FLAKEBRAKE_ROOT_AGENT_NAME,
  );
  if (existing === undefined) {
    return (
      await client.agents.create({
        name: FLAKEBRAKE_ROOT_AGENT_NAME,
        manifest,
      })
    ).data;
  }
  return (await client.agents.update(existing.id, { manifest })).data;
}

export function flakeBrakeRootAgentSpec(
  modelName: string,
): TrueForgeApi.AgentSpec {
  return {
    model: { name: modelName },
    instructions: rootAgentInstructions(),
    config: {
      askUserQuestions: { enabled: false },
      iterationLimit: 96,
      sandbox: { enabled: true, fileDownloads: false },
      dynamicSubAgents: { enabled: true },
    },
    mcpServers: [
      {
        name: "factory-orders",
        preload: true,
        enableTools: ["@all"],
        requireApprovalForTools: [],
      },
      {
        name: "factory-capacity",
        preload: true,
        enableTools: ["@all"],
        requireApprovalForTools: [],
      },
      {
        name: "factory-simulator",
        preload: true,
        enableTools: ["@all"],
        requireApprovalForTools: [],
      },
      {
        name: "factory-change-control",
        preload: true,
        enableTools: ["@all"],
        requireApprovalForTools: [
          "select_portfolio_modification",
          "accept_promise",
          "create_schedule_reservation",
          "submit_schedule_change",
        ],
      },
    ],
  };
}

function rootAgentInstructions(): string {
  return `You are the FlakeBrake root obligation commander. You alone communicate with the owner.

For the microfactory mission, create exactly three dynamic subagents named and titled by their name:
1. Portfolio and order analyst
2. Capacity and schedule analyst
3. Assurance and simulation engineer

Each receives a self-contained assignment and must return compact JSON with exactly these keys: findings, evidence_references, proposed_actions, dependencies, typed_effects, resource_work_classes, alternatives. The portfolio analyst must read orders and proposals. The capacity analyst must read the capacity plan and actual consumption and evaluate the current hero admission. The assurance engineer must use the genuine sandbox exec tool and mcp_client to read multiple FlakeBrake MCP services and mechanically recompute demand, ranking, and protected-order preservation.

After all three complete, retain their evidence. Call record_current_admission exactly once and do not inspect or parse its large response. Immediately call prepare_portfolio_modification, then pass only its returned arguments object byte-for-byte to select_portfolio_modification. Next call prepare_promise_acceptance and pass only its returned arguments object byte-for-byte to accept_promise. These are the owner's MODIFY and ACCEPT PROMISE choices. Never invent IDs, inspect dumped preparation files, combine owner-decision calls in generated code, or drop or move protected work.

For each schedule proposal, call prepare_schedule_effect and pass only its returned arguments object exactly to the named consequential tool; never call an owner-decision or consequential tool inside sandbox generated code. First prepare create_schedule_reservation with attempt/m4-denied-primary, microfactory-effect/v1, and 2026-08-26T09:10:00.000Z–2026-08-26T09:40:00.000Z. If denied, prepare the identical material effect once through submit_schedule_change using attempt/m4-denied-alternate and microfactory-effect/v2 so the active denial is mechanically demonstrated. Then prepare the genuinely different create_schedule_reservation alternative using attempt/m4-approved-alternative, microfactory-effect/v1, and 2026-08-26T09:40:00.000Z–2026-08-26T10:10:00.000Z. Do not recreate the three-subagent investigation after denial.

After an approved write, independently call read_schedule_state, then call verify_schedule_execution. Report completion only when read_execution_status shows a terminal verified M2 attempt. Every tool argument must use exact IDs and immutable values returned by prior tools.`;
}

function connectorDescription(
  serviceName: (typeof FACTORY_MCP_SERVICE_NAMES)[number],
): string {
  switch (serviceName) {
    case "factory-orders":
      return "FlakeBrake authoritative accepted orders and proposals";
    case "factory-capacity":
      return "FlakeBrake authoritative capacity and actual consumption";
    case "factory-simulator":
      return "FlakeBrake deterministic non-mutating schedule simulation";
    case "factory-change-control":
      return "FlakeBrake M2-fenced synthetic schedule change control";
  }
}

async function allocateLoopbackPort(signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: "resolve" | "reject", error?: unknown): void => {
        if (settled) return;
        settled = true;
        server.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        if (outcome === "resolve") resolve();
        else reject(error);
      };
      const onError = (error: Error): void => settle("reject", error);
      const onAbort = (): void => settle("reject", abortReason(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      server.once("error", onError);
      server.listen(
        { host: "127.0.0.1", port: 0, ...(signal === undefined ? {} : { signal }) },
        () => settle("resolve"),
      );
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Unable to allocate a loopback port");
    }
    return address.port;
  } finally {
    await closeListeningServer(server);
  }
}

async function waitForTrueForge(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  logs: BoundedProcessLog,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null) {
      throw new Error(
        `TrueForge 0.1.4 exited during startup (${String(child.exitCode)}): ${logs.safeText()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.ok && (await response.text()) === "OK!") return;
    } catch (error: unknown) {
      if (signal?.aborted === true) throw abortReason(signal);
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await abortableDelay(50, signal);
  }
  throw new Error(`TrueForge 0.1.4 startup timed out: ${logs.safeText()}`);
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  cancellation = false,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(cancellation ? "SIGTERM" : "SIGINT");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(cancellation ? 1_000 : 5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGTERM");
    const terminated = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      delay(cancellation ? 1_000 : 5_000).then(() => false),
    ]);
    if (!terminated && child.exitCode === null) {
      child.kill("SIGKILL");
      const killed = await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        delay(2_000).then(() => false),
      ]);
      if (!killed && child.exitCode === null) {
        throw new Error("TrueForge child did not exit after bounded termination");
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return delay(milliseconds);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeTrueForgeResources(
  child: ChildProcessWithoutNullStreams | undefined,
  localSandboxCompatibility: LocalSandboxCompatibility | undefined,
  codeModeTempRoot: string,
  cancellation = false,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const close of [
    child === undefined ? undefined : () => stopChild(child, cancellation),
    localSandboxCompatibility === undefined
      ? undefined
      : () => localSandboxCompatibility.close(),
    () => rm(codeModeTempRoot, { recursive: true, force: true }),
  ]) {
    if (close === undefined) continue;
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  return failures;
}

function closeListeningServer(server: import("node:net").Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function requirePath(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`${field} must be non-empty`);
}

class BoundedProcessLog {
  #value = "";

  public append(chunk: Buffer): void {
    this.#value = `${this.#value}${chunk.toString("utf8")}`.slice(-16_384);
  }

  public safeText(): string {
    return this.#value
      .replace(/(api[_-]?key["'\s:=]+)[^\s,"'}]+/giu, "$1<redacted>")
      .replace(/(authorization["'\s:=]+bearer\s+)[^\s,"'}]+/giu, "$1<redacted>");
  }
}
