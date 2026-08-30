import { createServer, type IncomingMessage, type Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  FACTORY_MCP_SERVICE_NAMES,
  createFactoryMcpService,
  type FactoryMcpDatabaseBinding,
  type FactoryMcpServiceName,
  type FactoryMcpServiceOptions,
} from "./mcp.js";
import { HERO_ENVIRONMENT_ID } from "./hero-fixture.js";
import { readDatabaseInstanceIdentity } from "./sqlite.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { retainM4RunnerCleanupDiagnostics } from "./m4-runner-lifecycle.js";

const DEFAULT_HOST = "127.0.0.1";
const MAX_MCP_FRAME_BYTES = 1_048_576;

export interface FactoryMcpHttpServiceOptions extends FactoryMcpServiceOptions {
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly signal?: AbortSignal;
}

export interface RunningFactoryMcpHttpService {
  readonly serviceName: FactoryMcpServiceName;
  readonly transport: "streamable-http";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface RunningFactoryMcpHttpCluster {
  readonly transport: "streamable-http";
  readonly services: ReadonlyMap<
    FactoryMcpServiceName,
    RunningFactoryMcpHttpService
  >;
  readonly close: () => Promise<void>;
}

interface AcceptedRequest {
  readonly request: IncomingMessage;
  readonly response: import("node:http").ServerResponse;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
}

const HTTP_DRAIN_TIMEOUT_MS = 500;

/**
 * Starts one stateless MCP Streamable HTTP endpoint. A fresh MCP server/transport
 * pair is attached to each request, but every pair is produced by the same
 * audited M3 service factory used by stdio.
 */
export async function startFactoryMcpHttpService(
  serviceName: FactoryMcpServiceName,
  options: FactoryMcpHttpServiceOptions,
): Promise<RunningFactoryMcpHttpService> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? 0;
  assertLoopback(host);
  assertPort(port);
  const durableBinding: FactoryMcpDatabaseBinding = {
    factoryIdentity: readDatabaseInstanceIdentity(
      options.factoryDatabasePath,
      "factory",
      HERO_ENVIRONMENT_ID,
    ),
    m2Identity: readDatabaseInstanceIdentity(
      options.m2DatabasePath,
      "m2",
      HERO_ENVIRONMENT_ID,
    ),
  };
  const accepted = new Set<AcceptedRequest>();
  let closing = false;
  const httpServer = createServer((request, response) => {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const acceptedRequest: AcceptedRequest = {
      request,
      response,
      done,
      resolveDone: () => resolveDone?.(),
    };
    accepted.add(acceptedRequest);
    void handleHttpRequest(
      serviceName,
      options,
      durableBinding,
      request,
      response,
    ).catch(() => {
      if (!response.headersSent) {
        writeJsonRpcError(response, 500, -32603, "Internal server error");
      } else if (!response.writableEnded) {
        response.end();
      }
    }).finally(() => {
      accepted.delete(acceptedRequest);
      acceptedRequest.resolveDone();
    });
  });
  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  try {
    await listen(httpServer, host, port, options.signal);
  } catch (error: unknown) {
    const cleanupFailures: unknown[] = [];
    try {
      await closeHttpServer(httpServer);
    } catch (cleanupError: unknown) {
      cleanupFailures.push(cleanupError);
    }
    if (error instanceof Error) {
      retainM4RunnerCleanupDiagnostics(error, cleanupFailures);
    }
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Factory MCP HTTP server did not bind a TCP address");
  }
  let closePromise: Promise<void> | undefined;
  return {
    serviceName,
    transport: "streamable-http",
    host,
    port: address.port,
    url: `http://${host}:${String(address.port)}/mcp`,
    close: async () => {
      closePromise ??= (async () => {
        closing = true;
        const stopped = closeHttpServer(httpServer);
        const initial = [...accepted];
        const drained = await Promise.race([
          Promise.allSettled(initial.map((item) => item.done)).then(() => true),
          delay(HTTP_DRAIN_TIMEOUT_MS).then(() => false),
        ]);
        if (!drained) {
          for (const item of [...accepted]) {
            item.request.destroy(
              new Error("Factory MCP HTTP shutdown aborted an incomplete request"),
            );
            item.response.destroy();
          }
        }
        await Promise.allSettled([...accepted].map((item) => item.done));
        httpServer.closeAllConnections();
        await stopped;
      })();
      await closePromise;
    },
  };

  async function handleHttpRequest(
    name: FactoryMcpServiceName,
    serviceOptions: FactoryMcpServiceOptions,
    binding: FactoryMcpDatabaseBinding,
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    if (closing) {
      writeJsonRpcError(response, 503, -32000, "Server is shutting down");
      return;
    }
    const path = new URL(request.url ?? "/", `http://${host}`).pathname;
    if (path !== "/mcp") {
      writeJsonRpcError(response, 404, -32601, "MCP endpoint not found");
      return;
    }
    if (request.method !== "POST") {
      writeJsonRpcError(response, 405, -32000, "Method not allowed");
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = parseJsonRejectingDuplicateKeys(
        await readBoundedUtf8Body(request),
      );
    } catch (error: unknown) {
      const status =
        error instanceof FrameTooLargeError || error instanceof Utf8FrameError
          ? 400
          : 400;
      writeJsonRpcError(response, status, -32700, "Parse error");
      return;
    }

    const service = createFactoryMcpService(name, serviceOptions, binding);
    // Omitted sessionIdGenerator is the SDK's documented stateless mode. The
    // cast only bridges the SDK declaration's exact-optional mismatch; it does
    // not alter the runtime transport or wrap it in an in-process substitute.
    const transport = new StreamableHTTPServerTransport();
    try {
      await service.server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, parsedBody);
    } finally {
      await transport.close();
      await service.close();
    }
  }
}

/** Starts all four independently addressable loopback endpoints. */
export async function startFactoryMcpHttpCluster(
  options: FactoryMcpHttpServiceOptions,
): Promise<RunningFactoryMcpHttpCluster> {
  const opened: RunningFactoryMcpHttpService[] = [];
  try {
    for (const serviceName of FACTORY_MCP_SERVICE_NAMES) {
      const service = await startFactoryMcpHttpService(serviceName, {
        ...options,
        port: 0,
        enableM4Tools: options.enableM4Tools ?? true,
      });
      opened.push(service);
    }
    const services = new Map(
      opened.map((service) => [service.serviceName, service] as const),
    );
    let closePromise: Promise<void> | undefined;
    return {
      transport: "streamable-http",
      services,
      close: async () => {
        closePromise ??= closeServicesInReverse([...services.values()]);
        await closePromise;
      },
    };
  } catch (error: unknown) {
    const cleanupFailures: unknown[] = [];
    try {
      await closeServicesInReverse(opened);
    } catch (cleanupError: unknown) {
      cleanupFailures.push(cleanupError);
    }
    if (error instanceof Error) {
      retainM4RunnerCleanupDiagnostics(error, cleanupFailures);
    }
    throw error;
  }
}

async function readBoundedUtf8Body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MCP_FRAME_BYTES) throw new FrameTooLargeError();
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (decoded.length === 0) throw new SyntaxError("Empty JSON request");
  return decoded;
}

function listen(
  server: Server,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: "resolve" | "reject", error?: unknown): void => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      server.off("listening", onListening);
      signal?.removeEventListener("abort", onAbort);
      if (outcome === "resolve") resolve();
      else reject(error);
    };
    const onError = (error: Error): void => {
      settle("reject", error);
    };
    const onListening = (): void => {
      settle("resolve");
    };
    const onAbort = (): void => settle("reject", abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, ...(signal === undefined ? {} : { signal }) });
  });
}

async function closeServicesInReverse(
  services: readonly RunningFactoryMcpHttpService[],
): Promise<void> {
  const reverseOwned = [...services].reverse();
  const settled = await Promise.allSettled(
    reverseOwned.map((service) => service.close()),
  );
  const failures = settled
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason as unknown);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Factory MCP HTTP cluster teardown failed");
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJsonRpcError(
  response: import("node:http").ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    connection: "close",
  });
  response.end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }),
  );
}

function assertLoopback(host: string): asserts host is "127.0.0.1" {
  if (host !== DEFAULT_HOST) {
    throw new TypeError("Factory MCP HTTP services must bind to 127.0.0.1");
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
}

class FrameTooLargeError extends Error {}
class Utf8FrameError extends Error {}
