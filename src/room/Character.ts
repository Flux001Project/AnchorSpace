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

/**
 * Idle micro-behaviors (T-16). Picked at random by the controller every
 * 30–60s when the character is in `state: "idle"`.
 */
export type IdleBehavior =
  | "none"
  | "look-window"   // head turns right toward window
  | "look-shelf"    // head turns left toward bookshelf
  | "stretch"       // body briefly elongates 4px
  | "sip-mug"       // head dips toward mug for 2s
  | "lean-back"     // body shifts down-back 3px
  | "look-flux";    // sub-agent only — head turns toward Flux

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
  /** Idle micro-behavior (only honored when desiredState === "idle"). */
  idleBehavior?: IdleBehavior;
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
  idleBehavior: IdleBehavior = "none";
  /** Set once the off-stage walk completes; renderer drops the char next tick. */
  done = false;

  // Animation timers.
  private spawnedAt = performance.now();
  private stateChangedAt = performance.now();
  private idleBehaviorChangedAt = performance.now();
  private prevIdleBehavior: IdleBehavior = "none";

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

    // Idle behavior tracking — only valid when state is "idle".
    const next = input.desiredState === "idle" ? (input.idleBehavior ?? "none") : "none";
    if (next !== this.prevIdleBehavior) {
      this.prevIdleBehavior = next;
      this.idleBehavior = next;
      this.idleBehaviorChangedAt = performance.now();
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
    let headOffsetX = 0;
    let headOffsetY = 0;
    let bodyStretch = 0;
    let stepBob = 0;

    switch (this.state) {
      case "idle": {
        // Slow sine bob, 2px amplitude.
        yOffset = Math.sin(tMs * 0.0025) * 2;
        // Layer the idle micro-behavior on top.
        const idle = applyIdleBehavior(this.idleBehavior, tMs - this.idleBehaviorChangedAt);
        headOffsetX = idle.headOffsetX;
        headOffsetY = idle.headOffsetY;
        bodyStretch = idle.bodyStretch;
        headTilt += idle.headTilt;
        xOffset += idle.xOffset;
        yOffset += idle.yOffset;
        break;
      }
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
    const bodyHExtra = bodyStretch;

    // Body (rounded rect): 36 × 54 (+ stretch in idle).
    const bw = 36;
    const bh = 54 + bodyHExtra;
    drawRoundedRect(ctx, cx - bw / 2, baseY - bh, bw, bh, 10, this.color);

    // Subtle dark inner shading.
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    drawRoundedRectPath(ctx, cx - bw / 2 + 2, baseY - bh + 2, bw - 4, bh - 8, 8);
    ctx.fill();

    // Head — circle. Idle micro-behaviors can shift the head.
    const headR = 17;
    const headCx = cx + Math.sin(headTilt) * 6 + headOffsetX;
    const headCy = baseY - bh - headR + 6 + headOffsetY;
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

    // Speech bubble.
    if (this.bubble) {
      drawBubble(ctx, cx, headCy - headR - 6, this.bubble);
    }
  }

  /** Top-of-head Y in world coords — used by the label/timer overlay. */
  topY(): number {
    const bh = 54;
    const headR = 17;
    return this.pos.y - bh - headR * 2 + 6;
  }
}

// ── Idle behavior animation ─────────────────────────────────────────────────

interface IdleApplied {
  headOffsetX: number;
  headOffsetY: number;
  bodyStretch: number;
  headTilt: number;
  xOffset: number;
  yOffset: number;
}

function applyIdleBehavior(b: IdleBehavior, tMs: number): IdleApplied {
  const z: IdleApplied = { headOffsetX: 0, headOffsetY: 0, bodyStretch: 0, headTilt: 0, xOffset: 0, yOffset: 0 };
  // Brief: behaviors should last ~2–4s. We ease in/out so they don't snap.
  // tMs is ms since this idle behavior was assigned.
  switch (b) {
    case "none":
      return z;
    case "look-window": {
      // Head turns right for 4s, eased.
      const dur = 4000;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t); // 0 → 1 → 0
      return { ...z, headOffsetX: 7 * ease, headTilt: 0.1 * ease };
    }
    case "look-shelf": {
      const dur = 4000;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t);
      return { ...z, headOffsetX: -7 * ease, headTilt: -0.1 * ease };
    }
    case "stretch": {
      const dur = 1600;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t);
      return { ...z, bodyStretch: 4 * ease };
    }
    case "sip-mug": {
      const dur = 2000;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t);
      return { ...z, headOffsetX: -8 * ease, headOffsetY: 6 * ease };
    }
    case "lean-back": {
      const dur = 3000;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t);
      return { ...z, xOffset: -3 * ease, yOffset: 3 * ease };
    }
    case "look-flux": {
      // For sub-agents on the right side: head turns LEFT.
      const dur = 3000;
      const t = Math.min(1, tMs / dur);
      const ease = Math.sin(Math.PI * t);
      return { ...z, headOffsetX: -8 * ease, headTilt: -0.12 * ease };
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
