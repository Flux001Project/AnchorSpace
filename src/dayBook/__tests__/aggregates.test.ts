/**
 * Tests for aggregates.ts — pure functions over PersistedRun[].
 *
 * These tests define the contract. The impl must satisfy them without
 * mutating the input array or its members.
 */

import { describe, expect, it } from "vitest";
import type { PersistedRun } from "../../persistence/dayBook";
import {
  aggregateDay,
  filterToday,
  type DayAggregates,
} from "../aggregates";

// --- fixtures ---------------------------------------------------------------

/** 2026-07-13 12:00 local (America/Chicago is UTC-5 in July → 17:00 UTC). */
const NOON_LOCAL = new Date("2026-07-13T17:00:00Z").getTime();
/** 2026-07-13 00:00 local. */
const START_OF_DAY_LOCAL = new Date("2026-07-13T05:00:00Z").getTime();
/** 2026-07-12 23:00 local — belongs to yesterday. */
const YESTERDAY_LATE = new Date("2026-07-13T04:00:00Z").getTime();

function mkRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  const startedAt = overrides.startedAt ?? NOON_LOCAL;
  return {
    key: `run-${startedAt}::sess-a`,
    runId: `run-${startedAt}`,
    sessionKey: "sess-a",
    agentId: "Flux",
    sessionLabel: "main",
    startedAt,
    endedAt: startedAt + 60_000,
    toolCallCount: 5,
    idleMs: 10_000,
    workingMs: 50_000,
    recentEvents: [],
    ...overrides,
  };
}

// --- filterToday ------------------------------------------------------------

describe("filterToday", () => {
  it("keeps runs started at-or-after local midnight of the reference day", () => {
    const yesterday = mkRun({ startedAt: YESTERDAY_LATE });
    const earlyToday = mkRun({ startedAt: START_OF_DAY_LOCAL });
    const noonToday = mkRun({ startedAt: NOON_LOCAL });
    const out = filterToday([yesterday, earlyToday, noonToday], NOON_LOCAL, "America/Chicago");
    expect(out.map((r) => r.startedAt)).toEqual([START_OF_DAY_LOCAL, NOON_LOCAL]);
  });

  it("does not mutate the input array", () => {
    const runs = [mkRun({ startedAt: YESTERDAY_LATE }), mkRun()];
    const before = [...runs];
    filterToday(runs, NOON_LOCAL, "America/Chicago");
    expect(runs).toEqual(before);
  });

  it("returns [] for an empty input", () => {
    expect(filterToday([], NOON_LOCAL, "America/Chicago")).toEqual([]);
  });
});

// --- aggregateDay -----------------------------------------------------------

describe("aggregateDay", () => {
  it("returns zeros/null on empty input", () => {
    const out = aggregateDay([], NOON_LOCAL);
    const expected: DayAggregates = {
      totalRuns: 0,
      activeRuns: 0,
      totalToolCalls: 0,
      idleMs: 0,
      workingMs: 0,
      workingRatio: null,
      agentsActive: [],
    };
    expect(out).toEqual(expected);
  });

  it("sums counts across runs", () => {
    const runs = [
      mkRun({ toolCallCount: 3 }),
      mkRun({ toolCallCount: 7, agentId: "Sub-1", sessionKey: "sess-b" }),
    ];
    const out = aggregateDay(runs, NOON_LOCAL);
    expect(out.totalRuns).toBe(2);
    expect(out.totalToolCalls).toBe(10);
  });

  it("counts activeRuns as those with endedAt === null", () => {
    const runs = [mkRun(), mkRun({ endedAt: null })];
    expect(aggregateDay(runs, NOON_LOCAL).activeRuns).toBe(1);
  });

  it("closes the tail of active runs into workingMs using (now - startedAt - idleMs) fallback", () => {
    // Active run started 60s before now, with 20s persisted idle and no persisted working.
    // The tail (40s) should count as working when the run is still open.
    const run = mkRun({
      startedAt: NOON_LOCAL - 60_000,
      endedAt: null,
      idleMs: 20_000,
      workingMs: 0,
    });
    const out = aggregateDay([run], NOON_LOCAL);
    // Persisted idle 20s + closed working tail 40s = 60s total, ratio = 40/60.
    expect(out.idleMs).toBe(20_000);
    expect(out.workingMs).toBe(40_000);
    expect(out.workingRatio).toBeCloseTo(40_000 / 60_000, 5);
  });

  it("workingRatio is null when idleMs + workingMs === 0", () => {
    const run = mkRun({
      startedAt: NOON_LOCAL,
      endedAt: NOON_LOCAL,
      idleMs: 0,
      workingMs: 0,
    });
    expect(aggregateDay([run], NOON_LOCAL).workingRatio).toBeNull();
  });

  it("agentsActive is a stable-sorted unique list of agentIds present in the input", () => {
    const runs = [
      mkRun({ agentId: "Sub-2" }),
      mkRun({ agentId: "Flux", sessionKey: "sess-b" }),
      mkRun({ agentId: "Sub-2", sessionKey: "sess-c" }),
    ];
    expect(aggregateDay(runs, NOON_LOCAL).agentsActive).toEqual(["Flux", "Sub-2"]);
  });

  it("does not mutate its input", () => {
    const runs = [mkRun({ endedAt: null }), mkRun()];
    const before = JSON.parse(JSON.stringify(runs));
    aggregateDay(runs, NOON_LOCAL);
    expect(runs).toEqual(before);
  });
});
