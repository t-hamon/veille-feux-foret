import { beforeEach, describe, expect, it } from "vitest";
import completBilan from "../e2e/fixtures/complet/bilan.json?raw";
import completDetections from "../e2e/fixtures/complet/detections.geojson?raw";
import completEtat from "../e2e/fixtures/complet/etat.json?raw";
import completFoyers from "../e2e/fixtures/complet/foyers.geojson?raw";
import completSurfaces from "../e2e/fixtures/complet/surfaces-brulees.geojson?raw";
import panneEtat from "../e2e/fixtures/firms-en-panne/etat.json?raw";
import {
  type Foyer,
  parseBurned,
  parseDetections,
  parseFoyers,
  parseStatus,
  parseSummary,
} from "./data";
import { AGE_COLOURS } from "./palette";
import {
  markSelectedFoyer,
  renderAttribution,
  renderDetail,
  renderFoyers,
  renderLegend,
  renderStatus,
  renderSummary,
} from "./ui";

const generated = new Date("2026-10-03T11:28:00Z");
const later = (minutes: number) => new Date(generated.getTime() + minutes * 60_000);
const status = parseStatus(JSON.parse(completEtat));
const foyers = parseFoyers(JSON.parse(completFoyers)).items;
const detections = parseDetections(JSON.parse(completDetections)).items;
const burned = parseBurned(JSON.parse(completSurfaces)).items;

let box: HTMLElement;
beforeEach(() => {
  box = document.createElement("div");
});

describe("status", () => {
  it("states the update time without alarm when data is fresh", () => {
    renderStatus(box, {
      status: { state: "ok", value: status },
      rejected: 0,
      now: later(20),
      missingFiles: [],
    });
    expect(box.dataset["state"]).toBe("fresh");
    expect(box.textContent).toContain("3 octobre 2026 à 13:28 (il y a 20 min)");
    expect(box.querySelector(".alert")).toBeNull();
    expect(box.querySelectorAll("li")).toHaveLength(7);
    expect(box.querySelector("details")?.open).toBe(false);
  });

  it("warns about late and old data", () => {
    renderStatus(box, {
      status: { state: "ok", value: status },
      rejected: 0,
      now: later(120),
      missingFiles: [],
    });
    expect(box.textContent).toContain("Données en retard");
    renderStatus(box, {
      status: { state: "ok", value: status },
      rejected: 0,
      now: later(3000),
      missingFiles: [],
    });
    expect(box.textContent).toContain("Données anciennes");
  });

  it("explains a FIRMS outage and opens the source detail", () => {
    renderStatus(box, {
      status: { state: "ok", value: parseStatus(JSON.parse(panneEtat)) },
      rejected: 0,
      now: later(5),
      missingFiles: ["detections.geojson"],
    });
    expect(box.textContent).toContain("Détections satellite indisponibles");
    expect(box.textContent).toContain("4 sources en échec");
    expect(box.textContent).toContain("Foyers (NASA FIRMS)");
    expect(box.textContent).toContain(
      "Fichiers non publiés lors de cette mise à jour : detections.geojson.",
    );
    expect(box.querySelector("details")?.open).toBe(true);
    expect(box.querySelectorAll('li[data-ok="false"]')).toHaveLength(4);
  });

  it("says when nothing could be read, and counts rejected entries", () => {
    renderStatus(box, {
      status: { state: "missing" },
      rejected: 0,
      now: later(0),
      missingFiles: [],
    });
    expect(box.dataset["state"]).toBe("unavailable");
    expect(box.textContent).toContain("aucun fichier publié");
    renderStatus(box, {
      status: { state: "error", message: "réponse HTTP 500" },
      rejected: 0,
      now: later(0),
      missingFiles: [],
    });
    expect(box.textContent).toContain("réponse HTTP 500");
    renderStatus(box, {
      status: { state: "ok", value: status },
      rejected: 2,
      now: later(0),
      missingFiles: [],
    });
    expect(box.textContent).toContain("2 entrées ignorées car mal formées.");
  });

  it("never interprets text from the data as HTML", () => {
    const hostile = parseStatus({
      generated_at: "2026-10-03T11:28:00Z",
      window_hours: 168,
      sources: { firms_modis: { ok: false, label: "<b>x</b>", error: "<script>bad()</script>" } },
    });
    renderStatus(box, {
      status: { state: "ok", value: hostile },
      rejected: 0,
      now: later(1),
      missingFiles: [],
    });
    expect(box.querySelector("b, script")).toBeNull();
    expect(box.textContent).toContain("<script>bad()</script>");
  });
});

describe("foyers and detail", () => {
  it("lists the foyers and reports the one selected", () => {
    const chosen: Foyer[] = [];
    renderFoyers(box, { state: "ok", value: foyers }, 2, (f) => chosen.push(f));
    const buttons = box.querySelectorAll("button");
    expect(buttons).toHaveLength(7);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    buttons[3]?.click();
    expect(chosen.map((f) => f.id)).toEqual([4]);
  });

  it("explains an empty or unavailable list", () => {
    renderFoyers(box, { state: "ok", value: [] }, null, () => undefined);
    expect(box.textContent).toContain("Aucun foyer sur les 7 derniers jours");
    renderFoyers(box, { state: "missing" }, null, () => undefined);
    expect(box.textContent).toContain("Liste indisponible");
  });

  it("details a foyer, a detection and both kinds of burned areas", () => {
    const foyer = foyers[0];
    const detection = detections[0];
    const dated = burned.find((b) => b.kind === "dated");
    const nrt = burned.find((b) => b.kind === "nrt");
    if (!foyer || !detection || !dated || !nrt) throw new Error("fixtures changed");

    renderDetail(box, { kind: "foyer", foyer }, later(0));
    expect(box.querySelector("h3")?.textContent).toBe("Foyer 1");
    expect(box.textContent).toContain("7 sur 7 jours");
    expect(box.textContent).toContain("ordre de grandeur");

    renderDetail(box, { kind: "detection", detection }, later(0));
    expect(box.querySelector("h3")?.textContent).toBe("Détection satellite");
    expect(box.textContent).toContain("Capteur");

    renderDetail(box, { kind: "burned", area: dated }, later(0));
    expect(box.querySelector("h3")?.textContent).toBe("Surface brûlée");
    expect(box.textContent).toContain("Date du feu");

    renderDetail(box, { kind: "burned", area: nrt }, later(0));
    expect(box.textContent).toContain("ne précise ni la date ni la commune");

    renderDetail(box, null, later(0));
    expect(box.textContent).toContain("Choisissez un foyer");
  });
});

describe("summary and captions", () => {
  it("writes the season summary", () => {
    renderSummary(box, { state: "ok", value: parseSummary(JSON.parse(completBilan)) });
    expect(box.textContent).toContain("Saison 2026 jusqu'à la semaine du 30 septembre 2026");
    expect(box.textContent).toContain("374 feux cartographiés");
    renderSummary(box, { state: "missing" });
    expect(box.textContent).toContain("Bilan indisponible");
  });

  it("credits the base map, the data sources and MapLibre", () => {
    renderAttribution(box, "osm");
    const links = [...box.querySelectorAll("a")].map((a) => a.textContent);
    expect(links).toEqual([
      "OpenFreeMap",
      "© OpenMapTiles",
      "Données © contributeurs OpenStreetMap",
      "NASA FIRMS",
      "EFFIS",
      "MapLibre",
    ]);
    renderAttribution(box, "ign");
    expect(box.textContent).toContain("© IGN, Plan IGN");
  });

  it("draws one legend entry per age class", () => {
    renderLegend(box, AGE_COLOURS);
    expect(box.querySelectorAll(".swatch-dot")).toHaveLength(4);
    expect(box.textContent).toContain("moins de 6 h");
  });
});

describe("selection in the list", () => {
  it("moves the pressed state without rebuilding the buttons", () => {
    renderFoyers(box, { state: "ok", value: foyers }, null, () => undefined);
    const third = box.querySelectorAll("button")[2];
    markSelectedFoyer(box, 3);
    expect(box.querySelectorAll("button")[2]).toBe(third);
    expect(third?.getAttribute("aria-pressed")).toBe("true");
    markSelectedFoyer(box, null);
    expect(box.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  });
});
