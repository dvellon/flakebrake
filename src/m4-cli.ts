import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalSerialize } from "./canonical.js";
import { runLiveM4Mission } from "./m4-live.js";
import { runDeterministicM4Mission } from "./m4-runner.js";

function value(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  const result = index === -1 ? undefined : arguments_[index + 1];
  if (result !== undefined && result.length === 0) throw new TypeError(`${name} is empty`);
  return result;
}

async function main(arguments_: readonly string[]): Promise<void> {
  const live = arguments_.includes("--live");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "flakebrake-m4-"));
  const explicitPaths = [
    "--m2-db",
    "--factory-db",
    "--mission-db",
    "--trueforge-db",
    "--sandbox-root",
  ].some((name) => arguments_.includes(name));
  try {
    const paths = {
      m2DatabasePath: value(arguments_, "--m2-db") ?? join(temporaryRoot, "m2.sqlite"),
      factoryDatabasePath:
        value(arguments_, "--factory-db") ?? join(temporaryRoot, "factory.sqlite"),
      missionDatabasePath:
        value(arguments_, "--mission-db") ?? join(temporaryRoot, "mission.sqlite"),
      trueforgeDatabasePath:
        value(arguments_, "--trueforge-db") ?? join(temporaryRoot, "trueforge.sqlite"),
      localSandboxRootParent:
        value(arguments_, "--sandbox-root") ?? join(temporaryRoot, "sandboxes"),
    };
    const m0DatabasePath = value(arguments_, "--m0-db");
    const liveModel = value(arguments_, "--model");
    const result = live
      ? await runLiveM4Mission({
          ...paths,
          ...(m0DatabasePath === undefined
            ? {}
            : { m0TrueForgeDatabasePath: m0DatabasePath }),
          ...(liveModel === undefined ? {} : { model: liveModel }),
        })
      : await runDeterministicM4Mission(paths);
    process.stdout.write(`${canonicalSerialize(result)}\n`);
  } finally {
    if (!explicitPaths) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FlakeBrake M4 mission failed: ${message}\n`);
  process.exitCode = 1;
});
