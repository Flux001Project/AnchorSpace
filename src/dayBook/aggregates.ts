/**
 * Aggregates — pure functions over PersistedRun[] for the day book summary band.
 *
 * Principle 1 fence: this module describes. It does not act, decide, or annotate.
 * "Concerning" heuristics live in `concerning.ts` (Phase 4.3).
 */

import type { PersistedRun } from "../persistence/dayBook";

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
 * evaluated in `tz` (IANA timezone). Non-mutating.
 *
 * Uses Intl.DateTimeFormat to derive the local Y/M/D of `now` in `tz`, then
 * computes the epoch ms of that day's local midnight. Runs with
 * `startedAt >= localMidnight` are kept.
 */
export function filterToday(
  runs: readonly PersistedRun[],
  now: number,
  tz: string
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

// --- helpers ----------------------------------------------------------------

/**
 * Epoch ms of local midnight for the calendar day containing `now`, in `tz`.
 *
 * Implementation: format `now` in `tz` to get its Y-M-D, then locate the
 * epoch ms whose formatted-in-`tz` timestamp is exactly `${Y}-${M}-${D} 00:00:00`.
 * A single-pass correction handles DST offset changes.
 */
function startOfLocalDay(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));

  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const m = get("month");
  const d = get("day");

  // First estimate: interpret the local Y-M-D 00:00 as if it were UTC.
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Then measure the tz offset at that instant and correct.
  const offsetMs = tzOffsetMs(utcMidnight, tz);
  return utcMidnight - offsetMs;
}

/** Offset in ms such that: local-time-in-tz = utc + offsetMs. Positive for east-of-UTC. */
function tzOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - instant;
}
