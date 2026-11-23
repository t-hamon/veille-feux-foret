import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FIXTURES, type DataStub, WIND_GENERATED_AT, expect, test } from "./support";

// Capture of 12 October 2026, update at 00:43:09 UTC (02:43 in Paris), with the
// weather of its three fire clusters. None of them is active at that update
// (last detection more than 6 hours before): the tests that need an active
// cluster serve the same foyers.geojson with "active" set to true.
test.use({ scenario: "vent" });

const layer = (page: Page) => page.getByRole("checkbox", { name: "Propagation" });
const legend = (page: Page) => page.locator("#legende-propagation");
const slider = (page: Page) => page.getByRole("slider", { name: "Instant affiché" });
const part = (page: Page) => page.locator("#detail .foyer-propagation");
const NOW = WIND_GENERATED_AT.getTime() / 1000;

function activeFoyers(data: DataStub): void {
  const foyers = JSON.parse(readFileSync(join(FIXTURES, "vent", "foyers.geojson"), "utf8")) as {
    features: { properties: Record<string, unknown> }[];
  };
  for (const feature of foyers.features) feature.properties["active"] = true;
  data.override("foyers.geojson", JSON.stringify(foyers));
}

test.describe("estimated spread", () => {
  test("is off at first, and brings 6 hours of forecast on its own", async ({ page, data }) => {
    await page.goto("/");
    await expect(page.locator("#frise")).toBeVisible();
    await expect(layer(page)).not.toBeChecked();
    await expect(legend(page)).toBeHidden();
    await expect(slider(page)).toHaveAttribute("max", "168");
    expect(data.requests).not.toContain("meteo-foyers.json");
    await layer(page).check();
    // 01:00 to 06:00 UTC: the whole hours up to 6 hours after the update.
    await expect(slider(page)).toHaveAttribute("max", "174");
    await expect(legend(page)).toContainText(
      "Estimation seulement sur les heures de prévision : avancez la frise après la dernière mise à jour.",
    );
    await expect(page).toHaveURL(/propagation=1/);
    expect(data.requests.filter((n) => n === "meteo-foyers.json")).toHaveLength(1);
    await expect(page.locator("#attribution")).toContainText(
      "Propagation estimée avec le vent du modèle AROME HD de Météo-France",
    );
    await layer(page).uncheck();
    await expect(legend(page)).toBeHidden();
    await expect(slider(page)).toHaveAttribute("max", "168");
    await expect(page).not.toHaveURL(/propagation=1/);
  });

  test("estimates nothing for clusters that are not active", async ({ page }) => {
    await page.goto("/#propagation=1&foyer=1");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText(
      "Aucun foyer actif avec un vent prévu : pas d'estimation.",
    );
    await expect(part(page)).toContainText(
      "Estimation faite seulement pour les foyers actifs, avec une détection dans les 6 heures précédant la mise à jour.",
    );
  });

  test("follows the forecast hours for active clusters", async ({ page, data }) => {
    activeFoyers(data);
    await page.goto("/#propagation=1&foyer=1");
    await expect(part(page).getByRole("heading")).toHaveText(
      "Propagation estimée (non officielle)",
    );
    // At the update itself: the 6 hours, no hour of the forecast yet.
    await expect(part(page)).toContainText(
      "Sur les 6 heures après la mise à jouravancée de 1,4 à 3,7 km",
    );
    await expect(part(page)).toContainText("Direction de l'avancéeouest-nord-ouest (298°)");
    await expect(part(page)).toContainText("Largeur à 6 heures1,1 à 2,9 km");
    await expect(part(page)).toContainText("Vent moyen prévu8 km/h, modèle AROME HD");
    await expect(part(page)).not.toContainText("À 0");
    await expect(part(page)).toContainText("sous-estime les feux d'herbe");
    // Moisture of the dead fine fuels at the hour closest to the update, 01:00
    // UTC (03:00 in Paris), after a night near 100 % humidity.
    await expect(part(page)).toContainText(
      "Humidité des combustibles fins morts à 03:0030,2 % (FFMC 73,7)",
    );
    await expect(part(page)).toContainText(
      "Plus de 7,5 % d'humidité : selon Cruz et Alexander (2019), la règle du vent surestime alors nettement l'avancée",
    );
    await expect(legend(page)).toContainText("Estimation seulement sur les heures de prévision");
    // Last hour of the forecast part: 06:00 UTC, 08:00 in Paris.
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText(
      "3 foyers actifs, estimation à 08:00, tous en végétation morte humide. La fiche d'un foyer en donne les limites.",
    );
    await expect(legend(page)).toContainText(
      "plus pâle : combustibles fins morts à plus de 7,5 % d'humidité, estimation probablement trop forte",
    );
    await expect(part(page)).toContainText("À 08:00avancée de");
    await expect(part(page)).toContainText(
      "Humidité des combustibles fins morts à 08:0030,7 % (FFMC 73,4)",
    );
    // Back to the past: nothing again.
    await page.keyboard.press("Home");
    await expect(legend(page)).toContainText("Estimation seulement sur les heures de prévision");
    await expect(part(page)).not.toContainText("À 0");
  });

  test("stops at 6 hours when the wind forecast goes further", async ({ page, data }) => {
    activeFoyers(data);
    await page.goto("/#propagation=1&vent=1&foyer=1");
    await expect(page.locator("#legende-vent")).toContainText("Vent à 10 m");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText(
      "3 foyers actifs, estimation à 08:43, la dernière heure estimée (6 heures après la mise à jour), tous en végétation morte humide.",
    );
    await expect(part(page)).not.toContainText("À 08:43");
    await expect(page.locator("#attribution")).not.toContainText("Propagation estimée");
  });

  test("comes back from a shared address on an hour of the forecast", async ({ page, data }) => {
    activeFoyers(data);
    // 03:00 UTC, 05:00 in Paris.
    const hour = Date.UTC(2026, 9, 12, 3) / 1000;
    await page.goto(`/#propagation=1&instant=${String(hour)}`);
    await expect(layer(page)).toBeChecked();
    await expect(legend(page)).toContainText(
      "3 foyers actifs, estimation à 05:00, tous en végétation morte humide.",
    );
    expect(hour - NOW).toBeLessThan(6 * 3600);
  });

  test("says when the moisture of the dead fine fuels is unknown", async ({ page, data }) => {
    activeFoyers(data);
    // A weather file written before the moisture was computed.
    const weather = JSON.parse(
      readFileSync(join(FIXTURES, "vent", "meteo-foyers.json"), "utf8"),
    ) as { fires: Record<string, unknown>[] };
    for (const entry of weather.fires) {
      delete entry["ffmc"];
      delete entry["fine_fuel_moisture"];
    }
    data.override("meteo-foyers.json", JSON.stringify(weather));
    await page.goto("/#propagation=1&foyer=1");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText(
      "3 foyers actifs, estimation à 08:00. La fiche d'un foyer en donne les limites.",
    );
    await expect(part(page)).toContainText(
      "Humidité des combustibles fins mortsinconnue à cette heure",
    );
    await expect(part(page)).not.toContainText("Plus de 7,5 %");
  });

  test("says why when the weather of the clusters is malformed", async ({ page, data }) => {
    data.override("meteo-foyers.json", JSON.stringify({ fires: {} }));
    await page.goto("/#propagation=1");
    await expect(legend(page)).toContainText(
      "Estimation impossible : météo des foyers indisponible (",
    );
  });

  test("has no automatic accessibility violation", async ({ page, data }) => {
    activeFoyers(data);
    await page.goto("/#propagation=1&foyer=1");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(legend(page)).toContainText("3 foyers actifs");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
