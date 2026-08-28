import { createServer, type IncomingMessage, type Server } from "node:http";

import { canonicalSerialize } from "./canonical.js";
import type { JsonValue } from "./domain.js";
import { canonicalGrantAllowanceKey } from "./effects.js";
import {
  type CanonicalScheduleCommand,
  claimedExecutionReference,
  factoryStateDigest,
  readAuthoritativeFactoryExecution,
  resultingScheduleState,
  SyntheticFactoryEnvironment,
} from "./factory-environment.js";
import {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  HERO_OWNER_ID,
  HERO_PRODUCTION_CELL_ID,
  HERO_RESOURCE_KEYS,
  createHeroProposal,
} from "./hero-fixture.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { createStore, type FlakeBrakeStore } from "./store.js";
import type {
  AdmissionRecordBody,
  ApprovalScope,
  ClaimExecutionInput,
  EffectFingerprint,
} from "./stateful-domain.js";

const PRIMARY_START = "2026-08-26T09:10:00.000Z";
const PRIMARY_END = "2026-08-26T09:40:00.000Z";
const ALTERNATIVE_START = "2026-08-26T09:40:00.000Z";
const ALTERNATIVE_END = "2026-08-26T10:10:00.000Z";
const GRANT_ID = "grant/m4-hero-schedule/v1";
const GRANT_VERSION = "grant/v1";
const GRANT_DECISION_ID = "owner-decision/m4-execution-scope";
const ACCEPT_DECISION_ID = "owner-decision/m4-accept-promise";
const MODIFY_DECISION_ID = "owner-decision/m4-select-replan";
const BUNDLE_ID = "bundle/m4-hero-schedule";
const APPROVED_ATTEMPT_ID = "attempt/m4-approved-alternative";
const HERO_WINNER_PLAN_ID =
  "replan-plan/sha256:68fe99d3402893002930fa143b1089629e4722215d1624af5924d628430aafe2";

export interface DeterministicM4ModelOptions {
  readonly m2DatabasePath: string;
  readonly factoryDatabasePath: string;
  readonly host?: "127.0.0.1";
  readonly port?: number;
}

export interface RunningDeterministicM4Model {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly baseUrl: string;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}

interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: unknown;
}

interface ChatRequest {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
}

interface DeterministicReply {
  readonly content?: string;
  readonly toolCalls?: readonly DeterministicToolCall[];
}

interface DeterministicToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Credential-free deterministic model endpoint used only by the mechanical M4
 * suite. It emits ordinary OpenAI-compatible chat-completion SSE; the genuine
 * TrueForge server owns all loop execution, subagents, tools, approvals, and
 * persisted events.
 */
export async function startDeterministicM4Model(
  options: DeterministicM4ModelOptions,
): Promise<RunningDeterministicM4Model> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new TypeError("Model must bind to loopback");
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Model port is invalid");
  }
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== "POST" ||
        new URL(request.url ?? "/", `http://${host}`).pathname !==
          "/v1/chat/completions"
      ) {
        response.writeHead(404).end();
        return;
      }
      const parsed = parseJsonRejectingDuplicateKeys(
        await readBody(request),
      ) as ChatRequest;
      const messages = requireMessages(parsed.messages);
      requests += 1;
      const reply = deterministicReply(messages, options);
      writeCompletion(response, requests, reply);
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "deterministic_model_error",
          },
        }),
      );
    });
  });
  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Deterministic model did not bind a TCP address");
  }
  let closed = false;
  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${String(address.port)}/v1`,
    requestCount: () => requests,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

function deterministicReply(
  messages: readonly ChatMessage[],
  options: DeterministicM4ModelOptions,
): DeterministicReply {
  const context = messages.map(messageText).join("\n");
  if (context.includes("operating as a sub-agent")) {
    if (context.includes("Act as the Portfolio and order analyst")) {
      return portfolioAnalystReply(messages);
    }
    if (context.includes("Act as the Capacity and schedule analyst")) {
      return capacityAnalystReply(messages);
    }
    if (context.includes("Act as the Assurance and simulation engineer")) {
      return assuranceEngineerReply(messages);
    }
  }
  return rootReply(messages, options);
}

function portfolioAnalystReply(messages: readonly ChatMessage[]): DeterministicReply {
  const names = toolCallNames(messages);
  if (!names.includes("read_orders")) {
    return {
      toolCalls: [
        call("portfolio-orders", "read_orders", {}),
        call("portfolio-proposals", "read_incoming_proposals", {}),
      ],
    };
  }
  return structuredSubagentResult({
    findings: [
      "Portfolio v1 contains protected, important, and owner-modifiable best-effort accepted work plus the rush proposal.",
      "Protected order terms and schedule commitment are immutable.",
    ],
    evidence_references: [
      "factory-orders/read_orders",
      "factory-orders/read_incoming_proposals",
      "portfolio/v1",
    ],
    proposed_actions: ["Evaluate the two bounded M1 replan families."],
    dependencies: ["Current capacity and authoritative simulation."],
    typed_effects: ["microfactory.schedule_reservation"],
    resource_work_classes: [
      "rush-order/agent-planning",
      "rush-order/owner-review",
      "rush-order/cell-run",
    ],
    alternatives: [
      "Modify the rush proposal quantity.",
      "Modify eligible lower-criticality accepted work.",
    ],
  });
}

function capacityAnalystReply(messages: readonly ChatMessage[]): DeterministicReply {
  const names = toolCallNames(messages);
  if (!names.includes("read_capacity_plan")) {
    return {
      toolCalls: [
        call("capacity-plan", "read_capacity_plan", {}),
        call("capacity-actuals", "read_actual_consumption", {}),
        call("capacity-simulation", "evaluate_hero_fixture", {}),
      ],
    };
  }
  return structuredSubagentResult({
    findings: [
      "Direct demand is agent 14/12, human 5/4, and production 100/110, so M1 returns REPLAN.",
      "Both bounded strategy families are feasible; production binds at 110 in the rush-reduction candidate.",
    ],
    evidence_references: [
      "factory-capacity/read_capacity_plan",
      "factory-capacity/read_actual_consumption",
      "factory-simulator/evaluate_hero_fixture",
    ],
    proposed_actions: ["Use the exact M1 lexicographic winner."],
    dependencies: ["Owner approval for any accepted-obligation modification."],
    typed_effects: ["portfolio.modify", "schedule.reserve"],
    resource_work_classes: [
      "agent_work_units",
      "human_review_decisions",
      "production_cell_minutes",
    ],
    alternatives: ["rush-order/reduce-to-8", "best-effort-order/reduce-to-8"],
  });
}

function assuranceEngineerReply(messages: readonly ChatMessage[]): DeterministicReply {
  const names = toolCallNames(messages);
  if (!names.includes("exec")) {
    return {
      toolCalls: [
        call("assurance-code-mode", "exec", {
          intent:
            "Mechanically join authoritative orders, capacity, and simulation evidence and check protected work.",
          command: assuranceCodeModeCommand(),
        }),
      ],
    };
  }
  const sandboxEvidence = toolResponseText(messages, "assurance-code-mode");
  const normalizedSandboxEvidence = sandboxEvidence.replaceAll('\\"', '"');
  if (
    !normalizedSandboxEvidence.includes('"exitCode":0') ||
    !normalizedSandboxEvidence.includes('"decision":"REPLAN"') ||
    !normalizedSandboxEvidence.includes(
      '"violations":["agent_work_units","human_review_decisions"]',
    ) ||
    !normalizedSandboxEvidence.includes(`"winner":"${HERO_WINNER_PLAN_ID}"`) ||
    !/"protected_sha256":"[0-9a-f]{64}"/.test(normalizedSandboxEvidence)
  ) {
    throw new Error(
      "TrueForge sandbox did not return the required authoritative M4 computation",
    );
  }
  return structuredSubagentResult({
    findings: [
      "Sandbox Code Mode recomputed simultaneous agent and human overload and the protected-order digest.",
      "The M1 winner and candidate set agree with authoritative simulation.",
    ],
    evidence_references: [
      "sandbox/exec/assurance-code-mode",
      "factory-simulator/evaluate_hero_fixture",
    ],
    proposed_actions: ["Preserve the protected digest through write and restart."],
    dependencies: ["M2 canonical denial and execution claim before mutation."],
    typed_effects: ["microfactory.schedule_reservation"],
    resource_work_classes: [
      "agent_work_units",
      "human_review_decisions",
      "production_cell_minutes",
    ],
    alternatives: ["primary slot", "different non-denied slot"],
  });
}

function rootReply(
  messages: readonly ChatMessage[],
  options: DeterministicM4ModelOptions,
): DeterministicReply {
  const names = toolCallNames(messages);
  const context = messages.map(messageText).join("\n");
  if (!names.includes("create_sub_agent")) {
    return {
      toolCalls: [
        call("subagent-portfolio", "create_sub_agent", {
          name: "Portfolio and order analyst",
          input:
            "Act as the Portfolio and order analyst. Read factory orders and proposals, preserve immutable portfolio versions and protected work, and return compact JSON with findings, evidence_references, proposed_actions, dependencies, typed_effects, resource_work_classes, alternatives.",
        }),
        call("subagent-capacity", "create_sub_agent", {
          name: "Capacity and schedule analyst",
          input:
            "Act as the Capacity and schedule analyst. Read capacity and actuals, evaluate the direct and both replan families, and return compact JSON with findings, evidence_references, proposed_actions, dependencies, typed_effects, resource_work_classes, alternatives.",
        }),
        call("subagent-assurance", "create_sub_agent", {
          name: "Assurance and simulation engineer",
          input:
            "Act as the Assurance and simulation engineer. Genuinely use sandbox exec and mcp_client generated code to join orders, capacity, and simulation, mechanically check direct overload, ranking, and protected preservation, then return compact JSON with findings, evidence_references, proposed_actions, dependencies, typed_effects, resource_work_classes, alternatives.",
        }),
      ],
    };
  }
  if (!names.includes("record_current_admission")) {
    return { toolCalls: [call("record-admission", "record_current_admission", {})] };
  }
  if (!names.includes("select_portfolio_modification")) {
    return withAuthoritativeStore(options, (store) => {
      const initial = latestAdmission(store, "REPLAN");
      return {
        toolCalls: [
          call("approve-modification", "select_portfolio_modification", {
            admission_record_id: initial.admissionRecordId,
            selected_plan_id: selectedHeroPlan(initial),
            owner_decision_id: MODIFY_DECISION_ID,
            approver_id: HERO_OWNER_ID,
          }),
        ],
      };
    });
  }
  if (!names.includes("accept_promise")) {
    return {
      toolCalls: [
        call(
          "accept-promise",
          "accept_promise",
          m4AcceptanceArguments(options),
        ),
      ],
    };
  }
  const scheduleReads = names.filter(
    (name) => name === "read_schedule_state",
  ).length;
  if (scheduleReads === 0) {
    return {
      toolCalls: [call("read-before-primary", "read_schedule_state", {})],
    };
  }
  if (!names.includes("create_schedule_reservation")) {
    return {
      toolCalls: [
        primaryMutationCall(
          "deny-primary",
          "create_schedule_reservation",
          "attempt/m4-denied-primary",
          "microfactory-effect/v1",
          PRIMARY_START,
          PRIMARY_END,
          options,
        ),
      ],
    };
  }
  if (!names.includes("submit_schedule_change")) {
    return {
      toolCalls: [
        primaryMutationCall(
          "deny-equivalent-alternate",
          "submit_schedule_change",
          "attempt/m4-denied-alternate",
          "microfactory-effect/v2",
          PRIMARY_START,
          PRIMARY_END,
          options,
        ),
      ],
    };
  }
  const reservationCalls = names.filter(
    (name) => name === "create_schedule_reservation",
  ).length;
  if (reservationCalls === 1) {
    return {
      toolCalls: [
        primaryMutationCall(
          "approve-alternative",
          "create_schedule_reservation",
          APPROVED_ATTEMPT_ID,
          "microfactory-effect/v1",
          ALTERNATIVE_START,
          ALTERNATIVE_END,
          options,
        ),
      ],
    };
  }
  if (
    readAuthoritativeFactoryExecution(
      options.factoryDatabasePath,
      APPROVED_ATTEMPT_ID,
    ) === null &&
    context.includes("already claimed exact attempt")
  ) {
    return {
      toolCalls: [
        primaryMutationCall(
          `approve-alternative-retry-${String(reservationCalls)}`,
          "create_schedule_reservation",
          APPROVED_ATTEMPT_ID,
          "microfactory-effect/v1",
          ALTERNATIVE_START,
          ALTERNATIVE_END,
          options,
        ),
      ],
    };
  }
  if (scheduleReads === 1) {
    return {
      toolCalls: [call("read-after-write", "read_schedule_state", {})],
    };
  }
  if (!names.includes("verify_schedule_execution")) {
    if (!context.includes("Continue with independent authoritative read-back")) {
      return {
        content: canonicalSerialize({
          status: "FACTORY_COMMITTED_PENDING_INDEPENDENT_VERIFICATION",
          approved_alternative_attempt: APPROVED_ATTEMPT_ID,
          investigation_reused: true,
        }),
      };
    }
    return {
      toolCalls: [
        call("verify-authoritatively", "verify_schedule_execution", {
          execution_attempt_id: APPROVED_ATTEMPT_ID,
        }),
      ],
    };
  }
  if (!names.includes("read_execution_status")) {
    return {
      toolCalls: [
        call("read-terminal-status", "read_execution_status", {
          execution_attempt_id: APPROVED_ATTEMPT_ID,
        }),
      ],
    };
  }
  return {
    content: canonicalSerialize({
      status: "COMPLETED_AFTER_AUTHORITATIVE_VERIFICATION",
      protected_order: "unchanged",
      controlled_writes: 1,
      denied_primary_scope: "preserved",
      equivalent_alternate: "blocked",
      approved_alternative_attempt: APPROVED_ATTEMPT_ID,
      investigation_reused: true,
    }),
  };
}

function primaryMutationCall(
  id: string,
  toolName: "create_schedule_reservation" | "submit_schedule_change",
  attemptId: string,
  effectSchemaVersion: EffectFingerprint["effectSchemaVersion"],
  start: string,
  end: string,
  options: DeterministicM4ModelOptions,
): DeterministicToolCall {
  const arguments_ = m4MutationToolArguments(
    toolName,
    options,
    attemptId,
    effectSchemaVersion,
    start,
    end,
  );
  return call(id, toolName, arguments_);
}

export function m4MutationToolArguments(
  toolName: "create_schedule_reservation" | "submit_schedule_change",
  options: Pick<
    DeterministicM4ModelOptions,
    "m2DatabasePath" | "factoryDatabasePath"
  >,
  attemptId: string,
  effectSchemaVersion: EffectFingerprint["effectSchemaVersion"],
  start: string,
  end: string,
): Record<string, unknown> {
  const arguments_ = m4MutationArguments(
    options,
    attemptId,
    effectSchemaVersion,
    start,
    end,
  );
  if (toolName === "create_schedule_reservation") return arguments_;
  const command = arguments_["schedule_command"] as Record<string, unknown>;
  const { schedule_command: _ignored, ...common } = arguments_;
  void _ignored;
  return {
    ...common,
    schedule_change: {
      schema_version: "microfactory-schedule-change/v1",
      operation: "reserve_cell",
      environment_id: command["environment_id"],
      order_id: command["order_id"],
      cell_id: command["production_cell_id"],
      quantity: command["quantity"],
      starts_at: command["start"],
      ends_at: command["end"],
    },
  };
}

export function m4MutationArguments(
  options: DeterministicM4ModelOptions,
  attemptId: string,
  effectSchemaVersion: EffectFingerprint["effectSchemaVersion"],
  start: string,
  end: string,
): Record<string, unknown> {
  return withAuthoritativeStore(options, (store) => {
    const effect = scheduleEffect(effectSchemaVersion, start, end);
    const command = scheduleCommand(start, end);
    const factory = new SyntheticFactoryEnvironment({
      path: options.factoryDatabasePath,
      now: () => HERO_HORIZON_END,
    });
    try {
      const before = factory.getScheduleState();
      const after = resultingScheduleState(before, attemptId, command);
      let claim: ReturnType<typeof claimedExecutionReference>;
      try {
        claim = claimedExecutionReference(store.getExecutionAttempt(attemptId));
      } catch {
        const accepted = selectedReadmission(store);
        const selectedPlanId = selectedAdmissionPlan(accepted);
        const versions = store.getPortfolio().versions;
        const scope = heroExecutionScope(accepted.promiseBasisId);
        const allowanceKey = canonicalGrantAllowanceKey(
          GRANT_DECISION_ID,
          BUNDLE_ID,
          scope,
          HERO_OWNER_ID,
        );
        claim = {
          admissionRecordId: accepted.admissionRecordId,
          promiseBasisId: accepted.promiseBasisId,
          acceptedOwnerDecisionId: ACCEPT_DECISION_ID,
          grantOwnerDecisionId: GRANT_DECISION_ID,
          grantId: GRANT_ID,
          expectedGrantVersion: GRANT_VERSION,
          grantAllowanceKey: allowanceKey,
          grantExecutionOrdinal: 1,
          selectedBundleId: BUNDLE_ID,
          selectedPlanId,
          expectedPortfolioVersion: versions.portfolioVersion,
          expectedCapacityModelVersion: versions.capacityModelVersion,
          expectedCapacityPlanVersion: versions.capacityPlanVersion,
          expectedAuthorizationStateVersion: versions.authorizationStateVersion,
          expectedCalibrationFrontierDigest:
            accepted.calibrationFrontierDigest,
          effect,
          expectedAfterState: JSON.parse(canonicalSerialize(after)) as JsonValue,
        };
      }
      return {
        execution_attempt_id: attemptId,
        claim,
        expected_before_state_version: before.stateVersion,
        expected_before_state_digest: factoryStateDigest(before),
        schedule_command: {
          schema_version: command.schemaVersion,
          command_kind: command.commandKind,
          environment_id: command.environmentId,
          order_id: command.orderId,
          production_cell_id: command.productionCellId,
          quantity: command.quantity,
          start: command.start,
          end: command.end,
        },
      };
    } finally {
      factory.close();
    }
  });
}

export function m4AcceptanceArguments(
  options: Pick<
    DeterministicM4ModelOptions,
    "m2DatabasePath" | "factoryDatabasePath"
  >,
): Record<string, unknown> {
  return withAuthoritativeStore(options, (store) => {
    const accepted = selectedReadmission(store);
    const selectedPlanId = selectedAdmissionPlan(accepted);
    return {
      admission_record_id: accepted.admissionRecordId,
      selected_plan_id: selectedPlanId,
      owner_decision_id: ACCEPT_DECISION_ID,
      approver_id: HERO_OWNER_ID,
      expected_portfolio_version: accepted.portfolioVersion,
      expected_capacity_model_version: accepted.capacityModelVersion,
      expected_capacity_plan_version: accepted.capacityPlanVersion,
      expected_authorization_state_version:
        accepted.authorizationStateVersion,
      expected_calibration_frontier_digest:
        accepted.calibrationFrontierDigest,
      grant: {
        grant_id: GRANT_ID,
        grant_version: GRANT_VERSION,
        grant_owner_decision_id: GRANT_DECISION_ID,
        selected_bundle_id: BUNDLE_ID,
        scope: heroExecutionScope(accepted.promiseBasisId),
      },
    };
  });
}

export function m4PortfolioModificationArguments(
  options: Pick<
    DeterministicM4ModelOptions,
    "m2DatabasePath" | "factoryDatabasePath"
  >,
): Record<string, unknown> {
  return withAuthoritativeStore(options, (store) => {
    const admission = latestAdmission(store, "REPLAN");
    return {
      admission_record_id: admission.admissionRecordId,
      selected_plan_id: selectedHeroPlan(admission),
      owner_decision_id: MODIFY_DECISION_ID,
      approver_id: HERO_OWNER_ID,
    };
  });
}

export function claimInputFromM4MutationArguments(
  input: Record<string, unknown>,
): ClaimExecutionInput {
  const claim = object(input["claim"], "claim");
  const commandInput =
    input["schedule_command"] === undefined
      ? alternateCommand(object(input["schedule_change"], "schedule_change"))
      : commandFromInput(object(input["schedule_command"], "schedule_command"));
  const effect = claim["effect"] as EffectFingerprint;
  const expectedAfterState = claim["expectedAfterState"] as JsonValue;
  return {
    executionAttemptId: string(input["execution_attempt_id"], "execution_attempt_id"),
    admissionRecordId: string(claim["admissionRecordId"], "admissionRecordId"),
    promiseBasisId: string(claim["promiseBasisId"], "promiseBasisId"),
    acceptedOwnerDecisionId: string(
      claim["acceptedOwnerDecisionId"],
      "acceptedOwnerDecisionId",
    ),
    grantOwnerDecisionId: string(
      claim["grantOwnerDecisionId"],
      "grantOwnerDecisionId",
    ),
    grantId: string(claim["grantId"], "grantId"),
    expectedGrantVersion: string(
      claim["expectedGrantVersion"],
      "expectedGrantVersion",
    ),
    grantAllowanceKey: string(
      claim["grantAllowanceKey"],
      "grantAllowanceKey",
    ),
    effect,
    affectedObligationIds: [commandInput.orderId],
    affectedResourceIds: [HERO_RESOURCE_KEYS.agent, HERO_RESOURCE_KEYS.production],
    resourceCapacityClaims: {
      [HERO_RESOURCE_KEYS.agent]: 6,
      [HERO_RESOURCE_KEYS.human]: 0,
      [HERO_RESOURCE_KEYS.production]: 30,
    },
    temporalClaim: {
      resourceKey: HERO_RESOURCE_KEYS.production,
      start: commandInput.start,
      end: commandInput.end,
      requiredDuration: 30,
      timeUnit: "minutes",
    },
    claimAccounting: "already_in_portfolio",
    selectedBundleId: string(claim["selectedBundleId"], "selectedBundleId"),
    selectedPlanId: string(claim["selectedPlanId"], "selectedPlanId"),
    expectedEffect: commandInput as unknown as JsonValue,
    expectedAfterState,
    attemptedAt: HERO_HORIZON_END,
    expectedPortfolioVersion: string(
      claim["expectedPortfolioVersion"],
      "expectedPortfolioVersion",
    ),
    expectedCapacityModelVersion: string(
      claim["expectedCapacityModelVersion"],
      "expectedCapacityModelVersion",
    ),
    expectedCapacityPlanVersion: string(
      claim["expectedCapacityPlanVersion"],
      "expectedCapacityPlanVersion",
    ),
    expectedAuthorizationStateVersion: string(
      claim["expectedAuthorizationStateVersion"],
      "expectedAuthorizationStateVersion",
    ),
    expectedCalibrationFrontierDigest: string(
      claim["expectedCalibrationFrontierDigest"],
      "expectedCalibrationFrontierDigest",
    ),
  };
}

export function effectFromM4MutationArguments(
  input: Record<string, unknown>,
): EffectFingerprint {
  const claim = object(input["claim"], "claim");
  return claim["effect"] as EffectFingerprint;
}

export function deniedScopeForM4Effect(
  promiseBasisId: string,
  effect: EffectFingerprint,
): ApprovalScope {
  return {
    ...heroExecutionScope(promiseBasisId),
    allowedEffectSchemaVersions: [effect.effectSchemaVersion],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: effect.materialParameters.quantity },
      start: { kind: "equals", value: effect.materialParameters.start },
      end: { kind: "equals", value: effect.materialParameters.end },
    },
    maxExecutions: 1,
  };
}

function heroExecutionScope(promiseBasisId: string): ApprovalScope {
  return {
    scopeSchemaVersion: "microfactory-approval-scope/v1",
    environmentId: HERO_ENVIRONMENT_ID,
    allowedEffectSchemaVersions: [
      "microfactory-effect/v1",
      "microfactory-effect/v2",
    ],
    allowedEffectTypes: ["schedule_reservation"],
    allowedTargetTypes: ["production_cell"],
    allowedTargetIds: [HERO_PRODUCTION_CELL_ID],
    allowedOperations: ["reserve"],
    materialParameterConstraints: {
      quantity: { kind: "equals", value: 10 },
      start: {
        kind: "set",
        values: [PRIMARY_START, ALTERNATIVE_START],
      },
      end: { kind: "set", values: [PRIMARY_END, ALTERNATIVE_END] },
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
  schemaVersion: EffectFingerprint["effectSchemaVersion"],
  start: string,
  end: string,
): EffectFingerprint {
  return {
    effectSchemaVersion: schemaVersion,
    environmentId: HERO_ENVIRONMENT_ID,
    effectType: "schedule_reservation",
    targetType: "production_cell",
    targetId: HERO_PRODUCTION_CELL_ID,
    operation: "reserve",
    materialParameters: { quantity: 10, start, end },
  };
}

function scheduleCommand(start: string, end: string): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: HERO_ENVIRONMENT_ID,
    orderId: createHeroProposal().obligationId,
    productionCellId: HERO_PRODUCTION_CELL_ID,
    quantity: 10,
    start,
    end,
  };
}

function commandFromInput(input: Record<string, unknown>): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: string(input["environment_id"], "environment_id"),
    orderId: string(input["order_id"], "order_id"),
    productionCellId: string(input["production_cell_id"], "production_cell_id"),
    quantity: number(input["quantity"], "quantity"),
    start: string(input["start"], "start"),
    end: string(input["end"], "end"),
  };
}

function alternateCommand(input: Record<string, unknown>): CanonicalScheduleCommand {
  return {
    schemaVersion: "microfactory-schedule-command/v1",
    commandKind: "create_schedule_reservation",
    environmentId: string(input["environment_id"], "environment_id"),
    orderId: string(input["order_id"], "order_id"),
    productionCellId: string(input["cell_id"], "cell_id"),
    quantity: number(input["quantity"], "quantity"),
    start: string(input["starts_at"], "starts_at"),
    end: string(input["ends_at"], "ends_at"),
  };
}

function selectedHeroPlan(record: AdmissionRecordBody): string {
  const candidate = record.candidatePlans.find(
    (value) =>
      value.feasible &&
      value.affectedObligations.some(
        (change) => change.optionId === "best-effort-order/reduce-to-8",
      ),
  );
  if (candidate === undefined) throw new Error("M1 hero winner is missing");
  return candidate.candidatePlanId;
}

function selectedAdmissionPlan(record: AdmissionRecordBody): string {
  if (record.selectedPlan.kind !== "selected") {
    throw new Error("M4 authoritative admission has no selected plan");
  }
  return record.selectedPlan.selectedPlanId;
}

function latestAdmission(
  store: FlakeBrakeStore,
  decision: AdmissionRecordBody["decision"],
): AdmissionRecordBody {
  const record = [...store.getAdmissionHistory()]
    .reverse()
    .find((candidate) => candidate.record.decision === decision)?.record;
  if (record === undefined) throw new Error(`No ${decision} admission exists`);
  return record;
}

function selectedReadmission(store: FlakeBrakeStore): AdmissionRecordBody {
  const record = store.getAdmissionHistory().find((candidate) =>
    candidate.addenda.some((addendum) => {
      if (addendum.kind !== "readmission_link") return false;
      const body = addendum.body;
      return (
        isJsonObject(body) &&
        body["kind"] === "M4_POST_MODIFICATION_ADMISSION"
      );
    }),
  )?.record;
  if (record === undefined) {
    throw new Error("No authoritative post-modification admission exists");
  }
  return record;
}

function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withAuthoritativeStore<T>(
  options: DeterministicM4ModelOptions,
  operation: (store: FlakeBrakeStore) => T,
): T {
  const store = createStore({
    path: options.m2DatabasePath,
    authoritativeFactoryDatabasePath: options.factoryDatabasePath,
    now: () => HERO_HORIZON_END,
  });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function structuredSubagentResult(
  value: Record<string, readonly string[]>,
): DeterministicReply {
  return { content: canonicalSerialize(value) };
}

function call(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): DeterministicToolCall {
  return { id, name, arguments: arguments_ };
}

function toolCallNames(messages: readonly ChatMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const item of message.tool_calls) {
      if (item === null || typeof item !== "object") continue;
      const functionValue = (item as Record<string, unknown>)["function"];
      if (functionValue === null || typeof functionValue !== "object") continue;
      const name = (functionValue as Record<string, unknown>)["name"];
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      return typeof value["text"] === "string" ? value["text"] : "";
    })
    .join("\n");
}

function toolResponseText(
  messages: readonly ChatMessage[],
  toolCallId: string,
): string {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.tool_call_id === toolCallId);
  return message === undefined ? "" : messageText(message);
}

function assuranceCodeModeCommand(): string {
  const code = `import asyncio, hashlib, json\nfrom mcp_client import call_tool\n\nasync def main():\n    orders = await call_tool("factory-orders", "read_orders", body={})\n    proposals = await call_tool("factory-orders", "read_incoming_proposals", body={})\n    capacity = await call_tool("factory-capacity", "read_capacity_plan", body={})\n    simulation = await call_tool("factory-simulator", "evaluate_hero_fixture", body={})\n    accepted = orders["orders"]\n    proposal = proposals["proposals"][0]\n    keys = ["agent_work_units", "human_review_decisions", "production_cell_minutes"]\n    existing = {key: sum(order["resourceDemand"][key] for order in accepted) for key in keys}\n    direct = {key: existing[key] + proposal["resourceDemand"][key] for key in keys}\n    direct["human_review_decisions"] += 1\n    limits = {resource["resourceKey"]: resource["capacity"] for resource in capacity["resources"]}\n    remaining = {key: limits[key] - direct[key] for key in keys}\n    protected = next(order for order in accepted if order["protected"])\n    protected_bytes = json.dumps(protected, sort_keys=True, separators=(",", ":")).encode()\n    result = simulation["result"]\n    proposal_candidate = next(item for item in result["candidates"] if item["strategy"] == "modify_proposal")\n    proposal_production = next(item["value"] for item in proposal_candidate["capacity"]["capacityAfter"] if item["resourceKey"] == "production_cell_minutes")\n    print(json.dumps({\n        "existing": existing, "direct": direct, "remaining": remaining,\n        "violations": sorted(key for key in keys if remaining[key] < 0),\n        "decision": result["decision"],\n        "winner": result["recommendedCandidate"]["candidatePlanId"],\n        "winner_strategy": result["recommendedCandidate"]["strategy"],\n        "strategy_families": [[item["strategy"], item["status"]] for item in result["strategyFamilies"]],\n        "candidate_ids": [item["candidatePlanId"] for item in result["candidates"]],\n        "proposal_production_after": proposal_production,\n        "protected_sha256": hashlib.sha256(protected_bytes).hexdigest(),\n    }, sort_keys=True, separators=(",", ":")))\n\nasyncio.run(main())\n`;
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return `printf %s '${encoded}' | base64 -d > flakebrake-assurance.py && python flakebrake-assurance.py`;
}

function writeCompletion(
  response: import("node:http").ServerResponse,
  requestNumber: number,
  reply: DeterministicReply,
): void {
  const id = `chatcmpl-flakebrake-${String(requestNumber)}`;
  const delta: Record<string, unknown> = { role: "assistant" };
  let finishReason: "stop" | "tool_calls";
  if (reply.toolCalls !== undefined) {
    delta["tool_calls"] = reply.toolCalls.map((toolCall, index) => ({
      index,
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    }));
    finishReason = "tool_calls";
  } else {
    delta["content"] = reply.content ?? "";
    finishReason = "stop";
  }
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: 1_777_776_000,
    model: "m4-mission",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "close",
  });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

function requireMessages(value: unknown): readonly ChatMessage[] {
  if (!Array.isArray(value)) throw new TypeError("messages must be an array");
  return value as readonly ChatMessage[];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4_194_304) throw new Error("model request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}
