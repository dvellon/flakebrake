import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  createMissionEvidenceDatabaseLifecycle,
  verifyMissionEvidenceBytesWithLifecycle,
  type MissionEvidenceBuildOptions,
} from "./mission-evidence.js";
import {
  withEvidenceLifecycleShutdown,
  type EvidenceHandleLifecycleManager,
} from "./mission-evidence-lifecycle.js";

const VALUE_FLAGS = [
  "--bundle",
  "--data-dir",
  "--m2-db",
  "--factory-db",
  "--mission-db",
  "--trueforge-db",
  "--mission-id",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

export interface MissionEvidenceCliOptions {
  readonly help: boolean;
  readonly bundlePath: string | null;
  readonly databases: MissionEvidenceBuildOptions | undefined;
}

export function parseMissionEvidenceCliArguments(
  arguments_: readonly string[],
): MissionEvidenceCliOptions {
  let help = false;
  const values: Partial<Record<ValueFlag, string>> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      if (help) throw new TypeError("--help was supplied more than once");
      help = true;
      continue;
    }
    if (!isValueFlag(argument)) {
      throw new TypeError(`unknown option ${argument ?? "<missing>"}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-") || value.length === 0) {
      throw new TypeError(`${argument} requires a value`);
    }
    const existing = values[argument];
    if (existing !== undefined && existing !== value) {
      throw new TypeError(`${argument} has conflicting duplicate values`);
    }
    values[argument] = value;
    index += 1;
  }
  if (help) return { help: true, bundlePath: null, databases: undefined };
  const bundle = values["--bundle"];
  if (bundle === undefined) throw new TypeError("--bundle is required");
  const bundlePath = absolutePath(bundle, "--bundle");
  const dataDirectory = values["--data-dir"];
  const explicitPaths = [
    values["--m2-db"],
    values["--factory-db"],
    values["--mission-db"],
    values["--trueforge-db"],
  ];
  if (dataDirectory !== undefined && explicitPaths.some((value) => value !== undefined)) {
    throw new TypeError("--data-dir cannot be combined with explicit database paths");
  }
  if (
    dataDirectory === undefined &&
    explicitPaths.some((value) => value !== undefined) &&
    explicitPaths.some((value) => value === undefined)
  ) {
    throw new TypeError(
      "--m2-db, --factory-db, --mission-db, and --trueforge-db must be supplied together",
    );
  }
  const missionId = values["--mission-id"] ?? "mission/flakebrake-m4-hero";
  const databases =
    dataDirectory !== undefined
      ? databaseOptionsFromDirectory(dataDirectory, missionId)
      : explicitPaths.every((value) => value !== undefined)
        ? {
            missionId,
            m2DatabasePath: absolutePath(values["--m2-db"] as string, "--m2-db"),
            factoryDatabasePath: absolutePath(
              values["--factory-db"] as string,
              "--factory-db",
            ),
            missionDatabasePath: absolutePath(
              values["--mission-db"] as string,
              "--mission-db",
            ),
            trueforgeDatabasePath: absolutePath(
              values["--trueforge-db"] as string,
              "--trueforge-db",
            ),
          }
        : undefined;
  return { help: false, bundlePath, databases };
}

/** @internal Real CLI boundary with explicit, bounded lifecycle shutdown. */
export function runMissionEvidenceCli(
  arguments_: readonly string[],
  lifecycle: EvidenceHandleLifecycleManager<DatabaseSync> =
    createMissionEvidenceDatabaseLifecycle(),
  writeOutput: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  withEvidenceLifecycleShutdown(lifecycle, () => {
    const parsed = parseMissionEvidenceCliArguments(arguments_);
    if (parsed.help) {
      writeOutput(usage());
      return;
    }
    const bytes = readFileSync(parsed.bundlePath as string, "utf8");
    const result = verifyMissionEvidenceBytesWithLifecycle(
      bytes,
      parsed.databases,
      lifecycle,
    );
    writeOutput(
      `Verified canonical mission evidence bundle\n` +
        `Mission: ${result.missionId}\n` +
        `Payload digest: ${result.payloadDigest}\n` +
        `Canonical bytes: ${String(result.canonicalByteLength)}\n` +
        `Durable database match: ${result.databaseMatch ? "exact" : "not requested"}\n`,
    );
  });
}

function databaseOptionsFromDirectory(
  directory: string,
  missionId: string,
): MissionEvidenceBuildOptions {
  const root = absolutePath(directory, "--data-dir");
  return {
    missionId,
    m2DatabasePath: join(root, "m2.sqlite"),
    factoryDatabasePath: join(root, "factory.sqlite"),
    missionDatabasePath: join(root, "mission.sqlite"),
    trueforgeDatabasePath: join(root, "trueforge.sqlite"),
  };
}

function absolutePath(value: string, name: string): string {
  const path = resolve(value);
  if (!isAbsolute(path)) throw new TypeError(`${name} must resolve to an absolute path`);
  return path;
}

function isValueFlag(value: string | undefined): value is ValueFlag {
  return VALUE_FLAGS.includes(value as ValueFlag);
}

function usage(): string {
  return (
    "Usage: npm run evidence:verify -- --bundle PATH [--data-dir PATH] [--mission-id ID]\n" +
    "       npm run evidence:verify -- --bundle PATH --m2-db PATH --factory-db PATH --mission-db PATH --trueforge-db PATH [--mission-id ID]\n\n" +
    "Validates schema, canonical bytes, the SHA-256 payload digest, linkage, exact counts, and terminal consistency. " +
    "Supplying the databases also requires an exact read-only durable projection match.\n"
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runMissionEvidenceCli(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(
      `Mission evidence verification failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
