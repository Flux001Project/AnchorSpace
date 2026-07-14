/**
 * Time helpers — contract tests. The key promise is tz-independence:
 * `startOfLocalDay(now, "America/Chicago")` returns the same instant
 * regardless of the process TZ (Chicago on Joey's box, UTC in CI).
 */

import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_TZ, __setClock, nowMs, startOfLocalDay } from "../time";

// 2026-07-13 21:30 CDT = 2026-07-14 02:30 UTC. In America/Chicago (CDT, UTC-5),
// the local day containing this instant is 2026-07-13, whose local midnight is
// 2026-07-13 00:00 CDT = 2026-07-13 05:00 UTC.
const LATE_NIGHT_CT = new Date("2026-07-14T02:30:00Z").getTime();
const EXPECTED_MIDNIGHT_CT = new Date("2026-07-13T05:00:00Z").getTime();

describe("startOfLocalDay(now, America/Chicago)", () => {
  it("returns 2026-07-13 05:00 UTC for a late-Chicago-evening instant", () => {
    expect(startOfLocalDay(LATE_NIGHT_CT, "America/Chicago")).toBe(EXPECTED_MIDNIGHT_CT);
  });

  it("defaults tz to LOCAL_TZ (America/Chicago)", () => {
    expect(LOCAL_TZ).toBe("America/Chicago");
    expect(startOfLocalDay(LATE_NIGHT_CT)).toBe(EXPECTED_MIDNIGHT_CT);
  });

  it("handles the DST spring-forward crossing (2026-03-08 02:00 CST→03:00 CDT)", () => {
    // 2026-03-08 12:00 CT — after spring-forward. Local midnight is 2026-03-08
    // 00:00 CST = 2026-03-08 06:00 UTC (CST is UTC-6 before the jump; the
    // midnight itself is on the CST side).
    const noonCT = new Date("2026-03-08T17:00:00Z").getTime(); // 12:00 CDT
    const expected = new Date("2026-03-08T06:00:00Z").getTime(); // 00:00 CST
    expect(startOfLocalDay(noonCT, "America/Chicago")).toBe(expected);
  });

  it("handles UTC as a sanity control", () => {
    // 2026-07-13 12:00 UTC → local midnight UTC = 2026-07-13 00:00 UTC.
    const noonUtc = new Date("2026-07-13T12:00:00Z").getTime();
    const expected = new Date("2026-07-13T00:00:00Z").getTime();
    expect(startOfLocalDay(noonUtc, "UTC")).toBe(expected);
  });

  it("is a pure function — repeated calls return the same value", () => {
    const a = startOfLocalDay(LATE_NIGHT_CT, "America/Chicago");
    const b = startOfLocalDay(LATE_NIGHT_CT, "America/Chicago");
    expect(a).toBe(b);
  });
});

describe("nowMs + __setClock", () => {
  afterEach(() => __setClock(null));

  it("returns the injected clock's value when set", () => {
    __setClock(() => 12345);
    expect(nowMs()).toBe(12345);
  });

  it("restores Date.now when cleared", () => {
    __setClock(() => 0);
    expect(nowMs()).toBe(0);
    __setClock(null);
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(50);
  });
});
