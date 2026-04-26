# Phase 4 — Awareness Depth

**Status:** authorized 2026-04-26 15:00 CDT
**Predecessor:** Phase 3.1 shipped (`f58936a`)
**Sub-phases:** 4.0 → 4.1 → 4.2 → 4.3
**Brief source:** Joey handoff (TUI), preserved verbatim below.

---

## Purpose

AnchorSpace currently shows what's happening *now*. Phase 4 makes it show what
happened *across the day* — the load-bearing capability for the app's stated
purpose: a leadership/awareness instrument that catches wasted sessions.

The live room remains the ambient observation surface. A new opt-in panel —
the "day book" — becomes the analytical surface for reviewing what already
happened. Two surfaces, two mental modes: ambient awareness vs. deliberate
review. Conflating them dilutes both.

## Principle alignment

**Principle 1 (visibility, not action) — non-negotiable.** The day book *signals*; it does not *act*. Wasted-session detection produces a notebook annotation, not a "kill run" button. Cross-into-action features defer to a separate workstream.

**Principle 2/3 + task-shape screen.** Phase 4 has been pre-screened for delegation candidates. `dayBook.ts`, `aggregates.ts`, `concerning.ts` are greenfield isolated modules → genuine qwen3-coder:30b candidates. `runAggregator.ts` (touches existing parser snapshots) and visual judgment files stay with Flux.

---

## Sub-phase 4.0 — Run history substrate

The foundation. Nothing else in Phase 4 works without it.

### Scope
Persist every run beyond the current 50-entry activity log. A "run" = unique `runId + sessionKey`. Each run accumulates: start ts, end ts (or null), agent identity, session label, tool-call count, idle/working durations, rolling window of recent tool-event summaries.

### Substrate
localStorage with ~5000-entry rolling window. IndexedDB and gateway-disk persistence **explicitly deferred**.

### Data shape

```typescript
interface PersistedRun {
  runId: string;
  sessionKey: string;
  agentId: string;
  sessionLabel: string;
  startedAt: number;
  endedAt: number | null;
  toolCallCount: number;
  idleMs: number;
  workingMs: number;
  recentEvents: Array<{ t: number; type: string; summary: string }>;
}

interface DayBookStore {
  runs: PersistedRun[];   // sorted by startedAt desc
  version: number;
}
```

The current 50-entry activity-log notebook stays as-is — different lifecycle, different read pattern, **don't merge**.

### Files
- `src/persistence/dayBook.ts` — store, read/write, rolling window enforcement → **qwen candidate**
- `src/persistence/runAggregator.ts` — folds parser snapshots into `PersistedRun` → **Flux keeps**
- `src/persistence/__tests__/dayBook.test.ts` → qwen candidate alongside the impl
- `src/persistence/__tests__/runAggregator.test.ts` → Flux keeps

### Success criteria
- Run starts → entry appears in day book
- Run ends → endedAt populates
- Reload → today's runs persist
- Exceed 5000 entries → oldest evicted
- `npm run build` and `tsc --noEmit` clean, tests pass

---

## Sub-phase 4.1 — Day book panel (read-only)

### Scope
Panel opened by clicking a notebook icon on the room desk. Shows today's runs grouped by session, sorted by start time. Per-run: agent, session, duration, tool-call count, status. **No filtering, no editing, no actions.**

### UX shape
- Slides in from right, half-width desktop / full-width mobile
- Room stays visible behind a slight dim
- Esc closes; no other shortcuts in 4.1

### Files
- `src/dayBook/DayBookPanel.tsx` — top-level orchestration → **Flux keeps**
- `src/dayBook/RunRow.tsx` → **qwen candidate** (presentational, typed props)
- `src/dayBook/SessionGroup.tsx` → **qwen candidate**
- `src/render/notebookIcon.ts` — diegetic entry point → **Flux keeps** (visual judgment, room rendering)

### Success criteria
- Click notebook → panel opens
- Today's runs render with accurate counts/durations
- Active vs completed visually distinguished
- No interactive elements beyond close
- Mobile layout doesn't break room

---

## Sub-phase 4.2 — Aggregate day summary

### Scope
Summary band at the top of the day book panel: total runs today, total tool calls, idle/working ratio, agents active, "concerning sessions" count (defined in 4.3).

### Files
- `src/dayBook/DaySummary.tsx` — Flux keeps (layout)
- `src/dayBook/aggregates.ts` — pure functions over `PersistedRun[]` → **strongest qwen candidate in Phase 4**

### Success criteria
- Aggregates update when day book opens
- Numbers match hand-count on test fixture
- Renders cleanly above run list

---

## Sub-phase 4.3 — Wasted-session signals

### Scope
Heuristics for "concerning" sessions, surfaced as notebook-style annotations in the day book. **Concerning ≠ wasted.** Signal is a prompt for attention, not a verdict.

### Heuristics (v1, all config-driven thresholds)
- **Long idle** — `idleMs > 30 min` within a non-completed run
- **Tool churn** — `toolCallCount > 50` with no observable progress markers
- **Stuck** — working state for `> 2h` without state transitions
- **Empty** — completed run with `toolCallCount < 3` and `duration > 10 min`

### Surfacing
Each concerning run gets a small annotation in its day book row — diegetic language, not alarm UI. "sub-2 spent 2h here, no commits" reads as a notebook scribble.

### Explicit non-goals (Principle 1 enforcement)
- No "kill run" button
- No "reset agent" action
- No notification/toast/alert pattern
- No automated escalation
- User decides what to do; signal does not act

### Files
- `src/dayBook/concerning.ts` — heuristic functions, pure → **qwen candidate**
- `src/dayBook/concerningConfig.ts` — thresholds → trivial, either path
- `src/dayBook/RunAnnotation.tsx` — visual rendering → **Flux keeps**

### Success criteria
- Each heuristic triggers correctly on test fixture
- Thresholds config-driven, not hardcoded
- Annotations read observational, not alarming
- No false positives on quiet runs

---

## Out of scope for Phase 4

- Multi-day history / week view (defer until 5000-entry cap is felt)
- IndexedDB / gateway-disk persistence (defer until storage pressure)
- Filtering / search (defer until run count justifies)
- Export / share day book (defer until felt need)
- Chat panel / any interactive control surface (defer indefinitely; belongs in TUI/webchat/CLI workstream)
- Cost / token aggregation (Principle 1 borderline; revisit separately)
- Anything that *acts* on a run rather than describing it

## Phase 4 success criteria (overall)

- Open day book at end of day → see at a glance what agents did
- Wasted sessions get a notebook annotation; they don't hide
- Live room remains uncluttered; analytical surface is opt-in
- All four sub-phases ship with clean builds and tests
- **At least one successful qwen3-coder:30b delegation in Phase 4** — the task-shape screen earns its keep

## Phase 3.1 retrospective addendum (reflected in CONTEXT.md Principle 3)

> **Task-shape screen.** Before drafting a qwencoder prompt, ask whether the task requires localizing within existing code or producing mostly new code. Surgical edits inside existing files are Flux-keeps regardless of how mechanical they appear. Greenfield modules, new components in new files, and isolated pure functions are the genuine delegation candidates. The Phase 3.1 Bug 3 delegation failed not on prompt quality but on task shape — qwen produced a confident no-op (changed `fillText()` to itself) inside a 400-line render file. The screen runs **before** Principle 3's prompt-quality checklist.

## Pre-kickoff items (Joey requested)

1. ✅ Task-shape screen committed to Principle 3
2. ✅ StrictMode-flag scan — no further landmines beyond the testInjector instance already fixed in Phase 3.1
3. ⏳ drawLed pulse direction (amber pulses, green steady) — Flux gut-check says intent matches; Joey to confirm on next screenshot review
