import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalClone, canonicalSerialize, deepFreeze } from "./canonical.js";
import {
  inspectRecoveryDemo,
  interruptRecoveryDemonstration,
  recoverRecoveryDemonstration,
  replayCompletedRecoveryDemonstration,
  restartRecoveryDemonstration,
  type RecoveryDemoBoundary,
  type RecoveryDemoEvidence,
  type RecoveryDemoPaths,
  type RecoveryDemoReplayEvidence,
} from "./recovery-demo-runner.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

const LOOPBACK_HOST = "127.0.0.1";
const RECOVERY_STATE_SCHEMA = "flakebrake-recovery-demo-state/v1";
const RECOVERY_SCENARIO_ID = "deterministic_exact_once_recovery";
const OWNERSHIP_MARKER = ".flakebrake-recovery-demo-owned-v1";
const MAX_BODY_BYTES = 8 * 1024;

export type RecoveryDemoStage =
  | "idle"
  | "interrupted"
  | "restarted"
  | "verified"
  | "replayed"
  | "failed"
  | "closed";

export interface RecoveryDemoState {
  readonly schemaVersion: typeof RECOVERY_STATE_SCHEMA;
  readonly mode: "recovery_demonstration";
  readonly scenarioId: typeof RECOVERY_SCENARIO_ID;
  readonly runId: string;
  readonly restartGeneration: number;
  readonly revision: number;
  readonly stage: RecoveryDemoStage;
  readonly boundary: RecoveryDemoBoundary | null;
  readonly canInterrupt: boolean;
  readonly canRestart: boolean;
  readonly canRecover: boolean;
  readonly canReplay: boolean;
  readonly canReset: boolean;
  readonly runnerClosedAtBoundary: boolean;
  readonly error: string | null;
  readonly durableBeforeInterruption: RecoveryDemoEvidence | null;
  readonly recoveryAfterRestart: RecoveryDemoEvidence | null;
  readonly completedReplay: RecoveryDemoReplayEvidence | null;
  readonly explanation: {
    readonly durableBefore: string;
    readonly recoveredAfter: string;
    readonly replayProof: string;
  };
  readonly timeline: readonly {
    readonly sequence: number;
    readonly phase: "setup" | "interruption" | "restart" | "recovery" | "verification" | "replay";
    readonly title: string;
    readonly detail: string;
    readonly status: "complete" | "current";
  }[];
}

export interface RecoveryDemoCoordinatorOptions {
  readonly dataRoot: string;
  readonly cleanupDataOnClose?: boolean;
}

export class RecoveryDemoRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryDemoRequestError";
  }
}

export class RecoveryDemoCoordinator {
  readonly #dataRoot: string;
  readonly #cleanupDataOnClose: boolean;
  readonly #paths: RecoveryDemoPaths;
  readonly #timeline: RecoveryDemoState["timeline"][number][] = [];
  #runId = recoveryRunId();
  #restartGeneration = 0;
  #revision = 0;
  #stage: RecoveryDemoStage = "idle";
  #boundary: RecoveryDemoBoundary | null = null;
  #before: RecoveryDemoEvidence | null = null;
  #after: RecoveryDemoEvidence | null = null;
  #replay: RecoveryDemoReplayEvidence | null = null;
  #runnerClosedAtBoundary = false;
  #error: string | null = null;

  public constructor(options: RecoveryDemoCoordinatorOptions) {
    if (!isAbsolute(options.dataRoot)) {
      throw new TypeError("Recovery demonstration dataRoot must be absolute");
    }
    this.#dataRoot = resolve(options.dataRoot);
    this.#cleanupDataOnClose = options.cleanupDataOnClose ?? true;
    this.#paths = {
      m2DatabasePath: join(this.#dataRoot, "m2.sqlite"),
      factoryDatabasePath: join(this.#dataRoot, "factory.sqlite"),
    };
    establishOwnedDataRoot(this.#dataRoot);
  }

  public interrupt(boundary: RecoveryDemoBoundary): RecoveryDemoState {
    this.#requireStage("idle");
    this.#boundary = boundary;
    try {
      this.#record(
        "setup",
        "Authorized attempt prepared",
        "One accepted promise, one bounded grant, and one claimed execution attempt are durable.",
      );
      this.#before = interruptRecoveryDemonstration(this.#paths, boundary);
      this.#runnerClosedAtBoundary = true;
      this.#stage = "interrupted";
      this.#record(
        "interruption",
        "Owning runner closed at the selected boundary",
        boundary === "after_execution_fence_before_factory_mutation"
          ? "The active execution fence is durable; the factory has no mutation or receipt."
          : "The factory mutation and receipt are durable; M2 has no receipt binding or terminal event.",
      );
      this.#bump();
      return this.state();
    } catch (error: unknown) {
      this.#fail(error);
      throw error;
    }
  }

  public restart(): RecoveryDemoState {
    this.#requireStage("interrupted");
    this.#restartGeneration += 1;
    try {
      this.#after = restartRecoveryDemonstration(
        this.#paths,
        this.#requireBoundary(),
      );
      this.#stage = "restarted";
      this.#record(
        "restart",
        "Fresh runner reopened the same databases",
        "The durable fence, attempt, factory evidence, and database identities were retained without adding facts.",
      );
      this.#bump();
      return this.state();
    } catch (error: unknown) {
      this.#fail(error);
      throw error;
    }
  }

  public recover(): RecoveryDemoState {
    this.#requireStage("restarted");
    try {
      this.#after = recoverRecoveryDemonstration(
        this.#paths,
        this.#requireBoundary(),
      );
      this.#stage = "verified";
      this.#record(
        "recovery",
        this.#boundary === "after_execution_fence_before_factory_mutation"
          ? "Existing executor resumed the active fence"
          : "Authoritative recovery bound the committed receipt",
        this.#boundary === "after_execution_fence_before_factory_mutation"
          ? "The executor reused the durable attempt and fence, then committed exactly one factory result."
          : "Recovery independently found the factory result and added the missing M2 fence binding.",
      );
      this.#record(
        "verification",
        "Independent verification reached terminal success",
        "Read-back matched the immutable command and fence; two actual-consumption facts and one terminal event are durable.",
      );
      this.#bump();
      return this.state();
    } catch (error: unknown) {
      this.#fail(error);
      throw error;
    }
  }

  public replay(): RecoveryDemoState {
    this.#requireStage("verified");
    try {
      this.#replay = replayCompletedRecoveryDemonstration(
        this.#paths,
        this.#requireBoundary(),
      );
      this.#after = this.#replay;
      this.#stage = "replayed";
      this.#record(
        "replay",
        "Completed replay added nothing",
        "The executor and verifier both reported replay, every count stayed fixed, and the full durable-state digest was unchanged.",
      );
      this.#bump();
      return this.state();
    } catch (error: unknown) {
      this.#fail(error);
      throw error;
    }
  }

  public reset(): RecoveryDemoState {
    if (this.#stage === "closed") {
      throw new RecoveryDemoRequestError(409, "closed", "The recovery demonstration is closed");
    }
    removeOwnedDatabaseArtifacts(this.#paths);
    this.#timeline.length = 0;
    this.#runId = recoveryRunId();
    this.#restartGeneration = 0;
    this.#stage = "idle";
    this.#boundary = null;
    this.#before = null;
    this.#after = null;
    this.#replay = null;
    this.#runnerClosedAtBoundary = false;
    this.#error = null;
    this.#bump();
    return this.state();
  }

  public state(): RecoveryDemoState {
    if (
      this.#boundary !== null &&
      this.#stage !== "idle" &&
      this.#stage !== "failed" &&
      this.#before !== null
    ) {
      // Read-only refresh proves UI state still comes from the owned databases.
      const current = inspectRecoveryDemo(this.#paths, this.#boundary);
      if (this.#stage === "interrupted" || this.#stage === "restarted") {
        this.#after = current;
      } else if (this.#stage === "verified" || this.#stage === "replayed") {
        this.#after = current;
      }
    }
    const beforeText = this.#boundary === null
      ? "Choose one deterministic boundary, then deliberately close the runner."
      : this.#boundary === "after_execution_fence_before_factory_mutation"
        ? "Durable before stop: one active M2 execution fence; zero factory mutations, receipts, terminal events, or actual facts."
        : "Durable before stop: one factory mutation and receipt behind an active fence; zero M2 receipt bindings, terminal events, or actual facts.";
    return {
      schemaVersion: RECOVERY_STATE_SCHEMA,
      mode: "recovery_demonstration",
      scenarioId: RECOVERY_SCENARIO_ID,
      runId: this.#runId,
      restartGeneration: this.#restartGeneration,
      revision: this.#revision,
      stage: this.#stage,
      boundary: this.#boundary,
      canInterrupt: this.#stage === "idle",
      canRestart: this.#stage === "interrupted",
      canRecover: this.#stage === "restarted",
      canReplay: this.#stage === "verified",
      canReset: !["idle", "closed"].includes(this.#stage),
      runnerClosedAtBoundary: this.#runnerClosedAtBoundary,
      error: this.#error,
      durableBeforeInterruption: this.#before,
      recoveryAfterRestart: this.#after,
      completedReplay: this.#replay,
      explanation: {
        durableBefore: beforeText,
        recoveredAfter:
          this.#after?.claimState === "terminal_verified"
            ? "Recovery completed: exactly one mutation, one receipt, one terminal event, and two actual-consumption facts."
            : "Recovery has not run; the attempt remains nonterminal and no success is exposed.",
        replayProof:
          this.#replay?.durableStateUnchanged === true
            ? "Replay proof: executor replay + verifier replay; the full durable-state digest did not change."
            : "Replay proof is pending after verified convergence.",
      },
      timeline: this.#timeline,
    };
  }

  public close(): void {
    if (this.#stage === "closed") return;
    this.#stage = "closed";
    this.#bump();
    if (this.#cleanupDataOnClose) {
      requireOwnershipMarker(this.#dataRoot);
      rmSync(this.#dataRoot, { recursive: true, force: true });
    }
  }

  #record(
    phase: RecoveryDemoState["timeline"][number]["phase"],
    title: string,
    detail: string,
  ): void {
    for (let index = 0; index < this.#timeline.length; index += 1) {
      const item = this.#timeline[index];
      if (item !== undefined) this.#timeline[index] = { ...item, status: "complete" };
    }
    this.#timeline.push({
      sequence: this.#timeline.length + 1,
      phase,
      title,
      detail,
      status: "current",
    });
  }

  #requireStage(expected: RecoveryDemoStage): void {
    if (this.#stage !== expected) {
      throw new RecoveryDemoRequestError(
        409,
        "invalid_stage",
        `Operation requires ${expected}, but the demonstration is ${this.#stage}`,
      );
    }
  }

  #requireBoundary(): RecoveryDemoBoundary {
    if (this.#boundary === null) throw new Error("Recovery boundary is missing");
    return this.#boundary;
  }

  #fail(error: unknown): void {
    this.#stage = "failed";
    this.#error = error instanceof Error ? error.message : String(error);
    this.#bump();
  }

  #bump(): void {
    this.#revision += 1;
  }
}

export interface StartRecoveryDemoServerOptions extends RecoveryDemoCoordinatorOptions {
  readonly port?: number;
  readonly assetRoot?: string;
}

export interface RunningRecoveryDemoServer {
  readonly url: string;
  readonly port: number;
  readonly coordinator: RecoveryDemoCoordinator;
  close(): Promise<void>;
}

interface RecoveryDemoApiResult {
  readonly replayed: boolean;
  readonly state: RecoveryDemoState;
}

export async function startRecoveryDemoServer(
  options: StartRecoveryDemoServerOptions,
): Promise<RunningRecoveryDemoServer> {
  const port = options.port ?? 4177;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Recovery demonstration port must be between 0 and 65535");
  }
  const coordinator = new RecoveryDemoCoordinator(options);
  const assetRoot =
    options.assetRoot ?? fileURLToPath(new URL("../ui/recovery/", import.meta.url));
  const idempotency = new Map<
    string,
    { readonly digest: string; readonly response: RecoveryDemoApiResult }
  >();
  let origin = "";
  let closePromise: Promise<void> | null = null;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failure = error instanceof RecoveryDemoRequestError
        ? error
        : new RecoveryDemoRequestError(500, "internal_error", "The recovery demonstration failed safely");
      sendJson(response, failure.statusCode, {
        error: failure.code,
        message: failure.message,
      });
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    applySecurityHeaders(response);
    validateRequestOrigin(request, origin);
    const url = parseRequestTarget(request.url, origin);
    if (url.pathname === "/api/recovery") {
      if (request.method === "GET") {
        sendJson(response, 200, coordinator.state());
        return;
      }
      if (request.method !== "POST") {
        throw new RecoveryDemoRequestError(405, "method_not_allowed", "Only GET and POST are allowed");
      }
      const body = await readJsonObject(request);
      validateExactKeys(body, ["operation", "boundary", "requestId"]);
      const operation = requireEnum(
        body["operation"],
        ["interrupt", "restart", "recover", "replay", "reset"] as const,
        "operation",
      );
      const boundary = body["boundary"] === null
        ? null
        : requireEnum(
            body["boundary"],
            [
              "after_execution_fence_before_factory_mutation",
              "after_factory_commit_before_m2_binding",
            ] as const,
            "boundary",
          );
      if ((operation === "interrupt") !== (boundary !== null)) {
        throw new RecoveryDemoRequestError(
          400,
          "invalid_boundary",
          "Only interrupt requires an explicit recovery boundary",
        );
      }
      const requestId = requireRequestId(body["requestId"]);
      const inputDigest = digest({ operation, boundary });
      const prior = idempotency.get(requestId);
      if (prior !== undefined) {
        if (prior.digest !== inputDigest) {
          throw new RecoveryDemoRequestError(409, "idempotency_conflict", "Request ID was reused with different input");
        }
        sendJson(response, 200, { ...prior.response, replayed: true });
        return;
      }
      const state = operation === "interrupt"
        ? coordinator.interrupt(boundary as RecoveryDemoBoundary)
        : operation === "restart"
          ? coordinator.restart()
          : operation === "recover"
            ? coordinator.recover()
            : operation === "replay"
              ? coordinator.replay()
              : coordinator.reset();
      const result = deepFreeze(canonicalClone<RecoveryDemoApiResult>({
        replayed: false,
        state,
      }));
      idempotency.set(requestId, { digest: inputDigest, response: result });
      sendJson(response, 200, result);
      return;
    }
    if (request.method !== "GET") {
      throw new RecoveryDemoRequestError(405, "method_not_allowed", "Only GET is allowed");
    }
    const asset = staticAsset(url.pathname, assetRoot);
    if (!existsSync(asset.path) || !statSync(asset.path).isFile()) {
      throw new RecoveryDemoRequestError(404, "not_found", "Resource not found");
    }
    response.writeHead(200, { "Content-Type": asset.contentType });
    createReadStream(asset.path).pipe(response);
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, LOOPBACK_HOST, resolveListen);
    });
  } catch (error: unknown) {
    return await failRecoveryDemoStartup(server, coordinator, error);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    return await failRecoveryDemoStartup(
      server,
      coordinator,
      new Error("Recovery demonstration server has no TCP address"),
    );
  }
  origin = `http://${LOOPBACK_HOST}:${String(address.port)}`;
  return {
    url: origin,
    port: address.port,
    coordinator,
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closePromise = closeRecoveryDemoServer(server, coordinator);
      return closePromise;
    },
  };
}

async function closeRecoveryDemoServer(
  server: ReturnType<typeof createServer>,
  coordinator: RecoveryDemoCoordinator,
): Promise<void> {
  const serverClose = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
    server.closeAllConnections();
  });
  const serverResult = await Promise.allSettled([serverClose]);
  const coordinatorResult = await Promise.allSettled([
    Promise.resolve().then(() => coordinator.close()),
  ]);
  const errors = [...serverResult, ...coordinatorResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Recovery demonstration server cleanup failed");
  }
}

async function failRecoveryDemoStartup(
  server: ReturnType<typeof createServer>,
  coordinator: RecoveryDemoCoordinator,
  primaryError: unknown,
): Promise<never> {
  const cleanupTasks: Promise<void>[] = [
    Promise.resolve().then(() => coordinator.close()),
  ];
  if (server.listening) {
    cleanupTasks.unshift(new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      });
      server.closeAllConnections();
    }));
  }
  const results = await Promise.allSettled(cleanupTasks);
  const cleanupErrors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Recovery demonstration startup and cleanup failed",
      { cause: primaryError instanceof Error ? primaryError : undefined },
    );
  }
  throw primaryError;
}

function establishOwnedDataRoot(dataRoot: string): void {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const marker = join(dataRoot, OWNERSHIP_MARKER);
  const expected = `${RECOVERY_STATE_SCHEMA}\n`;
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== expected) {
      throw new Error("Recovery demonstration ownership marker is invalid");
    }
    return;
  }
  if (readdirSync(dataRoot).length > 0) {
    throw new Error("Recovery demonstration data root is not empty");
  }
  writeFileSync(marker, expected, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function requireOwnershipMarker(dataRoot: string): void {
  const marker = join(dataRoot, OWNERSHIP_MARKER);
  if (
    !existsSync(marker) ||
    readFileSync(marker, "utf8") !== `${RECOVERY_STATE_SCHEMA}\n`
  ) {
    throw new Error("Recovery demonstration refuses to clean an unowned directory");
  }
}

function removeOwnedDatabaseArtifacts(paths: RecoveryDemoPaths): void {
  for (const path of [paths.m2DatabasePath, paths.factoryDatabasePath]) {
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
}

function validateRequestOrigin(request: IncomingMessage, origin: string): void {
  if (origin.length === 0) {
    throw new RecoveryDemoRequestError(503, "starting", "Server is starting");
  }
  if (request.headers.host !== new URL(origin).host) {
    throw new RecoveryDemoRequestError(400, "invalid_host", "Host must match the loopback server");
  }
  if (request.headers.origin !== undefined && request.headers.origin !== origin) {
    throw new RecoveryDemoRequestError(403, "invalid_origin", "Origin is not authorized");
  }
  if (request.method === "POST" && request.headers.origin !== origin) {
    throw new RecoveryDemoRequestError(403, "origin_required", "Mutations require the exact loopback origin");
  }
}

function parseRequestTarget(target: string | undefined, origin: string): URL {
  if (
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    /[\u0000-\u0020\u007f]/u.test(target) ||
    /%(?![0-9A-Fa-f]{2})/u.test(target)
  ) {
    throw new RecoveryDemoRequestError(400, "invalid_target", "Invalid origin-form request target");
  }
  try {
    const parsed = new URL(target, origin);
    if (parsed.origin !== origin) throw new TypeError("origin mismatch");
    return parsed;
  } catch {
    throw new RecoveryDemoRequestError(400, "invalid_target", "Invalid origin-form request target");
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new RecoveryDemoRequestError(415, "content_type", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) {
      throw new RecoveryDemoRequestError(413, "body_too_large", "Request body is too large");
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RecoveryDemoRequestError(400, "invalid_json", "Request body must be strict JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecoveryDemoRequestError(400, "invalid_shape", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function validateExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalSerialize(Object.keys(value).sort()) !== canonicalSerialize([...expected].sort())) {
    throw new RecoveryDemoRequestError(400, "invalid_shape", "Request fields do not match the schema");
  }
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RecoveryDemoRequestError(400, "invalid_field", `${name} is invalid`);
  }
  return value as T;
}

function requireRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u.test(value)
  ) {
    throw new RecoveryDemoRequestError(400, "invalid_request_id", "requestId is invalid");
  }
  return value;
}

function staticAsset(
  pathname: string,
  root: string,
): { readonly path: string; readonly contentType: string } {
  const assets: Readonly<Record<string, readonly [string, string]>> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  };
  const asset = assets[pathname];
  if (asset === undefined) {
    throw new RecoveryDemoRequestError(404, "not_found", "Resource not found");
  }
  return { path: join(root, asset[0]), contentType: asset[1] };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = canonicalSerialize(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

export function recoveryDemoRequestId(operation: string): string {
  return `recovery:${operation}:${randomUUID()}`;
}

function recoveryRunId(): string {
  return `recovery-run:${randomUUID()}`;
}
