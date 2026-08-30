import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { canonicalSerialize, compareStableStrings } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import {
  claimedExecutionReference,
  commandFromAttempt,
  factoryStateDigest,
  resultingScheduleState,
  SyntheticFactoryEnvironment,
  type AuthorizedScheduleMutation,
  type CanonicalScheduleCommand,
  type SyntheticMutationResponse,
} from "./factory-environment.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  HERO_OWNER_ID,
  HERO_PRODUCTION_CELL_ID,
  HERO_RESOURCE_KEYS,
  createHeroInitialState,
  createHeroProposal,
} from "./hero-fixture.js";
import { createFactoryMcpService } from "./mcp.js";
import {
  AuthorizationDeniedError,
  type AdmissionRecordBody,
  type ApprovalScope,
  type ClaimExecutionInput,
  type EffectFingerprint,
} from "./stateful-domain.js";
import { createStore, type FlakeBrakeStore } from "./store.js";

const M5_PARENT_MARKER = ".flakebrake-m5-owned-v1";
const M5_PARENT_MARKER_CONTENT = "flakebrake-m5-judge-state/v1\n";
const CHALLENGE_DIRECTORY = "challenge-lab-v1";
const CHALLENGE_MARKER = ".flakebrake-challenge-owned-v1";
const CHALLENGE_MARKER_CONTENT = "flakebrake-adversarial-challenge/v1\n";
const CHALLENGE_RESULT = "challenge-result.json";
const CHALLENGE_EVIDENCE = "challenge-evidence.json";
const CHALLENGE_EVIDENCE_SCHEMA_VERSION = "flakebrake-challenge-evidence/v1";
const CHALLENGE_MISSION_ID = "mission/challenge-lab";

const FIRST_START = "2026-08-26T09:10:00.000Z";
const FIRST_END = "2026-08-26T09:40:00.000Z";
const ACCEPT_DECISION_ID = "owner-decision/challenge-accept";
const GRANT_DECISION_ID = "owner-decision/challenge-grant";
const GRANT_ID = "grant/challenge-execution/v1";
const GRANT_VERSION = "grant/v1";
const BUNDLE_ID = "bundle/challenge-execution";

export interface ChallengeCounts {
  readonly admissions: number;
  readonly grants: number;
  readonly attempts: number;
  readonly fences: number;
  readonly mutations: number;
  readonly receipts: number;
  readonly terminalEvents: number;
  readonly actualFacts: number;
}

export interface ChallengeEvidence {
  readonly counts: ChallengeCounts;
  readonly snapshotDigest: string;
}

export interface AdversarialChallengeResult {
  readonly id:
    | "identity-substitution"
    | "stale-authoritative-basis"
    | "attempt-id-conflict"
    | "forged-receipt"
    | "alternate-after-denial"
    | "valid-idempotent-replay";
  readonly title: string;
  readonly control: "rejection" | "positive";
  readonly attemptedAction: string;
  readonly authoritativeReason: string;
  readonly rule: string;
  readonly adapterPath: string;
  readonly before: ChallengeEvidence;
  readonly after: ChallengeEvidence;
  readonly snapshotEqual: boolean;
  readonly zeroUnauthorizedEffects: boolean;
  readonly replayProof: null | {
    readonly replayed: boolean;
    readonly originalResultReturned: boolean;
    readonly originalReceiptReturned: boolean;
    readonly noSecondMutation: boolean;
    readonly noDuplicateFacts: boolean;
  };
}

export interface AdversarialChallengeLabResult {
  readonly schemaVersion: "flakebrake-adversarial-challenge/v1";
  readonly label: "Deterministic assurance demonstration";
  readonly complete: boolean;
  readonly allPassed: boolean;
  readonly omitted: readonly string[];
  readonly challenges: readonly AdversarialChallengeResult[];
}

/** One immutable per-database identity read from a held evidence connection. */
export interface ChallengeDatabaseBinding {
  readonly storeKind: "m2" | "factory";
  readonly incarnationId: string;
}

export interface ChallengeScenarioBindings {
  readonly m2: ChallengeDatabaseBinding;
  readonly factory: ChallengeDatabaseBinding;
}

/** Terminal-state projection derived from the same pinned snapshot as the counts. */
export interface ChallengeTerminalState {
  readonly reservationEventKinds: readonly string[];
  readonly verifiedTerminalEvents: number;
}

export type ChallengeTableRows = ReadonlyArray<Readonly<Record<string, unknown>>>;

export type ChallengeDatabaseDump = Readonly<Record<string, ChallengeTableRows>>;

export interface ChallengeSnapshotContent {
  readonly m2: ChallengeDatabaseDump;
  readonly factory: ChallengeDatabaseDump;
}

/**
 * The persisted evidence of one completed challenge scenario. Counts, terminal
 * state, and the digest are projections of the embedded snapshot content and
 * are recomputed from it whenever the representation is consumed.
 */
export interface ChallengeScenarioEvidenceRecord {
  readonly scenarioId: AdversarialChallengeResult["id"];
  readonly directory: string;
  readonly databases: ChallengeScenarioBindings;
  readonly counts: ChallengeCounts;
  readonly terminal: ChallengeTerminalState;
  readonly snapshot: ChallengeSnapshotContent;
  readonly snapshotDigest: string;
}

/**
 * The canonical, scenario-bound challenge evidence representation. It is the
 * durable record of the completed execution: restart replay consumes this
 * representation and never reopens the mutable scenario databases. It binds
 * scenario order, mission and lab session, database incarnation identities,
 * durable counts, terminal state, content digests, and the exact canonical
 * result bytes. The restart representation is validated for canonical
 * encoding, exact bindings, counts, terminal state, and internal digest
 * consistency. Malformed, torn, mixed, or inconsistently modified evidence
 * fails closed. The co-located digest is not producer authentication and
 * does not prevent a writer controlling the evidence root from rewriting
 * the complete representation self-consistently.
 */
export interface AdversarialChallengeEvidenceBundle {
  readonly schemaVersion: typeof CHALLENGE_EVIDENCE_SCHEMA_VERSION;
  readonly missionId: typeof CHALLENGE_MISSION_ID;
  readonly labSessionId: string;
  readonly resultDigest: string;
  readonly scenarios: readonly ChallengeScenarioEvidenceRecord[];
}

const CHALLENGE_SCENARIOS = [
  { id: "identity-substitution", directory: "01-identity" },
  { id: "stale-authoritative-basis", directory: "02-stale-basis" },
  { id: "attempt-id-conflict", directory: "03-attempt-conflict" },
  { id: "forged-receipt", directory: "04-forged-receipt" },
  { id: "alternate-after-denial", directory: "05-alternate-denial" },
  { id: "valid-idempotent-replay", directory: "06-valid-replay" },
] as const satisfies ReadonlyArray<{
  readonly id: AdversarialChallengeResult["id"];
  readonly directory: string;
}>;

const CHALLENGE_COUNT_KEYS = [
  "admissions",
  "grants",
  "attempts",
  "fences",
  "mutations",
  "receipts",
  "terminalEvents",
  "actualFacts",
] as const satisfies ReadonlyArray<keyof ChallengeCounts>;

const CHALLENGE_COUNT_KEYS_SORTED: readonly string[] = [...CHALLENGE_COUNT_KEYS].sort(
  compareStableStrings,
);

/** @internal The fixed per-scenario database paths admitted for evidence. */
export interface ChallengeEvidencePaths {
  readonly m2: string;
  readonly factory: string;
}

type FixturePaths = ChallengeEvidencePaths;

interface PreparedFixture extends FixturePaths {
  readonly accepted: AdmissionRecordBody;
  readonly selectedPlanId: string;
  readonly grantAllowanceKey: string;
  readonly evidence: ChallengeEvidenceSession;
}

interface ClaimedFixture extends PreparedFixture {
  readonly request: AuthorizedScheduleMutation;
}

/** @internal One complete evidence snapshot read from a held session. */
export interface ChallengeCompleteEvidence extends ChallengeEvidence {
  readonly snapshot: string;
  readonly content: ChallengeSnapshotContent;
  readonly terminal: ChallengeTerminalState;
}

type CompleteEvidence = ChallengeCompleteEvidence;

interface ScenarioOutcome {
  readonly challenge: AdversarialChallengeResult;
  readonly finalEvidence: CompleteEvidence;
  readonly databases: ChallengeScenarioBindings;
}

/**
 * Run the bounded assurance lab inside the M5 invocation-owned data root.
 * The caller supplies no filenames or provider configuration.
 */
export async function runAdversarialChallengeLab(
  ownedDataRootValue: string,
): Promise<AdversarialChallengeLabResult> {
  const replay = readAdversarialChallengeLab(ownedDataRootValue);
  if (replay !== null) return replay;
  const root = establishChallengeRoot(ownedDataRootValue);
  const labSessionId = `challenge-session/${randomUUID()}`;
  const outcomes: readonly ScenarioOutcome[] = [
    await identitySubstitutionChallenge(scenarioRoot(root, "01-identity")),
    await staleBasisChallenge(scenarioRoot(root, "02-stale-basis")),
    await attemptConflictChallenge(scenarioRoot(root, "03-attempt-conflict")),
    await forgedReceiptChallenge(scenarioRoot(root, "04-forged-receipt")),
    await alternateDenialChallenge(scenarioRoot(root, "05-alternate-denial")),
    await validReplayChallenge(scenarioRoot(root, "06-valid-replay")),
  ];
  const challenges = outcomes.map((outcome) => outcome.challenge);
  const result: AdversarialChallengeLabResult = {
    schemaVersion: "flakebrake-adversarial-challenge/v1",
    label: "Deterministic assurance demonstration",
    complete: true,
    allPassed: challenges.every((challenge) => challenge.zeroUnauthorizedEffects),
    omitted: [],
    challenges,
  };
  const resultBytes = canonicalSerialize(result);
  const bundle: AdversarialChallengeEvidenceBundle = {
    schemaVersion: CHALLENGE_EVIDENCE_SCHEMA_VERSION,
    missionId: CHALLENGE_MISSION_ID,
    labSessionId,
    resultDigest: sha256(resultBytes),
    scenarios: outcomes.map((outcome, index) => {
      const scenario = CHALLENGE_SCENARIOS[index];
      if (scenario === undefined || scenario.id !== outcome.challenge.id) {
        throw new Error("The challenge scenario order is inconsistent");
      }
      return {
        scenarioId: outcome.challenge.id,
        directory: scenario.directory,
        databases: outcome.databases,
        counts: outcome.finalEvidence.counts,
        terminal: outcome.finalEvidence.terminal,
        snapshot: outcome.finalEvidence.content,
        snapshotDigest: outcome.finalEvidence.snapshotDigest,
      };
    }),
  };
  const bundleBytes = canonicalSerialize(bundle);
  // What is persisted must replay: the exact durable validation path runs
  // against the serialized bytes before either file is written. The evidence
  // representation is published before the result, so a crash between the two
  // leaves a root whose missing result fails closed as incomplete durable
  // state rather than a result without its representation.
  validateDurableChallengeEvidence(resultBytes, bundleBytes);
  publishDurableChallengeFile(join(root, CHALLENGE_EVIDENCE), bundleBytes);
  publishDurableChallengeFile(join(root, CHALLENGE_RESULT), resultBytes);
  return result;
}

const DURABLE_PUBLICATION_ATTEMPTS = 16;

/**
 * Crash-durable, collision-safe publication of one canonical challenge file,
 * following the M5 marker publication discipline: an exclusively created
 * owned temporary in the destination directory, a full write, fsync, and
 * close, an atomic same-directory rename, then a directory fsync (tolerated
 * as narrower file-durable publication only on Windows, whose directory
 * handles cannot be synced). The committed pathname is never opened or
 * truncated in place, and publication refuses to replace an existing file.
 */
function publishDurableChallengeFile(destination: string, serialized: string): void {
  let descriptor: number | null = null;
  let temporary: string | null = null;
  let collision: unknown = null;
  for (let attempt = 0; attempt < DURABLE_PUBLICATION_ATTEMPTS && descriptor === null; attempt += 1) {
    const candidate = `${destination}.${randomUUID()}.tmp`;
    try {
      descriptor = openSync(candidate, "wx", 0o600);
      temporary = candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      collision = error;
    }
  }
  if (descriptor === null || temporary === null) {
    throw new Error("Challenge evidence publication exhausted its unique temporary identities", {
      cause: collision,
    });
  }
  const owned = temporary;
  let renamed = false;
  try {
    const payload = Buffer.from(serialized, "utf8");
    let written = 0;
    while (written < payload.length) {
      written += writeSync(descriptor, payload, written);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (existsSync(destination)) {
      throw new Error("Refusing to replace an existing durable challenge file");
    }
    renameSync(owned, destination);
    renamed = true;
    try {
      const directoryDescriptor = openSync(dirname(destination), "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error: unknown) {
      if (process.platform !== "win32") throw error;
    }
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!renamed) {
      try {
        rmSync(owned, { force: true });
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    attachChallengeCleanupDiagnostics(error, cleanupErrors);
    throw error;
  }
}

/**
 * Replay the durable challenge result from its canonical, scenario-bound
 * evidence representation. Unlike live evidence, which is read from held
 * authoritative database connections, restart evidence is validated for
 * internal consistency only: canonical byte-exactness, exact bindings, and
 * digests, counts, terminal state, and database identities recomputed from
 * the embedded snapshot content. The mutable scenario databases are never
 * reopened. Malformed, torn, mixed, or inconsistently modified evidence
 * fails closed; a writer controlling the evidence root can still rewrite
 * the complete representation self-consistently, because the co-located
 * digest is not producer authentication.
 */
export function readAdversarialChallengeLab(
  ownedDataRootValue: string,
): AdversarialChallengeLabResult | null {
  const ownedDataRoot = requireOwnedM5Root(ownedDataRootValue);
  const root = join(ownedDataRoot, CHALLENGE_DIRECTORY);
  if (!existsSync(root)) return null;
  requireChallengeRoot(root);
  const resultPath = join(root, CHALLENGE_RESULT);
  if (!existsSync(resultPath)) {
    throw new Error("The challenge lab has incomplete durable state");
  }
  if (lstatSync(resultPath).isSymbolicLink()) {
    throw new Error("The challenge result must not be a symbolic link");
  }
  const resultBytes = readFileSync(resultPath, "utf8");
  const evidencePath = join(root, CHALLENGE_EVIDENCE);
  if (!existsSync(evidencePath)) {
    throw new Error("The challenge lab evidence representation is missing");
  }
  if (lstatSync(evidencePath).isSymbolicLink()) {
    throw new Error("The challenge evidence representation must not be a symbolic link");
  }
  const bundleBytes = readFileSync(evidencePath, "utf8");
  return validateDurableChallengeEvidence(resultBytes, bundleBytes);
}

/** Remove only the fixed, marked child owned by this invocation. */
export function cleanupAdversarialChallengeLab(ownedDataRootValue: string): void {
  const ownedDataRoot = requireOwnedM5Root(ownedDataRootValue);
  const root = join(ownedDataRoot, CHALLENGE_DIRECTORY);
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to clean an invalid challenge-lab directory");
  }
  const marker = join(root, CHALLENGE_MARKER);
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink()) {
    throw new Error("Refusing to clean an unowned challenge-lab directory");
  }
  if (readFileSync(marker, "utf8") !== CHALLENGE_MARKER_CONTENT) {
    throw new Error("Refusing to clean a challenge lab with an invalid ownership marker");
  }
  rmSync(root, { recursive: true, force: true });
}

function requireChallengeRoot(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The challenge-lab directory is invalid");
  }
  const marker = join(root, CHALLENGE_MARKER);
  if (
    !existsSync(marker) ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== CHALLENGE_MARKER_CONTENT
  ) {
    throw new Error("The challenge-lab ownership marker is invalid");
  }
}

function validateDurableChallengeEvidence(
  resultBytes: string,
  bundleBytes: string,
): AdversarialChallengeLabResult {
  const result = parseDurableChallengeResult(resultBytes);
  const bundle = parseDurableChallengeEvidenceBundle(bundleBytes);
  requireChallengeEvidenceBinding(result, resultBytes, bundle);
  return result;
}

function parseDurableChallengeResult(bytes: string): AdversarialChallengeLabResult {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    throw new Error("The durable challenge result is invalid");
  }
  if (!isChallengeLabResult(value) || canonicalSerialize(value) !== bytes) {
    throw new Error("The durable challenge result is invalid");
  }
  return value;
}

function parseDurableChallengeEvidenceBundle(
  bytes: string,
): AdversarialChallengeEvidenceBundle {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    throw new Error("The durable challenge evidence representation is invalid");
  }
  if (!isChallengeEvidenceBundle(value) || canonicalSerialize(value) !== bytes) {
    throw new Error("The durable challenge evidence representation is invalid");
  }
  return value;
}

function requireChallengeEvidenceBinding(
  result: AdversarialChallengeLabResult,
  resultBytes: string,
  bundle: AdversarialChallengeEvidenceBundle,
): void {
  if (
    bundle.resultDigest !== sha256(resultBytes) ||
    bundle.scenarios.length !== result.challenges.length
  ) {
    throw challengeEvidenceBindingError();
  }
  for (const [index, scenario] of bundle.scenarios.entries()) {
    const challenge = result.challenges[index];
    if (challenge === undefined || scenario.scenarioId !== challenge.id) {
      throw challengeEvidenceBindingError();
    }
    let recomputedCounts: ChallengeCounts;
    let recomputedTerminal: ChallengeTerminalState;
    try {
      verifySnapshotDatabaseBindings(scenario.snapshot, scenario.databases);
      recomputedCounts = countsFromSnapshot(scenario.snapshot);
      recomputedTerminal = terminalStateFromSnapshot(scenario.snapshot);
    } catch {
      throw challengeEvidenceInconsistencyError();
    }
    if (
      sha256(canonicalSerialize(scenario.snapshot)) !== scenario.snapshotDigest ||
      canonicalSerialize(recomputedCounts) !== canonicalSerialize(scenario.counts) ||
      canonicalSerialize(recomputedTerminal) !== canonicalSerialize(scenario.terminal)
    ) {
      throw challengeEvidenceInconsistencyError();
    }
    if (
      challenge.after.snapshotDigest !== scenario.snapshotDigest ||
      canonicalSerialize(challenge.after.counts) !== canonicalSerialize(scenario.counts) ||
      canonicalSerialize(challenge.before) !== canonicalSerialize(challenge.after)
    ) {
      throw challengeEvidenceBindingError();
    }
  }
}

function challengeEvidenceBindingError(): Error {
  return new Error(
    "The durable challenge evidence representation does not bind to the durable challenge result",
  );
}

function challengeEvidenceInconsistencyError(): Error {
  return new Error("The durable challenge evidence representation is internally inconsistent");
}

async function identitySubstitutionChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-identity");
  try {
    const substituted: AuthorizedScheduleMutation = {
      ...fixture.request,
      claim: {
        ...fixture.request.claim,
        admissionRecordId: "admission/[substituted]",
        acceptedOwnerDecisionId: "owner-decision/[substituted-acceptance]",
        grantOwnerDecisionId: "owner-decision/[substituted-grant]",
        grantId: "grant/[substituted]",
        selectedPlanId: "plan/[substituted]",
      },
    };
    const challenge = await rejectionThroughMcp(
      fixture,
      {
        id: "identity-substitution",
        title: "Identity substitution",
        attemptedAction:
          "Create one reservation while substituting the bound admission, grant, owner decisions, and plan identities.",
        rule:
          "The consequential request must exactly reproduce every immutable field of the authoritative M2 claim linkage.",
        adapterPath:
          "factory-change-control.create_schedule_reservation → canonical executor → exact live-attempt linkage",
      },
      "create_schedule_reservation",
      mutationArguments(substituted),
      /does not exactly reproduce the authoritative M2 claim linkage/u,
    );
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function staleBasisChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-stale-basis");
  try {
    const stale: AuthorizedScheduleMutation = {
      ...fixture.request,
      expectedBeforeStateVersion: "factory-state/v999",
    };
    const challenge = await rejectionThroughMcp(
      fixture,
      {
        id: "stale-authoritative-basis",
        title: "Stale authoritative basis",
        attemptedAction:
          "Create the approved reservation against a stale factory state version while retaining a syntactically valid digest.",
        rule:
          "The before-state version and digest are a compare-and-swap pair and must match the authoritative factory read at execution time.",
        adapterPath:
          "factory-change-control.create_schedule_reservation → canonical executor → factory compare-and-swap",
      },
      "create_schedule_reservation",
      mutationArguments(stale),
      /stale synthetic state compare-and-swap precondition/u,
    );
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function attemptConflictChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-conflict");
  try {
    await withChangeControlClient(fixture, false, async (client) => {
      requireToolSuccess(
        await client.callTool({
          name: "create_schedule_reservation",
          arguments: mutationArguments(fixture.request),
        }) as CallToolResult,
        "valid setup mutation",
      );
    });
    const conflicting: AuthorizedScheduleMutation = {
      ...fixture.request,
      command: { ...fixture.request.command, quantity: 9 },
    };
    const challenge = await rejectionThroughMcp(
      fixture,
      {
        id: "attempt-id-conflict",
        title: "Conflicting attempt ID reuse",
        attemptedAction:
          "Reuse a completed attempt identity with a different material reservation quantity.",
        rule:
          "An execution attempt identity is idempotent only for byte-equivalent canonical material data; conflicting reuse is rejected.",
        adapterPath:
          "factory-change-control.create_schedule_reservation → immutable execution-result lookup",
      },
      "create_schedule_reservation",
      mutationArguments(conflicting),
      /was reused with different material data/u,
    );
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function forgedReceiptChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-forged-receipt");
  try {
    await withChangeControlClient(fixture, false, async (client) => {
      requireToolSuccess(
        await client.callTool({
          name: "create_schedule_reservation",
          arguments: mutationArguments(fixture.request),
        }) as CallToolResult,
        "valid setup mutation",
      );
    });
    const before = fixture.evidence.snapshot();
    const store = createStore({
      path: fixture.m2,
      authoritativeFactoryDatabasePath: fixture.factory,
      now: () => HERO_HORIZON_END,
    });
    let reason: string;
    try {
      reason = expectThrownReason(
        () =>
          store.recordExecutionTerminal({
            terminalEventId: "terminal/challenge-forged-receipt",
            executionAttemptId: fixture.request.executionAttemptId,
            status: "VERIFIED_SUCCESS",
            receiptReference: "receipt/[forged]",
            observedAfterState: fixture.request.claim.expectedAfterState,
            actualConsumption: [],
          }),
        /requires authoritative factory verification/u,
      );
    } finally {
      store.close();
    }
    const after = fixture.evidence.snapshot();
    const challenge = rejectionResult(
      {
        id: "forged-receipt",
        title: "Forged or mismatched receipt",
        attemptedAction:
          "Declare verified success with a caller-supplied mutation receipt instead of authoritative factory evidence.",
        rule:
          "A fenced execution can become verified only through result-bound factory evidence and independent read-back; caller receipts are never trusted.",
        adapterPath:
          "FlakeBrakeStore.recordExecutionTerminal → fenced M3 authoritative-verification guard",
      },
      reason,
      before,
      after,
    );
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function alternateDenialChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareFixture(root);
  try {
    const store = createStore({ path: fixture.m2, now: () => HERO_HORIZON_START });
    let factory: SyntheticFactoryEnvironment | null = null;
    let deniedInput: ClaimExecutionInput;
    try {
      factory = new SyntheticFactoryEnvironment({
        path: fixture.factory,
        now: () => HERO_HORIZON_END,
      });
      const deniedEffect = scheduleEffect("microfactory-effect/v1");
      store.createDenial({
        denialId: "denial/challenge-primary-interval",
        deniedEffectFingerprint: deniedEffect,
        deniedScope: executionScope(fixture.accepted.promiseBasisId),
        objectiveId: createHeroProposal().objective,
        approverId: HERO_OWNER_ID,
        evidencePacketId: "evidence/challenge-primary-denial",
        missionId: "mission/challenge-lab",
        reason: "The primary interval remains durably denied",
      });
      deniedInput = claimInput(
        store,
        factory,
        fixture,
        "attempt/challenge-denied-alternate",
        scheduleEffect("microfactory-effect/v2"),
      );
    } finally {
      factory?.close();
      store.close();
    }
    const before = fixture.evidence.snapshot();
    const rejectionStore = createStore({ path: fixture.m2, now: () => HERO_HORIZON_START });
    let reason: string;
    try {
      try {
        rejectionStore.claimExecution(deniedInput);
        throw new Error("Expected the active denial to reject the alternate representation");
      } catch (error: unknown) {
        if (!(error instanceof AuthorizationDeniedError)) throw error;
        if (error.evaluation.decision !== "DENY" || error.evaluation.reason !== "active_denial") {
          throw new Error("The alternate representation was not rejected by the active denial");
        }
        reason = safeReason(error);
      }
    } finally {
      rejectionStore.close();
    }
    const after = fixture.evidence.snapshot();
    const challenge = rejectionResult(
      {
        id: "alternate-after-denial",
        title: "Equivalent representation after denial",
        attemptedAction:
          "Claim the durably denied reservation through effect schema v2, an equivalent representation of the denied v1 effect.",
        rule:
          "Denial predicates match the normalized material effect, not a tool name or surface schema version.",
        adapterPath:
          "FlakeBrakeStore.claimExecution → evaluateAuthorization → normalizeEffect → active denial predicate",
      },
      reason,
      before,
      after,
    );
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function validReplayChallenge(root: string): Promise<ScenarioOutcome> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-valid-replay");
  try {
    let first!: SyntheticMutationResponse;
    await withChangeControlClient(fixture, true, async (client) => {
      first = requireMutationResponse(
        requireToolSuccess(
          await client.callTool({
            name: "create_schedule_reservation",
            arguments: mutationArguments(fixture.request),
          }) as CallToolResult,
          "initial authorized mutation",
        ),
      );
      requireToolSuccess(
        await client.callTool({
          name: "verify_schedule_execution",
          arguments: { execution_attempt_id: fixture.request.executionAttemptId },
        }) as CallToolResult,
        "authoritative verification",
      );
    });
    const before = fixture.evidence.snapshot();
    let replay!: SyntheticMutationResponse;
    await withChangeControlClient(fixture, false, async (client) => {
      replay = requireMutationResponse(
        requireToolSuccess(
          await client.callTool({
            name: "submit_schedule_change",
            arguments: alternateMutationArguments(fixture.request),
          }) as CallToolResult,
          "valid replay",
        ),
      );
    });
    const after = fixture.evidence.snapshot();
    const snapshotEqual = before.snapshot === after.snapshot;
    const sameResult = canonicalSerialize(first.result) === canonicalSerialize(replay.result);
    const sameReceipt = first.result.receipt.receiptId === replay.result.receipt.receiptId;
    const replayProof = {
      replayed: replay.replayed,
      originalResultReturned: sameResult,
      originalReceiptReturned: sameReceipt,
      noSecondMutation: after.counts.mutations === before.counts.mutations,
      noDuplicateFacts: after.counts.actualFacts === before.counts.actualFacts,
    };
    const challenge: AdversarialChallengeResult = {
      id: "valid-idempotent-replay",
      title: "Valid idempotent replay · positive control",
      control: "positive",
      attemptedAction:
        "Replay the previously verified reservation through the alternate schedule-change adapter with identical canonical material data.",
      authoritativeReason:
        "Replay accepted: the canonical request matched the immutable result, so the original result and receipt were returned.",
      rule:
        "Equivalent retries for one attempt identity replay the immutable result; they do not consume another allowance, mutate again, or duplicate facts.",
      adapterPath:
        "factory-change-control.submit_schedule_change → canonical executor → immutable result replay",
      before: publicEvidence(before),
      after: publicEvidence(after),
      snapshotEqual,
      zeroUnauthorizedEffects:
        snapshotEqual && Object.values(replayProof).every((value) => value === true),
      replayProof,
    };
    return scenarioOutcome(fixture, challenge);
  } finally {
    fixture.evidence.close();
  }
}

async function rejectionThroughMcp(
  fixture: PreparedFixture,
  description: Pick<
    AdversarialChallengeResult,
    "id" | "title" | "attemptedAction" | "rule" | "adapterPath"
  >,
  toolName: "create_schedule_reservation" | "submit_schedule_change",
  arguments_: Record<string, unknown>,
  expectedReason: RegExp,
): Promise<AdversarialChallengeResult> {
  const before = fixture.evidence.snapshot();
  let reason = "";
  await withChangeControlClient(fixture, false, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: arguments_ }) as CallToolResult;
    reason = requireToolRejection(result, expectedReason);
  });
  const after = fixture.evidence.snapshot();
  return rejectionResult(description, reason, before, after);
}

function rejectionResult(
  description: Pick<
    AdversarialChallengeResult,
    "id" | "title" | "attemptedAction" | "rule" | "adapterPath"
  >,
  authoritativeReason: string,
  before: CompleteEvidence,
  after: CompleteEvidence,
): AdversarialChallengeResult {
  const snapshotEqual = before.snapshot === after.snapshot;
  const countsEqual = canonicalSerialize(before.counts) === canonicalSerialize(after.counts);
  return {
    ...description,
    control: "rejection",
    authoritativeReason,
    before: publicEvidence(before),
    after: publicEvidence(after),
    snapshotEqual,
    zeroUnauthorizedEffects: snapshotEqual && countsEqual,
    replayProof: null,
  };
}

/**
 * Take the scenario's terminal snapshot from its still-owned evidence session
 * and require it to match the challenge's recorded final evidence exactly.
 */
function scenarioOutcome(
  fixture: PreparedFixture,
  challenge: AdversarialChallengeResult,
): ScenarioOutcome {
  const finalEvidence = fixture.evidence.snapshot();
  if (
    finalEvidence.snapshotDigest !== challenge.after.snapshotDigest ||
    canonicalSerialize(finalEvidence.counts) !== canonicalSerialize(challenge.after.counts)
  ) {
    throw new Error("The challenge scenario diverged after its final evidence was recorded");
  }
  return { challenge, finalEvidence, databases: fixture.evidence.bindings };
}

function prepareClaimedFixture(root: string, attemptId: string): ClaimedFixture {
  const fixture = prepareFixture(root);
  let store: FlakeBrakeStore | null = null;
  let factory: SyntheticFactoryEnvironment | null = null;
  let claimed: ClaimedFixture | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    store = createStore({ path: fixture.m2, now: () => HERO_HORIZON_START });
    factory = new SyntheticFactoryEnvironment({
      path: fixture.factory,
      now: () => HERO_HORIZON_END,
    });
    store.claimExecution(
      claimInput(store, factory, fixture, attemptId, scheduleEffect("microfactory-effect/v1")),
    );
    const attempt = store.getExecutionAttempt(attemptId);
    const before = factory.getScheduleState();
    claimed = {
      ...fixture,
      request: {
        executionAttemptId: attemptId,
        claim: claimedExecutionReference(attempt),
        command: commandFromAttempt(attempt),
        expectedBeforeStateVersion: before.stateVersion,
        expectedBeforeStateDigest: factoryStateDigest(before),
      },
    };
  } catch (error: unknown) {
    primaryFailed = true;
    primaryError = error;
  }
  const cleanupErrors = closeFixtureHandles(factory, store);
  if (primaryFailed || cleanupErrors.length > 0) {
    const primary: unknown = primaryFailed
      ? primaryError
      : new AggregateError(cleanupErrors, "Challenge fixture cleanup failed");
    if (primaryFailed) attachChallengeCleanupDiagnostics(primary, cleanupErrors);
    try {
      fixture.evidence.close();
    } catch (cleanupError: unknown) {
      attachChallengeCleanupDiagnostics(primary, [cleanupError]);
    }
    throw primary;
  }
  if (claimed === undefined) {
    throw new Error("Challenge fixture preparation was incomplete");
  }
  return claimed;
}

function prepareFixture(root: string): PreparedFixture {
  const paths = { m2: join(root, "m2.sqlite"), factory: join(root, "factory.sqlite") };
  const store = createStore({
    path: paths.m2,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_START,
  });
  let factory: SyntheticFactoryEnvironment | null = null;
  let evidence: ChallengeEvidenceSession | null = null;
  let fixture: PreparedFixture | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    factory = new SyntheticFactoryEnvironment({
      path: paths.factory,
      now: () => HERO_HORIZON_END,
    });
    // Authoritative evidence ownership is established here: both databases
    // were created by this invocation inside the just-created scenario
    // directory, their creating connections are still open, and every later
    // evidence read for this scenario uses these held connections.
    evidence = ChallengeEvidenceSession.open(paths);
    const initial = store.evaluateAndRecordAdmission({ proposal: createHeroProposal() });
    if (initial.decision !== "REPLAN") {
      throw new Error("Challenge fixture requires the canonical REPLAN admission");
    }
    const selectedPlanId = selectedPlan(initial);
    const modified = store.recordOwnerDecision({
      kind: "MODIFY",
      admissionRecordId: initial.admissionRecordId,
      ownerDecisionId: "owner-decision/challenge-modify",
      approverId: HERO_OWNER_ID,
      selectedPlanId,
    });
    if (modified.status !== "READMITTED") {
      throw new Error("Challenge fixture requires the authoritative readmission");
    }
    const accepted = modified.freshAdmissionRecord;
    const committed = store.acceptPromise({
      admissionRecordId: accepted.admissionRecordId,
      selectedPlanId,
      ownerDecisionId: ACCEPT_DECISION_ID,
      approverId: HERO_OWNER_ID,
      ownerSourceIdentity: "owner-source/challenge-lab",
      expectedPortfolioVersion: accepted.portfolioVersion,
      expectedCapacityModelVersion: accepted.capacityModelVersion,
      expectedCapacityPlanVersion: accepted.capacityPlanVersion,
      expectedAuthorizationStateVersion: accepted.authorizationStateVersion,
      expectedCalibrationFrontierDigest: accepted.calibrationFrontierDigest,
    });
    if (committed.status !== "COMMITTED") {
      throw new Error("Challenge fixture promise acceptance was not committed");
    }
    const versions = store.getPortfolio().versions;
    const grant = store.issueGrant({
      grantId: GRANT_ID,
      grantVersion: GRANT_VERSION,
      admissionRecordId: accepted.admissionRecordId,
      promiseBasisId: accepted.promiseBasisId,
      acceptedOwnerDecisionId: ACCEPT_DECISION_ID,
      ownerDecisionId: GRANT_DECISION_ID,
      selectedBundleId: BUNDLE_ID,
      selectedPlanId,
      scope: executionScope(accepted.promiseBasisId),
      postDenialAuthorization: null,
      expectedPortfolioVersion: versions.portfolioVersion,
      expectedCapacityModelVersion: versions.capacityModelVersion,
      expectedCapacityPlanVersion: versions.capacityPlanVersion,
    });
    fixture = {
      ...paths,
      accepted,
      selectedPlanId,
      grantAllowanceKey: grant.grantAllowanceKey,
      evidence,
    };
  } catch (error: unknown) {
    primaryFailed = true;
    primaryError = error;
  }
  const cleanupErrors = closeFixtureHandles(factory, store);
  if (primaryFailed || cleanupErrors.length > 0) {
    const primary: unknown = primaryFailed
      ? primaryError
      : new AggregateError(cleanupErrors, "Challenge fixture cleanup failed");
    if (primaryFailed) attachChallengeCleanupDiagnostics(primary, cleanupErrors);
    if (evidence !== null) {
      try {
        evidence.close();
      } catch (cleanupError: unknown) {
        attachChallengeCleanupDiagnostics(primary, [cleanupError]);
      }
    }
    throw primary;
  }
  if (fixture === undefined) {
    throw new Error("Challenge fixture preparation was incomplete");
  }
  return fixture;
}

/** Close both fixture handles independently so one failure cannot skip the other. */
function closeFixtureHandles(
  factory: SyntheticFactoryEnvironment | null,
  store: FlakeBrakeStore | null,
): readonly unknown[] {
  const cleanupErrors: unknown[] = [];
  if (factory !== null) {
    try {
      factory.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (store !== null) {
    try {
      store.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

function claimInput(
  store: FlakeBrakeStore,
  factory: SyntheticFactoryEnvironment,
  fixture: PreparedFixture,
  executionAttemptId: string,
  effect: EffectFingerprint,
): ClaimExecutionInput {
  const versions = store.getPortfolio().versions;
  const command = scheduleCommand();
  const after = resultingScheduleState(factory.getScheduleState(), executionAttemptId, command);
  return {
    executionAttemptId,
    admissionRecordId: fixture.accepted.admissionRecordId,
    promiseBasisId: fixture.accepted.promiseBasisId,
    acceptedOwnerDecisionId: ACCEPT_DECISION_ID,
    grantOwnerDecisionId: GRANT_DECISION_ID,
    grantId: GRANT_ID,
    expectedGrantVersion: GRANT_VERSION,
    grantAllowanceKey: fixture.grantAllowanceKey,
    effect,
    affectedObligationIds: [createHeroProposal().obligationId],
    affectedResourceIds: [HERO_RESOURCE_KEYS.agent, HERO_RESOURCE_KEYS.production],
    resourceCapacityClaims: {
      [HERO_RESOURCE_KEYS.agent]: 6,
      [HERO_RESOURCE_KEYS.human]: 0,
      [HERO_RESOURCE_KEYS.production]: 30,
    },
    temporalClaim: {
      resourceKey: HERO_RESOURCE_KEYS.production,
      start: FIRST_START,
      end: FIRST_END,
      requiredDuration: 30,
      timeUnit: "minutes",
    },
    claimAccounting: "already_in_portfolio",
    selectedBundleId: BUNDLE_ID,
    selectedPlanId: fixture.selectedPlanId,
    expectedEffect: command as unknown as JsonValue,
    expectedAfterState: after as unknown as JsonValue,
    attemptedAt: HERO_HORIZON_START,
    expectedPortfolioVersion: versions.portfolioVersion,
    expectedCapacityModelVersion: versions.capacityModelVersion,
    expectedCapacityPlanVersion: versions.capacityPlanVersion,
    expectedAuthorizationStateVersion: versions.authorizationStateVersion,
    expectedCalibrationFrontierDigest: fixture.accepted.calibrationFrontierDigest,
  };
}

function executionScope(promiseBasisId: string): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: HERO_ENVIRONMENT_ID,
    allowedEffectSchemaVersions: ["microfactory-effect/v1", "microfactory-effect/v2"],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: [HERO_PRODUCTION_CELL_ID],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: 10 },
      start: { kind: "equals", value: FIRST_START },
      end: { kind: "equals", value: FIRST_END },
    },
    resourceConstraints: {
      [HERO_RESOURCE_KEYS.agent]: { kind: "equals", value: 6 },
      [HERO_RESOURCE_KEYS.human]: { kind: "equals", value: 0 },
      [HERO_RESOURCE_KEYS.production]: { kind: "equals", value: 30 },
    },
    objectiveId: createHeroProposal().objective,
    promiseBasisId,
    approverId: HERO_OWNER_ID,
    validFrom: HERO_HORIZON_START,
    validUntil: HERO_HORIZON_END,
    maxExecutions: 1,
  };
}

function scheduleEffect(
  effectSchemaVersion: EffectFingerprint["effectSchemaVersion"],
): EffectFingerprint {
  return {
    effectSchemaVersion,
    environmentId: HERO_ENVIRONMENT_ID,
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: HERO_PRODUCTION_CELL_ID,
    operation: "reserve",
    materialParameters: { quantity: 10, start: FIRST_START, end: FIRST_END },
  };
}

function scheduleCommand(): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: HERO_ENVIRONMENT_ID,
    orderId: createHeroProposal().obligationId,
    productionCellId: HERO_PRODUCTION_CELL_ID,
    quantity: 10,
    start: FIRST_START,
    end: FIRST_END,
  };
}

function selectedPlan(record: AdmissionRecordBody): string {
  const candidate = record.candidatePlans.find(
    (item) =>
      item.feasible &&
      item.affectedObligations.some(
        (change) => change.optionId === "best-effort-order/reduce-to-8",
      ),
  );
  if (candidate === undefined) throw new Error("Canonical challenge plan is missing");
  return candidate.candidatePlanId;
}

async function withChangeControlClient<T>(
  fixture: FixturePaths,
  enableM4Tools: boolean,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const running = createFactoryMcpService("factory-change-control", {
    factoryDatabasePath: fixture.factory,
    m2DatabasePath: fixture.m2,
    now: () => HERO_HORIZON_END,
    enableM4Tools,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "flakebrake-challenge-lab", version: "0.1.0" });
  let primaryError: unknown;
  try {
    await running.server.connect(serverTransport);
    await client.connect(clientTransport);
    return await operation(client);
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([client.close(), running.close()]);
    const cleanupErrors = cleanup
      .filter((item): item is PromiseRejectedResult => item.status === "rejected")
      .map((item) => item.reason as unknown);
    if (primaryError === undefined && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Challenge adapter cleanup failed");
    }
  }
}

function mutationArguments(request: AuthorizedScheduleMutation): Record<string, unknown> {
  return {
    execution_attempt_id: request.executionAttemptId,
    claim: request.claim,
    expected_before_state_version: request.expectedBeforeStateVersion,
    expected_before_state_digest: request.expectedBeforeStateDigest,
    schedule_command: {
      schema_version: request.command.schemaVersion,
      command_kind: request.command.commandKind,
      environment_id: request.command.environmentId,
      order_id: request.command.orderId,
      production_cell_id: request.command.productionCellId,
      quantity: request.command.quantity,
      start: request.command.start,
      end: request.command.end,
    },
  };
}

function alternateMutationArguments(
  request: AuthorizedScheduleMutation,
): Record<string, unknown> {
  return {
    execution_attempt_id: request.executionAttemptId,
    claim: request.claim,
    expected_before_state_version: request.expectedBeforeStateVersion,
    expected_before_state_digest: request.expectedBeforeStateDigest,
    schedule_change: {
      schema_version: "microfactory-schedule-change/v1",
      operation: "reserve_cell",
      environment_id: request.command.environmentId,
      order_id: request.command.orderId,
      cell_id: request.command.productionCellId,
      quantity: request.command.quantity,
      starts_at: request.command.start,
      ends_at: request.command.end,
    },
  };
}

/**
 * Scenario-lifetime ownership of the challenge evidence connections.
 *
 * The session is opened once, immediately after the scenario's databases are
 * created inside the invocation-owned challenge root, and every piece of
 * evidence for that scenario is read from these held connections. After this
 * single admission point the evidence path never reopens a caller-visible
 * database pathname, so renaming and restoring the files cannot change what
 * the evidence reads. This binds evidence to the connections established at
 * creation; it does not prove that SQLite consumed a specific inode.
 *
 * @internal Exported only for executable regression proofs.
 */
export class ChallengeEvidenceSession {
  readonly #m2: DatabaseSync;
  readonly #factory: DatabaseSync;
  readonly #bindings: ChallengeScenarioBindings;
  #closed = false;

  private constructor(
    m2: DatabaseSync,
    factory: DatabaseSync,
    bindings: ChallengeScenarioBindings,
  ) {
    this.#m2 = m2;
    this.#factory = factory;
    this.#bindings = bindings;
  }

  static open(paths: FixturePaths): ChallengeEvidenceSession {
    const scenario = requireAdmissibleScenario(paths);
    for (const primary of [paths.m2, paths.factory]) {
      requireAdmissibleParticipant(primary, scenario, true);
      requireAdmissibleParticipant(`${primary}-wal`, scenario, false);
      requireAdmissibleParticipant(`${primary}-shm`, scenario, false);
    }
    const handles: DatabaseSync[] = [];
    try {
      const m2 = new DatabaseSync(paths.m2, { readOnly: true });
      handles.push(m2);
      m2.exec("PRAGMA busy_timeout = 5000");
      const factory = new DatabaseSync(paths.factory, { readOnly: true });
      handles.push(factory);
      factory.exec("PRAGMA busy_timeout = 5000");
      const bindings: ChallengeScenarioBindings = {
        m2: readDatabaseBinding(m2, "m2"),
        factory: readDatabaseBinding(factory, "factory"),
      };
      return new ChallengeEvidenceSession(m2, factory, bindings);
    } catch (error: unknown) {
      const cleanupErrors: unknown[] = [];
      for (const handle of handles.reverse()) {
        try {
          handle.close();
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError);
        }
      }
      attachChallengeCleanupDiagnostics(error, cleanupErrors);
      throw error;
    }
  }

  get bindings(): ChallengeScenarioBindings {
    return this.#bindings;
  }

  /**
   * One consistent evidence snapshot from the held connections. A read
   * transaction is pinned per database in deterministic acquisition order
   * (m2, then factory) before any row is read; every table's rows are read
   * inside those pinned transactions, and the counts, terminal state, and
   * digest are projections of that single row set, so a concurrent commit
   * cannot mix database states or divorce the counts from the digested rows.
   *
   * The optional observer runs after both transactions are pinned and exists
   * @internal for executable isolation proofs only.
   */
  snapshot(observers?: { readonly onSnapshotsPinned?: () => void }): CompleteEvidence {
    if (this.#closed) throw new Error("The challenge evidence session is closed");
    const pinned: DatabaseSync[] = [];
    try {
      for (const database of [this.#m2, this.#factory]) {
        database.exec("BEGIN");
        pinned.push(database);
        database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      }
      observers?.onSnapshotsPinned?.();
      const content: ChallengeSnapshotContent = {
        m2: databaseSnapshot(this.#m2),
        factory: databaseSnapshot(this.#factory),
      };
      while (pinned.length > 0) {
        pinned.pop()?.exec("COMMIT");
      }
      verifySnapshotDatabaseBindings(content, this.#bindings);
      const counts = countsFromSnapshot(content);
      const terminal = terminalStateFromSnapshot(content);
      const snapshot = canonicalSerialize(content);
      return { counts, snapshotDigest: sha256(snapshot), snapshot, content, terminal };
    } catch (error: unknown) {
      const cleanupErrors: unknown[] = [];
      while (pinned.length > 0) {
        const database = pinned.pop();
        if (database === undefined || !database.isTransaction) continue;
        try {
          database.exec("ROLLBACK");
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError);
        }
      }
      attachChallengeCleanupDiagnostics(error, cleanupErrors);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const cleanupErrors: unknown[] = [];
    for (const database of [this.#factory, this.#m2]) {
      try {
        database.close();
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Challenge evidence session cleanup failed");
    }
  }
}

function requireAdmissibleScenario(paths: FixturePaths): string {
  const scenario = dirname(paths.m2);
  if (
    dirname(paths.factory) !== scenario ||
    paths.m2 !== join(scenario, "m2.sqlite") ||
    paths.factory !== join(scenario, "factory.sqlite")
  ) {
    throw evidenceAdmissionError();
  }
  const challengeRoot = dirname(scenario);
  requireChallengeRoot(challengeRoot);
  const scenarioStat = lstatSync(scenario);
  if (!scenarioStat.isDirectory() || scenarioStat.isSymbolicLink()) {
    throw evidenceAdmissionError();
  }
  if (realpathSync(scenario) !== join(realpathSync(challengeRoot), basename(scenario))) {
    throw evidenceAdmissionError();
  }
  return scenario;
}

function requireAdmissibleParticipant(
  path: string,
  scenario: string,
  required: boolean,
): void {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) throw evidenceAdmissionError();
      return;
    }
    throw evidenceAdmissionError();
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    dirname(path) !== scenario
  ) {
    throw evidenceAdmissionError();
  }
}

function evidenceAdmissionError(): Error {
  return new Error(
    "Challenge evidence admission requires every owned database file to be a regular non-symbolic-link single-link SQLite participant",
  );
}

function readDatabaseBinding(
  database: DatabaseSync,
  storeKind: "m2" | "factory",
): ChallengeDatabaseBinding {
  const row = database
    .prepare("SELECT store_kind, incarnation_id FROM database_incarnation WHERE singleton = 1")
    .get() as Record<string, unknown> | undefined;
  const incarnationId = row?.["incarnation_id"];
  if (
    row === undefined ||
    row["store_kind"] !== storeKind ||
    typeof incarnationId !== "string" ||
    !incarnationId.startsWith("database-incarnation/")
  ) {
    throw new Error(
      `The ${storeKind} challenge database is missing its immutable incarnation identity`,
    );
  }
  return { storeKind, incarnationId };
}

function verifySnapshotDatabaseBindings(
  content: ChallengeSnapshotContent,
  bindings: ChallengeScenarioBindings,
): void {
  for (const storeKind of ["m2", "factory"] as const) {
    const rows = requireSnapshotTable(content[storeKind], "database_incarnation");
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row["store_kind"] !== storeKind ||
      row["incarnation_id"] !== bindings[storeKind].incarnationId
    ) {
      throw new Error("Challenge evidence diverged from its bound database identities");
    }
  }
}

function countsFromSnapshot(content: ChallengeSnapshotContent): ChallengeCounts {
  return {
    admissions: requireSnapshotTable(content.m2, "admission_records").length,
    grants: requireSnapshotTable(content.m2, "grants").length,
    attempts: requireSnapshotTable(content.m2, "execution_attempts").length,
    fences: requireSnapshotTable(content.m2, "execution_fences").length,
    mutations: requireSnapshotTable(content.factory, "mutation_events").length,
    receipts: requireSnapshotTable(content.factory, "execution_results").length,
    terminalEvents: requireSnapshotTable(content.m2, "reservation_events").length,
    actualFacts: requireSnapshotTable(content.m2, "admission_addenda").filter(
      (row) => row["kind"] === "actual_consumption",
    ).length,
  };
}

function terminalStateFromSnapshot(content: ChallengeSnapshotContent): ChallengeTerminalState {
  const kinds = requireSnapshotTable(content.m2, "reservation_events")
    .map((row) => {
      const kind = row["event_kind"];
      if (typeof kind !== "string" || kind.length === 0) {
        throw new Error("The challenge evidence terminal events are malformed");
      }
      return kind;
    })
    .sort(compareStableStrings);
  return {
    reservationEventKinds: kinds,
    verifiedTerminalEvents: kinds.filter((kind) => kind === "terminal_verified").length,
  };
}

function requireSnapshotTable(dump: ChallengeDatabaseDump, table: string): ChallengeTableRows {
  const rows = dump[table];
  if (rows === undefined) {
    throw new Error("The challenge evidence snapshot is missing a required table");
  }
  return rows;
}

function attachChallengeCleanupDiagnostics(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (
    cleanupErrors.length === 0 ||
    ((typeof primaryError !== "object" || primaryError === null) &&
      typeof primaryError !== "function")
  ) {
    return;
  }
  try {
    const existing = Reflect.get(primaryError, "cleanupErrors");
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: Object.freeze([
        ...(Array.isArray(existing) ? existing : []),
        ...cleanupErrors,
      ]),
      writable: false,
    });
  } catch {
    // The authoritative provenance failure remains primary.
  }
}

function databaseSnapshot(database: DatabaseSync): ChallengeDatabaseDump {
  const tables = (
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as Record<string, unknown>[]
  ).map((row) => String(row["name"]));
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (database.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[])
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).sort(([left], [right]) => compareStableStrings(left, right)),
          ),
        )
        .sort((left, right) =>
          compareStableStrings(canonicalSerialize(left), canonicalSerialize(right)),
        ),
    ]),
  );
}

function publicEvidence(evidence: CompleteEvidence): ChallengeEvidence {
  return { counts: evidence.counts, snapshotDigest: evidence.snapshotDigest };
}

function requireToolSuccess(result: CallToolResult, context: string): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`${context} failed: ${toolText(result)}`);
  }
  const structured = result.structuredContent;
  if (structured === undefined) {
    const parsed = JSON.parse(toolText(result)) as unknown;
    if (!isObject(parsed)) throw new Error(`${context} returned a non-object result`);
    return parsed;
  }
  return structured;
}

function requireToolRejection(result: CallToolResult, expectedReason: RegExp): string {
  if (result.isError !== true) throw new Error("Challenge action did not fail closed");
  const reason = safeReason(toolText(result));
  if (!expectedReason.test(reason)) {
    throw new Error(`Unexpected authoritative rejection: ${reason}`);
  }
  return reason;
}

function requireMutationResponse(value: Record<string, unknown>): SyntheticMutationResponse {
  const result = value["result"];
  if (typeof value["replayed"] !== "boolean" || !isObject(result)) {
    throw new Error("Challenge mutation adapter returned an invalid response");
  }
  return value as unknown as SyntheticMutationResponse;
}

function expectThrownReason(operation: () => unknown, expectedReason: RegExp): string {
  try {
    operation();
  } catch (error: unknown) {
    const reason = safeReason(error);
    if (!expectedReason.test(reason)) {
      throw new Error(`Unexpected authoritative rejection: ${reason}`);
    }
    return reason;
  }
  throw new Error("Challenge action did not fail closed");
}

function toolText(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<typeof item, { readonly type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join(" ");
}

function safeReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replaceAll(/(?:admission|grant|attempt|plan|receipt|terminal)\/[A-Za-z0-9._\-/\[\]]+/gu, "[redacted identity]")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function establishChallengeRoot(ownedDataRootValue: string): string {
  const ownedDataRoot = requireOwnedM5Root(ownedDataRootValue);
  const root = join(ownedDataRoot, CHALLENGE_DIRECTORY);
  if (existsSync(root)) {
    throw new Error("The deterministic challenge lab has already been initialized");
  }
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, CHALLENGE_MARKER), CHALLENGE_MARKER_CONTENT, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return root;
}

function requireOwnedM5Root(value: string): string {
  if (!isAbsolute(value)) throw new TypeError("Challenge data root must be absolute");
  const root = resolve(value);
  if (!existsSync(root)) throw new Error("Challenge data root does not exist");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Challenge data root must be a real directory");
  }
  // The final entry was just verified to be a real directory, so realpath only
  // canonicalizes aliased ancestors. Every challenge path is constructed from
  // this canonical root; valid roots reached through symlinked ancestors work,
  // matching the accepted M5 root validation, while symbolic links at owned
  // entries themselves remain rejected.
  const canonicalRoot = realpathSync(root);
  const marker = join(canonicalRoot, M5_PARENT_MARKER);
  if (
    !existsSync(marker) ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== M5_PARENT_MARKER_CONTENT
  ) {
    throw new Error("Challenge data root is not owned by this M5 invocation");
  }
  return canonicalRoot;
}

function scenarioRoot(root: string, name: string): string {
  if (!/^[0-9]{2}-[a-z-]+$/u.test(name)) throw new TypeError("Invalid scenario name");
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `keys` must be pre-sorted with compareStableStrings. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value).sort(compareStableStrings);
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isChallengeLabResult(value: unknown): value is AdversarialChallengeLabResult {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "allPassed",
      "challenges",
      "complete",
      "label",
      "omitted",
      "schemaVersion",
    ])
  ) {
    return false;
  }
  if (
    value["schemaVersion"] !== "flakebrake-adversarial-challenge/v1" ||
    value["label"] !== "Deterministic assurance demonstration" ||
    value["complete"] !== true ||
    typeof value["allPassed"] !== "boolean" ||
    !Array.isArray(value["omitted"]) ||
    value["omitted"].length !== 0 ||
    !Array.isArray(value["challenges"]) ||
    value["challenges"].length !== 6
  ) {
    return false;
  }
  const expectedIds = CHALLENGE_SCENARIOS.map((scenario) => scenario.id);
  for (const [index, item] of value["challenges"].entries()) {
    if (
      !isObject(item) ||
      !hasExactKeys(item, [
        "adapterPath",
        "after",
        "attemptedAction",
        "authoritativeReason",
        "before",
        "control",
        "id",
        "replayProof",
        "rule",
        "snapshotEqual",
        "title",
        "zeroUnauthorizedEffects",
      ]) ||
      item["id"] !== expectedIds[index]
    ) {
      return false;
    }
    if (
      typeof item["title"] !== "string" ||
      (item["control"] !== "rejection" && item["control"] !== "positive") ||
      typeof item["attemptedAction"] !== "string" ||
      typeof item["authoritativeReason"] !== "string" ||
      typeof item["rule"] !== "string" ||
      typeof item["adapterPath"] !== "string" ||
      item["snapshotEqual"] !== true ||
      item["zeroUnauthorizedEffects"] !== true ||
      !isChallengeEvidence(item["before"]) ||
      !isChallengeEvidence(item["after"])
    ) {
      return false;
    }
    const proof = item["replayProof"];
    if (item["control"] === "rejection" && proof !== null) return false;
    if (
      item["control"] === "positive" &&
      (!isObject(proof) ||
        !hasExactKeys(proof, [
          "noDuplicateFacts",
          "noSecondMutation",
          "originalReceiptReturned",
          "originalResultReturned",
          "replayed",
        ]) ||
        !Object.values(proof).every((entry) => entry === true))
    ) {
      return false;
    }
  }
  return (
    value["allPassed"] ===
    value["challenges"].every(
      (item) => isObject(item) && item["zeroUnauthorizedEffects"] === true,
    )
  );
}

function isChallengeEvidence(value: unknown): value is ChallengeEvidence {
  if (!isObject(value) || !hasExactKeys(value, ["counts", "snapshotDigest"])) return false;
  const counts = value["counts"];
  if (!isObject(counts) || !hasExactKeys(counts, CHALLENGE_COUNT_KEYS_SORTED)) return false;
  if (!isSha256Digest(value["snapshotDigest"])) return false;
  return CHALLENGE_COUNT_KEYS.every((key) => {
    const count = counts[key];
    return Number.isSafeInteger(count) && (count as number) >= 0;
  });
}

function isChallengeEvidenceBundle(value: unknown): value is AdversarialChallengeEvidenceBundle {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "labSessionId",
      "missionId",
      "resultDigest",
      "scenarios",
      "schemaVersion",
    ])
  ) {
    return false;
  }
  if (
    value["schemaVersion"] !== CHALLENGE_EVIDENCE_SCHEMA_VERSION ||
    value["missionId"] !== CHALLENGE_MISSION_ID ||
    typeof value["labSessionId"] !== "string" ||
    !/^challenge-session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value["labSessionId"],
    ) ||
    !isSha256Digest(value["resultDigest"])
  ) {
    return false;
  }
  const scenarios = value["scenarios"];
  if (!Array.isArray(scenarios) || scenarios.length !== CHALLENGE_SCENARIOS.length) {
    return false;
  }
  return scenarios.every((scenario, index) =>
    isChallengeScenarioEvidenceRecord(scenario, CHALLENGE_SCENARIOS[index]),
  );
}

function isChallengeScenarioEvidenceRecord(
  value: unknown,
  expected:
    | { readonly id: AdversarialChallengeResult["id"]; readonly directory: string }
    | undefined,
): value is ChallengeScenarioEvidenceRecord {
  if (expected === undefined || !isObject(value)) return false;
  if (
    !hasExactKeys(value, [
      "counts",
      "databases",
      "directory",
      "scenarioId",
      "snapshot",
      "snapshotDigest",
      "terminal",
    ])
  ) {
    return false;
  }
  if (
    value["scenarioId"] !== expected.id ||
    value["directory"] !== expected.directory ||
    !isSha256Digest(value["snapshotDigest"])
  ) {
    return false;
  }
  const databases = value["databases"];
  if (
    !isObject(databases) ||
    !hasExactKeys(databases, ["factory", "m2"]) ||
    !isChallengeDatabaseBinding(databases["m2"], "m2") ||
    !isChallengeDatabaseBinding(databases["factory"], "factory")
  ) {
    return false;
  }
  const counts = value["counts"];
  if (
    !isObject(counts) ||
    !hasExactKeys(counts, CHALLENGE_COUNT_KEYS_SORTED) ||
    !CHALLENGE_COUNT_KEYS.every((key) => {
      const count = counts[key];
      return Number.isSafeInteger(count) && (count as number) >= 0;
    })
  ) {
    return false;
  }
  const terminal = value["terminal"];
  if (
    !isObject(terminal) ||
    !hasExactKeys(terminal, ["reservationEventKinds", "verifiedTerminalEvents"])
  ) {
    return false;
  }
  const kinds = terminal["reservationEventKinds"];
  const verified = terminal["verifiedTerminalEvents"];
  if (
    !Array.isArray(kinds) ||
    !kinds.every((kind) => typeof kind === "string" && kind.length > 0) ||
    !Number.isSafeInteger(verified) ||
    (verified as number) < 0
  ) {
    return false;
  }
  const snapshot = value["snapshot"];
  if (!isObject(snapshot) || !hasExactKeys(snapshot, ["factory", "m2"])) return false;
  return (
    isChallengeDatabaseDump(snapshot["m2"]) && isChallengeDatabaseDump(snapshot["factory"])
  );
}

function isChallengeDatabaseBinding(
  value: unknown,
  storeKind: "m2" | "factory",
): value is ChallengeDatabaseBinding {
  if (!isObject(value) || !hasExactKeys(value, ["incarnationId", "storeKind"])) return false;
  const incarnationId = value["incarnationId"];
  return (
    value["storeKind"] === storeKind &&
    typeof incarnationId === "string" &&
    incarnationId.startsWith("database-incarnation/") &&
    incarnationId.length > "database-incarnation/".length
  );
}

function isChallengeDatabaseDump(value: unknown): value is ChallengeDatabaseDump {
  if (!isObject(value)) return false;
  return Object.values(value).every(
    (rows) => Array.isArray(rows) && rows.every((row) => isObject(row)),
  );
}
