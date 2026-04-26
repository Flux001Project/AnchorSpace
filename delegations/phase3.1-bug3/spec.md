# Delegation: Phase 3.1 Bug #3 — sub-agent name color
**Target model:** `qwen3-coder:30b` (alias: `code`)
**Date:** 2026-04-26
**Author:** Flux
**Verification:** built per Principle 3, see report after run

---

## Task

Modify the `drawAwarenessLabel` function in `src/room/Room.tsx` so the **name line** (top label above each character) renders in the character's identity color (`ch.color`) instead of the hardcoded cream `rgba(232, 213, 183, 0.92)`.

The **task line** and **timer line** (lower labels) MUST stay cream/timer-color exactly as they are. Only the name line changes.

## Exact file path

`/Users/invokeautomation/.openclaw/workspace/anchorspace/src/room/Room.tsx`

## Function signature (unchanged — modify body only)

```ts
function drawAwarenessLabel(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  run: AgentRunState | undefined,
  now: number
): void
```

## Current implementation (lines 402–436 of Room.tsx)

```ts
function drawAwarenessLabel(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  run: AgentRunState | undefined,
  now: number
) {
  const cx = ch.pos.x;
  const top = ch.topY();
  // Stack labels well above the speech bubble (~36px clearance).
  const baseY = top - 38;

  const live = run && run.endedAt === undefined;
  const taskLine = live ? taskLineFor(run) : undefined;
  const durationMs = live && run ? Math.max(0, now - run.startedAt) : 0;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Name.
  ctx.font = "bold 12px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = "rgba(232, 213, 183, 0.92)";
  ctx.fillText(ch.label, cx, baseY);

  if (live && taskLine) {
    // Task line.
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = "rgba(232, 213, 183, 0.7)";
    ctx.fillText(taskLine, cx, baseY + 14);
    // Timer.
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = timerColorFor(durationMs);
    ctx.fillText(formatDuration(durationMs), cx, baseY + 28);
  }

  ctx.restore();
}
```

## What `ch.color` is

`Character` has a public readonly field `color: string` set at construction. Values in this codebase:

- Flux: `"#F0A500"` (warm amber, from `palette.flux`)
- Sub-agents: cycle through `["#5B8CFF", "#FF6B9D", "#50C878", "#FF8C42"]` via `subagentColor(index)`

All are 6-digit hex, fully opaque, already saturated for legibility against the dim room background.

## Required change

In the `// Name.` block, change:

```ts
ctx.fillStyle = "rgba(232, 213, 183, 0.92)";
```

to:

```ts
ctx.fillStyle = ch.color;
```

That is the entire change. Do not modify anything else in the function. Do not modify anything else in the file.

## Worked examples

### Example 1 — Flux, idle (no live run)
- `ch.label = "Flux"`, `ch.color = "#F0A500"`, `run = undefined`
- Expected render: text "Flux" at `(cx, baseY)` in color `#F0A500`, bold 12px monospace.
- No task line, no timer.

### Example 2 — Flux, working
- `ch.label = "Flux"`, `ch.color = "#F0A500"`, live run with `taskLineFor(run) = "exec: ls -la"`, `durationMs = 4500`
- Expected:
  - "Flux" at `baseY` in `#F0A500`
  - "exec: ls -la" at `baseY + 14` in `rgba(232, 213, 183, 0.7)` (unchanged)
  - "0:04" at `baseY + 28` in `timerColorFor(4500)` (unchanged)

### Example 3 — Sub-agent index 0, working
- `ch.label = "agent-1"`, `ch.color = "#5B8CFF"`, live run with `taskLineFor(run) = "read: src/foo.ts"`, `durationMs = 12000`
- Expected:
  - "agent-1" at `baseY` in `#5B8CFF` (blue)
  - "read: src/foo.ts" at `baseY + 14` in cream (unchanged)
  - "0:12" at `baseY + 28` in `timerColorFor(12000)` (unchanged)

### Example 4 — Sub-agent index 2, idle
- `ch.label = "agent-3"`, `ch.color = "#50C878"` (green), `run = undefined`
- Expected: "agent-3" at `baseY` in `#50C878`. No second/third line.

### Example 5 — Sub-agent index 1, ended run (run.endedAt set)
- `ch.label = "agent-2"`, `ch.color = "#FF6B9D"`, `run.endedAt !== undefined`
- `live` is false → only the name renders.
- Expected: "agent-2" at `baseY` in `#FF6B9D`. No task, no timer.

## Negative constraints

- Do NOT change the font, position, alignment, or baseline of the name.
- Do NOT change the task line color (must remain `"rgba(232, 213, 183, 0.7)"`).
- Do NOT change the timer color (must remain `timerColorFor(durationMs)`).
- Do NOT add input validation, null checks beyond what already exists, or type guards.
- Do NOT add JSDoc, inline comments, or `console.log`.
- Do NOT add new imports.
- Do NOT extract helpers, refactor, or rename anything.
- Do NOT modify any other function in `Room.tsx`.
- Do NOT modify any other file.
- Do NOT add opacity/alpha to `ch.color` — render it as-is at full opacity.

## Build-success definition

Pass when, run from `/Users/invokeautomation/.openclaw/workspace/anchorspace`:

```
npm run build
npx tsc --noEmit
```

Both must exit 0.

Additionally, the diff vs `c814c8c` must be exactly one line changed (the `fillStyle` assignment for the name) inside `drawAwarenessLabel`. Any other diff is scope creep and will be stripped before commit.
