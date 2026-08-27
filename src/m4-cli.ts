import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { canonicalSerialize } from "./canonical.js";
import {
  m4OwnerDecisionResponse,
  type M4OwnerDecisionProvider,
} from "./m4-mission-controller.js";
import { runLiveM4Mission } from "./m4-live.js";
import { runDeterministicM4Mission } from "./m4-runner.js";

const VALUE_FLAGS = [
  "--m2-db",
  "--factory-db",
  "--mission-db",
  "--trueforge-db",
  "--sandbox-root",
  "--m0-db",
  "--model",
  "--owner-source",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

export interface M4CliArguments {
  readonly help: boolean;
  readonly live: boolean;
  readonly values: Readonly<Partial<Record<ValueFlag, string>>>;
}

export function parseM4CliArguments(
  arguments_: readonly string[],
): M4CliArguments {
  let help = false;
  let live = false;
  const values: Partial<Record<ValueFlag, string>> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      if (help) throw new TypeError("--help was supplied more than once");
      help = true;
      continue;
    }
    if (argument === "--live") {
      if (live) throw new TypeError("--live was supplied more than once");
      live = true;
      continue;
    }
    if (!isValueFlag(argument)) {
      throw new TypeError(`unknown option ${argument ?? "<missing>"}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new TypeError(`${argument} requires a value`);
    }
    if (value.length === 0) throw new TypeError(`${argument} value is empty`);
    const existing = values[argument];
    if (existing !== undefined && existing !== value) {
      throw new TypeError(`${argument} has conflicting duplicate values`);
    }
    values[argument] = value;
    index += 1;
  }
  return { help, live, values };
}

async function main(arguments_: readonly string[]): Promise<void> {
  const parsed = parseM4CliArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const m0DatabasePath =
    parsed.values["--m0-db"] ?? process.env["FLAKEBRAKE_M0_DATABASE_PATH"];
  const ownerSourceIdentity =
    parsed.values["--owner-source"] ??
    process.env["FLAKEBRAKE_OWNER_SOURCE_ID"];
  if (parsed.live && m0DatabasePath === undefined) {
    throw new TypeError(
      "--live requires --m0-db or FLAKEBRAKE_M0_DATABASE_PATH",
    );
  }
  if (parsed.live && ownerSourceIdentity === undefined) {
    throw new TypeError(
      "--live requires --owner-source or FLAKEBRAKE_OWNER_SOURCE_ID",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "flakebrake-m4-"));
  try {
    const paths = {
      m2DatabasePath:
        parsed.values["--m2-db"] ?? join(temporaryRoot, "m2.sqlite"),
      factoryDatabasePath:
        parsed.values["--factory-db"] ?? join(temporaryRoot, "factory.sqlite"),
      missionDatabasePath:
        parsed.values["--mission-db"] ?? join(temporaryRoot, "mission.sqlite"),
      trueforgeDatabasePath:
        parsed.values["--trueforge-db"] ??
        join(temporaryRoot, "trueforge.sqlite"),
      localSandboxRootParent:
        parsed.values["--sandbox-root"] ?? join(temporaryRoot, "sandboxes"),
    };
    const result = parsed.live
      ? await runLiveM4Mission({
          ...paths,
          m0TrueForgeDatabasePath: m0DatabasePath as string,
          ownerDecisionProvider: interactiveOwnerDecisionProvider(
            ownerSourceIdentity as string,
          ),
          ...(parsed.values["--model"] === undefined
            ? {}
            : { model: parsed.values["--model"] }),
        })
      : await runDeterministicM4Mission(paths);
    process.stdout.write(`${canonicalSerialize(result)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function interactiveOwnerDecisionProvider(
  ownerSourceIdentity: string,
): M4OwnerDecisionProvider {
  return async (request) => {
    process.stderr.write(
      `\nExternal owner approval required:\n${canonicalSerialize(request)}\n`,
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const response = (await terminal.question(
        "Decision (ALLOW or DENY): ",
      )).trim();
      if (response === "ALLOW") {
        return m4OwnerDecisionResponse(request, ownerSourceIdentity, {
          status: "allow",
        });
      }
      if (response === "DENY") {
        const reason = (await terminal.question("Denial reason: ")).trim();
        if (reason.length === 0) {
          throw new TypeError("An explicit denial reason is required");
        }
        return m4OwnerDecisionResponse(request, ownerSourceIdentity, {
          status: "deny",
          reason,
        });
      }
      throw new TypeError("Owner decision must be exactly ALLOW or DENY");
    } finally {
      terminal.close();
    }
  };
}

function isValueFlag(value: string | undefined): value is ValueFlag {
  return VALUE_FLAGS.includes(value as ValueFlag);
}

function usage(): string {
  return `Usage: flakebrake m4 [--live] [options]\n\nValue options:\n  --m2-db PATH\n  --factory-db PATH\n  --mission-db PATH\n  --trueforge-db PATH\n  --sandbox-root PATH\n  --m0-db PATH\n  --model NAME\n  --owner-source ID\n\nLive mode requires an explicit M0 path and owner-source identity.\n`;
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FlakeBrake M4 mission failed: ${message}\n`);
  process.exitCode = 1;
});
