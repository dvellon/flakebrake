export { serializeAdmissionResult } from "./serialization.js";
export {
  AdmissionInputError,
  compareReplanCandidates,
  evaluateAdmission,
} from "./kernel.js";
export { rational } from "./rational.js";
export {
  approvalScopeContained,
  approvalScopeCovers,
  approvalScopeStrictlyContained,
  canonicalGrantAllowanceKey,
  canonicalizeApprovalScope,
  deniedScopePredicate,
  denialPredicateMatches,
  effectFingerprintIdentity,
  normalizeEffect,
} from "./effects.js";
export { createStore, FlakeBrakeStore } from "./store.js";
export {
  claimedExecutionReference,
  commandFromAttempt,
  factoryStateDigest,
  resultingScheduleState,
  SyntheticFactoryEnvironment,
} from "./factory-environment.js";
export {
  FACTORY_MCP_SERVICE_NAMES,
  createFactoryMcpService,
  runFactoryMcpCli,
  serveFactoryMcpStdio,
  startFactoryMcpCluster,
} from "./mcp.js";
export {
  HERO_ENVIRONMENT_ID,
  HERO_HORIZON_END,
  HERO_HORIZON_START,
  HERO_OWNER_ID,
  HERO_PRODUCTION_CELL_ID,
  HERO_RESOURCE_KEYS,
  HERO_SCHEDULE_COMMITMENTS,
  createHeroEvaluationInput,
  createHeroInitialState,
  createHeroProposal,
} from "./hero-fixture.js";
export {
  AuthorizationDeniedError,
  ExecutionAttemptConflictError,
  StatefulInputError,
} from "./stateful-domain.js";
export type * from "./domain.js";
export type * from "./stateful-domain.js";
export type * from "./factory-environment.js";
export type * from "./mcp.js";
export { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
export { DuplicateJsonKeyError } from "./strict-json.js";
