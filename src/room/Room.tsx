/**
 * Room — canvas surface, game loop, and character controller.
 *
 * Responsibilities:
 *   - Resolve the current store snapshot (proxy status + AgentRuns) into a
 *     desired character set: Flux always exists; each (runId, sessionKey)
 *     in AgentRuns becomes a sub-agent character (spawn order = first-seen).
 *   - Manage spawn/despawn: walk new sub-agents in from off-stage, walk
 *     finished sub-agents off when their run ends.
 *   - Drive the game loop at requestAnimationFrame, target 60fps.
 */

import { useEffect, useRef } from "react";
import { useRoomStore } from "../store/roomStore";
import type { AgentRunState } from "../lib/AgentStateParser";
import { Character, type CharacterState, FLUX_COLOR } from "./Character";
import {
  ANCHOR_DESK,
  SECONDARY_DESKS,
  OFFSTAGE_LEFT,
  OFFSTAGE_RIGHT,
  STAGE_W,
  STAGE_H,
  drawScene,
} from "./scene";
import { palette, subagentColor } from "./palette";

// ── Tool name → speech bubble copy ───────────────────────────────────────────

const TRUNC = 30;
const truncate = (s: string, n = TRUNC): string =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

/**
 * Build the bubble text for a run state, per the brief:
 *   - waiting → "..."
 *   - typing  → tool name + truncated meta (~30 chars total)
 *   - reading → tool name + truncated path/URL
 *   - assistant-only stream (no tool open) → no bubble
 *   - unknown tool name → tool name as-is (per amendment #3)
 */
function bubbleFor(run: AgentRunState | undefined, character: "flux" | "subagent"): string | undefined {
  if (!run) return character === "flux" ? undefined : undefined;
  const top = run.openTools[run.openTools.length - 1];
  if (top) {
    const meta = top.title ?? top.progressText ?? "";
    if (meta) {
      const head = `${top.name}: `;
      const remain = TRUNC - head.length;
      return head + truncate(meta, Math.max(8, remain));
    }
    return truncate(top.name, TRUNC);
  }
  if (run.activity === "typing" && run.assistantText) {
    // Assistant-only stream: brief says no bubble. Return undefined.
    return undefined;
  }
  return undefined;
}

/** Activity → desired character state (Phase 2 visual layer). */
function stateFor(run: AgentRunState | undefined): CharacterState {
  if (!run) return "idle";
  if (run.endedAt !== undefined) return "idle";
  const top = run.openTools[run.openTools.length - 1];
  if (top) {
    switch (top.activity) {
      case "running":
      case "managing":
        return "typing";
      case "reading":
      case "searching":
        return "reading";
      case "writing":
        return "typing";
      case "imagining":
        return "waiting";
      default:
        return "typing";
    }
  }
  // No tool open. Activity may still be assistant streaming.
  if (run.activity === "typing") return "idle"; // gentle bob during LLM thinking
  return "idle";
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Room() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const start = useRoomStore((s) => s.start);
  const stop = useRoomStore((s) => s.stop);

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

    // Resolve devicePixelRatio for crisp rendering on retina.
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = STAGE_W * dpr;
    canvas.height = STAGE_H * dpr;
    canvas.style.width = `${STAGE_W}px`;
    canvas.style.height = `${STAGE_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Character controller state (lives across frames) ────────────────────
    const flux = new Character({
      id: "flux",
      label: "Flux",
      color: FLUX_COLOR,
      spawnPos: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
      homePos: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
    });

    /** Sub-agent registry, keyed by runState.key (`runId::sessionKey`). */
    const subagents = new Map<string, { char: Character; deskIdx: number; spawnOrder: number }>();
    let spawnCounter = 0;

    let rafId = 0;
    let lastTs = performance.now();

    function frame(now: number) {
      const dt = Math.min(64, now - lastTs); // clamp to 64ms (~15fps floor)
      lastTs = now;

      const snap = useRoomStore.getState();
      const runs = snap.runs;

      // Choose Flux's run = main session run (newest live by startedAt). If
      // none live, Flux is idle.
      let fluxRun: AgentRunState | undefined;
      const runArr = [...runs.values()];
      // Use the most-recent live run as Flux's "active" run for now. (Phase 4
      // will assign per session, but the brief says Flux is the anchor.)
      const live = runArr.filter((r) => r.endedAt === undefined);
      if (live.length > 0) {
        fluxRun = live.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
      }

      // Spawn sub-agents for *additional* live runs beyond Flux's.
      for (const run of live) {
        if (run === fluxRun) continue;
        if (!subagents.has(run.key)) {
          const deskIdx = subagents.size % SECONDARY_DESKS.length;
          const desk = SECONDARY_DESKS[deskIdx];
          const order = spawnCounter++;
          const ch = new Character({
            id: run.key,
            label: shortLabel(run),
            color: subagentColor(order),
            spawnPos: { ...OFFSTAGE_LEFT },
            homePos: { x: desk.characterX, y: desk.characterY },
          });
          subagents.set(run.key, { char: ch, deskIdx, spawnOrder: order });
        }
      }

      // Tick Flux.
      flux.tick(
        {
          desiredState: stateFor(fluxRun),
          desiredTarget: { x: ANCHOR_DESK.characterX, y: ANCHOR_DESK.characterY },
          bubbleText: bubbleFor(fluxRun, "flux"),
        },
        dt
      );

      // Tick sub-agents. If their run ended (or vanished), walk off & despawn.
      for (const [key, slot] of [...subagents.entries()]) {
        const run = runs.get(key);
        const desk = SECONDARY_DESKS[slot.deskIdx];
        const ended = !run || run.endedAt !== undefined;
        slot.char.tick(
          {
            desiredState: stateFor(run),
            desiredTarget: { x: desk.characterX, y: desk.characterY },
            bubbleText: bubbleFor(run, "subagent"),
            despawning: ended,
            offstagePos: OFFSTAGE_RIGHT,
          },
          dt
        );
        if (slot.char.done) subagents.delete(key);
      }

      // ── Draw ──────────────────────────────────────────────────────────────
      const occupiedSecondary = SECONDARY_DESKS.map((_, i) =>
        [...subagents.values()].some((s) => s.deskIdx === i && !s.char.done)
      );
      const ledColor = snap.proxy.connected ? "#50C878" : palette.monitorGlow;

      drawScene(ctx, { anchor: true, secondary: occupiedSecondary }, ledColor, now);

      // Sort by Y so back rows render first.
      const drawables: Character[] = [flux, ...[...subagents.values()].map((s) => s.char)];
      drawables.sort((a, b) => a.pos.y - b.pos.y);
      for (const c of drawables) c.draw(ctx, now);

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      style={{
        background: palette.wall,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          maxWidth: "100%",
          maxHeight: "100vh",
          imageRendering: "auto",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
        data-testid="anchor-canvas"
      />
    </div>
  );
}

function shortLabel(run: AgentRunState): string {
  // Best-effort: use last segment of sessionKey, truncate.
  const seg = run.sessionKey.split(":").pop() ?? run.runId.slice(0, 6);
  return seg.length > 14 ? seg.slice(0, 13) + "…" : seg;
}
