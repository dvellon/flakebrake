import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startM5JudgeServer } from "../src/m5-ui.js";
import { sessionCleanupStack, type SessionCleanupStack } from "./m5-error-capture.js";

const EXISTING_DEMO_PORT = 4173;
const LOOPBACK_HOST = "127.0.0.1";

export interface BoundM5BrowserSmokeServer {
  readonly dataRoot: string;
  readonly port: number;
  readonly url: string;
}

export interface StartM5BrowserSmokeInvocationOptions {
  readonly afterBinding?: (server: BoundM5BrowserSmokeServer) => void | Promise<void>;
}

export interface M5BrowserSmokeInvocation extends BoundM5BrowserSmokeServer {
  own(release: () => Promise<void>): void;
  close(): Promise<void>;
  fail(primaryError: unknown): Promise<never>;
}

export async function startM5BrowserSmokeInvocation(
  options: StartM5BrowserSmokeInvocationOptions = {},
): Promise<M5BrowserSmokeInvocation> {
  // Establish cleanup ownership before allocating the first invocation resource.
  const cleanup = sessionCleanupStack();
  try {
    const dataRoot = ownTemporaryDirectory(cleanup, "flakebrake-m5-browser-");
    const running = await startM5JudgeServer({
      dataRoot,
      port: 0,
      cleanupDataOnClose: true,
    });
    cleanup.own(() => running.close());

    const authoritativeUrl = new URL(running.url);
    if (
      authoritativeUrl.hostname !== LOOPBACK_HOST ||
      Number(authoritativeUrl.port) !== running.port
    ) {
      throw new Error("the capacity browser smoke did not receive an authoritative loopback URL");
    }
    if (running.port === EXISTING_DEMO_PORT) {
      throw new Error("the capacity browser smoke must not use the existing demo port 4173");
    }

    const bound = {
      dataRoot,
      port: running.port,
      url: authoritativeUrl.href.replace(/\/$/u, ""),
    } satisfies BoundM5BrowserSmokeServer;
    await options.afterBinding?.(bound);

    return {
      ...bound,
      own: (release) => cleanup.own(release),
      close: () => cleanup.release(),
      fail: async (primaryError: unknown): Promise<never> => {
        throw await preservePrimaryError(cleanup, primaryError, "M5 browser smoke and cleanup failed");
      },
    };
  } catch (error: unknown) {
    throw await preservePrimaryError(cleanup, error, "M5 browser smoke startup and cleanup failed");
  }
}

function ownTemporaryDirectory(cleanup: SessionCleanupStack, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.own(async () => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function preservePrimaryError(
  cleanup: SessionCleanupStack,
  primaryError: unknown,
  message: string,
): Promise<unknown> {
  try {
    await cleanup.release();
  } catch (cleanupError: unknown) {
    return new AggregateError([primaryError, cleanupError], message, {
      cause: primaryError instanceof Error ? primaryError : undefined,
    });
  }
  return primaryError;
}
