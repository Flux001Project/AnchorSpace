/**
 * Procedural background scene for AnchorSpace.
 *
 * Logical canvas: 1280 × 800 (16:10). All measurements use this base; the
 * component scales the canvas via CSS so the layout stays consistent.
 *
 * Top 60% (0..480) = back wall.
 * Bottom 40% (480..800) = floor.
 *
 * Layout decisions (flagged in the Phase 2 report — these are not in the
 * brief verbatim, so call them out for validation):
 *
 *   - Anchor desk: center-left, 380×100, x=160, y=520 (top of desk surface).
 *     Big enough to feel like a real workstation; not so big it crowds Flux.
 *   - Secondary desks: 4 slots along the right wall, 200×80 each, stacked
 *     in two rows of two. y rows: 510 and 640. Two per row at x=820, x=1060.
 *     Dimmer fill (#241509) when no character is parked there.
 *   - Bookshelf: left wall, 100×360, x=30, y=130. Five shelves with
 *     2–4 book rectangles per shelf in mixed accent/cream tones.
 *   - Window: right side back wall, 220×180, x=1010, y=110. ~24 stars
 *     at randomized but seeded positions so the night sky doesn't reflow
 *     on each frame.
 *   - Lamp: small base on left edge of anchor desk; cone-of-light radial
 *     gradient covers the desk + Flux's idle position.
 *   - LED: top-right corner, 14×14 with 24px glow.
 */

import { palette } from "./palette";

export const STAGE_W = 1280;
export const STAGE_H = 800;

// Anchor desk (Flux's workstation) — center-left.
export const ANCHOR_DESK = {
  x: 160,
  y: 520,
  w: 380,
  h: 100,
  // Where Flux stands: feet at this point, looking at the monitor.
  characterX: 350,
  characterY: 560,
};

// Secondary desks for sub-agents — right wall, two rows.
export const SECONDARY_DESKS = [
  { x: 820, y: 510, w: 200, h: 80, characterX: 920, characterY: 540 },
  { x: 1060, y: 510, w: 200, h: 80, characterX: 1160, characterY: 540 },
  { x: 820, y: 640, w: 200, h: 80, characterX: 920, characterY: 670 },
  { x: 1060, y: 640, w: 200, h: 80, characterX: 1160, characterY: 670 },
] as const;

// Off-stage spawn point for walk-on animation.
export const OFFSTAGE_LEFT = { x: -80, y: 600 };
export const OFFSTAGE_RIGHT = { x: STAGE_W + 80, y: 600 };

// LED indicator (top-right).
export const LED = { x: STAGE_W - 36, y: 28, r: 7 };

// Notebook on Flux's desk (T-15). Closed leather journal, gold accent.
// Position: front-right of the anchor desk so the player can see it without
// it being hidden by Flux's body.
export const NOTEBOOK = {
  x: ANCHOR_DESK.x + ANCHOR_DESK.w - 70,
  y: ANCHOR_DESK.y + 18,
  w: 44,
  h: 60,
};

// Window.
const WINDOW = { x: 1010, y: 110, w: 220, h: 180 };

// Bookshelf.
const BOOKSHELF = { x: 30, y: 130, w: 100, h: 360 };

// Deterministic star field — seeded once.
const STAR_FIELD: Array<{ x: number; y: number; r: number; alpha: number }> = (() => {
  // Mulberry32 — tiny seeded PRNG.
  let s = 0xc0ffee5;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const stars: Array<{ x: number; y: number; r: number; alpha: number }> = [];
  for (let i = 0; i < 26; i++) {
    stars.push({
      x: WINDOW.x + 14 + rand() * (WINDOW.w - 28),
      y: WINDOW.y + 12 + rand() * (WINDOW.h - 24),
      r: 0.8 + rand() * 1.4,
      alpha: 0.4 + rand() * 0.6,
    });
  }
  return stars;
})();

// Bookshelf books — also seeded so they don't twitch each frame.
const BOOK_STRIPS: Array<{ shelfY: number; books: Array<{ w: number; color: string; tilt: number }> }> = (() => {
  let s = 0xb00b1e5;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const colors = ["#8B6914", "#E8D5B7", "#5B3F1A", "#A87937", "#3D2314", "#C9A063"];
  const shelves = 5;
  const result: Array<{ shelfY: number; books: Array<{ w: number; color: string; tilt: number }> }> = [];
  const shelfH = BOOKSHELF.h / shelves;
  for (let i = 0; i < shelves; i++) {
    const books: Array<{ w: number; color: string; tilt: number }> = [];
    let totalW = 0;
    while (totalW < BOOKSHELF.w - 14) {
      const w = 8 + Math.floor(rand() * 9);
      if (totalW + w > BOOKSHELF.w - 8) break;
      books.push({
        w,
        color: colors[Math.floor(rand() * colors.length)],
        tilt: rand() < 0.15 ? -6 + rand() * 12 : 0, // a few books leaning
      });
      totalW += w + 1;
    }
    result.push({ shelfY: BOOKSHELF.y + i * shelfH, books });
  }
  return result;
})();

// ── Drawing routines ─────────────────────────────────────────────────────────

export interface SceneState {
  occupied: { anchor: boolean; secondary: boolean[] };
  ledColor: string;
  tMs: number;
  /** True when at least one run is live; controls monitor + lamp intensity. */
  working: boolean;
  /** Number of activity-log entries (0–50); drives notebook thickness. */
  notebookEntryCount: number;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SceneState
) {
  const { occupied, ledColor, tMs, working, notebookEntryCount } = state;
  // Wall + floor.
  ctx.fillStyle = palette.wall;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H * 0.6);
  ctx.fillStyle = palette.floor;
  ctx.fillRect(0, STAGE_H * 0.6, STAGE_W, STAGE_H * 0.4);

  // Floor wood-grain — a few horizontal seams.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 1;
  for (let y = STAGE_H * 0.6 + 30; y < STAGE_H; y += 38) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(STAGE_W, y);
    ctx.stroke();
  }

  // Wall/floor seam shadow.
  const seam = ctx.createLinearGradient(0, STAGE_H * 0.6 - 20, 0, STAGE_H * 0.6 + 30);
  seam.addColorStop(0, "rgba(0,0,0,0)");
  seam.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = seam;
  ctx.fillRect(0, STAGE_H * 0.6 - 20, STAGE_W, 50);

  drawWindow(ctx, tMs);
  drawBookshelf(ctx);
  drawSecondaryDesks(ctx, occupied.secondary, working);
  drawAnchorDesk(ctx, working);
  drawNotebook(ctx, notebookEntryCount);
  drawLamp(ctx, working);
  drawAmbient(ctx, working);
  drawLed(ctx, ledColor, tMs);
}

function drawWindow(ctx: CanvasRenderingContext2D, tMs: number) {
  // Window frame.
  ctx.fillStyle = "#1f120c";
  ctx.fillRect(WINDOW.x - 6, WINDOW.y - 6, WINDOW.w + 12, WINDOW.h + 12);

  // Sky.
  ctx.fillStyle = palette.windowDark;
  ctx.fillRect(WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h);

  // Stars — twinkle slow.
  for (const s of STAR_FIELD) {
    const twinkle = 0.65 + 0.35 * Math.sin(tMs * 0.0015 + s.x);
    ctx.fillStyle = `rgba(74, 74, 138, ${(s.alpha * twinkle).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mullion (cross divider).
  ctx.strokeStyle = "#1f120c";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(WINDOW.x + WINDOW.w / 2, WINDOW.y);
  ctx.lineTo(WINDOW.x + WINDOW.w / 2, WINDOW.y + WINDOW.h);
  ctx.moveTo(WINDOW.x, WINDOW.y + WINDOW.h / 2);
  ctx.lineTo(WINDOW.x + WINDOW.w, WINDOW.y + WINDOW.h / 2);
  ctx.stroke();

  // Sill.
  ctx.fillStyle = palette.desk;
  ctx.fillRect(WINDOW.x - 10, WINDOW.y + WINDOW.h, WINDOW.w + 20, 8);
}

function drawBookshelf(ctx: CanvasRenderingContext2D) {
  // Frame.
  ctx.fillStyle = "#1f120c";
  ctx.fillRect(BOOKSHELF.x - 4, BOOKSHELF.y - 4, BOOKSHELF.w + 8, BOOKSHELF.h + 8);
  ctx.fillStyle = palette.desk;
  ctx.fillRect(BOOKSHELF.x, BOOKSHELF.y, BOOKSHELF.w, BOOKSHELF.h);

  const shelves = BOOK_STRIPS.length;
  const shelfH = BOOKSHELF.h / shelves;

  // Shelf horizontals.
  ctx.fillStyle = "#1f120c";
  for (let i = 1; i < shelves; i++) {
    ctx.fillRect(BOOKSHELF.x, BOOKSHELF.y + i * shelfH - 1, BOOKSHELF.w, 2);
  }

  // Books.
  for (const strip of BOOK_STRIPS) {
    let x = BOOKSHELF.x + 4;
    for (const book of strip.books) {
      const h = shelfH - 12;
      ctx.save();
      if (book.tilt) {
        ctx.translate(x + book.w / 2, strip.shelfY + shelfH - 6);
        ctx.rotate((book.tilt * Math.PI) / 180);
        ctx.fillStyle = book.color;
        ctx.fillRect(-book.w / 2, -h, book.w - 1, h);
      } else {
        ctx.fillStyle = book.color;
        ctx.fillRect(x, strip.shelfY + shelfH - h - 4, book.w - 1, h);
      }
      ctx.restore();
      x += book.w;
    }
  }
}

function drawAnchorDesk(ctx: CanvasRenderingContext2D, working: boolean) {
  // Desk.
  ctx.fillStyle = palette.desk;
  ctx.fillRect(ANCHOR_DESK.x, ANCHOR_DESK.y, ANCHOR_DESK.w, ANCHOR_DESK.h);
  // Desk shadow under top.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(ANCHOR_DESK.x, ANCHOR_DESK.y + ANCHOR_DESK.h - 4, ANCHOR_DESK.w, 4);
  // Legs.
  ctx.fillStyle = "#1f120c";
  ctx.fillRect(ANCHOR_DESK.x + 6, ANCHOR_DESK.y + ANCHOR_DESK.h, 8, STAGE_H - (ANCHOR_DESK.y + ANCHOR_DESK.h) - 6);
  ctx.fillRect(ANCHOR_DESK.x + ANCHOR_DESK.w - 14, ANCHOR_DESK.y + ANCHOR_DESK.h, 8, STAGE_H - (ANCHOR_DESK.y + ANCHOR_DESK.h) - 6);

  // Monitor — back of desk.
  const mon = { x: ANCHOR_DESK.x + 200, y: ANCHOR_DESK.y - 130, w: 160, h: 110 };
  // Stand.
  ctx.fillStyle = "#0a0604";
  ctx.fillRect(mon.x + mon.w / 2 - 6, mon.y + mon.h, 12, 18);
  ctx.fillRect(mon.x + mon.w / 2 - 30, mon.y + mon.h + 16, 60, 5);
  // Bezel.
  ctx.fillStyle = "#0a0604";
  ctx.fillRect(mon.x - 6, mon.y - 6, mon.w + 12, mon.h + 12);
  // Screen. Working = current dim amber gradient. Idle = ~30% brightness.
  const screen = ctx.createLinearGradient(mon.x, mon.y, mon.x, mon.y + mon.h);
  if (working) {
    screen.addColorStop(0, "#5a3a08");
    screen.addColorStop(1, "#241300");
  } else {
    screen.addColorStop(0, "#1d1304");
    screen.addColorStop(1, "#0c0700");
  }
  ctx.fillStyle = screen;
  ctx.fillRect(mon.x, mon.y, mon.w, mon.h);
  // Screen warm bloom (the spec said #F0A500 — full punch reads like fire on
  // raw geometry, so we render the bloom AROUND the monitor via the ambient
  // pass below, and keep the screen itself as a darker amber-tinted gradient
  // here). Flagged in the report.

  // Keyboard slab on desk.
  ctx.fillStyle = "#0a0604";
  ctx.fillRect(ANCHOR_DESK.x + 110, ANCHOR_DESK.y + 18, 180, 14);
  // Mug.
  ctx.fillStyle = palette.textChrome;
  ctx.fillRect(ANCHOR_DESK.x + 60, ANCHOR_DESK.y + 8, 22, 30);
  ctx.beginPath();
  ctx.ellipse(ANCHOR_DESK.x + 71, ANCHOR_DESK.y + 8, 11, 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#3a2a08";
  ctx.fill();
}

function drawSecondaryDesks(ctx: CanvasRenderingContext2D, occupied: boolean[], working: boolean) {
  // `working` drives the anchor monitor; sub-agent monitors only glow when
  // their slot is occupied (already handled below).
  void working;
  for (let i = 0; i < SECONDARY_DESKS.length; i++) {
    const d = SECONDARY_DESKS[i];
    const isOccupied = occupied[i];
    ctx.fillStyle = isOccupied ? palette.desk : "#241509";
    ctx.fillRect(d.x, d.y, d.w, d.h);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(d.x, d.y + d.h - 3, d.w, 3);
    // Mini monitor.
    const mw = 60, mh = 42;
    const mx = d.x + d.w / 2 - mw / 2;
    const my = d.y - mh - 4;
    ctx.fillStyle = "#0a0604";
    ctx.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
    if (isOccupied) {
      const g = ctx.createLinearGradient(mx, my, mx, my + mh);
      g.addColorStop(0, "#5a3a08");
      g.addColorStop(1, "#1a0d00");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = "#181012";
    }
    ctx.fillRect(mx, my, mw, mh);
  }
}

function drawLamp(ctx: CanvasRenderingContext2D, working: boolean) {
  // Cone radius shrinks ~20% when idle.
  const radiusScale = working ? 1 : 0.8;
  const innerR = 18 * radiusScale;
  const outerR = 280 * radiusScale;
  // Small lamp base on left edge of anchor desk.
  const base = { x: ANCHOR_DESK.x + 26, y: ANCHOR_DESK.y - 4 };
  ctx.fillStyle = "#1a100a";
  ctx.fillRect(base.x - 8, base.y - 6, 16, 8);
  // Stem.
  ctx.fillStyle = palette.accent;
  ctx.fillRect(base.x - 1, base.y - 36, 2, 32);
  // Shade — small triangle.
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.moveTo(base.x - 14, base.y - 36);
  ctx.lineTo(base.x + 14, base.y - 36);
  ctx.lineTo(base.x + 8, base.y - 56);
  ctx.lineTo(base.x - 8, base.y - 56);
  ctx.closePath();
  ctx.fill();

  // Cone of warm light from the shade — radial gradient.
  const grad = ctx.createRadialGradient(base.x, base.y - 30, innerR, base.x, base.y - 30, outerR);
  const coreAlpha = working ? 0.55 : 0.45;
  const midAlpha = working ? 0.18 : 0.13;
  grad.addColorStop(0, `rgba(255, 184, 119, ${coreAlpha})`);
  grad.addColorStop(0.4, `rgba(255, 107, 53, ${midAlpha})`);
  grad.addColorStop(1, "rgba(255, 107, 53, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grad;
  ctx.fillRect(base.x - outerR, base.y - outerR, outerR * 2, outerR * 2);
  ctx.restore();
}

function drawAmbient(ctx: CanvasRenderingContext2D, working: boolean) {
  // Brief: ambient #FF6B35 at 15% opacity. Apply as a soft full-room wash
  // biased toward the lamp side so the right wall stays moodier. Slightly
  // dimmed when idle.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const wash = ctx.createRadialGradient(STAGE_W * 0.32, STAGE_H * 0.55, 80, STAGE_W * 0.32, STAGE_H * 0.55, 760);
  const coreAlpha = working ? 0.15 : 0.11;
  const midAlpha = working ? 0.08 : 0.06;
  wash.addColorStop(0, `rgba(255, 107, 53, ${coreAlpha})`);
  wash.addColorStop(0.6, `rgba(255, 107, 53, ${midAlpha})`);
  wash.addColorStop(1, "rgba(255, 107, 53, 0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  ctx.restore();
}

/**
 * Notebook on the desk. Thickness grows with entry count: 0–4 entries = 1
 * level (the closed cover), 5–9 = 2 levels, ..., capped at 10 levels (50
 * entries). Each "level" adds a 2px right-edge stripe so it reads as page
 * count.
 */
function drawNotebook(ctx: CanvasRenderingContext2D, entryCount: number) {
  const { x, y, w, h } = NOTEBOOK;
  const thickness = Math.min(10, Math.floor(entryCount / 5) + 1);
  // Page stripes (right side, beneath the cover).
  ctx.fillStyle = "#d8c79a";
  for (let i = 0; i < thickness; i++) {
    const stripeX = x + w + i * 2 - 1;
    ctx.fillRect(stripeX, y + 4, 2, h - 8);
  }
  // Leather cover with a slight inner shadow.
  drawRoundedRectPath(ctx, x, y, w, h, 4);
  ctx.fillStyle = "#5b3f1a";
  ctx.fill();
  ctx.strokeStyle = "#1f120c";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Gold accent strip across spine.
  ctx.fillStyle = palette.accent;
  ctx.fillRect(x + 2, y + h * 0.3, 3, h * 0.4);
  // Small "A" embossed corner mark.
  ctx.fillStyle = palette.accent;
  ctx.font = "bold 10px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", x + w / 2, y + h / 2 + 1);
}

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

function drawLed(ctx: CanvasRenderingContext2D, color: string, tMs: number) {
  // Pulse only when amber (disconnected); steady when green.
  const pulse = color === palette.monitorGlow ? 1 : 0.6 + 0.4 * Math.sin(tMs * 0.005);
  ctx.save();
  // Glow.
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(LED.x, LED.y, 0, LED.x, LED.y, 22);
  glow.addColorStop(0, color);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.globalAlpha = 0.85 * pulse;
  ctx.beginPath();
  ctx.arc(LED.x, LED.y, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Dot.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(LED.x, LED.y, LED.r, 0, Math.PI * 2);
  ctx.fill();
}
