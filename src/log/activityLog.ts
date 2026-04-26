/**
 * Activity log — durable record of completed agent runs, surfaced via the
 * desk notebook overlay (T-15).
 *
 * Persistence: localStorage, key `anchorspace.activityLog.v1`. Cap 50
 * entries (oldest dropped). Survives page refresh. Browser-only — guarded
 * by a window check so SSR/Node script imports don't crash.
 *
 * Each entry is built from a finished run's snapshot at the moment its
 * lifecycle `phase: "end"` event fires. We keep:
 *   - agent: stable name ("Flux" / "Sub-1" / ...) and identity color
 *   - tool history: deduplicated tool names from openTools (last seen in run)
 *   - duration in ms
 *   - timestamp (run end ms-since-epoch)
 *   - one-line summary: prefer assistantText (cleaner), fall back to
 *     lastOutput, truncate to ~80 chars
 */

const STORAGE_KEY = "anchorspace.activityLog.v1";
const MAX_ENTRIES = 50;
const SUMMARY_MAX = 80;

export interface LogEntry {
  /** Run-derived stable id (`runId::sessionKey`). De-dup key. */
  id: string;
  /** Display name (e.g. "Flux", "Sub-3"). */
  agent: string;
  /** Identity color for the swatch chip. */
  agentColor: string;
  /** Distinct tool names used during the run, in first-seen order. */
  tools: string[];
  /** Duration in ms. */
  durationMs: number;
  /** Run end timestamp (ms-since-epoch). */
  endedAt: number;
  /** One-line summary (≤80 chars). */
  summary: string;
}

function safeRead(): LogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is LogEntry =>
      x && typeof x.id === "string" && typeof x.endedAt === "number"
    );
  } catch {
    return [];
  }
}

function safeWrite(entries: LogEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota / privacy mode — silent */
  }
}

export function loadEntries(): LogEntry[] {
  return safeRead();
}

/**
 * Append an entry. Drops oldest if over cap. Idempotent on `id` so we
 * don't double-log if a parser fires the lifecycle-end twice.
 */
export function appendEntry(entry: LogEntry): LogEntry[] {
  const existing = safeRead();
  if (existing.some((e) => e.id === entry.id)) return existing;
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  safeWrite(next);
  return next;
}

export function clearEntries() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Test-only seed helper for the screenshot harness. Replaces all entries.
 * Only callable from non-production code via the test injector.
 */
export function _seedForTests(entries: LogEntry[]) {
  safeWrite(entries.slice(0, MAX_ENTRIES));
}

export function summaryFromText(text: string | undefined, fallback?: string | undefined): string {
  const candidate = (text ?? fallback ?? "").trim().replace(/\s+/g, " ");
  if (!candidate) return "(no output)";
  return candidate.length <= SUMMARY_MAX ? candidate : candidate.slice(0, SUMMARY_MAX - 1) + "…";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
