import { createHash } from "node:crypto";

import {
  TrueForge,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";

import { canonicalSerialize } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import {
  claimInputFromM4MutationArguments,
  deniedScopeForM4Effect,
  effectFromM4MutationArguments,
} from "./m4-deterministic-model.js";
import {
  M4MissionStore,
  type M4BridgeAction,
  type M4BridgeActionKind,
  type M4BridgeOutcome,
  type M4MissionSnapshot,
} from "./m4-mission-store.js";
import { readAuthoritativeFactoryExecution } from "./factory-environment.js";
import { HERO_HORIZON_END, HERO_OWNER_ID, createHeroProposal } from "./hero-fixture.js";
import { stableTupleId } from "./identity.js";
import { createStore } from "./store.js";
import type { FlakeBrakeStore } from "./store.js";

export type M4OwnerApprovalDecision =
  | { readonly status: "allow" }
  | { readonly status: "deny"; readonly reason: string };

export interface M4OwnerApprovalRequest {
  readonly missionId: string;
  readonly trueforgeSessionId: string;
  readonly trueforgeTurnId: string;
  readonly trueforgeThreadId: string;
  readonly trueforgeToolCallId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly phase:
    | "portfolio_modification"
    | "promise_choice"
    | "consequential_effect";
}

export type M4OwnerDecisionProvider = (
  request: M4OwnerApprovalRequest,
) => Promise<M4OwnerApprovalDecision> | M4OwnerApprovalDecision;

export interface M4MissionControllerOptions {
  readonly missionId: string;
  readonly environmentId: string;
  readonly trueforgeAgentId: string;
  readonly trueforgeSessionId: string;
  readonly trueforgeClient: TrueForge;
  readonly missionStore: M4MissionStore;
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly ownerDecisionProvider: M4OwnerDecisionProvider;
  readonly disconnectInitialStreamAfterEvents?: number;
  readonly checkpointObserver?: (
    checkpoint: M4MissionCheckpoint,
  ) => Promise<void> | void;
}

export type M4MissionCheckpoint =
  | {
      readonly phase: "running_turn";
      readonly turnId: string;
      readonly eventType: "sandbox.created";
    }
  | {
      readonly phase: "approval_bridge_bound";
      readonly approval: M4ApprovalRecord;
    }
  | {
      readonly phase: "factory_committed_before_verification";
      readonly turnId: string;
      readonly executionAttemptId: string;
      readonly receiptId: string;
    };

export interface M4ApprovalRecord {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly source: "owner" | "active_m2_denial";
  readonly bridgeKey: string;
  readonly denialId: string | null;
  readonly executionAttemptId: string | null;
}

export interface M4MissionRunResult {
  readonly status: "VERIFIED_COMPLETE";
  readonly missionId: string;
  readonly trueforgeSessionId: string;
  readonly finalTurnId: string;
  readonly approvals: readonly M4ApprovalRecord[];
  readonly disconnectedAndResumed: boolean;
  readonly missionSnapshot: M4MissionSnapshot;
  readonly trueforgeEvents: readonly TrueForgeApi.SessionEventItem[];
  readonly projectionDigest: string;
}

interface TurnResult {
  readonly turnId: string;
  readonly events: readonly TrueForgeApi.SessionEvent[];
  readonly done: TrueForgeApi.TurnDoneEvent;
  readonly disconnectedAndResumed: boolean;
}

interface ResolvedToolCall {
  readonly toolCallId: string;
  readonly sourceEventId: string;
  readonly threadId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Headless coordinator for native TrueForge pauses. It never executes an agent
 * loop or tool itself. Its only cross-system responsibility is to bind the
 * persisted native approval decision to the existing M2 denial/claim APIs
 * before TrueForge receives the resume input.
 */
export class M4MissionController {
  readonly #options: M4MissionControllerOptions;
  readonly #approvals: M4ApprovalRecord[] = [];
  #disconnectPending: number | null;
  #sawSandboxCreated = false;

  public constructor(options: M4MissionControllerOptions) {
    this.#options = options;
    this.#disconnectPending =
      options.disconnectInitialStreamAfterEvents ?? null;
  }

  public async runToCompletion(): Promise<M4MissionRunResult> {
    this.#options.missionStore.bindMission({
      missionId: this.#options.missionId,
      environmentId: this.#options.environmentId,
      trueforgeAgentId: this.#options.trueforgeAgentId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      m2EnvironmentIdentity: databaseIdentity(this.#options.m2DatabasePath),
      factoryEnvironmentIdentity: databaseIdentity(
        this.#options.factoryDatabasePath,
      ),
    });
    this.#hydrateApprovals();

    let turn = await this.#initialOrCurrentTurn();
    let disconnectedAndResumed = turn.disconnectedAndResumed;
    let recoveredFailedTurns = 0;
    while (true) {
      if (turn.done.state.status !== "done") {
        recoveredFailedTurns += 1;
        if (recoveredFailedTurns > 3) {
          throw new Error("TrueForge mission exceeded failed-turn recovery limit");
        }
        turn = await this.#createAndConsumeTurn(turn.turnId, [
          {
            type: "user.message",
            content:
              "Resume the persisted FlakeBrake mission from retained evidence and durable state. Do not repeat completed investigation or effects.",
          },
        ]);
        disconnectedAndResumed = true;
        continue;
      }
      await this.#recordCompletedToolResponses(turn.events);
      const required = requiredApprovals(turn.done);
      if (required.length === 0) {
        const store = this.#store();
        let attempt: ReturnType<FlakeBrakeStore["getExecutionAttempt"]>;
        try {
          attempt = store.getExecutionAttempt(
            "attempt/m4-approved-alternative",
          );
          const reservation = store
            .getReservations(true)
            .find(
              (candidate) =>
                candidate.executionAttemptId === attempt.executionAttemptId,
            );
          if (reservation?.claimState !== "terminal_verified") {
            const factory = readAuthoritativeFactoryExecution(
              this.#options.factoryDatabasePath,
              attempt.executionAttemptId,
            );
            if (factory === null) {
              throw new Error(
                "TrueForge turn completed before a durable factory result",
              );
            }
            await this.#checkpoint({
              phase: "factory_committed_before_verification",
              turnId: turn.turnId,
              executionAttemptId: attempt.executionAttemptId,
              receiptId: factory.result.receipt.receiptId,
            });
            turn = await this.#createAndConsumeTurn(turn.turnId, [
              {
                type: "user.message",
                content:
                  "Continue with independent authoritative read-back and verification of the already committed factory result. Do not repeat the write.",
              },
            ]);
            disconnectedAndResumed ||= turn.disconnectedAndResumed;
            continue;
          }
        } finally {
          store.close();
        }
        const persistedEvents = await this.#listSessionEvents(turn.turnId);
        // TrueForge's persisted session API is the authoritative reconstruction
        // surface. Streaming deltas are deliberately not projected as extra
        // history items after a disconnect/resume.
        const allEvents = persistedEvents;
        const missionSnapshot = this.#options.missionStore.getSnapshot(
          this.#options.missionId,
        );
        const approvals = this.#orderedApprovals();
        const projection = {
          missionSnapshot,
          approvals,
          trueforgeEvents: allEvents,
          finalAttempt: attempt,
        };
        return {
          status: "VERIFIED_COMPLETE",
          missionId: this.#options.missionId,
          trueforgeSessionId: this.#options.trueforgeSessionId,
          finalTurnId: turn.turnId,
          approvals,
          disconnectedAndResumed,
          missionSnapshot,
          trueforgeEvents: allEvents,
          projectionDigest: digest(projection),
        };
      }
      const approvals = await Promise.all(
        required.map((requiredAction) =>
          this.#prepareApproval(turn.turnId, turn.events, requiredAction),
        ),
      );
      turn = await this.#createAndConsumeTurn(
        turn.turnId,
        approvals.map((approval) => approval.input),
      );
      disconnectedAndResumed ||= turn.disconnectedAndResumed;
      for (const approval of approvals) {
        this.#options.missionStore.recordBridgeOutcome(
          approval.bridgeKey,
          "trueforge_resumed",
          { nextTurnId: turn.turnId, decision: approval.input.approval.status },
        );
      }
    }
  }

  async #initialOrCurrentTurn(): Promise<TurnResult> {
    const snapshot = this.#options.missionStore.getSnapshot(
      this.#options.missionId,
    );
    const currentTurnId = snapshot.mission.currentTurnId;
    if (currentTurnId === null) {
      return this.#createAndConsumeTurn("none", [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: "Run the complete deterministic FlakeBrake microfactory mission. Use the mandated three subagents, native approvals, denial demonstration, different alternative, read-back, and authoritative verification.",
            },
            {
              type: "file",
              name: "flakebrake-m4-mission.json",
              data: `data:application/json;base64,${Buffer.from(
                canonicalSerialize({
                  missionId: this.#options.missionId,
                  environmentId: this.#options.environmentId,
                }),
                "utf8",
              ).toString("base64")}`,
            },
          ],
        },
      ]);
    }
    const response = await this.#options.trueforgeClient.sessions.getTurn(
      this.#options.trueforgeSessionId,
      currentTurnId,
    );
    if (response.data.state.status === "running") {
      return this.#subscribeAndConsume(
        currentTurnId,
        snapshot.mission.lastEventSequence,
      );
    }
    const events = await this.#listTurnEvents(currentTurnId);
    const done = [...events]
      .reverse()
      .find(
        (event): event is TrueForgeApi.TurnDoneEvent =>
          event.type === "turn.done",
      );
    if (done === undefined) {
      throw new Error(`Persisted turn ${currentTurnId} has no terminal event`);
    }
    return {
      turnId: currentTurnId,
      events,
      done,
      disconnectedAndResumed: false,
    };
  }

  async #createAndConsumeTurn(
    previousTurnId: TrueForgeApi.PreviousTurnIdInput,
    input: TrueForgeApi.TurnInputItem[],
  ): Promise<TurnResult> {
    const stream = await this.#options.trueforgeClient.sessions.createTurnStream(
      this.#options.trueforgeSessionId,
      { previousTurnId, input },
      { timeoutInSeconds: 120 },
    );
    return this.#consumeStream(stream, null, 0);
  }

  async #subscribeAndConsume(
    turnId: string,
    afterSequenceNumber: number,
  ): Promise<TurnResult> {
    const stream = await this.#options.trueforgeClient.sessions.subscribeToTurn(
      this.#options.trueforgeSessionId,
      turnId,
      { afterSequenceNumber },
      { timeoutInSeconds: 120 },
    );
    return this.#consumeStream(stream, turnId, afterSequenceNumber);
  }

  async #consumeStream(
    stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
    knownTurnId: string | null,
    initialSequence: number,
  ): Promise<TurnResult> {
    const events: TrueForgeApi.SessionEvent[] = [];
    let turnId = knownTurnId;
    let sequence = initialSequence;
    let deliberatelyDisconnected = false;
    for await (const event of stream) {
      sequence += 1;
      events.push(event as TrueForgeApi.SessionEvent);
      if (event.type === "turn.created") turnId = event.turnId;
      if (turnId !== null) {
        if (event.type === "sandbox.created") this.#sawSandboxCreated = true;
        this.#options.missionStore.advanceCursor(
          this.#options.missionId,
          turnId,
          sequence,
        );
        if (event.type === "sandbox.created") {
          await this.#checkpoint({
            phase: "running_turn",
            turnId,
            eventType: "sandbox.created",
          });
        }
      }
      if (
        turnId !== null &&
        this.#disconnectPending !== null &&
        sequence >= this.#disconnectPending &&
        this.#sawSandboxCreated &&
        event.type !== "turn.done"
      ) {
        this.#disconnectPending = null;
        deliberatelyDisconnected = true;
        break;
      }
      if (event.type === "turn.done") {
        if (turnId === null) throw new Error("turn.done arrived before turn.created");
        return {
          turnId,
          events,
          done: event,
          disconnectedAndResumed: deliberatelyDisconnected,
        };
      }
    }
    if (turnId === null) throw new Error("TrueForge stream ended before turn.created");
    const resumed = await this.#subscribeAndConsume(turnId, sequence);
    return {
      ...resumed,
      events: [...events, ...resumed.events],
      disconnectedAndResumed: deliberatelyDisconnected || resumed.disconnectedAndResumed,
    };
  }

  async #prepareApproval(
    turnId: string,
    events: readonly TrueForgeApi.SessionEvent[],
    required: TrueForgeApi.ToolApprovalRequiredEvent,
  ): Promise<{
    readonly bridgeKey: string;
    readonly input: TrueForgeApi.UserToolApprovalEvent;
  }> {
    if (required.toolCalls.length !== 1) {
      throw new Error("M4 requires one approval-gated tool per pause");
    }
    const reference = required.toolCalls[0];
    if (reference === undefined) throw new Error("Approval reference is missing");
    let resolved: ResolvedToolCall;
    try {
      resolved = resolveToolCall(events, required, reference);
    } catch {
      // A resumed SSE cursor may intentionally omit earlier source messages.
      // Resolve the approval against TrueForge's persisted turn history.
      resolved = resolveToolCall(
        await this.#listTurnEvents(turnId),
        required,
        reference,
      );
    }
    const actionKind = actionKindFor(resolved.name);
    const action = this.#options.missionStore.recordBridgeAction({
      missionId: this.#options.missionId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      trueforgeTurnId: turnId,
      trueforgeThreadId: resolved.threadId,
      trueforgeToolCallId: resolved.toolCallId,
      actionKind,
      toolName: resolved.name,
      arguments: asJson(resolved.arguments),
    });

    const alreadyBound = bridgeOutcome(
      this.#options.missionStore.getSnapshot(this.#options.missionId),
      action.bridgeKey,
      "approval_bound",
    );
    if (alreadyBound !== null) {
      const record = approvalRecord(alreadyBound.result);
      this.#rememberApproval(record);
      await this.#checkpoint({
        phase: "approval_bridge_bound",
        approval: record,
      });
      return {
        bridgeKey: action.bridgeKey,
        input: approvalInput(resolved, record),
      };
    }

    const prepared = await this.#bindM2Decision(action, resolved);
    const record: M4ApprovalRecord = {
      toolName: resolved.name,
      toolCallId: resolved.toolCallId,
      turnId,
      threadId: resolved.threadId,
      decision: prepared.decision,
      reason: prepared.reason,
      source: prepared.source,
      bridgeKey: action.bridgeKey,
      denialId: prepared.denialId,
      executionAttemptId: prepared.executionAttemptId,
    };
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "approval_bound",
      asJson(record),
    );
    this.#rememberApproval(record);
    await this.#checkpoint({
      phase: "approval_bridge_bound",
      approval: record,
    });
    return {
      bridgeKey: action.bridgeKey,
      input: approvalInput(resolved, record),
    };
  }

  async #bindM2Decision(
    action: M4BridgeAction,
    tool: ResolvedToolCall,
  ): Promise<{
    readonly decision: "allow" | "deny";
    readonly reason: string;
    readonly source: "owner" | "active_m2_denial";
    readonly denialId: string | null;
    readonly executionAttemptId: string | null;
  }> {
    if (
      tool.name === "select_portfolio_modification" ||
      tool.name === "accept_promise"
    ) {
      const owner = await this.#durableOwnerDecision(action, {
        tool,
        phase:
          tool.name === "select_portfolio_modification"
            ? "portfolio_modification"
            : "promise_choice",
      });
      return {
        decision: owner.status,
        reason: owner.status === "deny" ? owner.reason : "owner approved",
        source: "owner",
        denialId: null,
        executionAttemptId: null,
      };
    }

    const store = this.#store();
    try {
      const claim = claimInputFromM4MutationArguments(tool.arguments);
      const effect = effectFromM4MutationArguments(tool.arguments);
      const recordedOwner = this.#recordedOwnerDecision(action.bridgeKey);
      if (recordedOwner?.status === "deny") {
        return this.#recordOwnerDenial(store, action, tool, claim, effect, recordedOwner);
      }
      if (recordedOwner?.status === "allow") {
        return this.#recordOwnerAllowance(store, action, claim);
      }
      const authorization = store.evaluateAuthorization({
        effect,
        objectiveId: createHeroProposal().objective,
        promiseBasisId: claim.promiseBasisId,
        resourceClaims: claim.resourceCapacityClaims,
        attemptedAt: HERO_HORIZON_END,
        grantId: claim.grantId,
      });
      if (authorization.decision === "DENY") {
        this.#options.missionStore.recordBridgeOutcome(
          action.bridgeKey,
          "m2_applied",
          asJson(authorization),
        );
        return {
          decision: "deny",
          reason: authorization.explanation,
          source: "active_m2_denial",
          denialId:
            authorization.denialId === undefined
              ? null
              : authorization.denialId,
          executionAttemptId: null,
        };
      }
      const owner = await this.#durableOwnerDecision(action, {
        tool,
        phase: "consequential_effect",
      });
      if (owner.status === "deny") {
        return this.#recordOwnerDenial(store, action, tool, claim, effect, owner);
      }
      return this.#recordOwnerAllowance(store, action, claim);
    } finally {
      store.close();
    }
  }

  async #durableOwnerDecision(
    action: M4BridgeAction,
    input: {
      readonly tool: ResolvedToolCall;
      readonly phase: M4OwnerApprovalRequest["phase"];
    },
  ): Promise<M4OwnerApprovalDecision> {
    const recorded = this.#recordedOwnerDecision(action.bridgeKey);
    if (recorded !== null) return recorded;
    const owner = await this.#options.ownerDecisionProvider({
      missionId: this.#options.missionId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      trueforgeTurnId: action.trueforgeTurnId,
      trueforgeThreadId: action.trueforgeThreadId,
      trueforgeToolCallId: action.trueforgeToolCallId,
      toolName: input.tool.name,
      arguments: asJson(input.tool.arguments),
      phase: input.phase,
    });
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "owner_decision_received",
      asJson(owner),
    );
    return owner;
  }

  #recordedOwnerDecision(bridgeKey: string): M4OwnerApprovalDecision | null {
    const outcome = bridgeOutcome(
      this.#options.missionStore.getSnapshot(this.#options.missionId),
      bridgeKey,
      "owner_decision_received",
    );
    return outcome === null ? null : ownerDecision(outcome.result);
  }

  #recordOwnerDenial(
    store: FlakeBrakeStore,
    action: M4BridgeAction,
    tool: ResolvedToolCall,
    claim: ReturnType<typeof claimInputFromM4MutationArguments>,
    effect: ReturnType<typeof effectFromM4MutationArguments>,
    owner: Extract<M4OwnerApprovalDecision, { readonly status: "deny" }>,
  ): {
    readonly decision: "deny";
    readonly reason: string;
    readonly source: "owner";
    readonly denialId: string;
    readonly executionAttemptId: null;
  } {
    const denialId = stableTupleId("m4-denial", [
      this.#options.missionId,
      action.trueforgeSessionId,
      action.trueforgeTurnId,
      action.trueforgeThreadId,
      action.trueforgeToolCallId,
    ]);
    const denial = store.createDenial({
      denialId,
      deniedEffectFingerprint: effect,
      deniedScope: deniedScopeForM4Effect(claim.promiseBasisId, effect),
      objectiveId: createHeroProposal().objective,
      approverId: HERO_OWNER_ID,
      evidencePacketId: tool.sourceEventId,
      missionId: this.#options.missionId,
      reason: owner.reason,
    });
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "m2_applied",
      asJson(denial),
    );
    return {
      decision: "deny",
      reason: owner.reason,
      source: "owner",
      denialId,
      executionAttemptId: null,
    };
  }

  #recordOwnerAllowance(
    store: FlakeBrakeStore,
    action: M4BridgeAction,
    claim: ReturnType<typeof claimInputFromM4MutationArguments>,
  ): {
    readonly decision: "allow";
    readonly reason: string;
    readonly source: "owner";
    readonly denialId: null;
    readonly executionAttemptId: string;
  } {
    const claimed = store.claimExecution(claim);
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "m2_applied",
      asJson(claimed),
    );
    return {
      decision: "allow",
      reason: "owner approved and exact M2 claim is durable",
      source: "owner",
      denialId: null,
      executionAttemptId: claimed.executionAttemptId,
    };
  }

  async #recordCompletedToolResponses(
    events: readonly TrueForgeApi.SessionEvent[],
  ): Promise<void> {
    const snapshot = this.#options.missionStore.getSnapshot(
      this.#options.missionId,
    );
    for (const event of events) {
      if (event.type !== "tool.response") continue;
      const action = snapshot.bridgeActions.find(
        (candidate) =>
          candidate.trueforgeToolCallId === event.toolCallId &&
          candidate.trueforgeThreadId === event.threadId,
      );
      if (action === undefined) continue;
      if (action.actionKind === "owner_decision") {
        this.#options.missionStore.recordBridgeOutcome(
          action.bridgeKey,
          "m2_applied",
          { trueforgeToolResponse: event.content },
        );
      }
      this.#options.missionStore.recordBridgeOutcome(
        action.bridgeKey,
        "tool_completed",
        { trueforgeToolResponse: event.content },
      );
    }
  }

  async #listTurnEvents(
    turnId: string,
  ): Promise<readonly TrueForgeApi.SessionEvent[]> {
    const page = await this.#options.trueforgeClient.sessions.listTurnEvents(
      this.#options.trueforgeSessionId,
      turnId,
      { limit: 100, order: "asc" },
    );
    const events: TrueForgeApi.SessionEvent[] = [];
    for await (const event of page) events.push(event);
    return events;
  }

  async #listSessionEvents(
    lastTurnId: string,
  ): Promise<readonly TrueForgeApi.SessionEventItem[]> {
    const page = await this.#options.trueforgeClient.sessions.listEvents(
      this.#options.trueforgeSessionId,
      { lastTurnId, limit: 100 },
    );
    const events: TrueForgeApi.SessionEventItem[] = [];
    for await (const event of page) events.push(event);
    return events.reverse();
  }

  #store(): FlakeBrakeStore {
    return createStore({
      path: this.#options.m2DatabasePath,
      authoritativeFactoryDatabasePath: this.#options.factoryDatabasePath,
      now: () => HERO_HORIZON_END,
    });
  }

  #hydrateApprovals(): void {
    const snapshot = this.#options.missionStore.getSnapshot(
      this.#options.missionId,
    );
    for (const outcome of snapshot.bridgeOutcomes) {
      if (outcome.status === "approval_bound") {
        this.#rememberApproval(approvalRecord(outcome.result));
      }
    }
  }

  #rememberApproval(record: M4ApprovalRecord): void {
    if (this.#approvals.some((candidate) => candidate.bridgeKey === record.bridgeKey)) {
      return;
    }
    this.#approvals.push(record);
  }

  #orderedApprovals(): readonly M4ApprovalRecord[] {
    return [...this.#approvals].sort((left, right) =>
      left.turnId.localeCompare(right.turnId),
    );
  }

  async #checkpoint(checkpoint: M4MissionCheckpoint): Promise<void> {
    await this.#options.checkpointObserver?.(checkpoint);
  }
}

export function deterministicM4OwnerDecisions(): M4OwnerDecisionProvider {
  return (request) => {
    if (
      request.phase === "portfolio_modification" ||
      request.phase === "promise_choice"
    ) {
      return { status: "allow" };
    }
    const arguments_ = request.arguments as Record<string, JsonValue>;
    const claim = arguments_["claim"] as Record<string, JsonValue>;
    const effect = claim["effect"] as Record<string, JsonValue>;
    const material = effect["materialParameters"] as Record<string, JsonValue>;
    return material["start"] === "2026-08-26T09:10:00.000Z"
      ? {
          status: "deny",
          reason: "Owner denied the primary 09:10 schedule scope",
        }
      : { status: "allow" };
  };
}

function requiredApprovals(
  done: TrueForgeApi.TurnDoneEvent,
): readonly TrueForgeApi.ToolApprovalRequiredEvent[] {
  if (done.state.status !== "done") {
    throw new Error(`TrueForge turn ended ${done.state.status}`);
  }
  const unsupported = done.state.requiredActions.filter(
    (action) => action.type !== "tool.approval_required",
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported TrueForge required action ${unsupported[0]?.type ?? "unknown"}`,
    );
  }
  return done.state.requiredActions as TrueForgeApi.ToolApprovalRequiredEvent[];
}

function resolveToolCall(
  events: readonly TrueForgeApi.SessionEvent[],
  required: TrueForgeApi.ToolApprovalRequiredEvent,
  reference: TrueForgeApi.ToolCallRef,
): ResolvedToolCall {
  const source = events.find(
    (event): event is TrueForgeApi.ModelMessageEvent =>
      event.type === "model.message" && event.id === reference.sourceEventId,
  );
  const tool = source?.toolCalls?.find(
    (candidate) => candidate.id === reference.id,
  );
  if (source === undefined || tool === undefined) {
    throw new Error(`TrueForge approval tool call ${reference.id} not found`);
  }
  const parsed = JSON.parse(tool.function.arguments) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`TrueForge tool call ${reference.id} arguments are malformed`);
  }
  const parsedObject = parsed as Record<string, unknown>;
  if (tool.function.name === "call_tool") {
    if (parsedObject["mcp_server"] !== "factory-change-control") {
      throw new Error(
        "Approval-gated generic call_tool must target factory-change-control",
      );
    }
    const nestedName = parsedObject["tool_name"];
    const nestedArguments = parsedObject["input"];
    if (
      typeof nestedName !== "string" ||
      nestedArguments === null ||
      typeof nestedArguments !== "object" ||
      Array.isArray(nestedArguments)
    ) {
      throw new Error("Approval-gated generic call_tool input is malformed");
    }
    return {
      toolCallId: reference.id,
      sourceEventId: reference.sourceEventId,
      threadId: required.threadId,
      name: nestedName,
      arguments: nestedArguments as Record<string, unknown>,
    };
  }
  return {
    toolCallId: reference.id,
    sourceEventId: reference.sourceEventId,
    threadId: required.threadId,
    name: tool.function.name,
    arguments: parsedObject,
  };
}

function actionKindFor(toolName: string): M4BridgeActionKind {
  if (
    toolName === "select_portfolio_modification" ||
    toolName === "accept_promise"
  ) {
    return "owner_decision";
  }
  if (
    toolName === "create_schedule_reservation" ||
    toolName === "submit_schedule_change"
  ) {
    return "consequential_effect";
  }
  throw new Error(`Tool ${toolName} is not an M4 approval bridge operation`);
}

function bridgeOutcome(
  snapshot: M4MissionSnapshot,
  bridgeKey: string,
  status: M4BridgeOutcome["status"],
): M4BridgeOutcome | null {
  return (
    snapshot.bridgeOutcomes.find(
      (outcome) => outcome.bridgeKey === bridgeKey && outcome.status === status,
    ) ?? null
  );
}

function approvalInput(
  tool: ResolvedToolCall,
  record: M4ApprovalRecord,
): TrueForgeApi.UserToolApprovalEvent {
  return {
    type: "user.tool_approval",
    threadId: tool.threadId,
    toolCallId: tool.toolCallId,
    approval:
      record.decision === "allow"
        ? { status: "allow" }
        : { status: "deny", reason: record.reason },
  };
}

function approvalRecord(value: JsonValue): M4ApprovalRecord {
  const record = jsonObject(value, "approval_bound");
  const decision = jsonString(record["decision"], "decision");
  const source = jsonString(record["source"], "source");
  if (decision !== "allow" && decision !== "deny") {
    throw new TypeError("approval_bound decision is invalid");
  }
  if (source !== "owner" && source !== "active_m2_denial") {
    throw new TypeError("approval_bound source is invalid");
  }
  return {
    toolName: jsonString(record["toolName"], "toolName"),
    toolCallId: jsonString(record["toolCallId"], "toolCallId"),
    turnId: jsonString(record["turnId"], "turnId"),
    threadId: jsonString(record["threadId"], "threadId"),
    decision,
    reason: jsonString(record["reason"], "reason"),
    source,
    bridgeKey: jsonString(record["bridgeKey"], "bridgeKey"),
    denialId: jsonNullableString(record["denialId"], "denialId"),
    executionAttemptId: jsonNullableString(
      record["executionAttemptId"],
      "executionAttemptId",
    ),
  };
}

function ownerDecision(value: JsonValue): M4OwnerApprovalDecision {
  const record = jsonObject(value, "owner_decision_received");
  const status = jsonString(record["status"], "status");
  if (status === "allow") return { status };
  if (status === "deny") {
    return { status, reason: jsonString(record["reason"], "reason") };
  }
  throw new TypeError("Owner decision status is invalid");
}

function jsonObject(
  value: JsonValue,
  field: string,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function jsonString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function jsonNullableString(
  value: JsonValue | undefined,
  field: string,
): string | null {
  if (value === null) return null;
  return jsonString(value, field);
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalSerialize(value)) as JsonValue;
}

function databaseIdentity(path: string): string {
  return `sha256:${createHash("sha256").update(path).digest("hex")}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex")}`;
}
