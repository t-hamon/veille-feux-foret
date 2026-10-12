import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mapStarted, test } from "./support";

// Wind file of the capture of 12 October 2026: model run of 11 October at
// 18:00 UTC (20:00 in Paris), data generated at 00:43 UTC.
test.use({ scenario: "vent" });

const layer = (page: Page) => page.getByRole("checkbox", { name: "Vent" });
const legend = (page: Page) => page.locator("#legende-vent");
const button = (page: Page) => page.locator("#vent-animation");
const detail = (page: Page) => page.locator("#detail");

function fragment(page: Page): URLSearchParams {
  return new URLSearchParams(new URL(page.url()).hash.slice(1));
}

test.describe("wind layer", () => {
  test("is off by default and fetches nothing", async ({ page, data }) => {
    await page.goto("/");
    await expect(page.locator("#foyers li")).toHaveCount(3);
    await expect(layer(page)).not.toBeChecked();
    await expect(legend(page)).toBeHidden();
    await expect(button(page)).toBeHidden();
    await expect(page.locator("#attribution")).not.toContainText("Open-Meteo");
    expect(data.requests).not.toContain("vent.json");
  });

  test("shows the wind of the hour displayed, with its source", async ({ page, data }) => {
    await page.goto("/");
    await layer(page).check();
    await expect(legend(page)).toBeVisible();
    await expect(legend(page)).toContainText("Vent à 10 m");
    await expect(legend(page)).toContainText("moins de 10 km/h");
    await expect(legend(page)).toContainText("50 km/h et plus");
    // 00:43 UTC is shown with the wind of 01:00 UTC, 03:00 in Paris.
    await expect(legend(page)).toContainText(
      "Prévision pour le 12 oct., 03:00, calcul du 11 oct., 20:00.",
    );
    await expect(legend(page).getByRole("link", { name: "Open-Meteo.com" })).toBeVisible();
    await expect(page.locator("#attribution")).toContainText(
      "Vent modèle AROME HD de Météo-France, données Open-Meteo.com",
    );
    await expect(button(page)).toHaveText("Mettre le vent en pause");
    await expect(legend(page)).toHaveAttribute("data-state", "anime");
    expect(data.requests.filter((name) => name === "vent.json")).toHaveLength(1);
    expect(fragment(page).get("vent")).toBe("1");

    await layer(page).uncheck();
    await expect(legend(page)).toBeHidden();
    expect(fragment(page).get("vent")).toBeNull();
  });

  test("can be paused, and turned back on", async ({ page }) => {
    await page.goto("/#vent=1");
    await expect(button(page)).toHaveText("Mettre le vent en pause");
    await button(page).click();
    await expect(button(page)).toHaveText("Animer le vent");
    await expect(legend(page)).toHaveAttribute("data-state", "fixe");
    await expect(legend(page)).toContainText("Les flèches indiquent où souffle le vent.");
    await button(page).click();
    await expect(legend(page)).toHaveAttribute("data-state", "anime");
  });

  test("starts still for visitors who ask for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#vent=1");
    await expect(layer(page)).toBeChecked();
    await expect(button(page)).toHaveText("Animer le vent");
    await expect(legend(page)).toHaveAttribute("data-state", "fixe");
  });

  test("follows the timeline", async ({ page }) => {
    await page.goto("/#vent=1");
    await expect(legend(page)).toContainText("Prévision pour le 12 oct., 03:00");
    const slider = page.getByRole("slider", { name: "Instant affiché" });
    await slider.focus();
    await page.keyboard.press("Home");
    // Start of the timeline: 5 October 00:43 UTC, wind of 01:00 UTC, before the run.
    await expect(legend(page)).toContainText("Prévision archivée pour le 5 oct., 03:00");
  });

  test("shows the wind of the right hour when it arrives before the status file", async ({
    page,
  }) => {
    // Registered after the fixture routes, these run first: etat.json is held
    // back 1 s, so vent.json arrives first, and the map code 5 s, so that the
    // start of the map cannot put the legend right in its place.
    await page.route("**/data/etat.json", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fallback();
    });
    await page.route("**/assets/maplibre-gl-*/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.fallback();
    });
    await page.goto("/#vent=1");
    await expect(page.locator("#frise")).toBeVisible();
    await expect(legend(page)).toContainText("Prévision pour le 12 oct., 03:00", {
      timeout: 2000,
    });
  });

  test("gives the wind at a point of the map", async ({ page }) => {
    await page.goto("/#vent=1&carte=7.00/46.50000/2.50000");
    test.skip(!(await mapStarted(page)), "map not available in this browser");
    await expect(legend(page)).toContainText("Prévision pour");
    await page.locator("#carte canvas").click({ position: { x: 20, y: 20 } });
    await expect(detail(page).getByRole("heading", { name: "Vent à ce point" })).toBeVisible();
    await expect(detail(page)).toContainText("Vent moyen à 10 m");
    await expect(detail(page)).toContainText("km/h");
    await expect(detail(page)).toContainText("calcul du 11 octobre 2026 à 20:00");
    await expect(detail(page)).toContainText("Prévision du modèle.");
    await expect(detail(page).getByRole("link", { name: "Open-Meteo.com" })).toBeVisible();
  });

  test("has no automatic accessibility violation", async ({ page }) => {
    await page.goto("/#vent=1");
    await expect(legend(page)).toContainText("Prévision pour");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("says why when the wind file is malformed", async ({ page, data }) => {
    data.override("vent.json", JSON.stringify({ fetched_at: "hier" }));
    await page.goto("/#vent=1");
    await expect(page.locator("#notice")).toHaveText(
      "Vent indisponible (vent.json : date de collecte invalide).",
    );
    await expect(legend(page)).toContainText("Vent indisponible");
    await expect(button(page)).toBeHidden();
  });
});

test.describe("wind layer without a wind file", () => {
  test.use({ scenario: "complet" });

  test("says the wind is not published", async ({ page }) => {
    await page.goto("/");
    await layer(page).check();
    await expect(page.locator("#notice")).toHaveText("Vent indisponible (non publié).");
    await expect(legend(page)).toContainText("Vent indisponible (non publié).");
    await expect(button(page)).toBeHidden();
    await layer(page).uncheck();
    await expect(page.locator("#notice")).toBeHidden();
  });
});
