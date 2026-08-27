import { compareStableStrings } from "./canonical.js";
import type { TemporalSlack, TimeUnit } from "./domain.js";

const TIME_UNIT_MILLISECONDS: Readonly<Record<TimeUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
};

export interface FlexibleSchedulingClaim {
  readonly obligationId: string;
  readonly resourceKey: string;
  readonly start: string;
  readonly end: string;
  readonly timeUnit: TimeUnit;
  readonly flexibleDuration: number;
  readonly reportedRequiredDuration: number;
  readonly protected: boolean;
}

export interface FixedSchedulingClaim {
  readonly reservationId: string;
  readonly resourceKey: string;
  readonly start: string;
  readonly end: string;
  readonly timeUnit: TimeUnit;
}

interface TimeSegment {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

interface FlowResult {
  readonly total: number;
  readonly allocatedByObligation: ReadonlyMap<string, number>;
}

interface Edge {
  readonly to: number;
  readonly reverse: number;
  capacity: number;
  readonly originalCapacity: number;
}

export class SchedulingError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

export function evaluateTemporalSchedule(
  flexibleInput: readonly FlexibleSchedulingClaim[],
  fixedInput: readonly FixedSchedulingClaim[],
): readonly TemporalSlack[] {
  const resourceKeys = [
    ...new Set([
      ...flexibleInput.map((claim) => claim.resourceKey),
      ...fixedInput.map((claim) => claim.resourceKey),
    ]),
  ].sort(compareStableStrings);
  const results: TemporalSlack[] = [];

  for (const resourceKey of resourceKeys) {
    const flexible = flexibleInput
      .filter((claim) => claim.resourceKey === resourceKey)
      .sort((left, right) =>
        compareStableStrings(left.obligationId, right.obligationId),
      );
    const fixed = fixedInput
      .filter((claim) => claim.resourceKey === resourceKey)
      .sort(compareFixedClaims);
    const timeUnits = new Set([
      ...flexible.map((claim) => claim.timeUnit),
      ...fixed.map((claim) => claim.timeUnit),
    ]);
    if (timeUnits.size !== 1) {
      throw new SchedulingError(
        `Temporal claims for ${resourceKey} must use one compatible time unit`,
      );
    }
    const timeUnit = [...timeUnits][0];
    if (timeUnit === undefined) continue;
    assertFixedClaimsDoNotOverlap(fixed);
    const segments = freeSegments(flexible, fixed, timeUnit);
    const baseline = runFlow(flexible, segments);
    const requiredTotal = safeSum(
      flexible.map((claim) => claim.flexibleDuration),
      `required duration for ${resourceKey}`,
    );
    const feasible = baseline.total === requiredTotal;

    for (const claim of flexible) {
      const windowDuration = durationInUnit(
        claim.start,
        claim.end,
        claim.timeUnit,
      );
      const slack = feasible
        ? maximumAdditionalDuration(claim, flexible, segments, windowDuration)
        : (baseline.allocatedByObligation.get(claim.obligationId) ?? 0) -
          claim.flexibleDuration;
      results.push({
        obligationId: claim.obligationId,
        resourceKey: claim.resourceKey,
        constraintStart: claim.start,
        constraintEnd: claim.end,
        windowDuration,
        requiredDuration: claim.reportedRequiredDuration,
        slack,
        timeUnit: claim.timeUnit,
        protected: claim.protected,
        status: slack < 0 ? "violated" : slack === 0 ? "binding" : "slack",
      });
    }
  }

  return results.sort((left, right) =>
    compareStableStrings(left.obligationId, right.obligationId),
  );
}

function maximumAdditionalDuration(
  target: FlexibleSchedulingClaim,
  claims: readonly FlexibleSchedulingClaim[],
  segments: readonly TimeSegment[],
  windowDuration: number,
): number {
  let lower = target.flexibleDuration;
  let upper = windowDuration;
  while (lower < upper) {
    const middle = Math.floor((lower + upper + 1) / 2);
    const adjusted = claims.map((claim) =>
      claim.obligationId === target.obligationId
        ? { ...claim, flexibleDuration: middle }
        : claim,
    );
    const required = safeSum(
      adjusted.map((claim) => claim.flexibleDuration),
      `scheduling slack for ${target.obligationId}`,
    );
    if (runFlow(adjusted, segments).total === required) lower = middle;
    else upper = middle - 1;
  }
  return lower - target.flexibleDuration;
}

function freeSegments(
  flexible: readonly FlexibleSchedulingClaim[],
  fixed: readonly FixedSchedulingClaim[],
  timeUnit: TimeUnit,
): readonly TimeSegment[] {
  const breakpoints = [
    ...new Set(
      [...flexible, ...fixed].flatMap((claim) => [
        Date.parse(claim.start),
        Date.parse(claim.end),
      ]),
    ),
  ].sort((left, right) => left - right);
  const segments: TimeSegment[] = [];
  for (let index = 0; index + 1 < breakpoints.length; index += 1) {
    const start = breakpoints[index];
    const end = breakpoints[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const occupied = fixed.some(
      (claim) => Date.parse(claim.start) <= start && Date.parse(claim.end) >= end,
    );
    if (occupied) continue;
    const milliseconds = end - start;
    const divisor = TIME_UNIT_MILLISECONDS[timeUnit];
    if (milliseconds % divisor !== 0) {
      throw new SchedulingError(
        `Temporal segment is not an exact number of ${timeUnit}`,
      );
    }
    segments.push({ start, end, duration: milliseconds / divisor });
  }
  return segments;
}

function runFlow(
  claimsInput: readonly FlexibleSchedulingClaim[],
  segments: readonly TimeSegment[],
): FlowResult {
  const claims = [...claimsInput].sort((left, right) =>
    compareStableStrings(left.obligationId, right.obligationId),
  );
  const source = 0;
  const claimOffset = 1;
  const segmentOffset = claimOffset + claims.length;
  const sink = segmentOffset + segments.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const sourceEdges = new Map<string, Edge>();

  for (const [claimIndex, claim] of claims.entries()) {
    const edge = addEdge(
      graph,
      source,
      claimOffset + claimIndex,
      claim.flexibleDuration,
    );
    sourceEdges.set(claim.obligationId, edge);
    const claimStart = Date.parse(claim.start);
    const claimEnd = Date.parse(claim.end);
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segment.start >= claimStart && segment.end <= claimEnd) {
        addEdge(
          graph,
          claimOffset + claimIndex,
          segmentOffset + segmentIndex,
          segment.duration,
        );
      }
    }
  }
  for (const [segmentIndex, segment] of segments.entries()) {
    addEdge(graph, segmentOffset + segmentIndex, sink, segment.duration);
  }

  const total = maxFlow(graph, source, sink);
  const allocatedByObligation = new Map<string, number>();
  for (const claim of claims) {
    const edge = sourceEdges.get(claim.obligationId);
    if (edge === undefined) {
      throw new SchedulingError(`Missing flow edge for ${claim.obligationId}`);
    }
    allocatedByObligation.set(
      claim.obligationId,
      edge.originalCapacity - edge.capacity,
    );
  }
  return { total, allocatedByObligation };
}

function addEdge(
  graph: Edge[][],
  from: number,
  to: number,
  capacity: number,
): Edge {
  const forward: Edge = {
    to,
    reverse: graph[to]?.length ?? 0,
    capacity,
    originalCapacity: capacity,
  };
  const reverse: Edge = {
    to: from,
    reverse: graph[from]?.length ?? 0,
    capacity: 0,
    originalCapacity: 0,
  };
  graph[from]?.push(forward);
  graph[to]?.push(reverse);
  return forward;
}

function maxFlow(graph: Edge[][], source: number, sink: number): number {
  let total = 0;
  while (true) {
    const level = graph.map(() => -1);
    level[source] = 0;
    const queue = [source];
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      if (node === undefined) continue;
      for (const edge of graph[node] ?? []) {
        if (edge.capacity > 0 && level[edge.to] === -1) {
          level[edge.to] = (level[node] ?? 0) + 1;
          queue.push(edge.to);
        }
      }
    }
    if (level[sink] === -1) return total;
    const nextEdge = graph.map(() => 0);
    while (true) {
      const pushed = sendFlow(
        graph,
        level,
        nextEdge,
        source,
        sink,
        Number.MAX_SAFE_INTEGER,
      );
      if (pushed === 0) break;
      total = safeSum([total, pushed], "maximum scheduling flow");
    }
  }
}

function sendFlow(
  graph: Edge[][],
  level: readonly number[],
  nextEdge: number[],
  node: number,
  sink: number,
  available: number,
): number {
  if (node === sink) return available;
  const edges = graph[node] ?? [];
  while ((nextEdge[node] ?? 0) < edges.length) {
    const edgeIndex = nextEdge[node] ?? 0;
    const edge = edges[edgeIndex];
    if (
      edge !== undefined &&
      edge.capacity > 0 &&
      level[edge.to] === (level[node] ?? 0) + 1
    ) {
      const pushed = sendFlow(
        graph,
        level,
        nextEdge,
        edge.to,
        sink,
        Math.min(available, edge.capacity),
      );
      if (pushed > 0) {
        edge.capacity -= pushed;
        const reverse = graph[edge.to]?.[edge.reverse];
        if (reverse === undefined) throw new SchedulingError("Missing reverse edge");
        reverse.capacity += pushed;
        return pushed;
      }
    }
    nextEdge[node] = edgeIndex + 1;
  }
  return 0;
}

function assertFixedClaimsDoNotOverlap(
  fixed: readonly FixedSchedulingClaim[],
): void {
  for (let index = 1; index < fixed.length; index += 1) {
    const previous = fixed[index - 1];
    const current = fixed[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      Date.parse(current.start) < Date.parse(previous.end)
    ) {
      throw new SchedulingError(
        `Fixed reservations ${previous.reservationId} and ${current.reservationId} overlap`,
      );
    }
  }
}

function compareFixedClaims(
  left: FixedSchedulingClaim,
  right: FixedSchedulingClaim,
): number {
  const start = Date.parse(left.start) - Date.parse(right.start);
  if (start !== 0) return start;
  const end = Date.parse(left.end) - Date.parse(right.end);
  return end !== 0
    ? end
    : compareStableStrings(left.reservationId, right.reservationId);
}

function durationInUnit(start: string, end: string, unit: TimeUnit): number {
  const milliseconds = Date.parse(end) - Date.parse(start);
  const divisor = TIME_UNIT_MILLISECONDS[unit];
  if (milliseconds <= 0 || milliseconds % divisor !== 0) {
    throw new SchedulingError(`Window must be exact positive ${unit}`);
  }
  const duration = milliseconds / divisor;
  if (!Number.isSafeInteger(duration)) {
    throw new SchedulingError("Window duration exceeds safe integer range");
  }
  return duration;
}

function safeSum(values: readonly number[], context: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new SchedulingError(`${context} exceeds safe integer range`);
    }
  }
  return total;
}
