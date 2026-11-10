import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { WIND_GENERATED_AT, expect, mapStarted, test } from "./support";

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

// The timeline: 168 hours up to the update, then the forecast hours of the
// wind file, from 01:00 UTC on 12 October to its last hour, 21:00 UTC on 13
// October (23:00 in Paris): 45 more steps.
const NOW = WIND_GENERATED_AT.getTime() / 1000;
const LAST_HOUR = Date.UTC(2026, 9, 13, 21) / 1000;
const slider = (page: Page) => page.getByRole("slider", { name: "Instant affiché" });
const timeText = (page: Page) => page.locator("#instant-texte");
const note = (page: Page) => page.locator("#prevision");
const play = (page: Page) => page.locator("#lecture");
const latest = (page: Page) => page.getByRole("button", { name: "Dernière mise à jour" });

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

test.describe("forecast part of the timeline", () => {
  test("goes on to the last hour of the wind forecast", async ({ page }) => {
    await page.goto("/#vent=1");
    await expect(slider(page)).toHaveAttribute("max", "213");
    await expect(slider(page)).toHaveValue("168");
    await expect(note(page)).toBeHidden();
    await slider(page).focus();
    await page.keyboard.press("End");
    // The clock of the tests is 20 minutes after the update: 01:03 UTC.
    await expect(timeText(page)).toHaveText("Prévision, 13 oct., 23:00 (dans 44 h)");
    await expect(slider(page)).toHaveAttribute(
      "aria-valuetext",
      "Prévision, 13 oct., 23:00 (dans 44 h)",
    );
    await expect(note(page)).toHaveText(
      "Prévision : seul le vent change ; les foyers sont ceux de la dernière mise à jour.",
    );
    await expect(slider(page)).toHaveAttribute("aria-describedby", "prevision");
    await expect(page.locator("#frise")).toHaveAttribute("data-mode", "prevision");
    await expect(legend(page)).toContainText("Prévision pour le 13 oct., 23:00");
    await expect(page.locator("#foyers li")).toHaveCount(3);
    expect(fragment(page).get("instant")).toBe(String(LAST_HOUR));

    // The first hour of the forecast is just gone by on the clock.
    for (let step = 213; step > 169; step -= 1) await page.keyboard.press("ArrowLeft");
    await expect(timeText(page)).toHaveText("Prévision, 12 oct., 03:00 (il y a 3 min)");

    await latest(page).click();
    await expect(slider(page)).toHaveValue("168");
    await expect(timeText(page)).toContainText("dernière mise à jour");
    await expect(note(page)).toBeHidden();
    await expect(slider(page)).not.toHaveAttribute("aria-describedby", "prevision");
    await expect(latest(page)).toBeDisabled();
    expect(fragment(page).get("instant")).toBeNull();
  });

  test("appears with the wind layer only", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#frise")).toBeVisible();
    await expect(slider(page)).toHaveAttribute("max", "168");
    await expect(page.locator("#frise")).toHaveAttribute("data-prevision", "non");
    await layer(page).check();
    await expect(slider(page)).toHaveAttribute("max", "213");
    await expect(page.locator("#frise")).toHaveAttribute("data-prevision", "oui");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(note(page)).toBeVisible();

    // Without the wind, an hour of the forecast goes back to the last update.
    await layer(page).uncheck();
    await expect(slider(page)).toHaveAttribute("max", "168");
    await expect(slider(page)).toHaveValue("168");
    await expect(timeText(page)).toContainText("dernière mise à jour");
    await expect(note(page)).toBeHidden();
    expect(fragment(page).get("instant")).toBeNull();
  });

  test("keeps a past instant when the wind layer changes", async ({ page }) => {
    await page.goto(`/#instant=${String(NOW - 24 * 3600)}`);
    await expect(slider(page)).toHaveValue("144");
    await layer(page).check();
    await expect(slider(page)).toHaveAttribute("max", "213");
    await expect(slider(page)).toHaveValue("144");
    await layer(page).uncheck();
    await expect(slider(page)).toHaveAttribute("max", "168");
    await expect(slider(page)).toHaveValue("144");
    expect(fragment(page).get("instant")).toBe(String(NOW - 24 * 3600));
  });

  test("plays up to the last update, then through the forecast", async ({ page }) => {
    await page.goto(`/#vent=1&instant=${String(NOW - 3 * 3600)}`);
    await expect(slider(page)).toHaveAttribute("max", "213");
    await expect(slider(page)).toHaveValue("165");
    await expect(play(page)).toHaveAttribute(
      "aria-label",
      "Lire les 7 derniers jours heure par heure",
    );
    await play(page).click();
    await expect(slider(page)).toHaveValue("168");
    await expect(play(page)).toHaveText("Lire");
    await page.waitForTimeout(500);
    await expect(slider(page)).toHaveValue("168");
    await expect(play(page)).toHaveAttribute(
      "aria-label",
      "Lire la prévision du vent heure par heure",
    );

    // 45 steps at 150 ms each.
    await play(page).click();
    await expect(play(page)).toHaveText("Pause");
    await expect(slider(page)).toHaveValue("213", { timeout: 15_000 });
    await expect(play(page)).toHaveText("Lire");
    expect(fragment(page).get("instant")).toBe(String(LAST_HOUR));
  });

  test("restores an hour of the forecast from the address", async ({ page }) => {
    // The wind file arrives after the status file: the hour waits for it.
    await page.route("**/data/vent.json", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fallback();
    });
    await page.goto(`/#vent=1&instant=${String(LAST_HOUR)}`);
    await expect(page.locator("#frise")).toBeVisible();
    await expect(slider(page)).toHaveValue("213");
    await expect(timeText(page)).toHaveText("Prévision, 13 oct., 23:00 (dans 44 h)");
    expect(fragment(page).get("instant")).toBe(String(LAST_HOUR));
  });

  test("ignores an hour of the forecast without the wind layer", async ({ page }) => {
    await page.goto(`/#instant=${String(LAST_HOUR)}`);
    await expect(page.locator("#frise")).toBeVisible();
    await expect(slider(page)).toHaveAttribute("max", "168");
    await expect(slider(page)).toHaveValue("168");
    await expect(note(page)).toBeHidden();
  });

  test("has no automatic accessibility violation", async ({ page }) => {
    await page.goto("/#vent=1");
    await expect(slider(page)).toHaveAttribute("max", "213");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(note(page)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
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
