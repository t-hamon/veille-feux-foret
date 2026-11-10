import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FIXTURES, expect, test } from "./support";

// Weather file of the capture of 12 October 2026: model run of 11 October at
// 18:00 UTC (20:00 in Paris), data generated at 00:43 UTC; the weather of the
// three fire clusters is in the file.
test.use({ scenario: "vent" });

const weather = (page: Page) => page.locator("#detail .foyer-weather");
const foyer = (page: Page, id: number) =>
  page.locator(`#foyers button[data-foyer="${String(id)}"]`);
const slider = (page: Page) => page.getByRole("slider", { name: "Instant affiché" });

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, "vent", name), "utf8")) as Record<string, unknown>;
}

test.describe("weather in the sheet of a fire", () => {
  test("is fetched once, when a sheet is first opened", async ({ page, data }) => {
    await page.goto("/");
    await expect(page.locator("#foyers li")).toHaveCount(3);
    expect(data.requests).not.toContain("meteo-foyers.json");
    await foyer(page, 1).click();
    await expect(weather(page).getByRole("heading", { name: "Météo au foyer" })).toBeVisible();
    // 00:43 UTC is shown with the weather of 01:00 UTC, 03:00 in Paris.
    await expect(weather(page)).toContainText("12 octobre 2026 à 03:00");
    await expect(weather(page)).toContainText("5,8 °C");
    await expect(weather(page)).toContainText("100 %");
    await expect(weather(page)).toContainText("5 km/h, de sud-est (127°)");
    await expect(weather(page)).toContainText("calcul du 11 octobre 2026 à 20:00");
    await expect(weather(page)).toContainText("Prévision du modèle.");
    const table = weather(page).getByRole("table", {
      name: "Heures suivantes, toutes les 3 heures",
    });
    await expect(table.locator("tbody tr")).toHaveCount(8);
    await expect(table.locator("tbody tr").first()).toHaveText(
      /12 oct\. 06:00\s*5,3\s*98\s*9 ESE\s*13\s*0/,
    );
    await foyer(page, 2).click();
    await expect(page.locator("#detail h3")).toHaveText("Foyer 2");
    await expect(weather(page)).toContainText("Température à 2 m");
    expect(data.requests.filter((name) => name === "meteo-foyers.json")).toHaveLength(1);
  });

  test("is there when a shared address opens a sheet", async ({ page, data }) => {
    await page.goto("/#foyer=1");
    await expect(weather(page)).toContainText("12 octobre 2026 à 03:00");
    expect(data.requests).toContain("meteo-foyers.json");
  });

  test("follows the timeline, forecast part included", async ({ page }) => {
    await page.goto("/#foyer=1&vent=1");
    await expect(weather(page)).toContainText("12 octobre 2026 à 03:00");
    await expect(slider(page)).toHaveAttribute("max", "213");
    await slider(page).focus();
    await page.keyboard.press("Home");
    // Start of the timeline: 5 October 00:43 UTC, weather of 01:00 UTC.
    await expect(weather(page)).toContainText("5 octobre 2026 à 03:00");
    await expect(weather(page)).toContainText(
      "Heure passée : prévision archivée du modèle, pas une mesure.",
    );
    await page.keyboard.press("End");
    // Last hour of the forecast: no hour after it.
    await expect(weather(page)).toContainText("13 octobre 2026 à 23:00");
    await expect(weather(page)).toContainText("Pas d'heure suivante dans les données.");
    await expect(weather(page).getByRole("table")).toHaveCount(0);
  });

  test("explains a cluster whose weather could not be fetched", async ({ page, data }) => {
    const document = fixture("meteo-foyers.json");
    const fires = document["fires"] as { id: number }[];
    data.override(
      "meteo-foyers.json",
      JSON.stringify({ ...document, fires: fires.filter((f) => f.id !== 2), missing: [2] }),
    );
    await page.goto("/#foyer=2");
    await expect(weather(page)).toContainText(
      "Météo pas encore disponible pour ce foyer : elle sera demandée à une prochaine mise à jour.",
    );
  });

  test("explains a cluster without detection in the last 24 hours", async ({ page, data }) => {
    const foyers = fixture("foyers.geojson");
    const features = foyers["features"] as { properties: Record<string, unknown> }[];
    for (const feature of features) {
      if (feature.properties["id"] === 3) feature.properties["detections_24h"] = 0;
    }
    data.override("foyers.geojson", JSON.stringify(foyers));
    const document = fixture("meteo-foyers.json");
    const fires = document["fires"] as { id: number }[];
    data.override(
      "meteo-foyers.json",
      JSON.stringify({ ...document, fires: fires.filter((f) => f.id !== 3) }),
    );
    await page.goto("/#foyer=3");
    await expect(weather(page)).toContainText(
      "Météo non calculée : aucune détection depuis 24 heures.",
    );
  });

  test("says why when the weather file is malformed", async ({ page, data }) => {
    data.override("meteo-foyers.json", JSON.stringify({ fires: {} }));
    await page.goto("/#foyer=1");
    await expect(weather(page)).toContainText(
      "Météo indisponible (meteo-foyers.json : liste des foyers invalide).",
    );
  });

  test("has no automatic accessibility violation", async ({ page }) => {
    await page.goto("/#foyer=1");
    await expect(weather(page).getByRole("table")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("weather in the sheet of a fire, without a weather file", () => {
  test.use({ scenario: "complet" });

  test("says the weather is not published", async ({ page }) => {
    await page.goto("/#foyer=1");
    await expect(weather(page)).toContainText("Météo indisponible (non publiée).");
  });
});
