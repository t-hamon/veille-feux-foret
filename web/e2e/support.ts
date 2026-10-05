// Shared set-up of the end-to-end tests.
//
// The tests never reach a third-party server: the two base map servers are
// answered by a minimal local style (a plain background), and any other
// request leaving the local build fails the test. The data files are those the
// real pipeline writes from the capture of 3 October 2026, for one scenario
// (e2e/fixtures/<scenario>/, produced by tools/build_web_fixtures.py).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Page, type Route } from "@playwright/test";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const GENERATED_AT = new Date("2026-10-03T11:28:00Z");

export type Scenario = "complet" | "firms-partiel" | "firms-en-panne" | "effis-en-panne" | "vide";

const MAP_HOSTS = ["https://data.geopf.fr", "https://tiles.openfreemap.org"];

const CORS = { "access-control-allow-origin": "*" };

function stubStyle(host: string): string {
  return JSON.stringify({
    version: 8,
    name: "test",
    glyphs: `${host}/fonts/{fontstack}/{range}.pbf`,
    sources: {},
    layers: [{ id: "fond", type: "background", paint: { "background-color": "#e9e6e1" } }],
  });
}

export interface MapStub {
  /** URLs asked from the base map servers. */
  requests: string[];
  /** Make the style of a base map answer with an error. */
  failStyle(host: "ign" | "osm"): void;
}

async function stubBaseMaps(page: Page): Promise<MapStub> {
  const failing = new Set<string>();
  const stub: MapStub = {
    requests: [],
    failStyle(host) {
      failing.add(host === "ign" ? (MAP_HOSTS[0] ?? "") : (MAP_HOSTS[1] ?? ""));
    },
  };
  for (const host of MAP_HOSTS) {
    await page.route(`${host}/**`, async (route: Route) => {
      const url = route.request().url();
      stub.requests.push(url);
      if (url.includes("/fonts/")) {
        await route.fulfill({ status: 200, headers: CORS, body: Buffer.alloc(0) });
      } else if (url.includes("/styles/")) {
        if (failing.has(host)) {
          await route.fulfill({ status: 503, headers: CORS, body: "unavailable" });
        } else {
          await route.fulfill({
            status: 200,
            headers: { ...CORS, "content-type": "application/json" },
            body: stubStyle(host),
          });
        }
      } else {
        await route.fulfill({ status: 404, headers: CORS, body: "" });
      }
    });
  }
  return stub;
}

export interface DataStub {
  /** Data files asked by the page, by name. */
  requests: string[];
  /** Serve this body for one file instead of the scenario's file. */
  override(name: string, body: string, status?: number): void;
  /** Answer every data file after this many milliseconds. */
  delay(milliseconds: number): void;
}

async function serveData(page: Page, scenario: Scenario): Promise<DataStub> {
  const overrides = new Map<string, { body: string; status: number }>();
  let wait = 0;
  const stub: DataStub = {
    requests: [],
    override(name, body, status = 200) {
      overrides.set(name, { body, status });
    },
    delay(milliseconds) {
      wait = milliseconds;
    },
  };
  await page.route("**/data/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    stub.requests.push(name);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const forced = overrides.get(name);
    if (forced) {
      await route.fulfill({ status: forced.status, body: forced.body });
      return;
    }
    if (scenario === "vide" || !/^[a-z-]+\.(json|geojson)$/.test(name)) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    try {
      const body = readFileSync(join(FIXTURES, scenario, name));
      await route.fulfill({ status: 200, contentType: "application/json", body });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  return stub;
}

interface Fixtures {
  scenario: Scenario;
  maps: MapStub;
  data: DataStub;
  external: string[];
}

export const test = base.extend<Fixtures>({
  scenario: ["complet", { option: true }],
  external: [
    async ({ page }, use) => {
      const external: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
        const known = MAP_HOSTS.some((host) => request.url().startsWith(host));
        if (!local && !known && !["data:", "blob:"].includes(url.protocol)) {
          external.push(request.url());
        }
      });
      await use(external);
      expect(external, "requests to unexpected hosts").toEqual([]);
    },
    { auto: true },
  ],
  maps: [
    async ({ page }, use) => {
      await use(await stubBaseMaps(page));
    },
    { auto: true },
  ],
  data: [
    async ({ page, scenario }, use) => {
      await use(await serveData(page, scenario));
    },
    { auto: true },
  ],
  page: async ({ page }, use) => {
    // The data was generated at 11:28 UTC on 3 October 2026; the clock is set
    // shortly after, so the page sees fresh data unless a test says otherwise.
    await page.clock.setFixedTime(new Date(GENERATED_AT.getTime() + 20 * 60_000));
    await use(page);
  },
});

export { expect };

/** True once the map has started, false if the page fell back to the text-only view. */
export async function mapStarted(page: Page): Promise<boolean> {
  const message = page.locator("#carte-message");
  const canvas = page.locator("#carte canvas");
  await expect(canvas.or(message.filter({ hasText: /WebGL|pas pu/ }))).toBeVisible();
  return canvas.isVisible();
}
