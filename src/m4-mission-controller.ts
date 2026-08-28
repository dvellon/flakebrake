import { createHash, randomUUID } from "node:crypto";

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
import { readDatabaseInstanceIdentity } from "./sqlite.js";
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
  readonly m2DatabaseInstanceIdentity: string;
  readonly factoryDatabaseInstanceIdentity: string;
  readonly phase:
    | "portfolio_modification"
    | "promise_choice"
    | "consequential_effect";
  readonly requestDigest: string;
}

export interface M4OwnerDecisionResponse {
  readonly requestDigest: string;
  readonly ownerSourceIdentity: string;
  readonly decision: M4OwnerApprovalDecision;
}

export type M4OwnerDecisionProvider = (
  request: M4OwnerApprovalRequest,
) => Promise<M4OwnerDecisionResponse> | M4OwnerDecisionResponse;

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
  readonly ownerSourceIdentity: string | null;
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

interface PreparedApproval {
  readonly bridgeKey: string | null;
  readonly input: TrueForgeApi.UserToolApprovalEvent;
}

class InvalidM4ApprovalInputError extends Error {
  public readonly tool: ResolvedToolCall;

  public constructor(tool: ResolvedToolCall, cause: unknown) {
    super(
      `FlakeBrake rejected malformed ${tool.name} arguments: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "InvalidM4ApprovalInputError";
    this.tool = tool;
  }
}

type DurableMissionPhase =
  | {
      readonly complete: true;
      readonly attempt: ReturnType<FlakeBrakeStore["getExecutionAttempt"]>;
    }
  | {
      readonly complete: false;
      readonly continuation: string;
      readonly executionAttemptId: string | null;
      readonly factoryReceiptId: string | null;
    };

const ACTIVE_SUCCESSOR_OWNERS = new Set<string>();
const MAX_BOUNDED_CONTINUATIONS = 12;

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
    const identities = this.#databaseIdentities();
    this.#options.missionStore.bindMission({
      missionId: this.#options.missionId,
      environmentId: this.#options.environmentId,
      trueforgeAgentId: this.#options.trueforgeAgentId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      m2EnvironmentIdentity: identities.m2,
      factoryEnvironmentIdentity: identities.factory,
    });
    this.#assertDatabaseBinding();
    this.#hydrateApprovals();

    let turn = await this.#initialOrCurrentTurn();
    let disconnectedAndResumed = turn.disconnectedAndResumed;
    let recoveredFailedTurns = 0;
    let boundedContinuations = 0;
    let invalidApprovalRecoveries = 0;
    while (true) {
      this.#assertDatabaseBinding();
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
        const resolvedSuccessor = await this.#resolvedSuccessor(turn.turnId);
        if (resolvedSuccessor !== null) {
          turn = await this.#consumePersistedTurn(resolvedSuccessor);
          disconnectedAndResumed = true;
          continue;
        }
        const phase = this.#durableMissionPhase();
        if (!phase.complete) {
          boundedContinuations += 1;
          if (boundedContinuations > MAX_BOUNDED_CONTINUATIONS) {
            throw new Error(
              "TrueForge mission exceeded bounded durable-phase continuation limit",
            );
          }
          if (phase.factoryReceiptId !== null && phase.executionAttemptId !== null) {
            await this.#checkpoint({
              phase: "factory_committed_before_verification",
              turnId: turn.turnId,
              executionAttemptId: phase.executionAttemptId,
              receiptId: phase.factoryReceiptId,
            });
          }
          turn = await this.#createAndConsumeTurn(turn.turnId, [
            { type: "user.message", content: phase.continuation },
          ]);
          disconnectedAndResumed ||= turn.disconnectedAndResumed;
          continue;
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
          finalAttempt: phase.attempt,
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
      const approvals: PreparedApproval[] = [];
      for (const requiredAction of required) {
        if (requiredAction.toolCalls.length === 0) {
          throw new Error("TrueForge approval pause has no tool call");
        }
        if (requiredAction.toolCalls.length > 1) {
          invalidApprovalRecoveries += 1;
          if (invalidApprovalRecoveries > 3) {
            throw new Error(
              "TrueForge mission exceeded malformed approval recovery limit",
            );
          }
          for (const reference of requiredAction.toolCalls) {
            approvals.push({
              bridgeKey: null,
              input: {
                type: "user.tool_approval",
                threadId: requiredAction.threadId,
                toolCallId: reference.id,
                approval: {
                  status: "deny",
                  reason:
                    "FlakeBrake requires approval-gated mission operations to be retried sequentially, one per pause",
                },
              },
            });
          }
          continue;
        }
        try {
          approvals.push(
            await this.#prepareApproval(
              turn.turnId,
              turn.events,
              requiredAction,
            ),
          );
        } catch (error: unknown) {
          if (!(error instanceof InvalidM4ApprovalInputError)) throw error;
          invalidApprovalRecoveries += 1;
          if (invalidApprovalRecoveries > 3) {
            throw new Error(
              "TrueForge mission exceeded malformed approval recovery limit",
              { cause: error },
            );
          }
          approvals.push({
            bridgeKey: null,
            input: {
              type: "user.tool_approval",
              threadId: error.tool.threadId,
              toolCallId: error.tool.toolCallId,
              approval: { status: "deny", reason: error.message },
            },
          });
        }
      }
      turn = await this.#createAndConsumeTurn(
        turn.turnId,
        approvals.map((approval) => approval.input),
      );
      disconnectedAndResumed ||= turn.disconnectedAndResumed;
      for (const approval of approvals) {
        if (approval.bridgeKey === null) continue;
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
    this.#assertDatabaseBinding();
    const persisted = await this.#findExactSuccessor(previousTurnId, input);
    const ownerToken = `successor-owner/${String(process.pid)}/${randomUUID()}`;
    const claimed = this.#options.missionStore.claimSuccessorIntent({
      missionId: this.#options.missionId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      previousTurnId,
      input: asJson(input),
      ownerToken,
    });
    if (persisted !== null) {
      this.#options.missionStore.resolveSuccessorIntent(
        claimed.intent.intentKey,
        persisted.id,
      );
      return this.#consumePersistedTurn(persisted);
    }
    if (claimed.intent.successorTurnId !== null) {
      const successor = await this.#options.trueforgeClient.sessions.getTurn(
        this.#options.trueforgeSessionId,
        claimed.intent.successorTurnId,
      );
      return this.#consumePersistedTurn(successor.data);
    }

    let intent = claimed.intent;
    if (!claimed.claimed) {
      const recovered = await this.#waitForExactSuccessor(previousTurnId, input);
      if (recovered !== null) {
        this.#options.missionStore.resolveSuccessorIntent(
          intent.intentKey,
          recovered.id,
        );
        return this.#consumePersistedTurn(recovered);
      }
      if (successorOwnerIsActive(intent.ownerToken)) {
        throw new Error(
          `Exact TrueForge successor for ${previousTurnId} is still being created`,
        );
      }
      intent = this.#options.missionStore.reassignSuccessorIntent(
        intent.intentKey,
        intent.ownerToken,
        ownerToken,
      );
      if (intent.ownerToken !== ownerToken) {
        throw new Error(
          `Exact TrueForge successor for ${previousTurnId} has another durable owner`,
        );
      }
    }

    ACTIVE_SUCCESSOR_OWNERS.add(ownerToken);
    try {
      const recovered = await this.#findExactSuccessor(previousTurnId, input);
      if (recovered !== null) {
        this.#options.missionStore.resolveSuccessorIntent(
          intent.intentKey,
          recovered.id,
        );
        return this.#consumePersistedTurn(recovered);
      }
      this.#assertDatabaseBinding();
      const stream = await this.#options.trueforgeClient.sessions.createTurnStream(
        this.#options.trueforgeSessionId,
        { previousTurnId, input },
        { timeoutInSeconds: 120 },
      );
      const result = await this.#consumeStream(stream, null, 0);
      this.#options.missionStore.resolveSuccessorIntent(
        intent.intentKey,
        result.turnId,
      );
      return result;
    } catch (error: unknown) {
      const cursor = this.#options.missionStore.getSnapshot(
        this.#options.missionId,
      ).mission.currentTurnId;
      const expectedCursor = previousTurnId === "none" ? null : previousTurnId;
      if (cursor !== expectedCursor) throw error;
      const recovered = await this.#findExactSuccessor(previousTurnId, input);
      if (recovered !== null) {
        this.#options.missionStore.resolveSuccessorIntent(
          intent.intentKey,
          recovered.id,
        );
        return this.#consumePersistedTurn(recovered);
      }
      throw error;
    } finally {
      ACTIVE_SUCCESSOR_OWNERS.delete(ownerToken);
    }
  }

  async #findExactSuccessor(
    previousTurnId: TrueForgeApi.PreviousTurnIdInput,
    input: TrueForgeApi.TurnInputItem[],
  ): Promise<TrueForgeApi.Turn | null> {
    const expectedPrevious =
      previousTurnId === "none" ? null : previousTurnId;
    if (expectedPrevious === "auto") {
      throw new Error("M4 successor reconciliation forbids auto previousTurnId");
    }
    const page = await this.#options.trueforgeClient.sessions.listTurns(
      this.#options.trueforgeSessionId,
      { limit: 25 },
    );
    const siblings: TrueForgeApi.Turn[] = [];
    for await (const candidate of page) {
      if (candidate.previousTurnId === expectedPrevious) siblings.push(candidate);
    }
    const expectedInput = canonicalSerialize(input);
    const exact = siblings.filter(
      (candidate) => canonicalSerialize(candidate.input ?? []) === expectedInput,
    );
    if (exact.length > 1 || (exact.length === 1 && siblings.length > 1)) {
      throw new Error(
        `TrueForge predecessor ${previousTurnId} already has sibling successors`,
      );
    }
    if (exact.length === 0 && siblings.length > 0) {
      throw new Error(
        `TrueForge predecessor ${previousTurnId} has a conflicting successor input`,
      );
    }
    return exact[0] ?? null;
  }

  async #waitForExactSuccessor(
    previousTurnId: TrueForgeApi.PreviousTurnIdInput,
    input: TrueForgeApi.TurnInputItem[],
  ): Promise<TrueForgeApi.Turn | null> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const recovered = await this.#findExactSuccessor(previousTurnId, input);
      if (recovered !== null) return recovered;
      await delay(25);
    }
    return null;
  }

  async #consumePersistedTurn(turn: TrueForgeApi.Turn): Promise<TurnResult> {
    if (turn.state.status === "running") {
      const snapshot = this.#options.missionStore.getSnapshot(
        this.#options.missionId,
      );
      const afterSequenceNumber =
        snapshot.mission.currentTurnId === turn.id
          ? snapshot.mission.lastEventSequence
          : 0;
      return this.#subscribeAndConsume(turn.id, afterSequenceNumber);
    }
    const events = await this.#listTurnEvents(turn.id);
    const done = [...events]
      .reverse()
      .find(
        (event): event is TrueForgeApi.TurnDoneEvent =>
          event.type === "turn.done",
      );
    if (done === undefined) {
      throw new Error(`Persisted successor ${turn.id} has no terminal event`);
    }
    this.#options.missionStore.advanceCursor(
      this.#options.missionId,
      turn.id,
      events.length,
    );
    return {
      turnId: turn.id,
      events,
      done,
      disconnectedAndResumed: true,
    };
  }

  async #resolvedSuccessor(previousTurnId: string): Promise<TrueForgeApi.Turn | null> {
    const matching = this.#options.missionStore
      .getSnapshot(this.#options.missionId)
      .successorIntents.filter(
        (intent) =>
          intent.previousTurnId === previousTurnId &&
          intent.successorTurnId !== null,
      );
    if (matching.length > 1) {
      throw new Error(
        `TrueForge predecessor ${previousTurnId} has multiple durable successors`,
      );
    }
    const intent = matching[0];
    if (intent?.successorTurnId === null || intent === undefined) return null;
    const response = await this.#options.trueforgeClient.sessions.getTurn(
      this.#options.trueforgeSessionId,
      intent.successorTurnId,
    );
    const successor = response.data;
    if (
      successor.previousTurnId !== previousTurnId ||
      canonicalSerialize(successor.input ?? []) !==
        canonicalSerialize(intent.input)
    ) {
      throw new Error(
        `Durable TrueForge successor ${successor.id} conflicts with its intent`,
      );
    }
    return successor;
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
  ): Promise<PreparedApproval> {
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
    if (
      resolved.name === "create_schedule_reservation" ||
      resolved.name === "submit_schedule_change"
    ) {
      try {
        claimInputFromM4MutationArguments(resolved.arguments);
        effectFromM4MutationArguments(resolved.arguments);
      } catch (error: unknown) {
        throw new InvalidM4ApprovalInputError(resolved, error);
      }
    }
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
      ownerSourceIdentity: prepared.ownerSourceIdentity,
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
    readonly ownerSourceIdentity: string | null;
    readonly denialId: string | null;
    readonly executionAttemptId: string | null;
  }> {
    this.#assertDatabaseBinding();
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
        decision: owner.decision.status,
        reason:
          owner.decision.status === "deny"
            ? owner.decision.reason
            : "owner approved",
        source: "owner",
        ownerSourceIdentity: owner.ownerSourceIdentity,
        denialId: null,
        executionAttemptId: null,
      };
    }

    const store = this.#store();
    try {
      const claim = claimInputFromM4MutationArguments(tool.arguments);
      const effect = effectFromM4MutationArguments(tool.arguments);
      const recordedOwner = this.#recordedOwnerDecision(action.bridgeKey);
      if (recordedOwner?.decision.status === "deny") {
        return this.#recordOwnerDenial(store, action, tool, claim, effect, {
          ...recordedOwner,
          decision: recordedOwner.decision,
        });
      }
      if (recordedOwner?.decision.status === "allow") {
        return this.#recordOwnerAllowance(store, action, claim, recordedOwner);
      }
      let priorAttemptExists = false;
      try {
        store.getExecutionAttempt(claim.executionAttemptId);
        priorAttemptExists = true;
      } catch {
        // A missing attempt follows the normal authorization path below.
      }
      if (priorAttemptExists) {
        const owner = await this.#durableOwnerDecision(action, {
          tool,
          phase: "consequential_effect",
        });
        if (owner.decision.status === "deny") {
          return this.#recordOwnerDenial(store, action, tool, claim, effect, {
            ...owner,
            decision: owner.decision,
          });
        }
        return this.#recordOwnerAllowance(store, action, claim, owner);
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
          ownerSourceIdentity: null,
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
      if (owner.decision.status === "deny") {
        return this.#recordOwnerDenial(store, action, tool, claim, effect, {
          ...owner,
          decision: owner.decision,
        });
      }
      return this.#recordOwnerAllowance(store, action, claim, owner);
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
  ): Promise<M4OwnerDecisionResponse> {
    this.#assertDatabaseBinding();
    const recorded = this.#recordedOwnerDecision(action.bridgeKey);
    if (recorded !== null) return recorded;
    const databaseIdentities = this.#boundDatabaseIdentities();
    const requestWithoutDigest = {
      missionId: this.#options.missionId,
      trueforgeSessionId: this.#options.trueforgeSessionId,
      trueforgeTurnId: action.trueforgeTurnId,
      trueforgeThreadId: action.trueforgeThreadId,
      trueforgeToolCallId: action.trueforgeToolCallId,
      toolName: input.tool.name,
      arguments: asJson(input.tool.arguments),
      m2DatabaseInstanceIdentity: databaseIdentities.m2,
      factoryDatabaseInstanceIdentity: databaseIdentities.factory,
      phase: input.phase,
    } as const;
    const request: M4OwnerApprovalRequest = {
      ...requestWithoutDigest,
      requestDigest: digest(requestWithoutDigest),
    };
    const response = await this.#options.ownerDecisionProvider(request);
    this.#assertDatabaseBinding();
    const owner = validateOwnerDecisionResponse(response, request);
    this.#assertDatabaseBinding();
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "owner_decision_received",
      asJson(owner),
    );
    return owner;
  }

  #recordedOwnerDecision(bridgeKey: string): M4OwnerDecisionResponse | null {
    const outcome = bridgeOutcome(
      this.#options.missionStore.getSnapshot(this.#options.missionId),
      bridgeKey,
      "owner_decision_received",
    );
    if (outcome === null) return null;
    const action = this.#options.missionStore
      .getSnapshot(this.#options.missionId)
      .bridgeActions.find((candidate) => candidate.bridgeKey === bridgeKey);
    if (action === undefined) throw new Error(`Owner bridge ${bridgeKey} is missing`);
    const phase = ownerPhase(action.toolName);
    const databaseIdentities = this.#boundDatabaseIdentities();
    const requestWithoutDigest = {
      missionId: action.missionId,
      trueforgeSessionId: action.trueforgeSessionId,
      trueforgeTurnId: action.trueforgeTurnId,
      trueforgeThreadId: action.trueforgeThreadId,
      trueforgeToolCallId: action.trueforgeToolCallId,
      toolName: action.toolName,
      arguments: action.arguments,
      m2DatabaseInstanceIdentity: databaseIdentities.m2,
      factoryDatabaseInstanceIdentity: databaseIdentities.factory,
      phase,
    } as const;
    return validateOwnerDecisionResponse(ownerDecision(outcome.result), {
      ...requestWithoutDigest,
      requestDigest: digest(requestWithoutDigest),
    });
  }

  #recordOwnerDenial(
    store: FlakeBrakeStore,
    action: M4BridgeAction,
    tool: ResolvedToolCall,
    claim: ReturnType<typeof claimInputFromM4MutationArguments>,
    effect: ReturnType<typeof effectFromM4MutationArguments>,
    owner: M4OwnerDecisionResponse & {
      readonly decision: Extract<
        M4OwnerApprovalDecision,
        { readonly status: "deny" }
      >;
    },
  ): {
    readonly decision: "deny";
    readonly reason: string;
    readonly source: "owner";
    readonly ownerSourceIdentity: string;
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
      reason: owner.decision.reason,
    });
    this.#options.missionStore.recordBridgeOutcome(
      action.bridgeKey,
      "m2_applied",
      asJson(denial),
    );
    return {
      decision: "deny",
      reason: owner.decision.reason,
      source: "owner",
      ownerSourceIdentity: owner.ownerSourceIdentity,
      denialId,
      executionAttemptId: null,
    };
  }

  #recordOwnerAllowance(
    store: FlakeBrakeStore,
    action: M4BridgeAction,
    claim: ReturnType<typeof claimInputFromM4MutationArguments>,
    owner: M4OwnerDecisionResponse,
  ): {
    readonly decision: "allow";
    readonly reason: string;
    readonly source: "owner";
    readonly ownerSourceIdentity: string;
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
      ownerSourceIdentity: owner.ownerSourceIdentity,
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

  #durableMissionPhase(): DurableMissionPhase {
    const store = this.#store();
    try {
      const history = store.getAdmissionHistory();
      const initialReplan = history.find(
        (candidate) => candidate.record.decision === "REPLAN",
      );
      if (initialReplan === undefined) {
        return {
          complete: false,
          continuation:
            "Continue the bounded FlakeBrake mission from durable state: obtain and record the authoritative current admission before requesting any owner choice or effect.",
          executionAttemptId: null,
          factoryReceiptId: null,
        };
      }
      const fresh = history.find((candidate) =>
        candidate.addenda.some(
          (addendum) =>
            addendum.kind === "readmission_link" &&
            isM4PostModificationAdmission(addendum.body),
        ),
      );
      if (fresh === undefined) {
        return {
          complete: false,
          continuation:
            "Continue the bounded mission from the durable REPLAN phase. Use the exact prepared owner-approved existing-order modification, durably create portfolio v2, and obtain its fresh authoritative ADMITTABLE readmission before exposing Promise acceptance.",
          executionAttemptId: null,
          factoryReceiptId: null,
        };
      }
      if (fresh.record.decision !== "ADMITTABLE") {
        throw new Error("M4 post-modification admission is not ADMITTABLE");
      }
      const accepted = fresh.addenda.some(
        (addendum) => addendum.kind === "acceptance_commit",
      );
      if (!accepted) {
        return {
          complete: false,
          continuation:
            "Continue the bounded mission from the durable portfolio-v2 ADMITTABLE phase. Prepare and request ACCEPT PROMISE only for that fresh immutable admission basis.",
          executionAttemptId: null,
          factoryReceiptId: null,
        };
      }

      const claimedApprovals = this.#approvals.filter(
        (approval) =>
          approval.decision === "allow" &&
          approval.executionAttemptId !== null,
      );
      const claimedAttemptIds = [
        ...new Set(
          claimedApprovals.map((approval) => approval.executionAttemptId),
        ),
      ];
      if (claimedAttemptIds.length > 1) {
        throw new Error("M4 mission has multiple approved execution attempts");
      }
      const executionAttemptId = claimedAttemptIds[0] ?? null;
      if (executionAttemptId === null) {
        return {
          complete: false,
          continuation:
            "Continue the bounded mission from the durable accepted Promise Basis. Preserve prior denial facts, use only exact prepared schedule arguments, and advance the required denied-primary, equivalent-denial, then distinct-alternative phases without repeating completed work.",
          executionAttemptId: null,
          factoryReceiptId: null,
        };
      }
      const attempt = store.getExecutionAttempt(executionAttemptId);
      const reservation = store
        .getReservations(true)
        .find(
          (candidate) =>
            candidate.executionAttemptId === executionAttemptId,
        );
      if (reservation === undefined) {
        throw new Error(
          `Approved M4 attempt ${executionAttemptId} has no durable reservation`,
        );
      }
      if (reservation.claimState === "terminal_verified") {
        return { complete: true, attempt };
      }
      if (reservation.claimState !== "claimed_nonterminal") {
        throw new Error(
          `Approved M4 attempt ${executionAttemptId} ended ${reservation.claimState}`,
        );
      }
      const factory = readAuthoritativeFactoryExecution(
        this.#options.factoryDatabasePath,
        executionAttemptId,
      );
      if (factory === null) {
        return {
          complete: false,
          continuation:
            `Continue the bounded mission for the already claimed exact attempt ${executionAttemptId}. Resume its existing provider-owned consequential tool call; do not invent another attempt, repeat the claim, or fall back to local execution.`,
          executionAttemptId,
          factoryReceiptId: null,
        };
      }
      return {
        complete: false,
        continuation:
          "Continue with independent authoritative read-back and verification of the already committed factory result. Do not repeat the write.",
        executionAttemptId,
        factoryReceiptId: factory.result.receipt.receiptId,
      };
    } finally {
      store.close();
    }
  }

  #store(): FlakeBrakeStore {
    return createStore({
      path: this.#options.m2DatabasePath,
      authoritativeFactoryDatabasePath: this.#options.factoryDatabasePath,
      now: () => HERO_HORIZON_END,
    });
  }

  #databaseIdentities(): { readonly m2: string; readonly factory: string } {
    return {
      m2: readDatabaseInstanceIdentity(
        this.#options.m2DatabasePath,
        "m2",
        this.#options.environmentId,
      ),
      factory: readDatabaseInstanceIdentity(
        this.#options.factoryDatabasePath,
        "factory",
        this.#options.environmentId,
      ),
    };
  }

  #boundDatabaseIdentities(): {
    readonly m2: string;
    readonly factory: string;
  } {
    const mission = this.#options.missionStore.getSnapshot(
      this.#options.missionId,
    ).mission;
    return {
      m2: mission.m2EnvironmentIdentity,
      factory: mission.factoryEnvironmentIdentity,
    };
  }

  #assertDatabaseBinding(): void {
    const mission = this.#options.missionStore.getSnapshot(
      this.#options.missionId,
    ).mission;
    const current = this.#databaseIdentities();
    if (
      mission.m2EnvironmentIdentity !== current.m2 ||
      mission.factoryEnvironmentIdentity !== current.factory
    ) {
      throw new Error(
        `Mission ${this.#options.missionId} database instance identity conflicts with its durable environment binding`,
      );
    }
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

export function deterministicM4OwnerDecisions(
  ownerSourceIdentity = "test-owner/deterministic-m4-policy",
): M4OwnerDecisionProvider {
  return (request) => {
    if (
      request.phase === "portfolio_modification" ||
      request.phase === "promise_choice"
    ) {
      return m4OwnerDecisionResponse(request, ownerSourceIdentity, {
        status: "allow",
      });
    }
    const arguments_ = request.arguments as Record<string, JsonValue>;
    const claim = arguments_["claim"] as Record<string, JsonValue>;
    const effect = claim["effect"] as Record<string, JsonValue>;
    const material = effect["materialParameters"] as Record<string, JsonValue>;
    const decision = material["start"] === "2026-08-26T09:10:00.000Z"
      ? {
          status: "deny" as const,
          reason: "Owner denied the primary 09:10 schedule scope",
        }
      : { status: "allow" as const };
    return m4OwnerDecisionResponse(request, ownerSourceIdentity, decision);
  };
}

export function m4OwnerDecisionResponse(
  request: M4OwnerApprovalRequest,
  ownerSourceIdentity: string,
  decision: M4OwnerApprovalDecision,
): M4OwnerDecisionResponse {
  if (ownerSourceIdentity.trim().length === 0) {
    throw new TypeError("ownerSourceIdentity must be a non-empty string");
  }
  return {
    requestDigest: request.requestDigest,
    ownerSourceIdentity,
    decision,
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
    ownerSourceIdentity:
      source === "owner"
        ? jsonString(record["ownerSourceIdentity"], "ownerSourceIdentity")
        : null,
    bridgeKey: jsonString(record["bridgeKey"], "bridgeKey"),
    denialId: jsonNullableString(record["denialId"], "denialId"),
    executionAttemptId: jsonNullableString(
      record["executionAttemptId"],
      "executionAttemptId",
    ),
  };
}

function ownerDecision(value: JsonValue): M4OwnerDecisionResponse {
  const record = jsonObject(value, "owner_decision_received");
  const decisionRecord = jsonObject(record["decision"], "decision");
  const status = jsonString(decisionRecord["status"], "status");
  let decision: M4OwnerApprovalDecision;
  if (status === "allow") decision = { status };
  else if (status === "deny") {
    decision = {
      status,
      reason: jsonString(decisionRecord["reason"], "reason"),
    };
  } else {
    throw new TypeError("Owner decision status is invalid");
  }
  return {
    requestDigest: jsonString(record["requestDigest"], "requestDigest"),
    ownerSourceIdentity: jsonString(
      record["ownerSourceIdentity"],
      "ownerSourceIdentity",
    ),
    decision,
  };
}

function validateOwnerDecisionResponse(
  value: M4OwnerDecisionResponse,
  request: M4OwnerApprovalRequest,
): M4OwnerDecisionResponse {
  const parsed = ownerDecision(asJson(value));
  if (parsed.requestDigest !== request.requestDigest) {
    throw new Error(
      "External owner decision does not match the exact mission action and arguments",
    );
  }
  if (parsed.ownerSourceIdentity.trim().length === 0) {
    throw new TypeError("External owner source identity is missing");
  }
  return parsed;
}

function ownerPhase(toolName: string): M4OwnerApprovalRequest["phase"] {
  if (toolName === "select_portfolio_modification") {
    return "portfolio_modification";
  }
  if (toolName === "accept_promise") return "promise_choice";
  return "consequential_effect";
}

function isM4PostModificationAdmission(value: JsonValue): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    (value as Readonly<Record<string, JsonValue>>)["kind"] ===
    "M4_POST_MODIFICATION_ADMISSION"
  );
}

function jsonObject(
  value: JsonValue | undefined,
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

function successorOwnerIsActive(ownerToken: string): boolean {
  if (ACTIVE_SUCCESSOR_OWNERS.has(ownerToken)) return true;
  const match = /^successor-owner\/([1-9][0-9]*)\//u.exec(ownerToken);
  if (match === null) return false;
  const ownerPid = Number(match[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid === process.pid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex")}`;
}
