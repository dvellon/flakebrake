import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startRecoveryDemoServer } from "./recovery-demo-ui.js";

export interface RecoveryDemoCliOptions {
  readonly help: boolean;
  readonly port: number;
  readonly dataRoot: string | null;
}

export function parseRecoveryDemoCliArguments(
  arguments_: readonly string[],
): RecoveryDemoCliOptions {
  let help = false;
  let port = 4177;
  let explicitPort: number | null = null;
  let dataRoot: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      if (help) throw new TypeError("--help was supplied more than once");
      help = true;
      continue;
    }
    if (argument !== "--port" && argument !== "--data-dir") {
      throw new TypeError(`unknown option ${argument ?? "<missing>"}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-") || value.length === 0) {
      throw new TypeError(`${argument} requires a value`);
    }
    if (argument === "--port") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new TypeError("--port must be an integer between 0 and 65535");
      }
      if (explicitPort !== null && explicitPort !== parsed) {
        throw new TypeError("--port has conflicting duplicate values");
      }
      explicitPort = parsed;
      port = parsed;
    } else {
      const parsed = resolve(value);
      if (!isAbsolute(parsed)) {
        throw new TypeError("--data-dir must resolve to an absolute path");
      }
      if (dataRoot !== null && dataRoot !== parsed) {
        throw new TypeError("--data-dir has conflicting duplicate values");
      }
      dataRoot = parsed;
    }
    index += 1;
  }
  return { help, port, dataRoot };
}

async function main(arguments_: readonly string[]): Promise<void> {
  const parsed = parseRecoveryDemoCliArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(
      "Usage: npm run recovery:demo -- [--port PORT] [--data-dir PATH]\n\n" +
        "Runs the explicit deterministic recovery demonstration on loopback. " +
        "The default port is 4177 and no credentials are used.\n",
    );
    return;
  }
  const temporary = parsed.dataRoot === null;
  const dataRoot =
    parsed.dataRoot ??
    (await mkdtemp(join(tmpdir(), "flakebrake-recovery-demo-")));
  let running: Awaited<ReturnType<typeof startRecoveryDemoServer>>;
  try {
    running = await startRecoveryDemoServer({
      dataRoot,
      port: parsed.port,
      cleanupDataOnClose: temporary,
    });
  } catch (error: unknown) {
    if (temporary) await rm(dataRoot, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`FlakeBrake recovery demonstration ready: ${running.url}\n`);
  process.stdout.write("Explicit recovery mode · press Ctrl+C to stop.\n");
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= running.close();
    return stopping;
  };
  await new Promise<void>((resolveDone, rejectDone) => {
    const signal = (): void => {
      void stop().then(resolveDone, rejectDone);
    };
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `FlakeBrake recovery demonstration failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
