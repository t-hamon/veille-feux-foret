import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FIXTURES, STATIONS_GENERATED_AT, expect, mapStarted, test } from "./support";

// Capture of 11 November 2026 at 23:22 UTC: the stations file holds 120 hours,
// from 7 November 00:00 UTC; 719 stations measured the wind at 23:00 UTC
// (00:00 in Paris), only the 16 of the Bouches-du-Rhône before 21:00 UTC.
test.use({ scenario: "stations" });

const legend = (page: Page) => page.locator("#legende-stations");
const layer = (page: Page) => page.getByRole("checkbox", { name: "Stations" });
const windLayer = (page: Page) => page.getByRole("checkbox", { name: "Vent" });
const slider = (page: Page) => page.getByRole("slider", { name: "Instant affiché" });
const detail = (page: Page) => page.locator("#detail");
const NOW = STATIONS_GENERATED_AT.getTime() / 1000;

test.describe("wind measured at the stations", () => {
  test("is fetched with the stations layer only, unchecked at first", async ({ page, data }) => {
    await page.goto("/");
    await expect(page.locator("#frise")).toBeVisible();
    await expect(layer(page)).not.toBeChecked();
    await windLayer(page).check();
    await expect(page.locator("#legende-vent")).toContainText("Vent à 10 m");
    await expect(legend(page)).toBeHidden();
    expect(data.requests).not.toContain("stations-vent.json");
    await expect(page.locator("#attribution")).not.toContainText("Vent mesuré");
    await layer(page).check();
    await expect(legend(page)).toContainText(
      "719 stations Météo-France à 00:00 : la flèche indique où souffle le vent, le nombre sa vitesse moyenne en km/h ; un clic donne le détail.",
    );
    await expect(legend(page)).toContainText("zoomer pour les voir toutes");
    await expect(page.locator("#legende-vent")).not.toContainText("stations");
    expect(data.requests.filter((n) => n === "stations-vent.json")).toHaveLength(1);
    await expect(page.locator("#attribution")).toContainText("Vent mesuré Météo-France");
    await expect(page).toHaveURL(/stations=1/);
  });

  test("is shown without the wind layer, and comes back from the address", async ({
    page,
    data,
  }) => {
    await page.goto("/#stations=1");
    await expect(layer(page)).toBeChecked();
    await expect(windLayer(page)).not.toBeChecked();
    await expect(legend(page)).toContainText("719 stations");
    await expect(page.locator("#legende-vent")).toBeHidden();
    expect(data.requests).not.toContain("vent.json");
    await layer(page).uncheck();
    await expect(legend(page)).toBeHidden();
    await expect(page.locator("#attribution")).not.toContainText("Vent mesuré");
    await expect(page).not.toHaveURL(/stations=1/);
  });

  test("follows the timeline, without measurement before the file or in the forecast", async ({
    page,
  }) => {
    // 9 November at 12:30 UTC: the measurement of 12:00 UTC, Bouches-du-Rhône only.
    await page.goto(`/#vent=1&stations=1&instant=${String(Date.UTC(2026, 10, 9, 12, 30) / 1000)}`);
    await expect(legend(page)).toContainText("16 stations Météo-France à 13:00");
    await slider(page).focus();
    await page.keyboard.press("Home");
    await expect(legend(page)).toContainText(
      "Stations Météo-France : pas de mesure pour l'instant affiché.",
    );
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText(
      "Stations Météo-France : pas de mesure pour une heure de prévision.",
    );
  });

  test("gives the measurement of a station clicked on the map", async ({ page }) => {
    // The map centred on the station of Arbent (Ain).
    await page.goto("/#vent=1&stations=1&carte=10.00/46.27817/5.66900");
    test.skip(!(await mapStarted(page)), "WebGL unavailable in this browser");
    await expect(legend(page)).toContainText("719 stations");
    const box = await page.locator("#carte canvas").boundingBox();
    if (!box) throw new Error("no map");
    await page.waitForTimeout(500);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(detail(page).locator("h3")).toHaveText("Station Météo-France : ARBENT");
    await expect(detail(page)).toContainText("Altitude534 m");
    await expect(detail(page)).toContainText("Heure de la mesure12 novembre 2026 à 00:00");
    // 0.8 m/s, direction 70°, gust 2.4 m/s.
    await expect(detail(page)).toContainText("Vent moyen sur 10 min, à 10 m3 km/h");
    await expect(detail(page)).toContainText("Directionde est-nord-est (70°)");
    await expect(detail(page)).toContainText("Rafale maximale de l'heure9 km/h");
    await expect(detail(page)).toContainText(
      "SourceMétéo-France, mesures horaires des stations au sol",
    );
    // In the forecast part, the station has no measurement.
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(detail(page)).toContainText("Pas de mesure pour une heure de prévision.");
  });

  test("says why when the stations file is malformed", async ({ page, data }) => {
    data.override("stations-vent.json", JSON.stringify({ stations: {} }));
    await page.goto("/#stations=1");
    await expect(legend(page)).toContainText(
      "Mesures des stations indisponibles (stations-vent.json : liste des stations invalide).",
    );
  });

  test("has no automatic accessibility violation", async ({ page }) => {
    await page.goto("/#vent=1&stations=1");
    await expect(legend(page)).toContainText("719 stations");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("wind measured near a fire", () => {
  // The capture of 11 November has no fire cluster in France: the clusters of
  // 12 October are served in its place, to see their closest stations.
  test.beforeEach(({ data }) => {
    data.override("foyers.geojson", readFileSync(join(FIXTURES, "vent", "foyers.geojson"), "utf8"));
  });

  test("gives the closest station with a measurement at the hour shown", async ({ page, data }) => {
    await page.goto("/");
    await page.locator('#foyers button[data-foyer="1"]').click();
    const part = detail(page).locator(".foyer-station");
    await expect(part.getByRole("heading")).toHaveText("Vent mesuré à la station la plus proche");
    await expect(part).toContainText("StationJAMERICOURT, altitude 113 m");
    await expect(part).toContainText("Distance22,2 km du centre du foyer");
    await expect(part).toContainText("Heure de la mesure12 novembre 2026 à 00:00");
    // 2.6 m/s from 350°, gust 3.4 m/s.
    await expect(part).toContainText("Vent moyen sur 10 min, à 10 m9 km/h");
    await expect(part).toContainText("Directionde nord (350°)");
    await expect(part).toContainText("Rafale maximale de l'heure12 km/h");
    await expect(part).toContainText("le vent sur le feu peut être différent");
    expect(data.requests.filter((n) => n === "stations-vent.json")).toHaveLength(1);
  });

  test("has no measurement for a forecast hour, nor before the file", async ({ page }) => {
    await page.goto("/#foyer=3&vent=1");
    const part = detail(page).locator(".foyer-station");
    await expect(part).toContainText("VALENCIENNES");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(part).toContainText("Pas de mesure pour une heure de prévision.");
    await page.keyboard.press("Home");
    await expect(part).toContainText(
      "Aucune station n'a mesuré le vent à cette heure à moins de 50 km du foyer.",
    );
  });

  test("says when the stations file is not published", async ({ page, data }) => {
    data.override("stations-vent.json", "", 404);
    await page.goto(`/#foyer=1&instant=${String(NOW - 3600)}`);
    await expect(detail(page).locator(".foyer-station")).toContainText(
      "Mesures des stations indisponibles (non publiées).",
    );
  });
});
