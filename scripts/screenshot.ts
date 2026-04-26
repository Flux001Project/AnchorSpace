/**
 * Headless screenshot harness for AnchorSpace.
 *
 * Usage:
 *   npm run screenshots                # captures phase 2 + phase 3 stills
 *
 * Prereqs:
 *   - Vite dev server reachable at http://127.0.0.1:5173 (npm run dev)
 *   - The OpenClaw gateway is running on ws://127.0.0.1:18789 if you want
 *     real `phase2-flux-typing` / `phase2-flux-reading` shots driven by a
 *     real agent action.
 *
 * Each shot opens with `?mock=1` to expose the deterministic injector and
 * the store getter on `window`. The injector pushes synthetic envelopes
 * into the parser; the React tree + canvas re-render against them.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEV_URL = process.env.ANCHORSPACE_DEV_URL ?? "http://127.0.0.1:5173/";
// `mock=isolated` skips the real WS so screenshots stay deterministic even
// while real agent activity is happening on the host.
const MOCK_FLAG = "mock=isolated";
const OUT_DIR = join(process.cwd(), "screenshots");

type InjectKind =
  | "typing"
  | "reading"
  | "subagent"
  | "long-typing"
  | "seed-log"
  | "notebook-open"
  | "clear";

interface Shot {
  name: string;
  /** Optional: do something on the page before capture (inject events etc). */
  prep?: (page: Page) => Promise<void>;
  /** Wait a beat after prep so animations settle. */
  settleMs?: number;
  /** If true, screenshot the entire page (for the notebook overlay). */
  fullPage?: boolean;
  /** Reset localStorage before this shot. */
  freshStorage?: boolean;
}

const inject = (page: Page, ...kinds: InjectKind[]) =>
  page.evaluate((kinds) => {
    const w = window as unknown as { __anchorspaceTestInject?: (k: string) => void };
    for (const k of kinds) w.__anchorspaceTestInject?.(k);
  }, kinds);

const SHOTS: Shot[] = [
  // ── Phase 2 reproductions (kept for regression check) ─────────────────────
  { name: "phase2-empty-room", settleMs: 1200, freshStorage: true },
  {
    name: "phase2-flux-typing",
    settleMs: 600,
    freshStorage: true,
    prep: (p) => inject(p, "typing"),
  },
  {
    name: "phase2-flux-reading",
    settleMs: 600,
    freshStorage: true,
    prep: (p) => inject(p, "clear", "reading"),
  },
  {
    name: "phase2-with-subagent",
    settleMs: 4500,
    freshStorage: true,
    prep: (p) => inject(p, "clear", "typing", "subagent"),
  },

  // ── Phase 3 awareness shots ───────────────────────────────────────────────
  // (a) Idle room: no live runs. Need to wait for a Flux idle behavior to fire.
  // We accelerate that by NOT injecting any runs; the room sits idle from boot.
  // We then settle ~3s so the lamp/monitor dim is obvious + a behavior may
  // visibly start (random — accept whatever lands).
  { name: "phase3-idle-room", settleMs: 3500, freshStorage: true },

  // (b) Active Flux with timer + task label visible.
  {
    name: "phase3-active-flux",
    settleMs: 700,
    freshStorage: true,
    prep: (p) => inject(p, "typing"),
  },

  // (c) Sub-agent labels — Flux + 1 sub-agent both with names + tasks.
  {
    name: "phase3-with-subagent-labels",
    settleMs: 4500,
    freshStorage: true,
    prep: (p) => inject(p, "clear", "typing", "subagent"),
  },

  // (d) Long-run warning amber timer.
  {
    name: "phase3-long-run-warning",
    settleMs: 700,
    freshStorage: true,
    prep: (p) => inject(p, "long-typing"),
  },

  // (e) Notebook overlay open with seeded entries.
  {
    name: "phase3-notebook-open",
    settleMs: 700,
    freshStorage: true,
    fullPage: true,
    prep: async (p) => {
      await inject(p, "seed-log");
      // Slight beat so the store re-emits, then open.
      await new Promise((r) => setTimeout(r, 200));
      await inject(p, "notebook-open");
    },
  },
];

async function shoot(browser: Browser, shot: Shot) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  if (shot.freshStorage) {
    // Open page first so localStorage exists, then clear, then reload.
    await page.goto(`${DEV_URL}?${MOCK_FLAG}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      try {
        localStorage.removeItem("anchorspace.activityLog.v1");
      } catch {
        /* ignore */
      }
    });
  }
  await page.goto(`${DEV_URL}?${MOCK_FLAG}`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="anchor-canvas"]', { timeout: 10_000 });

  if (shot.prep) await shot.prep(page);
  await new Promise((r) => setTimeout(r, shot.settleMs ?? 600));

  const out = join(OUT_DIR, `${shot.name}.png`);
  if (shot.fullPage) {
    await page.screenshot({ path: out as `${string}.png`, type: "png", fullPage: true });
  } else {
    const canvas = await page.$('[data-testid="anchor-canvas"]');
    if (!canvas) throw new Error("canvas not found");
    await canvas.screenshot({ path: out as `${string}.png`, type: "png" });
  }
  console.log(`✓ ${shot.name} → ${out}`);
  await page.close();
}

async function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    for (const shot of SHOTS) await shoot(browser, shot);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
