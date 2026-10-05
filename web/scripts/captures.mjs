// Screenshots of the built site for the README and the pull requests.
//
// The site must be served first (npm run build, then npm run serve in another
// terminal). The data files are those of the test capture of 3 October 2026
// (e2e/fixtures/complet), served in place of /data/; the base maps come from
// their real servers, so this script needs a network connection. The clock of
// the page is set 20 minutes after that capture, so the page shows the data
// as it was then.
//
// Usage: node scripts/captures.mjs [output folder]   (default: ../docs/captures/lot-1b)

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";

const BASE = "http://127.0.0.1:8787/";
const DATA = join(import.meta.dirname, "..", "e2e", "fixtures", "complet");
const OUT = process.argv[2] ?? join(import.meta.dirname, "..", "..", "docs", "captures", "lot-1b");
const NOW = new Date("2026-10-03T11:48:00Z");

const SHOTS = [
  {
    name: "desktop-clair",
    device: { viewport: { width: 1440, height: 900 } },
    scheme: "light",
    hash: "",
  },
  {
    name: "desktop-foyer",
    device: { viewport: { width: 1440, height: 900 } },
    scheme: "light",
    hash: "#foyer=1",
  },
  {
    name: "desktop-sombre-surfaces",
    device: { viewport: { width: 1440, height: 900 } },
    scheme: "dark",
    hash: "#brule=1&carte=7.00/43.50000/2.50000",
  },
  {
    name: "desktop-osm",
    device: { viewport: { width: 1440, height: 900 } },
    scheme: "light",
    hash: "#fond=osm",
  },
  { name: "mobile-clair", device: devices["Pixel 7"], scheme: "light", hash: "" },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({ ...shot.device, colorScheme: shot.scheme });
    const page = await context.newPage();
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
    await page.goto(`${BASE}${shot.hash}`);
    await page.locator("#carte canvas").waitFor();
    // Let the tiles and labels of the base map arrive.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    const path = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path });
    console.log(path);
    await context.close();
  }
} finally {
  await browser.close();
}
