/**
 * Room — canvas surface, game loop, character controller, and the
 * Phase 3 awareness overlays (timers, labels, notebook).
 *
 * Phase 3 additions:
 *   - Working/idle flag from snapshot drives scene dimming.
 *   - Idle behavior scheduler — one micro-behavior per character every 30–60s.
 *   - Stable name + task labels above heads.
 *   - Live duration timer above each active character.
 *   - Notebook hit-test on canvas click; opens an overlay with log entries.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRoomStore } from "../store/roomStore";
import type { AgentRunState } from "../lib/AgentStateParser";
import { Character, type CharacterState, type IdleBehavior, FLUX_COLOR } from "./Character";
import {
  ANCHOR_DESK,
  SECONDARY_DESKS,
  OFFSTAGE_LEFT,
  OFFSTAGE_RIGHT,
  STAGE_W,
  STAGE_H,
  NOTEBOOK,
  drawScene,
  type SceneState,
} from "./scene";
import { palette, subagentColor } from "./palette";
import { formatDuration } from "../log/activityLog";
import NotebookOverlay from "./NotebookOverlay";

// ── Tool name → speech bubble copy ───────────────────────────────────────────

const BUBBLE_TRUNC = 30;
const TASK_TRUNC = 40;
const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

function bubbleFor(run: AgentRunState | undefined): string | undefined {
  if (!run) return undefined;
  const top = run.openTools[run.openTools.length - 1];
  if (top) {
    const meta = top.title ?? top.progressText ?? "";
    if (meta) {
      const head = `${top.name}: `;
      const remain = BUBBLE_TRUNC - head.length;
      return head + truncate(meta, Math.max(8, remain));
    }
    return truncate(top.name, BUBBLE_TRUNC);
  }
  return undefined;
}

/** First open tool's title, fallback to tool name. Truncated to ~40 chars. */
function taskLineFor(run: AgentRunState | undefined): string | undefined {
  if (!run) return undefined;
  const top = run.openTools[0];
  if (!top) {
    if (run.assistantText) return truncate(run.assistantText, TASK_TRUNC);
    return undefined;
  }
  const text = top.title ?? top.name;
  return truncate(text, TASK_TRUNC);
}

function stateFor(run: AgentRunState | undefined): CharacterState {
  if (!run) return "idle";
  if (run.endedAt !== undefined) return "idle";
  const top = run.openTools[run.openTools.length - 1];
  if (top) {
    switch (top.activity) {
      case "running":
      case "managing":
      case "writing":
        return "typing";
      case "reading":
      case "searching":
        return "reading";
      case "imagining":
        return "waiting";
      default:
        return "typing";
    }
  }
  return "idle";
}

/** Duration-color thresholds (T-17). Surfaced as a visual decision for review. */
function timerColorFor(durationMs: number): string {
  const min = durationMs / 60_000;
  if (min < 5) return palette.textChrome;       // cream
  if (min < 15) return palette.monitorGlow;     // amber
  return palette.ambient;                       // warning amber
}

// ── Idle behavior scheduler ──────────────────────────────────────────────────

const FLUX_BEHAVIORS: IdleBehavior[] = ["look-window", "look-shelf", "stretch", "sip-mug", "lean-back"];
const SUB_BEHAVIORS: IdleBehavior[] = ["look-flux"];

interface IdleSlot {
  behavior: IdleBehavior;
  endsAt: number;
  nextChangeAt: number;
}

function rollNextIdle(now: number, options: IdleBehavior[]): IdleSlot {
  // 30–60s gap until next behavior.
  const nextChange = now + (30_000 + Math.random() * 30_000);
  const beh = options[Math.floor(Math.random() * options.length)];
  // Behavior visible duration ~4s; the Character class eases internally.
  return { behavior: beh, endsAt: now + 4500, nextChangeAt: nextChange };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Room() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const start = useRoomStore((s) => s.start);
  const stop = useRoomStore((s) => s.stop);
  const notebookOpen = useRoomStore((s) => s.notebookOpen);
  const openNotebook = useRoomStore((s) => s.openNotebook);
  const closeNotebook = useRoomStore((s) => s.closeNotebook);

  // FPS counter (visible only when ?debug=1) — used to verify performance.
  const [fps, setFps] = useState<number | null>(null);
  const showDebug = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug"),
    []
  );

  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctxOrNull = canvas.getContext("2d");
    if (!ctxOrNull) return;
    const ctx: CanvasRenderingContext2D = ctxOrNull;

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = STAGE_W * dpr;
    canvas.height = STAGE_H * dpr;
    canvas.style.width = `${STAGE_W}px`;
    canvas.style.height = `${STAGE_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const flux = new Character({
      id: "flux",
      label: "Flux",
      color: FLUX_COLOR,
      spawnPos: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
      homePos: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
    });

    const subagents = new Map<string, { char: Character; deskIdx: number; spawnOrder: number }>();
    let spawnCounter = 0;

    // Idle scheduler state per character.
    const fluxIdle: IdleSlot = rollNextIdle(performance.now(), FLUX_BEHAVIORS);
    const subIdleSchedules = new Map<string, IdleSlot>();

    let rafId = 0;
    let lastTs = performance.now();

    // FPS tracking.
    let frameCount = 0;
    let fpsAccumMs = 0;

    function frame(now: number) {
      const dt = Math.min(64, now - lastTs);
      lastTs = now;
      frameCount += 1;
      fpsAccumMs += dt;
      if (fpsAccumMs >= 1000) {
        if (showDebug) setFps(Math.round((frameCount * 1000) / fpsAccumMs));
        frameCount = 0;
        fpsAccumMs = 0;
      }

      const snap = useRoomStore.getState();
      const runs = snap.runs;
      const names = snap.agentNames;
      const live = [...runs.values()].filter((r) => r.endedAt === undefined);

      // Choose Flux's run by name registry. Falls back to most-recent live.
      let fluxRun: AgentRunState | undefined;
      const fluxKey = [...names.entries()].find(([, n]) => n === "Flux")?.[0];
      if (fluxKey) fluxRun = runs.get(fluxKey);
      if (!fluxRun || fluxRun.endedAt !== undefined) {
        fluxRun = live
          .filter((r) => names.get(r.key) === "Flux")
          .sort((a, b) => b.startedAt - a.startedAt)[0];
      }

      // Spawn sub-agents for non-Flux live runs.
      for (const run of live) {
        if (names.get(run.key) === "Flux") continue;
        if (!subagents.has(run.key)) {
          const deskIdx = subagents.size % SECONDARY_DESKS.length;
          const desk = SECONDARY_DESKS[deskIdx];
          const order = spawnCounter++;
          const ch = new Character({
            id: run.key,
            label: names.get(run.key) ?? `Sub-${order + 1}`,
            color: subagentColor(order),
            spawnPos: { ...OFFSTAGE_LEFT },
            homePos: { x: desk.characterX, y: desk.characterY },
          });
          subagents.set(run.key, { char: ch, deskIdx, spawnOrder: order });
          subIdleSchedules.set(run.key, rollNextIdle(now, SUB_BEHAVIORS));
        }
      }

      // Idle scheduler for Flux.
      if (stateFor(fluxRun) === "idle") {
        if (now > fluxIdle.endsAt && now > fluxIdle.nextChangeAt) {
          const next = rollNextIdle(now, FLUX_BEHAVIORS);
          fluxIdle.behavior = next.behavior;
          fluxIdle.endsAt = next.endsAt;
          fluxIdle.nextChangeAt = next.nextChangeAt;
        } else if (now > fluxIdle.endsAt) {
          // Behavior over; we'll pick a new one after nextChangeAt.
          fluxIdle.behavior = "none";
        }
      } else {
        fluxIdle.behavior = "none";
      }

      // Tick Flux.
      flux.tick(
        {
          desiredState: stateFor(fluxRun),
          desiredTarget: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
          bubbleText: bubbleFor(fluxRun),
          idleBehavior: fluxIdle.behavior,
        },
        dt
      );

      // Tick sub-agents.
      for (const [key, slot] of [...subagents.entries()]) {
        const run = runs.get(key);
        const desk = SECONDARY_DESKS[slot.deskIdx];
        const ended = !run || run.endedAt !== undefined;
        const sched = subIdleSchedules.get(key);
        let beh: IdleBehavior = "none";
        if (sched && stateFor(run) === "idle") {
          if (now > sched.endsAt && now > sched.nextChangeAt) {
            const next = rollNextIdle(now, SUB_BEHAVIORS);
            sched.behavior = next.behavior;
            sched.endsAt = next.endsAt;
            sched.nextChangeAt = next.nextChangeAt;
            beh = sched.behavior;
          } else if (now <= sched.endsAt) {
            beh = sched.behavior;
          }
        }
        slot.char.tick(
          {
            desiredState: stateFor(run),
            desiredTarget: { x: desk.characterX, y: desk.characterY },
            bubbleText: bubbleFor(run),
            despawning: ended,
            offstagePos: OFFSTAGE_RIGHT,
            idleBehavior: beh,
          },
          dt
        );
        if (slot.char.done) {
          subagents.delete(key);
          subIdleSchedules.delete(key);
        }
      }

      // ── Draw scene ────────────────────────────────────────────────────────
      const occupiedSecondary = SECONDARY_DESKS.map((_, i) =>
        [...subagents.values()].some((s) => s.deskIdx === i && !s.char.done)
      );
      const ledColor = snap.proxy.connected ? "#50C878" : palette.monitorGlow;
      const working = live.length > 0;

      const sceneState: SceneState = {
        occupied: { anchor: true, secondary: occupiedSecondary },
        ledColor,
        tMs: now,
        working,
        notebookEntryCount: snap.logEntries.length,
      };
      drawScene(ctx, sceneState);

      // Sort by Y for depth order.
      const drawables: Array<{ char: Character; run?: AgentRunState }> = [
        { char: flux, run: fluxRun },
        ...[...subagents.entries()].map(([key, slot]) => ({ char: slot.char, run: runs.get(key) })),
      ];
      drawables.sort((a, b) => a.char.pos.y - b.char.pos.y);
      for (const d of drawables) d.char.draw(ctx, now);

      // Awareness overlays — name + task line + timer above each character.
      // `now` (rAF timestamp) is monotonic; run.startedAt is epoch ms. Pass
      // wall-clock so the timer math lands on real elapsed seconds.
      const wallNow = Date.now();
      for (const d of drawables) {
        if (d.char.done) continue;
        drawAwarenessLabel(ctx, d.char, d.run, wallNow);
      }

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [showDebug]);

  // Click handler — hit-test the notebook.
  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Convert client → CSS canvas coords → logical stage coords.
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const sx = (cssX / rect.width) * STAGE_W;
    const sy = (cssY / rect.height) * STAGE_H;
    if (
      sx >= NOTEBOOK.x - 6 &&
      sx <= NOTEBOOK.x + NOTEBOOK.w + 14 &&
      sy >= NOTEBOOK.y - 6 &&
      sy <= NOTEBOOK.y + NOTEBOOK.h + 6
    ) {
      openNotebook();
    }
  }

  // Escape key closes overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && notebookOpen) closeNotebook();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notebookOpen, closeNotebook]);

  return (
    <div
      ref={wrapperRef}
      style={{
        background: palette.wall,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        position: "relative",
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        style={{
          maxWidth: "100%",
          maxHeight: "100vh",
          imageRendering: "auto",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
          cursor: "default",
        }}
        data-testid="anchor-canvas"
      />
      {showDebug && fps !== null && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            color: "rgba(232,213,183,0.7)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            background: "rgba(0,0,0,0.4)",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          {fps} fps
        </div>
      )}
      <NotebookOverlay />
    </div>
  );
}

/**
 * Render the awareness label above a character: name (bold) + task line +
 * elapsed timer in duration-coded color. All rendered in the canvas, not
 * a DOM overlay, so it scales with the canvas.
 */
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
