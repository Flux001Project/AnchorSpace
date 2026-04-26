import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDayBook,
  saveDayBook,
  upsertRun,
  appendEvent,
  runsForDay,
  localMidnight,
  clearDayBook,
  isPhantomRun,
  MAX_RUNS,
  RECENT_EVENTS_PER_RUN,
  DAYBOOK_VERSION,
  DAYBOOK_STORAGE_KEY,
  type DayBookStore,
  type PersistedRun,
} from "../dayBook";

beforeEach(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
    },
  };
  clearDayBook();
});

const baseRun: PersistedRun = {
  key: "r::s",
  runId: "r",
  sessionKey: "s",
  agentId: "Flux",
  sessionLabel: "main",
  startedAt: 0,
  endedAt: null,
  toolCallCount: 0,
  idleMs: 0,
  workingMs: 0,
  recentEvents: [],
};

describe("dayBook", () => {
  it("loadDayBook returns empty store on miss", () => {
    const s = loadDayBook();
    expect(s.runs).toEqual([]);
    expect(s.version).toBe(DAYBOOK_VERSION);
  });

  it("round-trips save → load (current schema, no migration)", () => {
    // Use a non-phantom run (toolCallCount > 0) so the v1→v2 sweep
    // doesn't fire even if the test ever runs against a v1 store.
    const r: PersistedRun = {
      ...baseRun,
      key: "r1::s1",
      runId: "r1",
      sessionKey: "s1",
      startedAt: 1000,
      toolCallCount: 3,
    };
    saveDayBook({ runs: [r], version: DAYBOOK_VERSION });
    const reloaded = loadDayBook();
    expect(reloaded.runs.length).toBe(1);
    expect(reloaded.runs[0].key).toBe("r1::s1");
    expect(reloaded.runs[0].agentId).toBe("Flux");
  });

  it("upsert maintains DESC order and replaces by key", () => {
    const empty: DayBookStore = { runs: [], version: 1 };
    const a: PersistedRun = { ...baseRun, key: "a", runId: "a", startedAt: 100 };
    const b: PersistedRun = { ...a, key: "b", runId: "b", startedAt: 200 };
    const c: PersistedRun = { ...a, key: "c", runId: "c", startedAt: 150 };
    const aUpdated: PersistedRun = { ...a, toolCallCount: 7 };

    const s4 = [a, b, c, aUpdated].reduce(upsertRun, empty);

    expect(s4.runs.map((r) => r.key)).toEqual(["b", "c", "a"]);
    expect(s4.runs.find((r) => r.key === "a")!.toolCallCount).toBe(7);
    expect(s4.runs.length).toBe(3);
  });

  it("rolling-window evicts oldest beyond MAX_RUNS", () => {
    let store: DayBookStore = { runs: [], version: 1 };
    for (let i = 0; i < 5005; i++) {
      store = upsertRun(store, { ...baseRun, key: `k${i}`, runId: `k${i}`, startedAt: i });
    }
    expect(store.runs.length).toBe(MAX_RUNS);
    expect(store.runs[0].key).toBe("k5004");
    expect(store.runs[store.runs.length - 1].key).toBe("k5");
  });

  it("appendEvent caps recentEvents and is FIFO", () => {
    let store: DayBookStore = upsertRun({ runs: [], version: 1 }, { ...baseRun, key: "r" });
    for (let i = 0; i < 25; i++) {
      store = appendEvent(store, "r", { t: i, type: "exec", summary: `e${i}` });
    }
    const got = store.runs.find((x) => x.key === "r")!;
    expect(got.recentEvents.length).toBe(RECENT_EVENTS_PER_RUN);
    expect(got.recentEvents[0].summary).toBe("e5");
    expect(got.recentEvents[19].summary).toBe("e24");

    const sameStore = appendEvent(store, "does-not-exist", { t: 0, type: "x", summary: "x" });
    expect(sameStore).toBe(store);
  });

  it("localMidnight floors to local midnight", () => {
    // Use a local-tz-relative anchor so the test passes regardless of CI tz.
    const d = new Date(2026, 3, 26, 15, 30, 0, 0); // local Apr 26 15:30
    const midnight = localMidnight(d.getTime());
    const expected = new Date(2026, 3, 26, 0, 0, 0, 0).getTime();
    expect(midnight).toBe(expected);
  });

  it("v1→v2 migration sweeps phantom runs from a pre-4.0.1 store", () => {
    // A pre-4.0.1 store with two records:
    //   - real Flux run (7 tool calls, has events) — should survive
    //   - phantom Sub-1 (0 tool calls, no events, never ended) — should be evicted
    const real: PersistedRun = {
      ...baseRun,
      key: "flux-run::agent:main:main",
      runId: "flux-run",
      sessionKey: "agent:main:main",
      agentId: "Flux",
      startedAt: 1000,
      toolCallCount: 7,
      recentEvents: [
        { t: 1100, type: "exec", summary: "npm test" },
        { t: 1200, type: "read", summary: "src/foo.ts" },
      ],
    };
    const phantom: PersistedRun = {
      ...baseRun,
      key: "announce:v1:abc::agent:main:subagent:xyz",
      runId: "announce:v1:abc",
      sessionKey: "agent:main:subagent:xyz",
      agentId: "Sub-1",
      startedAt: 2000,
      // toolCallCount=0, recentEvents=[], endedAt=null — phantom shape
    };

    // Manually persist a v1 store to localStorage (saveDayBook would write
    // current version, defeating the test).
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
      DAYBOOK_STORAGE_KEY,
      JSON.stringify({ runs: [real, phantom], version: 1 })
    );

    const loaded = loadDayBook();
    expect(loaded.runs.length).toBe(1);
    expect(loaded.runs[0].key).toBe("flux-run::agent:main:main");
    expect(loaded.version).toBe(DAYBOOK_VERSION);

    // Migration is one-shot: a second load reads back the swept store.
    const reloaded = loadDayBook();
    expect(reloaded.runs.length).toBe(1);
    expect(reloaded.version).toBe(DAYBOOK_VERSION);
  });

  it("isPhantomRun classifies the documented shapes correctly", () => {
    // Phantom: zero tools, zero events, not ended.
    expect(isPhantomRun({ ...baseRun, toolCallCount: 0, recentEvents: [], endedAt: null })).toBe(true);
    // Real — has tool calls.
    expect(isPhantomRun({ ...baseRun, toolCallCount: 1, recentEvents: [], endedAt: null })).toBe(false);
    // Real — has events.
    expect(
      isPhantomRun({ ...baseRun, toolCallCount: 0, recentEvents: [{ t: 0, type: "x", summary: "y" }], endedAt: null })
    ).toBe(false);
    // Real — ended cleanly (parser saw a lifecycle.end).
    expect(isPhantomRun({ ...baseRun, toolCallCount: 0, recentEvents: [], endedAt: 1000 })).toBe(false);
  });

  it("runsForDay filters to [dayStart, dayStart + 24h)", () => {
    const today = localMidnight(new Date(2026, 3, 26, 15, 30).getTime());
    const inDayEarly = today + 1000;
    const inDayLate = today + 24 * 60 * 60 * 1000 - 1000;
    const beforeDay = today - 1000;
    const afterDay = today + 24 * 60 * 60 * 1000;

    let store: DayBookStore = { runs: [], version: 1 };
    for (const [k, t] of [
      ["before", beforeDay],
      ["early", inDayEarly],
      ["late", inDayLate],
      ["after", afterDay],
    ] as const) {
      store = upsertRun(store, { ...baseRun, key: k, runId: k, startedAt: t });
    }

    const dayRuns = runsForDay(store, today);
    expect(dayRuns.map((r) => r.key)).toEqual(["late", "early"]);
  });
});
