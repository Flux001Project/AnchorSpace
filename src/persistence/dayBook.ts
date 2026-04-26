/**
 * Day book — localStorage-backed rolling window of PersistedRun records.
 *
 * Foundation of Phase 4. The activity-log notebook (`src/log/activityLog.ts`)
 * stays as a separate store with its own lifecycle.
 *
 * Principle 1 fence: PersistedRun is a record of what happened. Do not
 * introduce action-shaped fields (dismissed, acknowledged, priority, …)
 * here. The day book is observational only.
 */

export interface PersistedRunEvent {
  /** Epoch ms. */
  t: number;
  /** Tool name or activity tag. */
  type: string;
  /** Short human-readable summary. */
  summary: string;
}

export interface PersistedRun {
  /** Composite key: `${runId}::${sessionKey}`. Unique. */
  key: string;
  runId: string;
  sessionKey: string;
  /** Stable display name e.g. "Flux", "Sub-1". */
  agentId: string;
  /** Free-text session label. */
  sessionLabel: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. null while live. */
  endedAt: number | null;
  /** Total tool calls observed during this run. */
  toolCallCount: number;
  /** Accumulated idle ms. */
  idleMs: number;
  /** Accumulated working ms. */
  workingMs: number;
  /** Last N events, oldest dropped (FIFO) past RECENT_EVENTS_PER_RUN. */
  recentEvents: PersistedRunEvent[];
}

export interface DayBookStore {
  /** Sorted by startedAt DESC (newest first). */
  runs: PersistedRun[];
  version: number;
}

/** Schema version. Bump when PersistedRun shape changes. */
export const DAYBOOK_VERSION = 1 as const;

/** Rolling-window cap. Oldest entries evict beyond this. */
export const MAX_RUNS = 5000 as const;

/** Per-run cap on `recentEvents` array length. */
export const RECENT_EVENTS_PER_RUN = 20 as const;

/** localStorage key. */
export const DAYBOOK_STORAGE_KEY = "anchorspace.dayBook.v1" as const;

/** Read store from localStorage. Returns empty store on miss/parse error. */
export function loadDayBook(): DayBookStore {
  if (typeof window === "undefined") {
    return { runs: [], version: DAYBOOK_VERSION };
  }
  try {
    const raw = window.localStorage.getItem(DAYBOOK_STORAGE_KEY);
    if (!raw) return { runs: [], version: DAYBOOK_VERSION };
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { runs?: unknown }).runs)
    ) {
      return { runs: [], version: DAYBOOK_VERSION };
    }
    const obj = parsed as { runs: unknown[]; version?: unknown };
    return {
      runs: obj.runs.filter(isPersistedRun),
      version: typeof obj.version === "number" ? obj.version : DAYBOOK_VERSION,
    };
  } catch {
    return { runs: [], version: DAYBOOK_VERSION };
  }
}

/** Persist store to localStorage. Silently no-ops when window is undefined. */
export function saveDayBook(store: DayBookStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DAYBOOK_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be full or disabled; nothing actionable here.
  }
}

/**
 * Insert or replace a run by `key`. Maintains startedAt-DESC sort.
 * Enforces MAX_RUNS rolling window: if exceeded, evicts the oldest
 * (smallest startedAt) entries until size ≤ MAX_RUNS.
 * Returns a NEW store — does not mutate the input.
 */
export function upsertRun(store: DayBookStore, run: PersistedRun): DayBookStore {
  const filtered = store.runs.filter((r) => r.key !== run.key);
  filtered.push(run);
  filtered.sort((a, b) => b.startedAt - a.startedAt);
  if (filtered.length > MAX_RUNS) {
    filtered.length = MAX_RUNS;
  }
  return { runs: filtered, version: store.version };
}

/**
 * Append an event to a run's `recentEvents`. Caps length at RECENT_EVENTS_PER_RUN
 * by dropping the OLDEST event (FIFO). If the run does not exist in the store,
 * returns the store unchanged. Does NOT mutate the input — returns a new store.
 */
export function appendEvent(
  store: DayBookStore,
  key: string,
  event: PersistedRunEvent
): DayBookStore {
  const idx = store.runs.findIndex((r) => r.key === key);
  if (idx === -1) return store;
  const next = [...store.runs];
  const target = next[idx];
  const newEvents = [...target.recentEvents, event];
  if (newEvents.length > RECENT_EVENTS_PER_RUN) {
    newEvents.splice(0, newEvents.length - RECENT_EVENTS_PER_RUN);
  }
  next[idx] = { ...target, recentEvents: newEvents };
  return { runs: next, version: store.version };
}

/**
 * Filter to runs whose startedAt falls within [dayStart, dayStart + 24h).
 * Returns runs sorted startedAt-DESC.
 */
export function runsForDay(store: DayBookStore, dayStart: number): PersistedRun[] {
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return store.runs
    .filter((r) => r.startedAt >= dayStart && r.startedAt < dayEnd)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Floor `now` (epoch ms) to local-tz midnight of that same day. */
export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Reset the store to empty. */
export function clearDayBook(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DAYBOOK_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Internal validators ──────────────────────────────────────────────────────

function isPersistedRun(v: unknown): v is PersistedRun {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    typeof o.runId === "string" &&
    typeof o.sessionKey === "string" &&
    typeof o.agentId === "string" &&
    typeof o.sessionLabel === "string" &&
    typeof o.startedAt === "number" &&
    (o.endedAt === null || typeof o.endedAt === "number") &&
    typeof o.toolCallCount === "number" &&
    typeof o.idleMs === "number" &&
    typeof o.workingMs === "number" &&
    Array.isArray(o.recentEvents)
  );
}
