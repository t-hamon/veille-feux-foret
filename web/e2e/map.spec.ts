import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { GENERATED_AT, expect, mapStarted, test } from "./support";

const END = GENERATED_AT.getTime() / 1000;
const START = END - 168 * 3600;

const status = (page: Page) => page.locator("#etat");
const detail = (page: Page) => page.locator("#detail");
const foyer = (page: Page, id: number) =>
  page.locator(`#foyers button[data-foyer="${String(id)}"]`);
const slider = (page: Page) => page.getByRole("slider", { name: "Instant affiché" });
const timeText = (page: Page) => page.locator("#instant-texte");

function fragment(page: Page): URLSearchParams {
  return new URLSearchParams(new URL(page.url()).hash.slice(1));
}

test.describe("situation from the pipeline data", () => {
  test("shows fresh data, the foyers, the season and the sources", async ({ page, data }) => {
    await page.goto("/");
    await expect(status(page)).toContainText("Dernière mise à jour : 3 octobre 2026 à 13:28");
    await expect(status(page)).toContainText("il y a 20 min");
    await expect(status(page)).not.toContainText("en retard");
    await expect(page.locator("#foyers li")).toHaveCount(7);
    await expect(foyer(page, 1)).toContainText("7 détections, dernière le 3 oct., 03:58");
    await expect(page.locator("#bilan")).toContainText("97 971 ha");
    await expect(page.locator("#bilan")).toContainText("14 198 ha");
    await expect(page.locator("#attribution")).toContainText("© IGN, Plan IGN");
    await expect(page.locator("#attribution")).toContainText("NASA FIRMS");
    await expect(timeText(page)).toHaveText(
      "État au 3 oct., 13:28, dernière mise à jour : 46 détections",
    );
    // Burned areas are only fetched when the layer is turned on.
    expect(data.requests).not.toContain("surfaces-brulees.geojson");
  });

  test("starts the map on the local style, or explains why it cannot", async ({ page, maps }) => {
    const workers: string[] = [];
    page.on("worker", (worker) => workers.push(worker.url()));
    await page.goto("/");
    if (await mapStarted(page)) {
      await expect(page.locator("#carte-message")).toBeHidden();
      expect(maps.requests.some((u) => u.endsWith("/PLAN.IGN/gris.json"))).toBe(true);
      // MapLibre's worker is the published file of this site, not a blob: URL.
      await expect
        .poll(() => workers)
        .toContain("http://127.0.0.1:8787/assets/maplibre-gl-6.11.2/maplibre-gl-worker.mjs");
      await expect(page.locator("#carte canvas")).toHaveAttribute(
        "aria-label",
        "Carte des feux de forêt en France",
      );
    } else {
      await expect(page.locator("#carte-message")).toContainText("WebGL 2 indisponible");
      await expect(page.locator("#foyers li")).toHaveCount(7);
    }
  });

  test("shows the detail of a foyer chosen in the list and shares it", async ({ page }) => {
    await page.goto("/");
    await foyer(page, 2).click();
    await expect(foyer(page, 2)).toHaveAttribute("aria-pressed", "true");
    await expect(detail(page).getByRole("heading", { name: "Foyer 2" })).toBeVisible();
    await expect(detail(page)).toContainText("6 sur 7 jours");
    await expect(detail(page)).toContainText("ordre de grandeur");
    expect(fragment(page).get("foyer")).toBe("2");
  });

  test("selects a foyer with the keyboard, without losing focus", async ({ page }) => {
    await page.goto("/");
    await foyer(page, 3).focus();
    await page.keyboard.press("Enter");
    await expect(detail(page).getByRole("heading", { name: "Foyer 3" })).toBeVisible();
    await expect(foyer(page, 3)).toBeFocused();
    await expect(foyer(page, 3)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(foyer(page, 4)).toBeFocused();
  });

  test("keeps the choices made before the data arrives", async ({ page, data }) => {
    data.delay(1500);
    await page.goto("/");
    await page.getByLabel("Fond de carte").selectOption("osm");
    await page.getByRole("checkbox", { name: "Surfaces brûlées" }).check();
    await expect(page.locator("#foyers li")).toHaveCount(7);
    await expect(page.getByLabel("Fond de carte")).toHaveValue("osm");
    await expect(page.getByRole("checkbox", { name: "Surfaces brûlées" })).toBeChecked();
    await expect.poll(() => data.requests).toContain("surfaces-brulees.geojson");
    expect(fragment(page).get("fond")).toBe("osm");
    expect(fragment(page).get("brule")).toBe("1");
  });
});

test.describe("timeline", () => {
  test("shows the state at an earlier instant and back", async ({ page }) => {
    await page.goto("/");
    await slider(page).focus();
    await page.keyboard.press("Home");
    await expect(timeText(page)).toHaveText("État au 26 sept., 13:28 : 0 détection");
    expect(fragment(page).get("instant")).toBe(String(START));
    await page.keyboard.press("End");
    await expect(timeText(page)).toContainText("dernière mise à jour : 46 détections");
    expect(fragment(page).get("instant")).toBeNull();
  });

  test("counts only the detections acquired up to the instant", async ({ page }) => {
    // 12 hours before the update: part of the detections are not acquired yet.
    await page.goto(`/#instant=${String(END - 12 * 3600)}`);
    await expect(slider(page)).toHaveValue("156");
    const text = await timeText(page).textContent();
    const count = Number(/: (\d+) détection/.exec(text ?? "")?.[1]);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(46);
    await page.getByRole("button", { name: "Dernière mise à jour" }).click();
    await expect(timeText(page)).toContainText("46 détections");
    await expect(page.getByRole("button", { name: "Dernière mise à jour" })).toBeDisabled();
  });

  test("plays the week hour by hour and can be paused", async ({ page }) => {
    await page.goto("/");
    const play = page.locator("#lecture");
    await play.click();
    await expect(play).toHaveText("Pause");
    // The reading starts from the beginning of the week and moves forward.
    await expect.poll(async () => Number(await slider(page).inputValue())).toBeGreaterThan(3);
    await play.click();
    await expect(play).toHaveText("Lire");
    const paused = await slider(page).inputValue();
    await page.waitForTimeout(500);
    await expect(slider(page)).toHaveValue(paused);
    expect(Number(paused)).toBeLessThan(168);
  });
});

test.describe("shared address", () => {
  test("restores the foyer, the base map and the instant", async ({ page, maps }) => {
    await page.goto(`/#fond=osm&foyer=2&instant=${String(START + 48 * 3600)}`);
    await expect(detail(page).getByRole("heading", { name: "Foyer 2" })).toBeVisible();
    await expect(page.getByLabel("Fond de carte")).toHaveValue("osm");
    await expect(page.locator("#attribution")).toContainText("OpenStreetMap");
    await expect(slider(page)).toHaveValue("48");
    if (await mapStarted(page)) {
      expect(maps.requests.some((u) => u.includes("tiles.openfreemap.org/styles/positron"))).toBe(
        true,
      );
    }
  });

  test("ignores hostile or invalid values", async ({ page }) => {
    await page.goto(
      "/#fond=javascript:alert(1)&foyer=<b>1</b>&instant=99999999999&carte=8/43/5<script>",
    );
    await expect(page.getByLabel("Fond de carte")).toHaveValue("ign");
    await expect(detail(page)).toContainText("Choisissez un foyer");
    await expect(slider(page)).toHaveValue("168");
    await expect(page.locator("b, script:not([src])")).toHaveCount(0);
  });

  test("remembers the chosen base map", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Fond de carte").selectOption("osm");
    expect(fragment(page).get("fond")).toBe("osm");
    await page.goto("/");
    await expect(page.getByLabel("Fond de carte")).toHaveValue("osm");
  });
});

test.describe("burned areas", () => {
  test("are loaded when the layer is turned on", async ({ page, data }) => {
    await page.goto("/");
    await page.getByRole("checkbox", { name: "Surfaces brûlées" }).check();
    await expect.poll(() => data.requests).toContain("surfaces-brulees.geojson");
    await expect(page.locator("#notice")).toBeHidden();
    expect(fragment(page).get("brule")).toBe("1");
  });

  test.describe("when EFFIS did not answer", () => {
    test.use({ scenario: "effis-en-panne" });

    test("says so instead of drawing nothing silently", async ({ page }) => {
      await page.goto("/");
      await expect(status(page)).toContainText("3 sources en échec");
      await expect(page.locator("#bilan")).toContainText("Bilan indisponible");
      await page.getByRole("checkbox", { name: "Surfaces brûlées" }).check();
      await expect(page.locator("#notice")).toHaveText(
        "Surfaces brûlées indisponibles (non publiées).",
      );
    });
  });
});

test.describe("degraded data", () => {
  test.describe("every FIRMS feed down", () => {
    test.use({ scenario: "firms-en-panne" });

    test("warns that no foyer does not mean no fire", async ({ page }) => {
      await page.goto("/");
      await expect(status(page)).toContainText("Détections satellite indisponibles");
      await expect(status(page)).toContainText("l'absence de foyer sur la carte ne signifie pas");
      await expect(page.locator("#foyers")).toContainText("Liste indisponible");
      await expect(status(page).locator("details")).toHaveAttribute("open", "");
      await expect(status(page)).toContainText("aucune donnée disponible");
    });
  });

  test.describe("one FIRMS feed down", () => {
    test.use({ scenario: "firms-partiel" });

    test("names the failed source and keeps the others", async ({ page }) => {
      await page.goto("/");
      await expect(status(page)).toContainText("1 source en échec");
      await expect(status(page).locator('li[data-ok="false"]')).toHaveCount(1);
      await expect(status(page).locator('li[data-ok="false"]')).toContainText("NOAA-21");
      await expect(page.locator("#foyers li").first()).toBeVisible();
    });
  });

  test.describe("no data published", () => {
    test.use({ scenario: "vide" });

    test("says the data is unavailable and shows no timeline", async ({ page }) => {
      await page.goto("/");
      await expect(status(page)).toContainText("Données indisponibles");
      await expect(page.locator("#frise")).toBeHidden();
      await expect(page.locator("#bilan")).toContainText("Bilan indisponible");
    });
  });

  test("flags late data", async ({ page }) => {
    await page.clock.setFixedTime(new Date(GENERATED_AT.getTime() + 2 * 3600_000));
    await page.goto("/");
    await expect(status(page)).toContainText("Données en retard");
  });

  test("flags old data", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-05T12:00:00Z"));
    await page.goto("/");
    await expect(status(page)).toContainText("Données anciennes");
  });

  test("reports a broken file without breaking the page", async ({ page, data }) => {
    data.override("detections.geojson", "<html>erreur</html>");
    await page.goto("/");
    await expect(page.locator("#foyers li")).toHaveCount(7);
    await expect(timeText(page)).toContainText("0 détection");
  });

  test("renders hostile text from the data as plain text", async ({ page, data }) => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    data.override(
      "etat.json",
      JSON.stringify({
        generated_at: "2026-10-03T11:28:00Z",
        window_hours: 168,
        sources: { firms_modis: { label: hostile, ok: false, error: hostile } },
        files: [],
      }),
    );
    await page.goto("/");
    await expect(status(page)).toContainText(hostile);
    await expect(status(page).locator("img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  });
});

test.describe("base map", () => {
  test("offers the other base map when one does not answer", async ({ page, maps }) => {
    maps.failStyle("ign");
    await page.goto("/#foyer=2");
    test.skip(!(await mapStarted(page)), "the map needs WebGL 2");
    const notice = page.locator("#notice");
    await expect(notice).toContainText("Le fond de carte Plan IGN ne répond pas.");
    await notice.getByRole("button", { name: "Utiliser OpenStreetMap" }).click();
    await expect(page.getByLabel("Fond de carte")).toHaveValue("osm");
    await expect.poll(() => maps.requests.some((u) => u.includes("/styles/positron"))).toBe(true);
    await expect(notice).toBeHidden();
    // The layers of the site are drawn on the new base map: the foyer centred
    // by the address can be picked on it.
    await expect.poll(() => fragment(page).get("carte") ?? "").toMatch(/^10\.00\//);
    const box = await page.locator("#carte canvas").boundingBox();
    if (!box) throw new Error("no canvas");
    await page.mouse.click(box.x + 30, box.y + box.height - 30);
    await expect(detail(page)).toContainText("Choisissez un foyer");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(detail(page).getByRole("heading", { name: "Foyer 2" })).toBeVisible();
  });

  test("keeps the working base map when the other one does not answer", async ({ page, maps }) => {
    maps.failStyle("osm");
    await page.goto("/");
    test.skip(!(await mapStarted(page)), "the map needs WebGL 2");
    await expect(page.locator("#carte-message")).toBeHidden();
    await page.getByLabel("Fond de carte").selectOption("osm");
    const notice = page.locator("#notice");
    await expect(notice).toHaveText(
      "Le fond de carte OpenStreetMap ne répond pas : le fond Plan IGN reste affiché.",
    );
    await expect(page.getByLabel("Fond de carte")).toHaveValue("ign");
    await expect(page.locator("#attribution")).toContainText("© IGN, Plan IGN");
    expect(fragment(page).get("fond")).toBeNull();
  });

  test("selects a foyer by clicking it on the map", async ({ page }) => {
    // Without a shared position, the map flies to the foyer of the address and
    // centres it.
    await page.goto("/#foyer=2");
    test.skip(!(await mapStarted(page)), "the map needs WebGL 2");
    await expect.poll(() => fragment(page).get("carte") ?? "").toMatch(/^10\.00\//);
    const box = await page.locator("#carte canvas").boundingBox();
    if (!box) throw new Error("no canvas");
    // A click away from any feature clears the selection.
    await page.mouse.click(box.x + 30, box.y + box.height - 30);
    await expect(detail(page)).toContainText("Choisissez un foyer");
    expect(fragment(page).get("foyer")).toBeNull();
    // A click on the foyer selects it again.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(detail(page).getByRole("heading", { name: "Foyer 2" })).toBeVisible();
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`has no automatic accessibility violation, ${scheme} theme`, async ({ page }) => {
    await page.goto("/");
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(page.locator("#foyers li")).toHaveCount(7);
    await mapStarted(page);
    await foyer(page, 1).click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
