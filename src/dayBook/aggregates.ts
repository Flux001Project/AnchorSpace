/**
 * Aggregates — pure functions over PersistedRun[] for the day book summary band.
 *
 * Principle 1 fence: this module describes. It does not act, decide, or annotate.
 * "Concerning" heuristics live in `concerning.ts` (Phase 4.3).
 */

import type { PersistedRun } from "../persistence/dayBook";
import { LOCAL_TZ, startOfLocalDay } from "../lib/time";

export interface DayAggregates {
  /** How many runs started today. */
  totalRuns: number;
  /** How many of those are still open (endedAt === null). */
  activeRuns: number;
  /** Sum of toolCallCount across all runs. */
  totalToolCalls: number;
  /** Sum of persisted idleMs. Active-run tails are not attributed to idle. */
  idleMs: number;
  /** Sum of persisted workingMs, with active-run tails closed into working. */
  workingMs: number;
  /**
   * workingMs / (workingMs + idleMs). null when the denominator is zero
   * (no observed activity yet) so the caller can render "—" instead of NaN%.
   */
  workingRatio: number | null;
  /** Unique agentIds present, sorted lexicographically for stable UI. */
  agentsActive: string[];
}

/**
 * Filter runs whose `startedAt` falls on the local calendar day containing `now`,
 * evaluated in `tz` (IANA timezone; defaults to the app's canonical `LOCAL_TZ`,
 * `America/Chicago`). Non-mutating.
 *
 * Delegates to the shared `startOfLocalDay` helper so day boundaries are
 * consistent across the codebase and independent of the host process tz.
 */
export function filterToday(
  runs: readonly PersistedRun[],
  now: number,
  tz: string = LOCAL_TZ
): PersistedRun[] {
  const startOfDay = startOfLocalDay(now, tz);
  return runs.filter((r) => r.startedAt >= startOfDay);
}

/**
 * Fold a set of runs into a single DayAggregates snapshot. Non-mutating.
 *
 * Active-run tail policy: for runs with `endedAt === null`, the elapsed wall
 * time between `startedAt` and `now` that isn't already attributed to
 * persisted `idleMs` is treated as working. This matches the mental model
 * "what is happening now is work" without requiring a live tick.
 */
export function aggregateDay(runs: readonly PersistedRun[], now: number): DayAggregates {
  let totalRuns = 0;
  let activeRuns = 0;
  let totalToolCalls = 0;
  let idleMs = 0;
  let workingMs = 0;
  const agentSet = new Set<string>();

  for (const r of runs) {
    totalRuns += 1;
    totalToolCalls += r.toolCallCount;
    idleMs += r.idleMs;

    if (r.endedAt === null) {
      activeRuns += 1;
      const elapsed = Math.max(0, now - r.startedAt);
      const tail = Math.max(0, elapsed - r.idleMs - r.workingMs);
      workingMs += r.workingMs + tail;
    } else {
      workingMs += r.workingMs;
    }

    agentSet.add(r.agentId);
  }

  const denom = idleMs + workingMs;
  const workingRatio = denom > 0 ? workingMs / denom : null;

  return {
    totalRuns,
    activeRuns,
    totalToolCalls,
    idleMs,
    workingMs,
    workingRatio,
    agentsActive: Array.from(agentSet).sort(),
  };
}


