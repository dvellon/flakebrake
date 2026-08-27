import { createServer, type IncomingMessage, type Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  FACTORY_MCP_SERVICE_NAMES,
  createFactoryMcpService,
  type FactoryMcpServiceName,
  type FactoryMcpServiceOptions,
  type RunningFactoryMcpService,
} from "./mcp.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

const DEFAULT_HOST = "127.0.0.1";
const MAX_MCP_FRAME_BYTES = 1_048_576;

export interface FactoryMcpHttpServiceOptions extends FactoryMcpServiceOptions {
  readonly host?: "127.0.0.1";
  readonly port?: number;
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

interface ActiveRequest {
  readonly transport: StreamableHTTPServerTransport;
  readonly service: RunningFactoryMcpService;
}

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
  const active = new Set<ActiveRequest>();
  let closing = false;
  const httpServer = createServer((request, response) => {
    void handleHttpRequest(
      serviceName,
      options,
      active,
      request,
      response,
    ).catch(() => {
      if (!response.headersSent) {
        writeJsonRpcError(response, 500, -32603, "Internal server error");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await listen(httpServer, host, port);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Factory MCP HTTP server did not bind a TCP address");
  }
  let closed = false;
  return {
    serviceName,
    transport: "streamable-http",
    host,
    port: address.port,
    url: `http://${host}:${String(address.port)}/mcp`,
    close: async () => {
      if (closed) return;
      closed = true;
      closing = true;
      await closeHttpServer(httpServer);
      await Promise.allSettled(
        [...active].map(async ({ service, transport }) => {
          await transport.close();
          await service.close();
        }),
      );
      active.clear();
    },
  };

  async function handleHttpRequest(
    name: FactoryMcpServiceName,
    serviceOptions: FactoryMcpServiceOptions,
    requests: Set<ActiveRequest>,
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

    const service = createFactoryMcpService(name, serviceOptions);
    // Omitted sessionIdGenerator is the SDK's documented stateless mode. The
    // cast only bridges the SDK declaration's exact-optional mismatch; it does
    // not alter the runtime transport or wrap it in an in-process substitute.
    const transport = new StreamableHTTPServerTransport();
    const activeRequest = { service, transport } as const;
    requests.add(activeRequest);
    try {
      await service.server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, parsedBody);
    } finally {
      requests.delete(activeRequest);
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
    let closed = false;
    return {
      transport: "streamable-http",
      services,
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled(
          [...services.values()].map((service) => service.close()),
        );
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled(opened.map((service) => service.close()));
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

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
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
    server.closeAllConnections();
  });
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
