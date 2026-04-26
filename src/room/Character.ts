/**
 * Character — procedural sprite + animation state machine + walking.
 *
 * Sprite anatomy (v0.1, no external assets):
 *   - body: rounded rectangle, 36×54 (W×H), color = identity
 *   - head: circle, radius 17, sits on top of body
 *   - little eye dots when "reading" (cue for the head tilt)
 *   - total height ~88px from feet to top of head
 *
 * State → animation rules (verbatim from brief):
 *   - idle:    sine bob, 2px amplitude, slow
 *   - typing:  rapid horizontal micro-shake on body, 3px, fast
 *   - reading: slow head tilt left-right
 *   - waiting: speech bubble with "..."
 *   - walking: position lerps toward target, body bobs with step rhythm
 *
 * Speech bubble:
 *   - waiting → "..."
 *   - typing  → tool name + truncated meta, e.g. "exec: ls -la /Users…"
 *   - reading → tool name + truncated path/URL
 *   - assistant-only stream (no tool open) → no bubble (just gentle bob)
 *
 * Walking is linear interpolation toward `target`. When the controller
 * sets `target = desk.characterPos`, the character walks there before
 * its work animation visually begins. Body bobs with step rhythm.
 */

import { palette } from "./palette";

export type CharacterState =
  | "idle"
  | "typing"
  | "reading"
  | "waiting"
  | "walking";

export interface CharacterInit {
  id: string;            // composite runId+sessionKey, or "flux"
  label: string;         // display name above head
  color: string;         // body fill
  spawnPos: { x: number; y: number };
  homePos: { x: number; y: number }; // desk position (where work happens)
}

export interface CharacterTickInput {
  desiredState: CharacterState;
  desiredTarget: { x: number; y: number };
  bubbleText?: string;
  /** True if the run has ended and this character should walk off-stage and despawn. */
  despawning?: boolean;
  offstagePos?: { x: number; y: number };
}

export class Character {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly homePos: { x: number; y: number };

  // Pose.
  pos: { x: number; y: number };
  target: { x: number; y: number };

  // State.
  state: CharacterState = "walking";
  bubble?: string;
  despawning = false;
  /** Set once the off-stage walk completes; renderer drops the char next tick. */
  done = false;

  // Animation timers.
  private spawnedAt = performance.now();
  private stateChangedAt = performance.now();

  constructor(init: CharacterInit) {
    this.id = init.id;
    this.label = init.label;
    this.color = init.color;
    this.homePos = init.homePos;
    this.pos = { ...init.spawnPos };
    this.target = { ...init.homePos };
  }

  /** Apply controller input. Walks toward target if not yet there. */
  tick(input: CharacterTickInput, dtMs: number) {
    this.despawning = !!input.despawning;
    if (this.despawning && input.offstagePos) {
      this.target = input.offstagePos;
    } else {
      this.target = input.desiredTarget;
    }

    // Lerp toward target. Speed: ~280 px/s.
    const speed = 280 / 1000;
    const dx = this.target.x - this.pos.x;
    const dy = this.target.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const step = Math.min(dist, speed * dtMs);
      this.pos.x += (dx / dist) * step;
      this.pos.y += (dy / dist) * step;
      this.setState("walking");
    } else {
      this.pos.x = this.target.x;
      this.pos.y = this.target.y;
      if (this.despawning) {
        this.done = true;
        return;
      }
      this.setState(input.desiredState);
    }

    this.bubble = input.bubbleText;
  }

  private setState(next: CharacterState) {
    if (this.state !== next) {
      this.state = next;
      this.stateChangedAt = performance.now();
    }
  }

  /** Draw at current pose. Caller is responsible for clearing/sorting. */
  draw(ctx: CanvasRenderingContext2D, tMs: number) {
    if (this.done) return;

    const stateMs = tMs - this.stateChangedAt;

    let xOffset = 0;
    let yOffset = 0;
    let headTilt = 0;
    let stepBob = 0;

    switch (this.state) {
      case "idle":
        // Slow sine bob, 2px amplitude.
        yOffset = Math.sin(tMs * 0.0025) * 2;
        break;
      case "typing":
        // Rapid horizontal micro-shake, 3px, fast.
        xOffset = Math.sin(tMs * 0.04) * 3;
        break;
      case "reading":
        // Slow head tilt left-right.
        headTilt = Math.sin(stateMs * 0.0025) * 0.18;
        break;
      case "waiting":
        // Idle bob with a tiny pause.
        yOffset = Math.sin(tMs * 0.002) * 1.5;
        break;
      case "walking": {
        // Step rhythm — body bob with horizontal phase.
        const lifeMs = tMs - this.spawnedAt;
        stepBob = Math.abs(Math.sin(lifeMs * 0.012)) * 3;
        break;
      }
    }

    const cx = this.pos.x + xOffset;
    const baseY = this.pos.y + yOffset - stepBob;

    // Body (rounded rect): 36 × 54
    const bw = 36, bh = 54;
    drawRoundedRect(ctx, cx - bw / 2, baseY - bh, bw, bh, 10, this.color);

    // Subtle dark inner shading.
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    drawRoundedRectPath(ctx, cx - bw / 2 + 2, baseY - bh + 2, bw - 4, bh - 8, 8);
    ctx.fill();

    // Head — circle.
    const headR = 17;
    const headCx = cx + Math.sin(headTilt) * 6;
    const headCy = baseY - bh - headR + 6;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(headCx, headCy, headR, 0, Math.PI * 2);
    ctx.fill();
    // Highlight.
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(headCx - 5, headCy - 5, 6, 0, Math.PI * 2);
    ctx.fill();

    // Tiny eye when "reading" so the head tilt has a focus.
    if (this.state === "reading") {
      ctx.fillStyle = "#0a0604";
      ctx.beginPath();
      ctx.arc(headCx - 4, headCy + 1, 1.6, 0, Math.PI * 2);
      ctx.arc(headCx + 4, headCy + 1, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Label under feet.
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(232, 213, 183, 0.7)";
    ctx.fillText(this.label, cx, baseY + 4);

    // Speech bubble.
    if (this.bubble) {
      drawBubble(ctx, cx, headCy - headR - 6, this.bubble);
    }
  }
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

function drawRoundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  drawRoundedRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Speech bubble — measured to fit text, with a 6px tail pointing to (cx, y).
 */
function drawBubble(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string) {
  ctx.save();
  ctx.font = "12px ui-monospace, SFMono-Regular, monospace";
  ctx.textBaseline = "alphabetic";
  const padX = 10, padY = 6;
  const m = ctx.measureText(text);
  const w = Math.max(40, m.width + padX * 2);
  const h = 22;
  const x = cx - w / 2;
  const top = y - h - 6;

  drawRoundedRectPath(ctx, x, top, w, h, 8);
  ctx.fillStyle = "rgba(232, 213, 183, 0.96)";
  ctx.fill();
  ctx.strokeStyle = "rgba(139, 105, 20, 0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Tail.
  ctx.beginPath();
  ctx.moveTo(cx - 5, top + h - 1);
  ctx.lineTo(cx, y - 1);
  ctx.lineTo(cx + 5, top + h - 1);
  ctx.closePath();
  ctx.fillStyle = "rgba(232, 213, 183, 0.96)";
  ctx.fill();
  ctx.strokeStyle = "rgba(139, 105, 20, 0.7)";
  ctx.stroke();

  // Text.
  ctx.fillStyle = "#3D2314";
  ctx.textAlign = "center";
  ctx.fillText(text, cx, top + h - padY - 1);

  ctx.restore();
}

// re-export for the controller.
export const FLUX_COLOR = palette.flux;
