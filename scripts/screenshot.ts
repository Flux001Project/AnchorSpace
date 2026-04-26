/**
 * Headless screenshot harness for AnchorSpace.
 *
 * Usage:
 *   tsx scripts/screenshot.ts            # captures all phase-2 stills
 *   tsx scripts/screenshot.ts --keep-alive  # leaves the dev server running
 *
 * Prereqs:
 *   - Vite dev server reachable at http://127.0.0.1:5173 (npm run dev)
 *   - The OpenClaw gateway is running on ws://127.0.0.1:18789 if you want
 *     real `phase2-flux-typing` / `phase2-flux-reading` shots driven by a
 *     real agent action.
 *
 * The script can ALSO drive the room through a __mockRunInjector__ exposed
 * on the window for the screenshot session — useful for the `phase2-with-
 * subagent` capture if no live agent run is producing one. The injector is
 * only attached when ?mock=1 is in the URL, so production builds remain
 * unaffected.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEV_URL = process.env.ANCHORSPACE_DEV_URL ?? "http://127.0.0.1:5173/";
const OUT_DIR = join(process.cwd(), "screenshots");

interface Shot {
  name: string;
  /** Optional: do something on the page before capture (inject events etc). */
  prep?: (page: Page) => Promise<void>;
  /** Wait a beat after prep so animations settle. */
  settleMs?: number;
}

const SHOTS: Shot[] = [
  {
    name: "phase2-empty-room",
    settleMs: 1200, // let the bob settle into a frame near top of cycle
  },
  {
    name: "phase2-flux-typing",
    settleMs: 600,
    prep: async (page) => {
      await page.evaluate(() => {
        const w = window as unknown as {
          __anchorspaceTestInject?: (kind: "typing" | "reading" | "subagent" | "clear") => void;
        };
        w.__anchorspaceTestInject?.("typing");
      });
    },
  },
  {
    name: "phase2-flux-reading",
    settleMs: 600,
    prep: async (page) => {
      await page.evaluate(() => {
        const w = window as unknown as {
          __anchorspaceTestInject?: (kind: "typing" | "reading" | "subagent" | "clear") => void;
        };
        w.__anchorspaceTestInject?.("clear");
        w.__anchorspaceTestInject?.("reading");
      });
    },
  },
  {
    name: "phase2-with-subagent",
    settleMs: 4500, // let sub-agent walk in from off-stage (~3.6s travel + buffer)
    prep: async (page) => {
      await page.evaluate(() => {
        const w = window as unknown as {
          __anchorspaceTestInject?: (kind: "typing" | "reading" | "subagent" | "clear") => void;
        };
        w.__anchorspaceTestInject?.("clear");
        w.__anchorspaceTestInject?.("typing");
        w.__anchorspaceTestInject?.("subagent");
      });
    },
  },
];

async function shoot(browser: Browser, shot: Shot) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  // ?mock=1 enables the test injector (see src/room/Room.tsx).
  const target = `${DEV_URL}?mock=1`;
  await page.goto(target, { waitUntil: "networkidle0" });

  // Wait for the canvas to mount.
  await page.waitForSelector('[data-testid="anchor-canvas"]', { timeout: 10_000 });

  if (shot.prep) await shot.prep(page);
  await new Promise((r) => setTimeout(r, shot.settleMs ?? 600));

  const out = join(OUT_DIR, `${shot.name}.png`);
  const canvas = await page.$('[data-testid="anchor-canvas"]');
  if (!canvas) throw new Error("canvas not found");
  await canvas.screenshot({ path: out as `${string}.png`, type: "png" });
  console.log(`✓ ${shot.name} → ${out}`);
  await page.close();
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

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
