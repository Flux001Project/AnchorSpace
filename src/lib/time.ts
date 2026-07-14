/**
 * Time — canonical timezone helpers for AnchorSpace.
 *
 * The whole app treats one calendar day as the local day in Joey's tz. The
 * literal string is declared here, once, so no other file has to know it.
 *
 * Rules:
 *   • Anywhere you need "the local day containing this instant," import
 *     `startOfLocalDay` and pass an IANA tz string (defaults to LOCAL_TZ).
 *   • Never use `Date#getFullYear/getMonth/getDate/setHours` for
 *     day-boundary math — those follow the host process tz, which is
 *     Chicago on Joey's Mac mini but UTC in most CI runners.
 *   • For "now," prefer `nowMs()` so tests can inject a clock.
 */

/** Canonical local timezone for the app. */
export const LOCAL_TZ = "America/Chicago" as const;

/** Injectable clock for tests. Default is Date.now. */
let clock: () => number = () => Date.now();

/** Current epoch ms via the injectable clock. */
export function nowMs(): number {
  return clock();
}

/** Test-only: replace the clock. Pass null to restore the default. */
export function __setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/**
 * Epoch ms of local midnight for the calendar day containing `now`, in `tz`.
 *
 * Non-mutating. Independent of the host process tz — a Vitest run under
 * `TZ=UTC` returns the same value as one under `TZ=America/Chicago`.
 */
export function startOfLocalDay(now: number, tz: string = LOCAL_TZ): number {
  const parts = formatParts(now, tz);
  // First estimate: interpret the local Y-M-D 00:00 as if it were UTC.
  const utcMidnight = Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0);
  // Then measure the tz offset at that instant and correct.
  const offsetMs = tzOffsetMs(utcMidnight, tz);
  return utcMidnight - offsetMs;
}

// --- internals --------------------------------------------------------------

interface Parts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function formatParts(instant: number, tz: string): Parts {
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
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    // Intl emits "24" for hour "00" in some locales/hour12 configs — normalize.
    hh: get("hour") % 24,
    mm: get("minute"),
    ss: get("second"),
  };
}

/** Offset ms such that: local-time-in-tz = utc + offsetMs. Positive east-of-UTC. */
function tzOffsetMs(instant: number, tz: string): number {
  const p = formatParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - instant;
}
