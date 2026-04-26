import { describe, it, expect, beforeEach } from "vitest";
import { RunAggregator } from "../runAggregator";
import { type DayBookStore } from "../dayBook";
import type { AgentRunState, ParsedSnapshot } from "../../lib/AgentStateParser";

// ── localStorage stub (the dayBook helpers may touch it indirectly) ──────────
beforeEach(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    },
  };
});

const emptyStore = (): DayBookStore => ({ runs: [], version: 1 });

const mkRun = (over: Partial<AgentRunState>): AgentRunState => ({
  key: "r::s",
  runId: "r",
  sessionKey: "s",
  activity: "idle",
  assistantText: "",
  openTools: [],
  startedAt: 0,
  ...over,
});

const snap = (runs: AgentRunState[]): ParsedSnapshot => ({
  runs: new Map(runs.map((r) => [r.key, r])),
  proxy: { connected: true, changedAt: 0 },
});

const sessionLabelFor = (sk: string) => sk;
const agentIdFor = (r: AgentRunState) => `agent:${r.runId}`;

describe("RunAggregator", () => {
  it("inserts a fresh run on first apply", () => {
    const agg = new RunAggregator();
    const r = mkRun({ activity: "thinking", startedAt: 1000 });
    const out = agg.apply(emptyStore(), snap([r]), 1000, sessionLabelFor, agentIdFor);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].key).toBe("r::s");
    expect(out.runs[0].agentId).toBe("agent:r");
    expect(out.runs[0].toolCallCount).toBe(0);
    expect(out.runs[0].endedAt).toBeNull();
  });

  it("counts new tool itemIds and dedupes already-seen ones", () => {
    const agg = new RunAggregator();
    let store = emptyStore();
    const t0 = 1000;

    // First snapshot: 2 open tools (both new).
    const r1 = mkRun({
      activity: "running",
      openTools: [
        { itemId: "i1", name: "exec", activity: "running", startedAt: t0 },
        { itemId: "i2", name: "read", activity: "reading", startedAt: t0 },
      ],
    });
    store = agg.apply(store, snap([r1]), t0, sessionLabelFor, agentIdFor);
    expect(store.runs[0].toolCallCount).toBe(2);
    expect(store.runs[0].recentEvents).toHaveLength(2);

    // Second snapshot: one of the original closed (i1 gone), one new (i3).
    const r2 = mkRun({
      activity: "running",
      openTools: [
        { itemId: "i2", name: "read", activity: "reading", startedAt: t0 },
        { itemId: "i3", name: "write", activity: "writing", startedAt: t0 + 100 },
      ],
    });
    store = agg.apply(store, snap([r2]), t0 + 100, sessionLabelFor, agentIdFor);
    expect(store.runs[0].toolCallCount).toBe(3);
    expect(store.runs[0].recentEvents.map((e) => e.type)).toEqual(["exec", "read", "write"]);
  });

  it("buckets elapsed dt into idle vs working based on prior activity", () => {
    const agg = new RunAggregator();
    let store = emptyStore();

    const idle = mkRun({ activity: "idle" });
    store = agg.apply(store, snap([idle]), 1000, sessionLabelFor, agentIdFor);
    // First apply: dt = 0, neither bucket increments.
    expect(store.runs[0].idleMs).toBe(0);
    expect(store.runs[0].workingMs).toBe(0);

    // 5s later, still idle → bucket 5000ms into idle.
    store = agg.apply(store, snap([idle]), 6000, sessionLabelFor, agentIdFor);
    expect(store.runs[0].idleMs).toBe(5000);
    expect(store.runs[0].workingMs).toBe(0);

    // 3s later, now working → that 3s buckets to working (prior was idle still
    // applies — we record dt against the activity at the START of the interval).
    const working = mkRun({ activity: "thinking" });
    store = agg.apply(store, snap([working]), 9000, sessionLabelFor, agentIdFor);
    expect(store.runs[0].idleMs).toBe(8000); // 5000 + 3000
    expect(store.runs[0].workingMs).toBe(0);

    // 2s later, still working → 2s into working.
    store = agg.apply(store, snap([working]), 11000, sessionLabelFor, agentIdFor);
    expect(store.runs[0].idleMs).toBe(8000);
    expect(store.runs[0].workingMs).toBe(2000);
  });

  it("propagates endedAt through to the persisted record", () => {
    const agg = new RunAggregator();
    let store = emptyStore();
    const live = mkRun({ activity: "thinking", startedAt: 1000 });
    store = agg.apply(store, snap([live]), 1000, sessionLabelFor, agentIdFor);
    expect(store.runs[0].endedAt).toBeNull();

    const ended = mkRun({ ...live, activity: "idle", endedAt: 2000 });
    store = agg.apply(store, snap([ended]), 2000, sessionLabelFor, agentIdFor);
    expect(store.runs[0].endedAt).toBe(2000);
  });

  it("preserves agentId and sessionLabel across snapshot folds", () => {
    const agg = new RunAggregator();
    let store = emptyStore();
    const r = mkRun({});

    const labels = ["first", "second", "third"];
    let i = 0;
    const labelFor = () => labels[i++ % labels.length];

    store = agg.apply(store, snap([r]), 1000, labelFor, agentIdFor);
    const firstLabel = store.runs[0].sessionLabel;
    expect(firstLabel).toBe("first");

    // Subsequent folds must NOT overwrite the persisted label.
    store = agg.apply(store, snap([r]), 2000, labelFor, agentIdFor);
    store = agg.apply(store, snap([r]), 3000, labelFor, agentIdFor);
    expect(store.runs[0].sessionLabel).toBe("first");
  });

  it("reset() clears memory so the next apply re-counts itemIds", () => {
    const agg = new RunAggregator();
    const r = mkRun({
      activity: "running",
      openTools: [{ itemId: "i1", name: "exec", activity: "running", startedAt: 0 }],
    });
    let store = agg.apply(emptyStore(), snap([r]), 0, sessionLabelFor, agentIdFor);
    expect(store.runs[0].toolCallCount).toBe(1);

    agg.reset();

    // Same itemId, fresh aggregator memory → counted again. (This is the
    // expected behavior: reset() is called when the room store fully restarts;
    // a fresh persisted store would be passed alongside in real usage.)
    store = agg.apply(emptyStore(), snap([r]), 0, sessionLabelFor, agentIdFor);
    expect(store.runs[0].toolCallCount).toBe(1);
  });
});
