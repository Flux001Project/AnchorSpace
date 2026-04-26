/**
 * Run aggregator — folds parser snapshots into PersistedRun records.
 *
 * The aggregator is stateful only in the sense that it remembers the previous
 * snapshot's per-run state so it can accumulate idle/working durations and
 * count newly-observed tool itemIds. It does not own a store; the caller
 * (typically the room store) drives apply() on each parser emit and persists
 * the returned DayBookStore.
 *
 * Principle 1 fence: this aggregator only describes what happened. It must
 * not introduce action-shaped fields or side effects beyond accumulation.
 */

import type { AgentRunState, ParsedSnapshot } from "../lib/AgentStateParser";
import {
  appendEvent,
  upsertRun,
  type DayBookStore,
  type PersistedRun,
  type PersistedRunEvent,
} from "./dayBook";

/** Per-run memory the aggregator needs between calls. */
interface RunMemory {
  /** itemIds we've already counted toward toolCallCount, so we don't double-count. */
  seenToolItemIds: Set<string>;
  /** Activity at last apply() — used to bucket the elapsed dt into idle vs working. */
  lastActivity: AgentRunState["activity"];
  /** Timestamp of the last apply() — for dt accumulation. */
  lastTickAt: number;
}

/**
 * Mutable in-memory state. One instance per active session of the room.
 * Built so a fresh start() in the room store creates a fresh aggregator.
 */
export class RunAggregator {
  private memory = new Map<string, RunMemory>();

  /**
   * Fold a parser snapshot into the given store. Returns a new store with
   * any newly observed runs upserted and existing runs updated. Called once
   * per parser emit; safe to call rapidly.
   *
   * @param store    current persisted store
   * @param snap     latest parser snapshot
   * @param now      epoch ms (caller-supplied for test determinism)
   * @param sessionLabelFor  resolves a human-readable label for a sessionKey
   * @param agentIdFor       resolves a stable display id for a run
   */
  apply(
    store: DayBookStore,
    snap: ParsedSnapshot,
    now: number,
    sessionLabelFor: (sessionKey: string) => string,
    agentIdFor: (run: AgentRunState) => string
  ): DayBookStore {
    let next = store;
    // Build a quick existing-runs lookup so we can preserve persisted fields
    // (toolCallCount, idleMs, workingMs, recentEvents) across snapshot folds.
    const existingByKey = new Map<string, PersistedRun>();
    for (const run of store.runs) existingByKey.set(run.key, run);

    for (const run of snap.runs.values()) {
      const prevPersisted = existingByKey.get(run.key);
      const mem = this.memory.get(run.key) ?? {
        seenToolItemIds: new Set<string>(),
        lastActivity: run.activity,
        lastTickAt: now,
      };

      // 1. Count newly observed tool itemIds.
      let newToolCalls = 0;
      const newEvents: PersistedRunEvent[] = [];
      for (const tool of run.openTools) {
        if (!mem.seenToolItemIds.has(tool.itemId)) {
          mem.seenToolItemIds.add(tool.itemId);
          newToolCalls += 1;
          newEvents.push({
            t: tool.startedAt,
            type: tool.name,
            summary: summarizeTool(tool.name, tool.title),
          });
        }
      }

      // 2. Bucket the elapsed dt into idle vs working based on previous activity.
      const dt = Math.max(0, now - mem.lastTickAt);
      const wasIdle = mem.lastActivity === "idle";
      const idleAdd = wasIdle ? dt : 0;
      const workingAdd = wasIdle ? 0 : dt;

      // 3. Compose the next persisted record.
      const merged: PersistedRun = {
        key: run.key,
        runId: run.runId,
        sessionKey: run.sessionKey,
        agentId: prevPersisted?.agentId ?? agentIdFor(run),
        sessionLabel: prevPersisted?.sessionLabel ?? sessionLabelFor(run.sessionKey),
        startedAt: prevPersisted?.startedAt ?? run.startedAt,
        endedAt: run.endedAt ?? null,
        toolCallCount: (prevPersisted?.toolCallCount ?? 0) + newToolCalls,
        idleMs: (prevPersisted?.idleMs ?? 0) + idleAdd,
        workingMs: (prevPersisted?.workingMs ?? 0) + workingAdd,
        recentEvents: prevPersisted?.recentEvents ?? [],
      };

      next = upsertRun(next, merged);

      // 4. Append any new tool events (after upsert so the run exists in the store).
      for (const ev of newEvents) {
        next = appendEvent(next, run.key, ev);
      }

      // 5. Update memory for next call.
      mem.lastActivity = run.activity;
      mem.lastTickAt = now;
      this.memory.set(run.key, mem);
    }

    return next;
  }

  /** Drop memory for runs no longer present in the parser. Call on store stop(). */
  reset(): void {
    this.memory.clear();
  }
}

/**
 * Compose a short, observational summary line for a tool item. Matches the
 * speech-bubble copy style used in Room.tsx but kept independent so the
 * aggregator does not depend on render code.
 */
function summarizeTool(name: string, title?: string): string {
  if (title && title.trim().length > 0) return `${name}: ${title.trim().slice(0, 80)}`;
  return name;
}
