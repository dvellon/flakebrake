import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

interface FixturePaths {
  readonly m2: string;
  readonly factory: string;
}

interface PreparedFixture extends FixturePaths {
  readonly accepted: AdmissionRecordBody;
  readonly selectedPlanId: string;
  readonly grantAllowanceKey: string;
}

interface ClaimedFixture extends PreparedFixture {
  readonly request: AuthorizedScheduleMutation;
}

interface CompleteEvidence extends ChallengeEvidence {
  readonly snapshot: string;
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
  const challenges: AdversarialChallengeResult[] = [];
  challenges.push(await identitySubstitutionChallenge(scenarioRoot(root, "01-identity")));
  challenges.push(await staleBasisChallenge(scenarioRoot(root, "02-stale-basis")));
  challenges.push(await attemptConflictChallenge(scenarioRoot(root, "03-attempt-conflict")));
  challenges.push(await forgedReceiptChallenge(scenarioRoot(root, "04-forged-receipt")));
  challenges.push(await alternateDenialChallenge(scenarioRoot(root, "05-alternate-denial")));
  challenges.push(await validReplayChallenge(scenarioRoot(root, "06-valid-replay")));
  const result: AdversarialChallengeLabResult = {
    schemaVersion: "flakebrake-adversarial-challenge/v1",
    label: "Deterministic assurance demonstration",
    complete: true,
    allPassed: challenges.every((challenge) => challenge.zeroUnauthorizedEffects),
    omitted: [],
    challenges,
  };
  writeFileSync(join(root, CHALLENGE_RESULT), canonicalSerialize(result), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return result;
}

/** Load only a result whose six complete database snapshots still match. */
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
  const bytes = readFileSync(resultPath, "utf8");
  const value = JSON.parse(bytes) as unknown;
  if (!isChallengeLabResult(value) || canonicalSerialize(value) !== bytes) {
    throw new Error("The durable challenge result is invalid");
  }
  const directories = [
    "01-identity",
    "02-stale-basis",
    "03-attempt-conflict",
    "04-forged-receipt",
    "05-alternate-denial",
    "06-valid-replay",
  ] as const;
  for (const [index, directory] of directories.entries()) {
    const challenge = value.challenges[index];
    if (challenge === undefined) throw new Error("The durable challenge result is incomplete");
    const current = completeEvidence({
      m2: join(root, directory, "m2.sqlite"),
      factory: join(root, directory, "factory.sqlite"),
    });
    if (
      canonicalSerialize(publicEvidence(current)) !== canonicalSerialize(challenge.after) ||
      canonicalSerialize(challenge.before) !== canonicalSerialize(challenge.after)
    ) {
      throw new Error("The durable challenge evidence no longer matches its complete snapshot");
    }
  }
  return value;
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

async function identitySubstitutionChallenge(
  root: string,
): Promise<AdversarialChallengeResult> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-identity");
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
  return rejectionThroughMcp(
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
}

async function staleBasisChallenge(root: string): Promise<AdversarialChallengeResult> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-stale-basis");
  const stale: AuthorizedScheduleMutation = {
    ...fixture.request,
    expectedBeforeStateVersion: "factory-state/v999",
  };
  return rejectionThroughMcp(
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
}

async function attemptConflictChallenge(root: string): Promise<AdversarialChallengeResult> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-conflict");
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
  return rejectionThroughMcp(
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
}

async function forgedReceiptChallenge(root: string): Promise<AdversarialChallengeResult> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-forged-receipt");
  await withChangeControlClient(fixture, false, async (client) => {
    requireToolSuccess(
      await client.callTool({
        name: "create_schedule_reservation",
        arguments: mutationArguments(fixture.request),
      }) as CallToolResult,
      "valid setup mutation",
    );
  });
  const before = completeEvidence(fixture);
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
  const after = completeEvidence(fixture);
  return rejectionResult(
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
}

async function alternateDenialChallenge(root: string): Promise<AdversarialChallengeResult> {
  const fixture = prepareFixture(root);
  const store = createStore({ path: fixture.m2, now: () => HERO_HORIZON_START });
  const factory = new SyntheticFactoryEnvironment({
    path: fixture.factory,
    now: () => HERO_HORIZON_END,
  });
  let deniedInput: ClaimExecutionInput;
  try {
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
    factory.close();
    store.close();
  }
  const before = completeEvidence(fixture);
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
  const after = completeEvidence(fixture);
  return rejectionResult(
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
}

async function validReplayChallenge(root: string): Promise<AdversarialChallengeResult> {
  const fixture = prepareClaimedFixture(root, "attempt/challenge-valid-replay");
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
  const before = completeEvidence(fixture);
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
  const after = completeEvidence(fixture);
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
  return {
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
}

async function rejectionThroughMcp(
  fixture: FixturePaths,
  description: Pick<
    AdversarialChallengeResult,
    "id" | "title" | "attemptedAction" | "rule" | "adapterPath"
  >,
  toolName: "create_schedule_reservation" | "submit_schedule_change",
  arguments_: Record<string, unknown>,
  expectedReason: RegExp,
): Promise<AdversarialChallengeResult> {
  const before = completeEvidence(fixture);
  let reason = "";
  await withChangeControlClient(fixture, false, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: arguments_ }) as CallToolResult;
    reason = requireToolRejection(result, expectedReason);
  });
  const after = completeEvidence(fixture);
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

function prepareClaimedFixture(root: string, attemptId: string): ClaimedFixture {
  const fixture = prepareFixture(root);
  const store = createStore({ path: fixture.m2, now: () => HERO_HORIZON_START });
  const factory = new SyntheticFactoryEnvironment({
    path: fixture.factory,
    now: () => HERO_HORIZON_END,
  });
  try {
    store.claimExecution(
      claimInput(store, factory, fixture, attemptId, scheduleEffect("microfactory-effect/v1")),
    );
    const attempt = store.getExecutionAttempt(attemptId);
    const before = factory.getScheduleState();
    return {
      ...fixture,
      request: {
        executionAttemptId: attemptId,
        claim: claimedExecutionReference(attempt),
        command: commandFromAttempt(attempt),
        expectedBeforeStateVersion: before.stateVersion,
        expectedBeforeStateDigest: factoryStateDigest(before),
      },
    };
  } finally {
    factory.close();
    store.close();
  }
}

function prepareFixture(root: string): PreparedFixture {
  const paths = { m2: join(root, "m2.sqlite"), factory: join(root, "factory.sqlite") };
  const store = createStore({
    path: paths.m2,
    initialState: createHeroInitialState(),
    now: () => HERO_HORIZON_START,
  });
  const factory = new SyntheticFactoryEnvironment({
    path: paths.factory,
    now: () => HERO_HORIZON_END,
  });
  try {
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
    return {
      ...paths,
      accepted,
      selectedPlanId,
      grantAllowanceKey: grant.grantAllowanceKey,
    };
  } finally {
    factory.close();
    store.close();
  }
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

function completeEvidence(paths: FixturePaths): CompleteEvidence {
  const snapshot = canonicalSerialize({
    m2: databaseSnapshot(paths.m2),
    factory: databaseSnapshot(paths.factory),
  });
  return {
    counts: {
      admissions: tableCount(paths.m2, "admission_records"),
      grants: tableCount(paths.m2, "grants"),
      attempts: tableCount(paths.m2, "execution_attempts"),
      fences: tableCount(paths.m2, "execution_fences"),
      mutations: tableCount(paths.factory, "mutation_events"),
      receipts: tableCount(paths.factory, "execution_results"),
      terminalEvents: tableCount(paths.m2, "reservation_events"),
      actualFacts: filteredCount(
        paths.m2,
        "admission_addenda",
        "kind = 'actual_consumption'",
      ),
    },
    snapshot,
    snapshotDigest: sha256(snapshot),
  };
}

function databaseSnapshot(path: string): Readonly<Record<string, readonly unknown[]>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
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
              Object.entries(row).sort(([left], [right]) =>
                compareStableStrings(left, right),
              ),
            ),
          )
          .sort((left, right) =>
            compareStableStrings(canonicalSerialize(left), canonicalSerialize(right)),
          ),
      ]),
    );
  } finally {
    database.close();
  }
}

function tableCount(path: string, table: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
      | Record<string, unknown>
      | undefined;
    const count = row?.["count"];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Invalid challenge evidence count for ${table}`);
    }
    return count as number;
  } finally {
    database.close();
  }
}

function filteredCount(path: string, table: string, predicate: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${predicate}`)
      .get() as Record<string, unknown> | undefined;
    const count = row?.["count"];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Invalid challenge evidence count for ${table}`);
    }
    return count as number;
  } finally {
    database.close();
  }
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
  const marker = join(root, M5_PARENT_MARKER);
  if (
    !existsSync(marker) ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== M5_PARENT_MARKER_CONTENT
  ) {
    throw new Error("Challenge data root is not owned by this M5 invocation");
  }
  return root;
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

function isChallengeLabResult(value: unknown): value is AdversarialChallengeLabResult {
  if (!isObject(value)) return false;
  if (
    value["schemaVersion"] !== "flakebrake-adversarial-challenge/v1" ||
    value["label"] !== "Deterministic assurance demonstration" ||
    value["complete"] !== true ||
    typeof value["allPassed"] !== "boolean" ||
    !Array.isArray(value["omitted"]) ||
    !value["omitted"].every((item) => typeof item === "string") ||
    !Array.isArray(value["challenges"]) ||
    value["challenges"].length !== 6
  ) {
    return false;
  }
  const expectedIds = [
    "identity-substitution",
    "stale-authoritative-basis",
    "attempt-id-conflict",
    "forged-receipt",
    "alternate-after-denial",
    "valid-idempotent-replay",
  ];
  for (const [index, item] of value["challenges"].entries()) {
    if (!isObject(item) || item["id"] !== expectedIds[index]) return false;
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
        ![
          "replayed",
          "originalResultReturned",
          "originalReceiptReturned",
          "noSecondMutation",
          "noDuplicateFacts",
        ].every((key) => proof[key] === true))
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
  if (!isObject(value) || !isObject(value["counts"])) return false;
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value["snapshotDigest"]))) return false;
  return [
    "admissions",
    "grants",
    "attempts",
    "fences",
    "mutations",
    "receipts",
    "terminalEvents",
    "actualFacts",
  ].every((key) => {
    const count = (value["counts"] as Record<string, unknown>)[key];
    return Number.isSafeInteger(count) && (count as number) >= 0;
  });
}
