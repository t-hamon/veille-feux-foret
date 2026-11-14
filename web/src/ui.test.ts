import { beforeEach, describe, expect, it } from "vitest";
import completBilan from "../e2e/fixtures/complet/bilan.json?raw";
import completDetections from "../e2e/fixtures/complet/detections.geojson?raw";
import completEtat from "../e2e/fixtures/complet/etat.json?raw";
import completFoyers from "../e2e/fixtures/complet/foyers.geojson?raw";
import completSurfaces from "../e2e/fixtures/complet/surfaces-brulees.geojson?raw";
import panneEtat from "../e2e/fixtures/firms-en-panne/etat.json?raw";
import stationsEtat from "../e2e/fixtures/stations/etat.json?raw";
import stationsFile from "../e2e/fixtures/stations/stations-vent.json?raw";
import ventEtat from "../e2e/fixtures/vent/etat.json?raw";
import ventMeteo from "../e2e/fixtures/vent/meteo-foyers.json?raw";
import {
  type Foyer,
  parseBurned,
  parseDetections,
  parseFoyers,
  parseStatus,
  parseSummary,
} from "./data";
import { parseFireWeather } from "./fireweather";
import { AGE_COLOURS, WIND_COLOURS } from "./palette";
import { parseStations, sampleAtStation, stationsAt } from "./stations";
import {
  markSelectedFoyer,
  renderAttribution,
  renderDetail,
  renderFoyerStation,
  renderFoyerWeather,
  renderFoyers,
  renderLegend,
  renderStationsLegend,
  renderStatus,
  renderSummary,
  renderWindLegend,
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

  it("names the weather sources when Open-Meteo fails", () => {
    const value = parseStatus(JSON.parse(ventEtat));
    const wind = value.sources.find((s) => s.id === "open_meteo_wind");
    expect(wind?.ok).toBe(true);
    // The status of an Open-Meteo outage, as the pipeline writes it.
    const failed = value.sources.map((s) =>
      s.id === "open_meteo_wind" ? { ...s, ok: false, error: "serveur injoignable" } : s,
    );
    renderStatus(box, {
      status: { state: "ok", value: { ...value, sources: failed } },
      rejected: 0,
      now: new Date(value.generatedAt.getTime() + 5 * 60_000),
      missingFiles: [],
    });
    expect(box.textContent).toContain("1 source en échec");
    expect(box.textContent).toContain(
      "Sources concernées : Vent et météo (Open-Meteo, modèle AROME de Météo-France).",
    );
    // A source of a group the page does not know is listed, never left unnamed.
    const unknown = value.sources.map((s) =>
      s.id === "open_meteo_wind" ? { ...s, id: "nouvelle_source", ok: false } : s,
    );
    renderStatus(box, {
      status: { state: "ok", value: { ...value, sources: unknown } },
      rejected: 0,
      now: new Date(value.generatedAt.getTime() + 5 * 60_000),
      missingFiles: [],
    });
    expect(box.textContent).toContain("1 source en échec. Les données affichées");
    expect(box.textContent).not.toContain("Sources concernées : .");
  });

  it("names the stations of Météo-France when they fail", () => {
    const value = parseStatus(JSON.parse(stationsEtat));
    expect(value.sources.find((s) => s.id === "meteofrance_stations")?.count).toBe(726);
    const failed = value.sources.map((s) =>
      s.id === "meteofrance_stations" ? { ...s, ok: false, error: "jeton refusé" } : s,
    );
    renderStatus(box, {
      status: { state: "ok", value: { ...value, sources: failed } },
      rejected: 0,
      now: new Date(value.generatedAt.getTime() + 5 * 60_000),
      missingFiles: [],
    });
    expect(box.textContent).toContain("1 source en échec");
    expect(box.textContent).toContain(
      "Sources concernées : Vent mesuré aux stations (Météo-France).",
    );
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
    expect(box.textContent).not.toContain("Vent");
  });

  it("credits the wind model and Open-Meteo when the wind is shown", () => {
    renderAttribution(box, "ign", true);
    expect(box.textContent).toContain(
      "| Vent modèle AROME HD de Météo-France, données Open-Meteo.com |",
    );
    const link = [...box.querySelectorAll("a")].find((a) => a.textContent === "Open-Meteo.com");
    expect(link?.getAttribute("href")).toBe("https://open-meteo.com/");
  });

  it("credits the stations of Météo-France when they are shown", () => {
    renderAttribution(box, "osm", false, true);
    expect(box.textContent).toContain(
      "| Surfaces brûlées EFFIS | Vent mesuré Météo-France | MapLibre",
    );
    expect(box.textContent).not.toContain("Open-Meteo");
    renderAttribution(box, "osm", true, true);
    expect(box.textContent).toContain("Open-Meteo.com | Vent mesuré Météo-France | MapLibre");
    renderAttribution(box, "osm", true);
    expect(box.textContent).not.toContain("Vent mesuré");
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

describe("weather of a fire", () => {
  const weather = parseFireWeather(JSON.parse(ventMeteo)).file.fires.get(1);
  if (!weather) throw new Error("no weather for fire 1");

  it("has its place in the sheet of a fire, out of the live announcements", () => {
    const foyer = foyers[0];
    if (!foyer) throw new Error("no foyer");
    renderDetail(box, { kind: "foyer", foyer }, later(0));
    const section = box.querySelector(".foyer-weather");
    expect(section?.getAttribute("aria-live")).toBe("off");
  });

  it("gives the weather of the hour shown, the next hours, its source and its limits", () => {
    renderFoyerWeather(box, { state: "ok", weather, hour: 169, distanceKm: 0.224 });
    expect(box.querySelector("h4")?.textContent).toBe("Météo au foyer");
    const text = box.textContent;
    expect(text).toContain("Heure12 octobre 2026 à 03:00");
    expect(text).toContain("Température à 2 m5,8 °C");
    expect(text).toContain("Humidité relative100 %");
    expect(text).toContain("Vent moyen à 10 m5 km/h, de sud-est (127°)");
    expect(text).toContain("Rafales sur l'heure9 km/h");
    expect(text).toContain("Pluie sur l'heure0 mm");
    expect(text).toContain("calcul du 11 octobre 2026 à 20:00");
    expect(text).toContain("Prévision du modèle.");
    expect(text).toContain("à 0,2 km du centre du foyer, altitude 154 m");
    expect(box.querySelector("a")?.getAttribute("href")).toBe("https://open-meteo.com/");

    const table = box.querySelector("table");
    expect(table?.querySelector("caption")?.textContent).toBe(
      "Heures suivantes, toutes les 3 heures",
    );
    const headers = [...(table?.querySelectorAll("thead th") ?? [])].map((h) => h.textContent);
    expect(headers).toEqual([
      "Heure",
      "Temp. (°C)",
      "Humidité (%)",
      "Vent (km/h)",
      "Rafales sur 3 h (km/h)",
      "Pluie sur 3 h (mm)",
    ]);
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])].map((r) =>
      [...r.children].map((c) => c.textContent),
    );
    expect(rows).toHaveLength(8);
    // The day is written on the first row and when it changes.
    expect(rows[0]).toEqual(["12 oct. 06:00", "5,3", "98", "9 ESE", "13", "0"]);
    expect(rows[1]?.[0]).toBe("09:00");
    expect(rows[6]?.[0]).toBe("13 oct. 00:00");
    expect(table?.querySelector("tbody th")?.getAttribute("scope")).toBe("row");
  });

  it("says when the hour is past, or has no value", () => {
    renderFoyerWeather(box, { state: "ok", weather, hour: 10, distanceKm: 0.224 });
    expect(box.textContent).toContain(
      "Heure passée : prévision archivée du modèle, pas une mesure.",
    );
    const empty = { ...weather, temperature: weather.temperature.map(() => null) };
    renderFoyerWeather(box, { state: "ok", weather: empty, hour: 169, distanceKm: 0.224 });
    expect(box.textContent).toContain("Température à 2 msans donnée");
    expect(box.querySelector("tbody td")?.textContent).toBe("sans donnée");
    renderFoyerWeather(box, { state: "ok", weather, hour: 212, distanceKm: 0.224 });
    expect(box.querySelector("table")).toBeNull();
    expect(box.textContent).toContain("Pas d'heure suivante dans les données.");
    renderFoyerWeather(box, { state: "ok", weather, hour: null, distanceKm: 0.224 });
    expect(box.textContent).toContain("Pas de météo pour l'instant affiché.");
  });

  it("explains why there is no weather", () => {
    renderFoyerWeather(box, { state: "loading" });
    expect(box.textContent).toContain("Chargement de la météo…");
    renderFoyerWeather(box, { state: "unavailable", reason: "non publiée" });
    expect(box.textContent).toContain("Météo indisponible (non publiée).");
    renderFoyerWeather(box, { state: "old" });
    expect(box.textContent).toContain("Météo non calculée : aucune détection depuis 24 heures.");
    renderFoyerWeather(box, { state: "missing" });
    expect(box.textContent).toContain(
      "Météo pas encore disponible pour ce foyer : elle sera demandée à une prochaine mise à jour.",
    );
  });
});

describe("wind", () => {
  const time = new Date("2026-10-12T01:00:00Z");
  const run = new Date("2026-10-11T18:00:00Z");

  it("gives the wind at a point, with its source and its limits", () => {
    renderDetail(
      box,
      {
        kind: "wind",
        lat: 46.5,
        lon: 2.5,
        sample: { speed: 23.4, from: 248, gusts: 41.6 },
        time,
        run,
        forecast: true,
      },
      later(0),
    );
    expect(box.querySelector("h3")?.textContent).toBe("Vent à ce point");
    const text = box.textContent;
    expect(text).toContain("Vent moyen à 10 m23 km/h");
    expect(text).toContain("Directionde ouest-sud-ouest (248°)");
    expect(text).toContain("Rafales42 km/h");
    expect(text).toContain("calcul du 11 octobre 2026 à 20:00");
    expect(text).toContain("Prévision du modèle.");
    expect(text).toContain("grille de 0,5°");
    expect(box.querySelector("a")?.getAttribute("href")).toBe("https://open-meteo.com/");
  });

  it("says when an hour is past, or when there are no gusts or no wind", () => {
    const point = { kind: "wind" as const, lat: 46.5, lon: 2.5, time, run, forecast: false };
    renderDetail(box, { ...point, sample: { speed: 5, from: 0, gusts: null } }, later(0));
    expect(box.textContent).toContain("prévision archivée du modèle, pas une mesure");
    expect(box.textContent).not.toContain("Rafales");
    renderDetail(box, { ...point, sample: null }, later(0));
    expect(box.textContent).toContain("en dehors de la zone couverte");
    renderDetail(box, { ...point, sample: null, time: null }, later(0));
    expect(box.textContent).toContain("Pas de donnée de vent pour l'instant affiché.");
  });

  it("draws the legend of the wind for each state", () => {
    renderWindLegend(box, { state: "loading" }, WIND_COLOURS);
    expect(box.dataset["state"]).toBe("loading");
    expect(box.textContent).toContain("Chargement du vent");

    renderWindLegend(box, { state: "unavailable", reason: "non publié" }, WIND_COLOURS);
    expect(box.dataset["state"]).toBe("unavailable");
    expect(box.textContent).toContain("Vent indisponible (non publié).");

    renderWindLegend(box, { state: "ok", time, run, forecast: true, animated: true }, WIND_COLOURS);
    expect(box.dataset["state"]).toBe("anime");
    expect(box.querySelectorAll(".swatch-wind")).toHaveLength(5);
    expect(box.textContent).toContain("moins de 10 km/h");
    expect(box.textContent).toContain("30 à 50 km/h");
    expect(box.textContent).toContain("Les traits suivent le vent");
    expect(box.textContent).toContain(
      "Prévision pour le 12 oct., 03:00, calcul du 11 oct., 20:00.",
    );

    renderWindLegend(
      box,
      { state: "ok", time, run: null, forecast: false, animated: false },
      WIND_COLOURS,
    );
    expect(box.dataset["state"]).toBe("fixe");
    expect(box.textContent).toContain("Les flèches indiquent où souffle le vent.");
    expect(box.textContent).toContain("Prévision archivée pour le 12 oct., 03:00.");

    renderWindLegend(
      box,
      { state: "ok", time: null, run, forecast: false, animated: false },
      WIND_COLOURS,
    );
    expect(box.textContent).toContain("Pas de donnée de vent pour l'instant affiché.");
  });
});

describe("wind measured at the stations", () => {
  const { file } = parseStations(JSON.parse(stationsFile));
  // 11 November 2026 at 23:00 UTC, 00:00 in Paris.
  const latest = Date.UTC(2026, 10, 11, 23) / 1000;
  const arbent = file.stations[0];
  if (!arbent) throw new Error("no station");
  const point = { kind: "station" as const, index: 0, station: arbent, forecast: false };
  const calm = stationsAt(file, latest).find((s) => s.station.name === "LURCY-LEVIS SA");
  if (!calm) throw new Error("no calm station");

  it("details a station and its measurement, with its source", () => {
    renderDetail(box, { ...point, sample: sampleAtStation(file, 0, latest) }, later(0));
    expect(box.querySelector("h3")?.textContent).toBe("Station Météo-France : ARBENT");
    const text = box.textContent;
    expect(text).toContain("Position46,2782° N, 5,6690° E");
    expect(text).toContain("Altitude534 m");
    expect(text).toContain("Heure de la mesure12 novembre 2026 à 00:00");
    expect(text).toContain("Vent moyen sur 10 min, à 10 m3 km/h");
    expect(text).toContain("Directionde est-nord-est (70°)");
    expect(text).toContain("Rafale maximale de l'heure9 km/h");
    expect(text).toContain("SourceMétéo-France, mesures horaires des stations au sol");
    expect(text).toContain("la dernière faite à l'instant affiché, à l'heure ronde");
  });

  it("says when a station has no measurement, or no name, or no altitude", () => {
    renderDetail(box, { ...point, sample: null }, later(0));
    expect(box.textContent).toContain("Pas de mesure de cette station pour l'heure affichée.");
    expect(box.textContent).not.toContain("Heure de la mesure");
    renderDetail(box, { ...point, sample: null, forecast: true }, later(0));
    expect(box.textContent).toContain("Pas de mesure pour une heure de prévision.");
    const unnamed = { ...arbent, name: null, altitude: null };
    renderDetail(box, { ...point, station: unnamed, sample: null }, later(0));
    expect(box.querySelector("h3")?.textContent).toBe("Station Météo-France : station 01014002");
    expect(box.textContent).not.toContain("Altitude");
  });

  it("gives a calm, and a measurement without values, as such", () => {
    renderDetail(box, { ...point, station: calm.station, sample: calm }, later(0));
    expect(box.textContent).toContain("Vent moyen sur 10 min, à 10 m0 km/h");
    expect(box.textContent).toContain("Directionvent calme");
    expect(box.textContent).toContain("Rafale maximale de l'heure5 km/h");
    const empty = { ...calm, speed: null, gusts: null };
    renderDetail(box, { ...point, station: calm.station, sample: empty }, later(0));
    expect(box.textContent).toContain("Vent moyen sur 10 min, à 10 msans donnée");
    expect(box.textContent).toContain("Directionsans donnée");
    expect(box.textContent).toContain("Rafale maximale de l'heuresans donnée");
  });

  it("has its place in the sheet of a fire, out of the live announcements", () => {
    const foyer = foyers[0];
    if (!foyer) throw new Error("no foyer");
    renderDetail(box, { kind: "foyer", foyer }, later(0));
    const sections = [...box.querySelectorAll("section")].map((s) => s.className);
    expect(sections).toEqual(["foyer-weather", "foyer-station"]);
    expect(box.querySelector(".foyer-station")?.getAttribute("aria-live")).toBe("off");
  });

  it("gives the closest station of a fire, with its distance and its limits", () => {
    const sample = sampleAtStation(file, 0, latest);
    if (!sample) throw new Error("no measurement");
    renderFoyerStation(box, { state: "ok", sample, distanceKm: 22.24 });
    expect(box.querySelector("h4")?.textContent).toBe("Vent mesuré à la station la plus proche");
    const text = box.textContent;
    expect(text).toContain("StationARBENT, altitude 534 m");
    expect(text).toContain("Distance22,2 km du centre du foyer");
    expect(text).toContain("Heure de la mesure12 novembre 2026 à 00:00");
    expect(text).toContain("Directionde est-nord-est (70°)");
    expect(text).toContain("le vent sur le feu peut être différent");
    renderFoyerStation(box, {
      state: "ok",
      sample: { ...sample, station: { ...arbent, altitude: null } },
      distanceKm: 3,
    });
    expect(box.textContent).toContain("StationARBENTDistance3 km du centre du foyer");
  });

  it("explains why a fire has no station", () => {
    const cases: [Parameters<typeof renderFoyerStation>[1], string][] = [
      [{ state: "loading" }, "Chargement des stations…"],
      [
        { state: "unavailable", reason: "non publiées" },
        "Mesures des stations indisponibles (non publiées).",
      ],
      [{ state: "forecast" }, "Pas de mesure pour une heure de prévision."],
      [
        { state: "none", maxKm: 50 },
        "Aucune station n'a mesuré le vent à cette heure à moins de 50 km du foyer.",
      ],
    ];
    for (const [model, text] of cases) {
      renderFoyerStation(box, model);
      expect(box.querySelector("h4")?.textContent).toBe("Vent mesuré à la station la plus proche");
      expect(box.querySelector("p")?.textContent).toBe(text);
      expect(box.querySelector("dl")).toBeNull();
    }
  });

  it("draws the legend of the stations in each state", () => {
    const time = new Date(latest * 1000);
    const line = () => box.querySelector(".legend-stations");
    renderStationsLegend(box, { state: "ok", time, count: 719 });
    expect(box.querySelector("h3")?.textContent).toBe("Vent mesuré");
    expect(box.dataset["state"]).toBe("ok");
    expect(line()?.querySelector(".swatch-station")?.getAttribute("aria-hidden")).toBe("true");
    expect(line()?.textContent).toBe(
      "719 stations Météo-France à 00:00 : la flèche indique où souffle le vent, le nombre sa vitesse moyenne en km/h ; un clic donne le détail.",
    );
    expect(box.textContent).toContain(
      "Les stations qui se chevaucheraient sont masquées : zoomer pour les voir toutes.",
    );
    renderStationsLegend(box, { state: "ok", time, count: 1 });
    expect(line()?.textContent).toContain("1 station Météo-France à 00:00");
    renderStationsLegend(box, { state: "ok", time: null, count: 0 });
    expect(line()?.textContent).toBe(
      "Stations Météo-France : pas de mesure pour l'instant affiché.",
    );
    expect(box.textContent).not.toContain("zoomer");
    renderStationsLegend(box, { state: "forecast" });
    expect(box.dataset["state"]).toBe("forecast");
    expect(line()?.textContent).toBe(
      "Stations Météo-France : pas de mesure pour une heure de prévision.",
    );
    renderStationsLegend(box, { state: "loading" });
    expect(line()?.textContent).toBe("Chargement des mesures des stations…");
    renderStationsLegend(box, { state: "unavailable", reason: "non publiées" });
    expect(line()?.textContent).toBe("Mesures des stations indisponibles (non publiées).");
  });

  it("keeps the legend of the wind without the stations", () => {
    const time = new Date(latest * 1000);
    renderWindLegend(
      box,
      { state: "ok", time, run: null, forecast: false, animated: false },
      WIND_COLOURS,
    );
    expect(box.querySelector(".legend-stations")).toBeNull();
    expect(box.textContent).not.toContain("Météo-France à");
  });

  it("never interprets the name of a station as HTML", () => {
    const named = { ...arbent, name: "<img src=x>" };
    renderDetail(box, { ...point, station: named, sample: null }, later(0));
    expect(box.querySelector("img")).toBeNull();
    expect(box.querySelector("h3")?.textContent).toBe("Station Météo-France : <img src=x>");
  });
});
