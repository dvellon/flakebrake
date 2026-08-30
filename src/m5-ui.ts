import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalSerialize } from "./canonical.js";
import {
  cleanupAdversarialChallengeLab,
  readAdversarialChallengeLab,
  runAdversarialChallengeLab,
  type AdversarialChallengeLabResult,
  type AdversarialChallengeResult,
} from "./challenge-lab.js";
import type { JsonValue } from "./domain.js";
import {
  readAuthoritativeFactoryExecution,
  SyntheticFactoryEnvironment,
} from "./factory-environment.js";
import {
  createHeroEvaluationInput,
  createHeroInitialState,
  HERO_HORIZON_END,
  HERO_RESOURCE_KEYS,
} from "./hero-fixture.js";
import { evaluateAdmission } from "./kernel.js";
import {
  m4OwnerDecisionResponse,
  type M4ApprovalRecord,
  type M4MissionCheckpoint,
  type M4OwnerApprovalDecision,
  type M4OwnerApprovalRequest,
  type M4OwnerDecisionResponse,
} from "./m4-mission-controller.js";
import { M4MissionStore, type M4MissionSnapshot } from "./m4-mission-store.js";
import {
  M4_HERO_MISSION_ID,
  runDeterministicM4Mission,
  type DeterministicM4MissionResult,
} from "./m4-runner.js";
import { createStore } from "./store.js";

const LOOPBACK_HOST = "127.0.0.1";
const OWNER_SOURCE_IDENTITY = "owner/judge-ui";
const STATE_SCHEMA_VERSION = "flakebrake-m5-judge-state/v1";
const OWNERSHIP_MARKER = ".flakebrake-m5-owned-v1";
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 256;
const HERO_ATTEMPT_ID = "attempt/m4-approved-alternative";
const DEFAULT_REQUEST_DRAIN_TIMEOUT_MS = 500;

export type M5RunStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "verifying"
  | "verified"
  | "failed"
  | "closed";

export interface M5PendingApproval {
  readonly missionId: string;
  readonly actionIdentity: string;
  readonly phase: M4OwnerApprovalRequest["phase"];
  readonly toolName: string;
  readonly expectedEffect: string;
  readonly recommendedDecision: "allow" | "deny";
  readonly ownerSourceIdentity: string;
  readonly technicalSubject: string | null;
}

export interface M5JudgeState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly revision: number;
  readonly run: {
    readonly status: M5RunStatus;
    readonly generation: number;
    readonly connection: "idle" | "connected" | "awaiting_owner" | "replayed" | "closed";
    readonly canStart: boolean;
    readonly canReset: boolean;
    readonly ownerCallsThisProcess: number;
    readonly errorCode: string | null;
  };
  readonly mission: {
    readonly missionId: string;
    readonly sessionId: string | null;
    readonly currentTurnId: string | null;
    readonly terminalProjectionDigest: string | null;
    readonly disconnectedAndResumed: boolean;
  };
  readonly hero: {
    readonly directDecision: "REPLAN";
    readonly portfolioVersion: string;
    readonly obligations: readonly {
      readonly obligationId: string;
      readonly objective: string;
      readonly criticality: string;
      readonly protected: boolean;
      readonly quantity: number;
    }[];
    readonly proposal: {
      readonly obligationId: string;
      readonly objective: string;
      readonly quantity: number;
    };
    readonly capacity: readonly {
      readonly resourceKey: string;
      readonly label: string;
      readonly unit: string;
      readonly declaredCapacity: number;
      readonly existingUse: number;
      readonly proposedConsumption: number;
      readonly remainingCapacity: number;
      readonly status: "available" | "over-capacity";
    }[];
    readonly violations: readonly string[];
    readonly candidates: readonly {
      readonly candidatePlanId: string;
      readonly strategy: string;
      readonly changedObligations: readonly string[];
      readonly remainingCapacity: readonly { readonly resourceKey: string; readonly value: number }[];
      readonly recommended: boolean;
    }[];
    readonly winningModification: {
      readonly candidatePlanId: string;
      readonly strategy: "modify_existing";
      readonly obligationId: string;
      readonly optionId: string;
      readonly fromQuantity: number;
      readonly toQuantity: number;
    };
    readonly protectedWorkUnchanged: boolean;
  };
  readonly pendingApproval: M5PendingApproval | null;
  readonly approvals: readonly {
    readonly toolName: string;
    readonly decision: "allow" | "deny";
    readonly source: "owner" | "active_m2_denial";
    readonly ownerSourceIdentity: string | null;
    readonly actionIdentity: string;
    readonly effect: string;
    readonly reason: string;
    readonly denialId: string | null;
  }[];
  readonly activity: {
    readonly rootAgent: { readonly id: string; readonly name: string } | null;
    readonly subagents: readonly { readonly threadId: string; readonly title: string; readonly status: "done" }[];
    readonly sandboxExecutions: number;
    readonly mcpServers: readonly string[];
    readonly toolCalls: readonly string[];
    readonly modelRequests: number;
  };
  readonly evidenceTimeline: readonly {
    readonly sequence: number;
    readonly kind: string;
    readonly title: string;
    readonly detail: string;
    readonly technicalIdentity: string | null;
    readonly status: "proposed" | "pending" | "denied" | "approved" | "verified" | "informational";
  }[];
  readonly execution: {
    readonly acceptanceCount: number;
    readonly attemptCount: number;
    readonly mutationCount: number;
    readonly receiptCount: number;
    readonly actualFactCount: number;
    readonly actualFacts: readonly {
      readonly resourceKey: string;
      readonly workClassKey: string;
      readonly value: number;
    }[];
    readonly attemptId: string | null;
    readonly receiptId: string | null;
    readonly approvedInterval: string | null;
    readonly mutationStatus: string | null;
    readonly independentReadBackObserved: boolean;
    readonly terminalStatus: string | null;
  };
  readonly safety: {
    readonly ownerCallCount: number;
    readonly mechanicalDenialCount: number;
    readonly duplicateApprovalCount: number;
    readonly duplicateEffectCount: number;
    readonly unauthorizedMutationCount: number;
  };
  readonly challengeLab: {
    readonly status: "idle" | "running" | "complete" | "failed" | "closed";
    readonly canRun: boolean;
    readonly label: "Deterministic assurance demonstration";
    readonly allPassed: boolean | null;
    readonly omitted: readonly string[];
    readonly challenges: readonly AdversarialChallengeResult[];
    readonly errorCode: string | null;
  };
}

export interface M5DemoCoordinatorOptions {
  readonly dataRoot: string;
  readonly cleanupDataOnClose?: boolean;
}

interface PendingApprovalInternal {
  readonly request: M4OwnerApprovalRequest;
  readonly publicState: M5PendingApproval;
  readonly resolve: (response: M4OwnerDecisionResponse) => void;
}

interface RecordedDecision {
  readonly response: M4OwnerDecisionResponse;
  readonly canonicalInput: string;
}

interface DemoPaths {
  readonly m2: string;
  readonly factory: string;
  readonly mission: string;
  readonly trueforge: string;
  readonly sandboxes: string;
}

export class M5RequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "M5RequestError";
  }
}

export class M5DemoCoordinator {
  readonly #dataRoot: string;
  readonly #cleanupDataOnClose: boolean;
  readonly #paths: DemoPaths;
  readonly #decisionHistory = new Map<string, RecordedDecision>();
  readonly #observedApprovals: M4ApprovalRecord[] = [];
  readonly #runtimeEvidence: {
    sequence: number;
    kind: string;
    title: string;
    detail: string;
    technicalIdentity: string | null;
    status: M5JudgeState["evidenceTimeline"][number]["status"];
  }[] = [];
  #pendingApproval: PendingApprovalInternal | null = null;
  #result: DeterministicM4MissionResult | null = null;
  #runPromise: Promise<void> | null = null;
  #status: M5RunStatus = "idle";
  #errorCode: string | null = null;
  #closed = false;
  #closing = false;
  #generation = 1;
  #revision = 0;
  #ownerCallsThisProcess = 0;
  #replayedTerminal = false;
  #challengeStatus: M5JudgeState["challengeLab"]["status"] = "idle";
  #challengeResult: AdversarialChallengeLabResult | null = null;
  #challengePromise: Promise<void> | null = null;
  #challengeErrorCode: string | null = null;

  public constructor(options: M5DemoCoordinatorOptions) {
    if (!isAbsolute(options.dataRoot)) {
      throw new TypeError("M5 dataRoot must be absolute");
    }
    this.#dataRoot = resolve(options.dataRoot);
    this.#cleanupDataOnClose = options.cleanupDataOnClose ?? true;
    this.#paths = {
      m2: join(this.#dataRoot, "m2.sqlite"),
      factory: join(this.#dataRoot, "factory.sqlite"),
      mission: join(this.#dataRoot, "mission.sqlite"),
      trueforge: join(this.#dataRoot, "trueforge.sqlite"),
      sandboxes: join(this.#dataRoot, "trueforge-data"),
    };
    establishOwnedDataRoot(this.#dataRoot);
    try {
      const challenge = readAdversarialChallengeLab(this.#dataRoot);
      if (challenge !== null) {
        this.#challengeResult = challenge;
        this.#challengeStatus = "complete";
      }
    } catch {
      this.#challengeStatus = "failed";
      this.#challengeErrorCode = "challenge_evidence_invalid";
    }
  }

  public start(): M5JudgeState {
    this.#assertOpen();
    if (this.#runPromise !== null || this.#status === "verified") {
      return this.state();
    }
    if (this.#status === "failed") {
      this.#generation += 1;
      this.#upsertEvidence(
        "failure",
        "Earlier attempt stopped safely · recovered",
        "A durable retry resumed the same mission without exposing unverified success or repeating an effect.",
        "informational",
      );
    }
    this.#status = "running";
    this.#replayedTerminal =
      this.#readExecution().terminalStatus === "terminal_verified";
    this.#errorCode = null;
    this.#upsertEvidence(
      "mission",
      "Deterministic mission started",
      "Canonical M1–M4 stores and TrueForge orchestration are starting.",
      "informational",
    );
    const run = runDeterministicM4Mission({
      m2DatabasePath: this.#paths.m2,
      factoryDatabasePath: this.#paths.factory,
      missionDatabasePath: this.#paths.mission,
      trueforgeDatabasePath: this.#paths.trueforge,
      localSandboxRootParent: this.#paths.sandboxes,
      ownerDecisionProvider: (request) => this.#requestOwnerDecision(request),
      checkpointObserver: (checkpoint) => this.#observeCheckpoint(checkpoint),
    });
    this.#runPromise = run
      .then((result) => {
        this.#result = result;
        this.#status = "verified";
        this.#pendingApproval = null;
        const completedExecution = this.#readExecution();
        this.#upsertEvidence(
          "receipt",
          "Mutation committed",
          "One fenced mutation and its receipt are durable; independent read-back followed.",
          "approved",
          completedExecution.receiptId,
        );
        this.#upsertEvidence(
          "read-back",
          "Independent factory read-back",
          "The resulting schedule matched the mutation receipt before verification.",
          "verified",
        );
        this.#upsertEvidence(
          "terminal",
          "Terminal verified success",
          "Independent read-back matched the authorized mutation before root completion.",
          "verified",
        );
      })
      .catch((error: unknown) => {
        this.#pendingApproval = null;
        this.#status = this.#closing ? "closed" : "failed";
        this.#errorCode = classifyMissionError(error);
        if (!this.#closing) {
          this.#upsertEvidence(
            "failure",
            "Mission stopped safely",
            "No unverified completion was exposed. See the local server console for diagnostics.",
            "denied",
          );
        }
      })
      .finally(() => {
        this.#runPromise = null;
        this.#bumpRevision();
      });
    this.#bumpRevision();
    return this.state();
  }

  public reset(): M5JudgeState {
    this.#assertOpen();
    if (this.#runPromise !== null || this.#pendingApproval !== null) {
      throw new M5RequestError(
        409,
        "mission_active",
        "The active mission must reach a safe terminal state before reset",
      );
    }
    cleanupOwnedDemoArtifacts(this.#dataRoot, this.#paths);
    this.#decisionHistory.clear();
    this.#observedApprovals.length = 0;
    this.#runtimeEvidence.length = 0;
    this.#result = null;
    this.#status = "idle";
    this.#errorCode = null;
    this.#generation += 1;
    this.#ownerCallsThisProcess = 0;
    this.#replayedTerminal = false;
    this.#bumpRevision();
    return this.state();
  }

  public decide(input: {
    readonly missionId: string;
    readonly actionIdentity: string;
    readonly decision: "allow" | "deny";
    readonly reason: string | null;
  }): { readonly replayed: boolean; readonly state: M5JudgeState } {
    this.#assertOpen();
    const canonicalInput = canonicalSerialize(input);
    const recorded = this.#decisionHistory.get(input.actionIdentity);
    if (recorded !== undefined) {
      if (recorded.canonicalInput !== canonicalInput) {
        throw new M5RequestError(
          409,
          "approval_conflict",
          "The action identity was already used with a different decision",
        );
      }
      return { replayed: true, state: this.state() };
    }
    const pending = this.#pendingApproval;
    if (pending === null) {
      throw new M5RequestError(409, "stale_action", "No matching owner action is pending");
    }
    if (
      input.missionId !== pending.request.missionId ||
      input.actionIdentity !== pending.request.requestDigest
    ) {
      throw new M5RequestError(
        409,
        "stale_action",
        "The submitted action does not match the current durable approval request",
      );
    }
    if (input.decision === "deny" && (input.reason === null || input.reason.trim().length === 0)) {
      throw new M5RequestError(400, "invalid_reason", "A denial requires a reason");
    }
    if (input.decision === "allow" && input.reason !== null) {
      throw new M5RequestError(400, "invalid_reason", "An approval must not include a denial reason");
    }
    const decision: M4OwnerApprovalDecision =
      input.decision === "allow"
        ? { status: "allow" }
        : { status: "deny", reason: input.reason as string };
    const response = m4OwnerDecisionResponse(
      pending.request,
      OWNER_SOURCE_IDENTITY,
      decision,
    );
    this.#decisionHistory.set(input.actionIdentity, { response, canonicalInput });
    this.#pendingApproval = null;
    this.#status = "running";
    this.#upsertEvidence(
      `approval:${pending.request.requestDigest}`,
      input.decision === "allow" ? "Owner approved exact action" : "Owner denied exact action",
      input.decision === "deny"
        ? `${pending.publicState.expectedEffect} · ${input.reason as string}`
        : pending.publicState.expectedEffect,
      input.decision === "allow" ? "approved" : "denied",
      pending.request.requestDigest,
    );
    pending.resolve(response);
    this.#bumpRevision();
    return { replayed: false, state: this.state() };
  }

  public startChallengeLab(): M5JudgeState {
    this.#assertOpen();
    if (this.#challengePromise !== null || this.#challengeStatus !== "idle") {
      return this.state();
    }
    this.#challengeStatus = "running";
    this.#challengeErrorCode = null;
    this.#challengePromise = runAdversarialChallengeLab(this.#dataRoot)
      .then((result) => {
        this.#challengeResult = result;
        this.#challengeStatus = "complete";
      })
      .catch(() => {
        this.#challengeStatus = this.#closing ? "closed" : "failed";
        this.#challengeErrorCode = "challenge_failed_closed";
      })
      .finally(() => {
        this.#challengePromise = null;
        this.#bumpRevision();
      });
    this.#bumpRevision();
    return this.state();
  }

  public state(): M5JudgeState {
    const evaluationInput = createHeroEvaluationInput();
    const direct = evaluateAdmission(evaluationInput);
    if (direct.decision !== "REPLAN" || direct.recommendedCandidate === null) {
      throw new Error("The canonical deterministic hero no longer produces a REPLAN winner");
    }
    const initial = createHeroInitialState();
    const portfolio = this.#readPortfolio() ?? {
      versions: evaluationInput.versions,
      acceptedObligations: initial.acceptedObligations,
      resources: initial.resources,
      activeReservations: [],
    };
    const initialProtected = initial.acceptedObligations.find((item) => item.protected);
    const currentProtected = portfolio.acceptedObligations.find(
      (item) => item.obligationId === initialProtected?.obligationId,
    );
    const missionSnapshot = this.#readMissionSnapshot();
    const approvals = this.#currentApprovals(missionSnapshot);
    const execution = this.#readExecution();
    const result = this.#result;
    const activity = result === null ? emptyActivity() : activityFromResult(result);
    const timeline = this.#timeline(approvals);
    const ownerApprovals = approvals.filter((item) => item.source === "owner");
    const duplicateApprovals = approvals.length - new Set(approvals.map((item) => item.bridgeKey)).size;
    const directCapacity = direct.directPlan.capacityAfter;
    const capacityBefore = new Map(
      direct.directPlan.capacityBefore.map((item) => [item.resourceKey, item.value]),
    );
    const proposed = new Map(
      direct.directPlan.predictedConsumption.map((item) => [item.resourceKey, item.value]),
    );
    const remaining = new Map(directCapacity.map((item) => [item.resourceKey, item.value]));
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      revision: this.#revision,
      run: {
        status: this.#status,
        generation: this.#generation,
        connection:
          this.#status === "idle"
            ? "idle"
            : this.#status === "awaiting_approval"
              ? "awaiting_owner"
              : this.#status === "verified" && this.#replayedTerminal
                  ? "replayed"
                : this.#status === "closed"
                  ? "closed"
                  : "connected",
        canStart: this.#status === "idle" || this.#status === "failed",
        canReset: this.#runPromise === null && this.#status !== "idle" && this.#status !== "closed",
        ownerCallsThisProcess: this.#ownerCallsThisProcess,
        errorCode: this.#errorCode,
      },
      mission: {
        missionId: M4_HERO_MISSION_ID,
        sessionId: missionSnapshot?.mission.trueforgeSessionId ?? result?.mission.trueforgeSessionId ?? null,
        currentTurnId: missionSnapshot?.mission.currentTurnId ?? result?.mission.finalTurnId ?? null,
        terminalProjectionDigest: result?.mission.projectionDigest ?? null,
        disconnectedAndResumed:
          (result?.mission.disconnectedAndResumed ?? false) || this.#replayedTerminal,
      },
      hero: {
        directDecision: direct.decision,
        portfolioVersion: portfolio.versions.portfolioVersion,
        obligations: portfolio.acceptedObligations.map((item) => ({
          obligationId: item.obligationId,
          objective: item.objective,
          criticality: item.criticality,
          protected: item.protected,
          quantity: numberField(item.serviceLevel["quantity"], "obligation quantity"),
        })),
        proposal: {
          obligationId: direct.promiseBasis.proposal.obligationId,
          objective: direct.promiseBasis.proposal.objective,
          quantity: numberField(
            direct.promiseBasis.proposal.serviceLevel["quantity"],
            "proposal quantity",
          ),
        },
        capacity: portfolio.resources.map((resource) => {
          const before = capacityBefore.get(resource.resourceKey) ?? 0;
          const remainingValue = remaining.get(resource.resourceKey) ?? 0;
          return {
            resourceKey: resource.resourceKey,
            label: resourceLabel(resource.resourceKey),
            unit: resource.unit,
            declaredCapacity: resource.capacity,
            existingUse: resource.capacity - before,
            proposedConsumption: proposed.get(resource.resourceKey) ?? 0,
            remainingCapacity: remainingValue,
            status: remainingValue < 0 ? "over-capacity" : "available",
          };
        }),
        violations: direct.directPlan.violations.map((item) =>
          "resourceKey" in item ? item.resourceKey : `${item.kind}:${item.obligationId}`,
        ),
        candidates: direct.candidates.map((candidate) => ({
          candidatePlanId: candidate.candidatePlanId,
          strategy: candidate.strategy,
          changedObligations: candidate.affectedObligations.map((item) => item.obligationId),
          remainingCapacity: candidate.capacity.capacityAfter,
          recommended: candidate.candidatePlanId === direct.recommendedCandidate?.candidatePlanId,
        })),
        winningModification: winningModification(direct.recommendedCandidate),
        protectedWorkUnchanged:
          canonicalSerialize(initialProtected) === canonicalSerialize(currentProtected),
      },
      pendingApproval: this.#pendingApproval?.publicState ?? null,
      approvals: approvals.map((approval) => ({
        toolName: approval.toolName,
        decision: approval.decision,
        source: approval.source,
        ownerSourceIdentity: approval.ownerSourceIdentity,
        actionIdentity: approval.bridgeKey,
        effect: approvalEffect(approval, missionSnapshot),
        reason: approval.reason,
        denialId: approval.denialId,
      })),
      activity,
      evidenceTimeline: timeline,
      execution,
      safety: {
        ownerCallCount: ownerApprovals.length,
        mechanicalDenialCount: approvals.filter(
          (item) => item.source === "active_m2_denial" && item.decision === "deny",
        ).length,
        duplicateApprovalCount: duplicateApprovals,
        duplicateEffectCount: Math.max(0, execution.mutationCount - 1),
        unauthorizedMutationCount:
          execution.mutationCount > 0 &&
          approvals.filter(
            (item) =>
              item.source === "owner" &&
              item.decision === "allow" &&
              isConsequentialTool(item.toolName),
          ).length !== 1
            ? execution.mutationCount
            : 0,
      },
      challengeLab: {
        status: this.#challengeStatus,
        canRun: this.#challengeStatus === "idle",
        label: "Deterministic assurance demonstration",
        allPassed: this.#challengeResult?.allPassed ?? null,
        omitted: this.#challengeResult?.omitted ?? [],
        challenges: this.#challengeResult?.challenges ?? [],
        errorCode: this.#challengeErrorCode,
      },
    };
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const pending = this.#pendingApproval;
    if (pending !== null) {
      this.#pendingApproval = null;
      pending.resolve(
        m4OwnerDecisionResponse(pending.request, OWNER_SOURCE_IDENTITY, {
          status: "deny",
          reason: "The judge UI is shutting down before authorization",
        }),
      );
    }
    await Promise.all([this.#runPromise, this.#challengePromise]);
    this.#status = "closed";
    this.#challengeStatus = "closed";
    this.#closed = true;
    if (this.#cleanupDataOnClose) {
      cleanupAdversarialChallengeLab(this.#dataRoot);
      cleanupOwnedDemoArtifacts(this.#dataRoot, this.#paths);
    }
    this.#bumpRevision();
  }

  async #requestOwnerDecision(
    request: M4OwnerApprovalRequest,
  ): Promise<M4OwnerDecisionResponse> {
    if (this.#closing) {
      return m4OwnerDecisionResponse(request, OWNER_SOURCE_IDENTITY, {
        status: "deny",
        reason: "The judge UI is shutting down before authorization",
      });
    }
    if (this.#pendingApproval !== null) {
      throw new Error("M5 received overlapping owner approval requests");
    }
    const recorded = this.#decisionHistory.get(request.requestDigest);
    if (recorded !== undefined) return recorded.response;
    this.#ownerCallsThisProcess += 1;
    this.#status = "awaiting_approval";
    const publicState = pendingApprovalState(request);
    this.#upsertEvidence(
      `approval:${request.requestDigest}`,
      `Owner decision required: ${humanToolName(request.toolName)}`,
      publicState.expectedEffect,
      "pending",
      request.requestDigest,
    );
    this.#bumpRevision();
    return new Promise<M4OwnerDecisionResponse>((resolveDecision) => {
      this.#pendingApproval = {
        request,
        publicState,
        resolve: resolveDecision,
      };
    });
  }

  #observeCheckpoint(checkpoint: M4MissionCheckpoint): void {
    if (checkpoint.phase === "running_turn") {
      this.#upsertEvidence(
        "sandbox",
        "Assurance sandbox created",
        "TrueForge Code Mode opened an isolated deterministic assurance run.",
        "informational",
      );
    } else if (checkpoint.phase === "approval_bridge_bound") {
      if (!this.#observedApprovals.some((item) => item.bridgeKey === checkpoint.approval.bridgeKey)) {
        this.#observedApprovals.push(checkpoint.approval);
      }
      this.#upsertEvidence(
        `approval:${checkpoint.approval.bridgeKey}`,
        checkpoint.approval.source === "active_m2_denial"
          ? "Auto-blocked · active policy"
          : checkpoint.approval.decision === "allow"
            ? "Owner approved the bound action"
            : "Owner denied the bound action",
        checkpoint.approval.source === "active_m2_denial"
          ? "The active M2 denial blocked the alternate adapter without another owner call."
          : `${humanToolName(checkpoint.approval.toolName)} · exact action digest and owner source bound durably.`,
        checkpoint.approval.decision === "allow" ? "approved" : "denied",
        checkpoint.approval.bridgeKey,
      );
    } else {
      this.#status = "verifying";
      this.#upsertEvidence(
        "receipt",
        "Mutation receipt committed",
        "One fenced mutation is durable; independent read-back must still verify it.",
        "pending",
      );
    }
    this.#bumpRevision();
  }

  #readMissionSnapshot(): M4MissionSnapshot | null {
    if (!existsSync(this.#paths.mission)) return null;
    try {
      const store = new M4MissionStore({ path: this.#paths.mission });
      try {
        return store.getSnapshotOrNull(M4_HERO_MISSION_ID);
      } finally {
        store.close();
      }
    } catch {
      return null;
    }
  }

  #readPortfolio(): ReturnType<ReturnType<typeof createStore>["getPortfolio"]> | null {
    if (!existsSync(this.#paths.m2)) return null;
    try {
      const store = createStore({
        path: this.#paths.m2,
        authoritativeFactoryDatabasePath: this.#paths.factory,
        now: () => HERO_HORIZON_END,
      });
      try {
        return store.getPortfolio();
      } finally {
        store.close();
      }
    } catch {
      return null;
    }
  }

  #readExecution(): M5JudgeState["execution"] {
    const empty: M5JudgeState["execution"] = {
      acceptanceCount: 0,
      attemptCount: 0,
      mutationCount: 0,
      receiptCount: 0,
      actualFactCount: 0,
      actualFacts: [],
      attemptId: null,
      receiptId: null,
      approvedInterval: null,
      mutationStatus: null,
      independentReadBackObserved: false,
      terminalStatus: null,
    };
    if (!existsSync(this.#paths.m2) || !existsSync(this.#paths.factory)) return empty;
    try {
      const store = createStore({
        path: this.#paths.m2,
        authoritativeFactoryDatabasePath: this.#paths.factory,
        now: () => HERO_HORIZON_END,
      });
      const factory = new SyntheticFactoryEnvironment({
        path: this.#paths.factory,
        now: () => HERO_HORIZON_END,
      });
      try {
        const addenda = store.getAdmissionHistory().flatMap((item) => item.addenda);
        const actualFacts = addenda
          .filter((item) => item.kind === "actual_consumption")
          .map((item) => actualFact(item.body))
          .filter((item): item is NonNullable<typeof item> => item !== null);
        let attempt: ReturnType<typeof store.getExecutionAttempt> | null = null;
        try {
          attempt = store.getExecutionAttempt(HERO_ATTEMPT_ID);
        } catch {
          attempt = null;
        }
        const factoryEvidence =
          attempt === null
            ? null
            : readAuthoritativeFactoryExecution(this.#paths.factory, attempt.executionAttemptId);
        const readBackObserved = this.#result === null ? false : readBackBeforeVerification(this.#result);
        const attemptIds = new Set(
          addenda
            .filter((item) => item.kind === "execution_attempt")
            .map((item) => stringValue(objectValue(item.body)?.["executionAttemptId"]))
            .filter((item): item is string => item !== null),
        );
        const reservation =
          attempt === null
            ? null
            : store
                .getReservations()
                .find(
                  (item) => item.executionAttemptId === attempt.executionAttemptId,
                ) ?? null;
        return {
          acceptanceCount: addenda.filter((item) => item.kind === "acceptance_commit").length,
          attemptCount: attemptIds.size,
          mutationCount: factory.getMutationCount(),
          receiptCount: addenda.filter((item) => item.kind === "receipt_reference").length,
          actualFactCount: actualFacts.length,
          actualFacts,
          attemptId: attempt?.executionAttemptId ?? null,
          receiptId: factoryEvidence?.result.receipt.receiptId ?? null,
          approvedInterval:
            factoryEvidence === null
              ? null
              : `${factoryEvidence.result.canonicalCommand.start} — ${factoryEvidence.result.canonicalCommand.end}`,
          mutationStatus: factoryEvidence?.result.status ?? null,
          independentReadBackObserved: readBackObserved,
          terminalStatus: reservation?.claimState ?? null,
        };
      } finally {
        factory.close();
        store.close();
      }
    } catch {
      return empty;
    }
  }

  #currentApprovals(snapshot: M4MissionSnapshot | null): readonly M4ApprovalRecord[] {
    if (this.#result !== null) return this.#result.mission.approvals;
    const fromSnapshot = snapshot?.bridgeOutcomes
      .filter((item) => item.status === "approval_bound")
      .map((item) => approvalRecordFromJson(item.result))
      .filter((item): item is M4ApprovalRecord => item !== null) ?? [];
    const combined = [...fromSnapshot, ...this.#observedApprovals];
    return combined.filter(
      (item, index) => combined.findIndex((candidate) => candidate.bridgeKey === item.bridgeKey) === index,
    );
  }

  #timeline(
    approvals: readonly M4ApprovalRecord[],
  ): M5JudgeState["evidenceTimeline"] {
    const postDecisionKinds = new Set([
      "receipt",
      "read-back",
      "terminal",
      ...(this.#status === "failed" ? ["failure"] : []),
    ]);
    const orchestration = this.#runtimeEvidence.filter(
      (item) => !item.kind.startsWith("approval:") && !postDecisionKinds.has(item.kind),
    );
    const pending = this.#runtimeEvidence.filter(
      (item) => item.kind.startsWith("approval:") && item.status === "pending",
    );
    const postDecision = this.#runtimeEvidence
      .filter((item) => postDecisionKinds.has(item.kind))
      .sort(
        (left, right) =>
          ["receipt", "read-back", "terminal", "failure"].indexOf(left.kind) -
          ["receipt", "read-back", "terminal", "failure"].indexOf(right.kind),
      );
    const items = [
      {
        sequence: 1,
        kind: "evaluation",
        title: "Direct rush evaluation: REPLAN",
        detail: "Canonical M1 evaluation found agent and human decision capacity violations.",
        technicalIdentity: null,
        status: "proposed" as const,
      },
      ...orchestration.map((item, index) => ({ ...item, sequence: index + 2 })),
    ];
    for (const approval of approvals) {
      const detail = `${humanToolName(approval.toolName)} · ${approval.source === "owner" ? "external owner" : "active M2 denial"}`;
      if (items.some((item) => item.kind === `approval:${approval.bridgeKey}`)) continue;
      items.push({
        sequence: items.length + 1,
        kind: `approval:${approval.bridgeKey}`,
        title:
          approval.source === "active_m2_denial"
            ? "Auto-blocked · active policy"
            : approval.decision === "allow"
              ? "Action approved"
              : "Action denied",
        detail,
        technicalIdentity: approval.bridgeKey,
        status: approval.decision === "allow" ? "approved" : "denied",
      });
    }
    items.push(...pending, ...postDecision);
    return items.map((item, index) => ({ ...item, sequence: index + 1 }));
  }

  #upsertEvidence(
    kind: string,
    title: string,
    detail: string,
    status: M5JudgeState["evidenceTimeline"][number]["status"],
    technicalIdentity: string | null = null,
  ): void {
    const evidence = {
      sequence: this.#runtimeEvidence.length + 1,
      kind,
      title,
      detail,
      technicalIdentity,
      status,
    };
    const existing = this.#runtimeEvidence.findIndex((item) => item.kind === kind);
    if (existing === -1) this.#runtimeEvidence.push(evidence);
    else this.#runtimeEvidence[existing] = {
      ...evidence,
      sequence: this.#runtimeEvidence[existing]?.sequence ?? evidence.sequence,
    };
    this.#bumpRevision();
  }

  #bumpRevision(): void {
    this.#revision += 1;
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) {
      throw new M5RequestError(409, "server_closing", "The judge UI is closing");
    }
  }
}

export interface StartM5JudgeServerOptions extends M5DemoCoordinatorOptions {
  readonly port?: number;
  readonly assetRoot?: string;
  readonly requestDrainTimeoutMs?: number;
  /** Deterministic lifecycle barrier used to verify bounded shutdown ownership. */
  readonly beforeHandlerSettlement?: (request: {
    readonly method: string;
    readonly pathname: string;
  }) => Promise<void>;
}

export interface RunningM5JudgeServer {
  readonly url: string;
  readonly port: number;
  readonly coordinator: M5DemoCoordinator;
  activeRequestCount(): number;
  close(): Promise<void>;
}

interface ActiveM5RequestLifecycle {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly settled: Promise<void>;
}

export async function startM5JudgeServer(
  options: StartM5JudgeServerOptions,
): Promise<RunningM5JudgeServer> {
  const port = options.port ?? 4173;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("M5 port must be an integer between 0 and 65535");
  }
  const requestDrainTimeoutMs = options.requestDrainTimeoutMs ?? DEFAULT_REQUEST_DRAIN_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestDrainTimeoutMs) || requestDrainTimeoutMs < 1) {
    throw new TypeError("M5 request drain timeout must be a positive integer");
  }
  const coordinator = new M5DemoCoordinator(options);
  const assetRoot =
    options.assetRoot ??
    fileURLToPath(new URL("../ui/m5/", import.meta.url));
  const idempotency = new Map<
    string,
    { readonly requestDigest: string; readonly statusCode: number; readonly body: unknown }
  >();
  let publicOrigin = "";
  let closing: Promise<void> | null = null;
  let closed = false;
  let serverClose: Promise<void> | null = null;
  let acceptingRequests = true;
  const activeRequests = new Map<IncomingMessage, ActiveM5RequestLifecycle>();
  const sockets = new Set<Socket>();
  const drainWaiters = new Set<() => void>();
  const server = createServer((request, response) => {
    let resolveHandlerSettled!: () => void;
    const handlerSettled = new Promise<void>((resolveSettled) => {
      resolveHandlerSettled = resolveSettled;
    });
    activeRequests.set(request, { request, response, settled: handlerSettled });
    let handlerLifecycleSettled = false;
    const settleHandlerLifecycle = (): void => {
      if (handlerLifecycleSettled) return;
      handlerLifecycleSettled = true;
      activeRequests.delete(request);
      resolveHandlerSettled();
      if (activeRequests.size === 0) {
        for (const resolveDrain of drainWaiters) resolveDrain();
        drainWaiters.clear();
      }
    };
    const responseSettled = new Promise<void>((resolveResponse) => {
      let done = false;
      const settleResponse = (): void => {
        if (done) return;
        done = true;
        resolveResponse();
      };
      response.once("finish", settleResponse);
      response.once("close", settleResponse);
    });
    let pathname = "<invalid-request-target>";
    const handlerLifecycle = (async (): Promise<void> => {
      try {
        if (!acceptingRequests) {
          sendJson(response, 503, { error: "server_closing", message: "The judge UI is closing" });
          request.destroy();
        } else {
          assertAcceptingRequests();
          applySecurityHeaders(response);
          validateHostAndOrigin(request, publicOrigin);
          const url = parseOriginFormRequestTarget(request.url, publicOrigin);
          pathname = url.pathname;
          await handleRequest(request, response, url);
        }
      } catch (error: unknown) {
        const requestError =
          error instanceof M5RequestError
            ? error
            : new M5RequestError(500, "internal_error", "The request failed safely");
        if (!response.destroyed && !response.writableEnded) {
          sendJson(response, requestError.statusCode, {
            error: requestError.code,
            message: requestError.message,
          });
        }
      } finally {
        try {
          await options.beforeHandlerSettlement?.({
            method: request.method ?? "UNKNOWN",
            pathname,
          });
        } finally {
          await responseSettled;
        }
      }
    })();
    void handlerLifecycle.then(settleHandlerLifecycle, settleHandlerLifecycle);
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const assertAcceptingRequests = (): void => {
    if (!acceptingRequests) {
      throw new M5RequestError(503, "server_closing", "The judge UI is closing");
    }
  };

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    assertAcceptingRequests();
    if (url.pathname === "/api/state") {
      requireMethod(request, "GET");
      sendJson(response, 200, coordinator.state());
      return;
    }
    if (url.pathname === "/api/mission") {
      requireMethod(request, "POST");
      const body = await readJsonObject(request);
      assertAcceptingRequests();
      validateExactKeys(body, ["operation", "requestId"]);
      const operation = requireEnum(body["operation"], ["start", "reset"], "operation");
      const requestId = requireRequestId(body["requestId"]);
      const result = idempotentMutation(
        idempotency,
        requestId,
        { route: url.pathname, body },
        () => ({
          statusCode: 200,
          body: {
            replayed: false,
            state: operation === "start" ? coordinator.start() : coordinator.reset(),
          },
        }),
      );
      sendJson(response, result.statusCode, result.body);
      return;
    }
    if (url.pathname === "/api/challenge") {
      requireMethod(request, "POST");
      const body = await readJsonObject(request);
      assertAcceptingRequests();
      validateExactKeys(body, ["operation", "requestId"]);
      requireEnum(body["operation"], ["run"], "operation");
      const requestId = requireRequestId(body["requestId"]);
      const result = idempotentMutation(
        idempotency,
        requestId,
        { route: url.pathname, body },
        () => ({
          statusCode: 200,
          body: {
            replayed: false,
            state: coordinator.startChallengeLab(),
          },
        }),
      );
      sendJson(response, result.statusCode, result.body);
      return;
    }
    if (url.pathname === "/api/approval") {
      requireMethod(request, "POST");
      const body = await readJsonObject(request);
      assertAcceptingRequests();
      validateExactKeys(body, [
        "missionId",
        "actionIdentity",
        "decision",
        "reason",
        "requestId",
      ]);
      const requestId = requireRequestId(body["requestId"]);
      const missionId = requireBoundedText(body["missionId"], "missionId", 256);
      const actionIdentity = requireBoundedText(
        body["actionIdentity"],
        "actionIdentity",
        256,
      );
      const decision = requireEnum(body["decision"], ["allow", "deny"], "decision");
      const reason =
        body["reason"] === null
          ? null
          : requireBoundedText(body["reason"], "reason", 300);
      const result = idempotentMutation(
        idempotency,
        requestId,
        { route: url.pathname, body },
        () => {
          const decisionResult = coordinator.decide({
            missionId,
            actionIdentity,
            decision,
            reason,
          });
          return {
            statusCode: 200,
            body: { replayed: decisionResult.replayed, state: decisionResult.state },
          };
        },
      );
      sendJson(response, result.statusCode, result.body);
      return;
    }
    const asset = staticAsset(url.pathname, assetRoot);
    requireMethod(request, "GET");
    if (!existsSync(asset.path) || !statSync(asset.path).isFile()) {
      throw new M5RequestError(404, "not_found", "The requested resource does not exist");
    }
    response.writeHead(200, { "Content-Type": asset.contentType });
    createReadStream(asset.path).pipe(response);
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      server.once("error", onError);
      server.listen(port, LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    try {
      await coordinator.close();
    } catch (cleanupError: unknown) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "M5 startup and cleanup failed", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    const error = new Error("M5 judge server did not expose a TCP address");
    const cleanupErrors: unknown[] = [];
    try {
      await coordinator.close();
    } catch (cleanupError: unknown) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "M5 startup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  publicOrigin = `http://${LOOPBACK_HOST}:${address.port}`;
  const beginServerClose = (): Promise<void> => {
    if (serverClose !== null) return serverClose;
    serverClose = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      });
      server.closeIdleConnections();
    });
    return serverClose;
  };
  return {
    url: publicOrigin,
    port: address.port,
    coordinator,
    activeRequestCount: () => activeRequests.size,
    async close(): Promise<void> {
      if (closed) return;
      if (closing !== null) return closing;
      acceptingRequests = false;
      const closeAttempt = closeServer(
        server,
        beginServerClose(),
        coordinator,
        activeRequests,
        sockets,
        drainWaiters,
        requestDrainTimeoutMs,
      )
        .then(() => {
          closed = true;
        })
        .finally(() => {
          if (!closed) closing = null;
        });
      closing = closeAttempt;
      return closing;
    },
  };
}

async function closeServer(
  server: Server,
  serverClose: Promise<void>,
  coordinator: M5DemoCoordinator,
  activeRequests: ReadonlyMap<IncomingMessage, ActiveM5RequestLifecycle>,
  sockets: ReadonlySet<Socket>,
  drainWaiters: Set<() => void>,
  requestDrainTimeoutMs: number,
): Promise<void> {
  const drained = await waitForRequestDrain(activeRequests, drainWaiters, requestDrainTimeoutMs);
  if (!drained) {
    for (const { request, response } of activeRequests.values()) {
      request.destroy(new Error("M5 request aborted during bounded shutdown"));
      response.destroy(new Error("M5 response aborted during bounded shutdown"));
    }
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
  }
  const handlersSettled =
    drained || await waitForRequestDrain(activeRequests, drainWaiters, requestDrainTimeoutMs);
  if (!handlersSettled) {
    const errors: unknown[] = [
      new Error(`M5 shutdown retained ${String(activeRequests.size)} unsettled handler(s)`),
    ];
    const serverResult = await Promise.allSettled([serverClose]);
    if (serverResult[0]?.status === "rejected") errors.push(serverResult[0].reason as unknown);
    throw new AggregateError(errors, "M5 handler shutdown did not settle safely");
  }
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  const coordinatorClose = coordinator.close();
  const results = await Promise.allSettled([serverClose, coordinatorClose]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length > 0) {
    throw new AggregateError(errors, "M5 judge server cleanup failed");
  }
}

async function waitForRequestDrain(
  activeRequests: ReadonlyMap<IncomingMessage, ActiveM5RequestLifecycle>,
  drainWaiters: Set<() => void>,
  timeoutMs: number,
): Promise<boolean> {
  if (activeRequests.size === 0) return true;
  let timer: NodeJS.Timeout | null = null;
  let resolveDrain!: () => void;
  const drained = new Promise<void>((resolveValue) => { resolveDrain = resolveValue; });
  drainWaiters.add(resolveDrain);
  void Promise.all([...activeRequests.values()].map((handler) => handler.settled)).then(() => {
    if (activeRequests.size === 0) resolveDrain();
  });
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([drained.then(() => "drained" as const), timeout]);
  drainWaiters.delete(resolveDrain);
  if (timer !== null) clearTimeout(timer);
  return result === "drained";
}

function establishOwnedDataRoot(dataRoot: string): void {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const marker = join(dataRoot, OWNERSHIP_MARKER);
  const expected = `${STATE_SCHEMA_VERSION}\n`;
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== expected) {
      throw new Error("M5 data root ownership marker is invalid");
    }
    return;
  }
  const entries = readFileSafeDirectory(dataRoot);
  if (entries.length > 0) {
    throw new Error("M5 data root is not empty and has no ownership marker");
  }
  writeFileSync(marker, expected, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function readFileSafeDirectory(path: string): readonly string[] {
  return existsSync(path) ? readdirSync(path) : [];
}

function cleanupOwnedDemoArtifacts(dataRoot: string, paths: DemoPaths): void {
  const marker = join(dataRoot, OWNERSHIP_MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== `${STATE_SCHEMA_VERSION}\n`) {
    throw new Error("Refusing to clean an unowned M5 data root");
  }
  for (const databasePath of [paths.m2, paths.factory, paths.mission, paths.trueforge]) {
    for (const artifact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
      rmSync(artifact, { force: true });
    }
  }
  rmSync(paths.sandboxes, { recursive: true, force: true });
}

function pendingApprovalState(request: M4OwnerApprovalRequest): M5PendingApproval {
  const expectedEffect = expectedEffectForRequest(request);
  return {
    missionId: request.missionId,
    actionIdentity: request.requestDigest,
    phase: request.phase,
    toolName: request.toolName,
    expectedEffect,
    recommendedDecision:
      request.phase === "consequential_effect" && expectedEffect.includes("09:10")
        ? "deny"
        : "allow",
    ownerSourceIdentity: OWNER_SOURCE_IDENTITY,
    technicalSubject:
      request.toolName === "accept_promise"
        ? stringValue(objectValue(request.arguments)?.["admission_record_id"])
        : null,
  };
}

function expectedEffectForRequest(request: M4OwnerApprovalRequest): string {
  if (request.toolName === "select_portfolio_modification") {
    const direct = evaluateAdmission(createHeroEvaluationInput());
    if (direct.decision !== "REPLAN" || direct.recommendedCandidate === null) {
      return "Select the canonical M1 replan winner";
    }
    const winner = winningModification(direct.recommendedCandidate);
    return `Modify ${winner.obligationId}: quantity ${winner.fromQuantity} → ${winner.toQuantity}`;
  }
  const arguments_ = objectValue(request.arguments);
  if (request.toolName === "accept_promise") {
    return "Accept the fresh capacity-safe promise and issue its exact authorization grant";
  }
  const schedule = objectValue(arguments_?.["schedule_command"]);
  const alternate = objectValue(arguments_?.["schedule_change"]);
  const start = stringValue(schedule?.["start"]) ?? stringValue(alternate?.["starts_at"]);
  const end = stringValue(schedule?.["end"]) ?? stringValue(alternate?.["ends_at"]);
  const order = stringValue(schedule?.["order_id"]) ?? stringValue(alternate?.["order_id"]);
  return `Reserve ${order ?? "the rush order"} on cell-alpha, ${shortTime(start)}–${shortTime(end)}`;
}

function approvalEffect(
  approval: M4ApprovalRecord,
  snapshot: M4MissionSnapshot | null,
): string {
  const action = snapshot?.bridgeActions.find((item) => item.bridgeKey === approval.bridgeKey);
  if (action === undefined) return humanToolName(approval.toolName);
  return expectedEffectForRequest({
    missionId: action.missionId,
    trueforgeSessionId: action.trueforgeSessionId,
    trueforgeTurnId: action.trueforgeTurnId,
    trueforgeThreadId: action.trueforgeThreadId,
    trueforgeToolCallId: action.trueforgeToolCallId,
    toolName: action.toolName,
    arguments: action.arguments,
    m2DatabaseInstanceIdentity: "bound",
    factoryDatabaseInstanceIdentity: "bound",
    phase:
      action.toolName === "select_portfolio_modification"
        ? "portfolio_modification"
        : action.toolName === "accept_promise"
          ? "promise_choice"
          : "consequential_effect",
    requestDigest: action.bridgeKey,
  });
}

function winningModification(candidate: {
  readonly candidatePlanId: string;
  readonly strategy: string;
  readonly affectedObligations: readonly {
    readonly obligationId: string;
    readonly optionId: string;
    readonly previousServiceLevel: readonly { readonly field: string; readonly value: number }[];
    readonly proposedServiceLevel: readonly { readonly field: string; readonly value: number }[];
  }[];
}): M5JudgeState["hero"]["winningModification"] {
  const change = candidate.affectedObligations[0];
  if (candidate.strategy !== "modify_existing" || change === undefined) {
    throw new Error("The canonical hero winner no longer modifies an existing obligation");
  }
  const before = change.previousServiceLevel.find((item) => item.field === "quantity");
  const after = change.proposedServiceLevel.find((item) => item.field === "quantity");
  if (before === undefined || after === undefined) {
    throw new Error("The canonical hero winner has no quantity change");
  }
  return {
    candidatePlanId: candidate.candidatePlanId,
    strategy: "modify_existing",
    obligationId: change.obligationId,
    optionId: change.optionId,
    fromQuantity: before.value,
    toQuantity: after.value,
  };
}

function activityFromResult(result: DeterministicM4MissionResult): M5JudgeState["activity"] {
  const servers = new Set<string>();
  const tools = new Set<string>();
  for (const item of result.mission.trueforgeEvents) {
    const event = item.event as unknown as Record<string, unknown>;
    if (event["type"] === "mcp.initialize") {
      for (const server of Array.isArray(event["mcpServers"]) ? event["mcpServers"] : []) {
        const name = stringValue(objectValue(server)?.["name"]);
        if (name !== null) servers.add(name);
      }
    }
    const name = stringValue(event["name"]);
    if (name !== null && String(event["type"]).startsWith("tool.")) tools.add(name);
  }
  return {
    rootAgent: { id: result.rootAgentId, name: result.rootAgentName },
    subagents: result.subagentThreads.map((item) => ({ ...item, status: "done" })),
    sandboxExecutions: result.sandboxIds.length,
    mcpServers: [...servers].sort(),
    toolCalls: [...tools].sort(),
    modelRequests: result.trueforgeModelRequests,
  };
}

function emptyActivity(): M5JudgeState["activity"] {
  return {
    rootAgent: null,
    subagents: [],
    sandboxExecutions: 0,
    mcpServers: [],
    toolCalls: [],
    modelRequests: 0,
  };
}

function readBackBeforeVerification(result: DeterministicM4MissionResult): boolean {
  const events = result.mission.trueforgeEvents.map((item) => item.event as unknown as Record<string, unknown>);
  const readBack = events.findIndex(
    (event) => event["type"] === "tool.response" && event["toolCallId"] === "read-after-write",
  );
  const verified = events.findIndex(
    (event) =>
      event["type"] === "tool.response" && event["toolCallId"] === "verify-authoritatively",
  );
  return readBack >= 0 && verified > readBack;
}

function approvalRecordFromJson(value: JsonValue): M4ApprovalRecord | null {
  const record = objectValue(value);
  if (record === null) return null;
  const decision = record["decision"];
  const source = record["source"];
  if ((decision !== "allow" && decision !== "deny") || (source !== "owner" && source !== "active_m2_denial")) {
    return null;
  }
  const required = ["toolName", "toolCallId", "turnId", "threadId", "reason", "bridgeKey"] as const;
  if (required.some((key) => typeof record[key] !== "string")) return null;
  return record as unknown as M4ApprovalRecord;
}

function actualFact(
  value: JsonValue,
): M5JudgeState["execution"]["actualFacts"][number] | null {
  const record = objectValue(value);
  const resourceKey = stringValue(record?.["resourceKey"]);
  const workClassKey = stringValue(record?.["workClassKey"]);
  const amount = record?.["actualConsumption"];
  return resourceKey !== null && workClassKey !== null && typeof amount === "number"
    ? { resourceKey, workClassKey, value: amount }
    : null;
}

function validateHostAndOrigin(request: IncomingMessage, publicOrigin: string): void {
  if (publicOrigin.length === 0) throw new M5RequestError(503, "starting", "Server is starting");
  const expectedHost = new URL(publicOrigin).host;
  if (request.headers.host !== expectedHost) {
    throw new M5RequestError(400, "invalid_host", "Host header is not the bound loopback origin");
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== publicOrigin) {
    throw new M5RequestError(403, "invalid_origin", "Origin is not authorized");
  }
  if (request.method === "POST" && origin !== publicOrigin) {
    throw new M5RequestError(403, "origin_required", "Mutating requests require the exact UI origin");
  }
}

function parseOriginFormRequestTarget(target: string | undefined, publicOrigin: string): URL {
  if (
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    target.includes("#") ||
    /[\u0000-\u0020\u007f]/u.test(target) ||
    /%(?![0-9A-Fa-f]{2})/u.test(target)
  ) {
    throw new M5RequestError(
      400,
      "invalid_request_target",
      "Request target must be a valid HTTP origin-form path",
    );
  }
  try {
    const url = new URL(target, publicOrigin);
    if (url.origin !== publicOrigin || url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("request target escaped the bound origin");
    }
    return url;
  } catch {
    throw new M5RequestError(
      400,
      "invalid_request_target",
      "Request target must be a valid HTTP origin-form path",
    );
  }
}

function requireMethod(request: IncomingMessage, expected: "GET" | "POST"): void {
  if (request.method !== expected) {
    throw new M5RequestError(405, "method_not_allowed", `Only ${expected} is allowed`);
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new M5RequestError(415, "content_type_required", "Content-Type must be application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    request.destroy();
    throw new M5RequestError(413, "body_too_large", "JSON request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BODY_BYTES) {
      request.destroy();
      throw new M5RequestError(413, "body_too_large", "JSON request body is too large");
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new M5RequestError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new M5RequestError(400, "invalid_json_shape", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function validateExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalSerialize(actual) !== canonicalSerialize(required)) {
    throw new M5RequestError(400, "invalid_json_shape", "Request fields do not match the endpoint schema");
  }
}

function idempotentMutation(
  records: Map<string, { readonly requestDigest: string; readonly statusCode: number; readonly body: unknown }>,
  requestId: string,
  input: unknown,
  operation: () => { readonly statusCode: number; readonly body: unknown },
): { readonly statusCode: number; readonly body: unknown } {
  const requestDigest = sha256(canonicalSerialize(input));
  const existing = records.get(requestId);
  if (existing !== undefined) {
    if (existing.requestDigest !== requestDigest) {
      throw new M5RequestError(409, "idempotency_conflict", "Request ID was reused with different input");
    }
    const body = objectValue(existing.body);
    return {
      statusCode: existing.statusCode,
      body: body === null ? existing.body : { ...body, replayed: true },
    };
  }
  const result = operation();
  records.set(requestId, { requestDigest, ...result });
  if (records.size > MAX_IDEMPOTENCY_RECORDS) {
    const oldest = records.keys().next().value as string | undefined;
    if (oldest !== undefined) records.delete(oldest);
  }
  return result;
}

function requireRequestId(value: unknown): string {
  const requestId = requireBoundedText(value, "requestId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u.test(requestId)) {
    throw new M5RequestError(400, "invalid_request_id", "Request ID format is invalid");
  }
  return requestId;
}

function requireBoundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new M5RequestError(400, "invalid_field", `${name} must be non-empty bounded text`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new M5RequestError(400, "invalid_field", `${name} is invalid`);
  }
  return value as T;
}

function staticAsset(pathname: string, root: string): { readonly path: string; readonly contentType: string } {
  const table: Readonly<Record<string, readonly [string, string]>> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  };
  const asset = table[pathname];
  if (asset === undefined) throw new M5RequestError(404, "not_found", "The requested resource does not exist");
  return { path: join(root, asset[0]), contentType: asset[1] };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent) return;
  const body = canonicalSerialize(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function resourceLabel(key: string): string {
  return key === HERO_RESOURCE_KEYS.agent
    ? "Agent work"
    : key === HERO_RESOURCE_KEYS.human
      ? "Owner decisions"
      : key === HERO_RESOURCE_KEYS.production
        ? "Production cell"
        : key;
}

function humanToolName(toolName: string): string {
  return toolName.replaceAll("_", " ");
}

function isConsequentialTool(toolName: string): boolean {
  return toolName === "create_schedule_reservation" || toolName === "submit_schedule_change";
}

function shortTime(value: string | null): string {
  if (value === null) return "unknown time";
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf())
    ? parsed.toISOString().slice(11, 16)
    : value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function classifyMissionError(error: unknown): string {
  if (error instanceof Error && /approval|authorization|denial/iu.test(error.message)) {
    return "authorization_failed_closed";
  }
  return "mission_failed_closed";
}
