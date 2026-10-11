// Screenshots and a short animated GIF of the site, for the README and the
// pull requests. Both need a network connection: the base maps come from
// their real servers.
//
// Two sources, written to two folders:
// - npm run captures: the local build, which must be served first (npm run
//   build, then npm run serve in another terminal), into docs/captures/build.
//   The data files are those of the test capture of 3 October 2026
//   (e2e/fixtures/complet), served in place of /data/, and the clock of the
//   page is set 20 minutes after that capture, so the pictures can be
//   compared from one change to the next.
// - npm run captures:demo: the deployed site, with its current data, as a
//   visitor sees it, into docs/captures/en-ligne (the pictures of the README).
//
// The GIF is assembled by sharp (libvips), already installed with wrangler's
// local engine: the timeline is moved step by step rather than played in real
// time, so every run gives the same sequence.
//
// Usage: node scripts/captures.mjs [--deployed] [output folder]

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";
import sharp from "sharp";

const LOCAL = "http://127.0.0.1:8787/";
// Same address as SITE_URL in .github/workflows/deploy.yml.
const DEPLOYED = "https://veille-feux-foret.hamonthibaud.workers.dev/";
const DATA = join(import.meta.dirname, "..", "e2e", "fixtures", "complet");
const NOW = new Date("2026-10-03T11:48:00Z");

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--deployed");
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(" ")} (only --deployed is accepted)`);
  process.exit(2);
}
const deployed = args.includes("--deployed");
const BASE = deployed ? DEPLOYED : LOCAL;
const OUT =
  args.find((arg) => !arg.startsWith("--")) ??
  join(import.meta.dirname, "..", "..", "docs", "captures", deployed ? "en-ligne" : "build");

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const SHOTS = [
  { name: "desktop-clair", device: DESKTOP, scheme: "light", hash: "" },
  { name: "desktop-foyer", device: DESKTOP, scheme: "light", hash: "#foyer=1" },
  {
    name: "desktop-sombre-surfaces",
    device: DESKTOP,
    scheme: "dark",
    hash: "#brule=1&carte=7.00/43.50000/2.50000",
  },
  { name: "desktop-osm", device: DESKTOP, scheme: "light", hash: "#fond=osm" },
  { name: "mobile-clair", device: devices["Pixel 7"], scheme: "light", hash: "" },
];

// The GIF: recorded at 1280 x 800, written 960 pixels wide.
const GIF_VIEWPORT = { width: 1280, height: 800 };
const GIF_WIDTH = 960;
// Hours between two pictures of the timeline (168 hours in all).
const GIF_TIMELINE_STEP = 8;

async function open(browser, device, scheme, hash) {
  const context = await browser.newContext({ ...device, colorScheme: scheme });
  const page = await context.newPage();
  if (!deployed) {
    await page.clock.setFixedTime(NOW);
    await page.route("**/data/*", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: readFileSync(join(DATA, name)),
        });
      } catch {
        await route.fulfill({ status: 404, body: "" });
      }
    });
  }
  await page.goto(`${BASE}${hash}`);
  await page.locator("#carte canvas").waitFor();
  // The timeline only appears once the status file has been read.
  await page.locator("#frise").waitFor();
  await settle(page, 1500);
  return { context, page };
}

// Lets the tiles, labels and data layers arrive after a change.
async function settle(page, milliseconds) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(milliseconds);
}

async function screenshots(browser) {
  for (const shot of SHOTS) {
    const { context, page } = await open(browser, shot.device, shot.scheme, shot.hash);
    if (shot.hash.includes("foyer=") && (await page.locator("#detail dl").count()) === 0) {
      console.warn(`${shot.name}: no foyer sheet shown (no foyer with this number).`);
    }
    const path = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path });
    console.log(path);
    await context.close();
  }
}

async function gif(browser) {
  const { context, page } = await open(browser, { viewport: GIF_VIEWPORT }, "light", "");
  const frames = [];
  const delays = [];
  async function frame(delay) {
    const picture = await page.screenshot();
    frames.push(await sharp(picture).resize({ width: GIF_WIDTH }).png().toBuffer());
    delays.push(delay);
  }

  // France at the last update.
  await frame(2000);

  // The week, step by step, from its first hour.
  const slider = page.locator("#instant");
  const last = Number(await slider.getAttribute("max"));
  for (let step = 0; step < last; step += GIF_TIMELINE_STEP) {
    await slider.evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, String(step));
    await page.waitForTimeout(250);
    await frame(step === 0 ? 1000 : 300);
  }
  await page.locator("#maintenant").click();
  await page.waitForTimeout(250);
  await frame(1500);

  // Burned areas, loaded on demand.
  await page.locator("#couche-brule").check();
  await settle(page, 1500);
  await frame(2500);

  // The first foyer of the list: the map flies to it and its sheet opens.
  const foyers = page.locator("button[data-foyer]");
  if ((await foyers.count()) === 0) {
    console.warn("No foyer in the data: the animation ends without a foyer.");
  } else {
    await foyers.first().click();
    for (let i = 0; i < 6; i += 1) {
      await page.waitForTimeout(350);
      await frame(200);
    }
    await settle(page, 1000);
    await frame(3000);
  }

  await context.close();
  const path = join(OUT, "interactions.gif");
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 0, effort: 7, interFrameMaxError: 8 })
    .toFile(path);
  const size = (statSync(path).size / 1024 / 1024).toFixed(1);
  console.log(`${path} (${String(frames.length)} images, ${size} Mo)`);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  await screenshots(browser);
  await gif(browser);
} finally {
  await browser.close();
}
