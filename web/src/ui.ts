// Rendering of the side panel and the map captions. Every text, and above all
// any text coming from a data source, goes through textContent: no HTML string
// is ever built.

import { BASEMAPS } from "./basemaps";
import type { BurnedArea, Detection, Foyer, LoadResult, Status, Summary } from "./data";
import { type FireWeather, type WeatherSample, nextHours, sampleAt } from "./fireweather";
import * as format from "./format";
import type { Basemap } from "./share";
import { type SourceGroup, ageMinutes, freshness, groupOf, health } from "./status";
import { SPEED_CLASSES, type WindSample, compassAbbreviation, compassPoint } from "./wind";

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function link(text: string, href: string): HTMLAnchorElement {
  return el("a", { href }, text);
}

function plural(count: number, one: string, many: string): string {
  return `${format.number(count)} ${count > 1 ? many : one}`;
}

// ------------------------------------------------------------------ status

export interface StatusModel {
  status: LoadResult<Status>;
  rejected: number;
  now: Date;
  missingFiles: string[];
}

const SOURCE_NAMES: Record<SourceGroup, string> = {
  firms: "Foyers (NASA FIRMS)",
  effis: "Surfaces brûlées et bilan (EFFIS)",
  meteo: "Vent et météo (Open-Meteo, modèle AROME de Météo-France)",
};

export function renderStatus(container: HTMLElement, model: StatusModel): void {
  container.replaceChildren();
  const { status } = model;
  if (status.state !== "ok") {
    container.dataset["state"] = "unavailable";
    const reason = status.state === "missing" ? "aucun fichier publié" : status.message;
    container.append(
      el(
        "p",
        { class: "alert" },
        el("strong", {}, "Données indisponibles. "),
        `La carte n'affiche aucun foyer : les données n'ont pas pu être lues (${reason}). Réessayez dans quelques minutes.`,
      ),
    );
    return;
  }

  const value = status.value;
  const state = freshness(value, model.now);
  container.dataset["state"] = state;
  const minutes = ageMinutes(value.generatedAt, model.now);
  container.append(
    el(
      "p",
      {},
      "Dernière mise à jour : ",
      el(
        "time",
        { datetime: value.generatedAt.toISOString() },
        format.dateTimeLong(value.generatedAt),
      ),
      ` (${format.elapsed(minutes)}).`,
    ),
  );

  if (state === "late") {
    container.append(
      el(
        "p",
        { class: "alert" },
        el("strong", {}, "Données en retard. "),
        "La mise à jour automatique, prévue toutes les 30 minutes, n'a pas eu lieu récemment. La carte montre la dernière situation connue.",
      ),
    );
  } else if (state === "old") {
    container.append(
      el(
        "p",
        { class: "alert alert-strong" },
        el("strong", {}, "Données anciennes. "),
        "Elles datent de plus de 24 heures et ne reflètent pas la situation actuelle.",
      ),
    );
  }

  const { failed, firmsDown } = health(value);
  if (firmsDown) {
    container.append(
      el(
        "p",
        { class: "alert alert-strong" },
        el("strong", {}, "Détections satellite indisponibles. "),
        "Aucun flux NASA FIRMS n'a répondu lors de la dernière mise à jour : l'absence de foyer sur la carte ne signifie pas l'absence de feu.",
      ),
    );
  }

  const list = el("ul", { class: "source-list" });
  for (const source of value.sources) {
    const group = groupOf(source);
    const item = el("li", { "data-ok": String(source.ok) });
    item.append(el("span", { class: "source-name" }, source.label));
    if (source.ok) {
      const count = source.count === null ? "" : `, ${format.number(source.count)} entrées`;
      item.append(el("span", { class: "source-state" }, ` : à jour${count}`));
    } else {
      const last = source.updatedAt
        ? `dernières données du ${format.dateTimeLong(source.updatedAt)}`
        : "aucune donnée disponible";
      item.append(
        el(
          "span",
          { class: "source-state" },
          ` : indisponible lors de la dernière vérification, ${last}`,
        ),
      );
      if (source.error) item.append(el("span", { class: "source-error" }, ` (${source.error})`));
    }
    if (group) item.dataset["group"] = group;
    list.append(item);
  }
  const details = el(
    "details",
    { class: "sources-detail" },
    el("summary", {}, "Détail par source"),
    list,
  );
  if (failed.length > 0) {
    details.open = true;
    const names = [...new Set(failed.map((s) => groupOf(s)).filter((g) => g !== null))]
      .map((g) => SOURCE_NAMES[g])
      .join(", ");
    container.append(
      el(
        "p",
        { class: "alert" },
        el("strong", {}, `${plural(failed.length, "source", "sources")} en échec. `),
        names === "" ? "" : `Sources concernées : ${names}. `,
        "Les données affichées pour ces sources sont les dernières reçues, ou absentes.",
      ),
    );
  }
  container.append(details);

  if (model.missingFiles.length > 0) {
    container.append(
      el(
        "p",
        { class: "muted" },
        `Fichiers non publiés lors de cette mise à jour : ${model.missingFiles.join(", ")}.`,
      ),
    );
  }
  if (model.rejected > 0) {
    container.append(
      el(
        "p",
        { class: "muted" },
        `${plural(model.rejected, "entrée ignorée", "entrées ignorées")} car mal formées.`,
      ),
    );
  }
}

// ------------------------------------------------------------------ foyers

export function foyerTitle(foyer: Foyer): string {
  return `Foyer ${String(foyer.id)}`;
}

export function renderFoyers(
  container: HTMLElement,
  foyers: LoadResult<Foyer[]>,
  selected: number | null,
  onSelect: (foyer: Foyer) => void,
): void {
  container.replaceChildren();
  if (foyers.state !== "ok") {
    container.append(
      el(
        "p",
        { class: "muted" },
        "Liste indisponible : les foyers n'ont pas été publiés lors de la dernière mise à jour.",
      ),
    );
    return;
  }
  if (foyers.value.length === 0) {
    container.append(
      el(
        "p",
        {},
        "Aucun foyer sur les 7 derniers jours : un foyer demande au moins 3 détections proches. Les détections isolées restent visibles sur la carte.",
      ),
    );
    return;
  }
  container.append(
    el(
      "p",
      { class: "muted" },
      `${plural(foyers.value.length, "foyer", "foyers")} sur les 7 derniers jours, par nombre de détections puis du plus récent au plus ancien. Un foyer regroupe au moins 3 détections proches.`,
    ),
  );
  const list = el("ol", { class: "foyer-list" });
  for (const foyer of foyers.value) {
    const button = el(
      "button",
      { type: "button", class: "foyer-button", "data-foyer": String(foyer.id) },
      el("span", { class: "foyer-name" }, foyerTitle(foyer)),
      el(
        "span",
        { class: "foyer-meta" },
        `${plural(foyer.detections, "détection", "détections")}, dernière le ${format.dateTime(foyer.last)}`,
      ),
      foyer.active ? el("span", { class: "badge" }, "actif") : null,
    );
    button.setAttribute("aria-pressed", String(foyer.id === selected));
    button.addEventListener("click", () => {
      onSelect(foyer);
    });
    list.append(el("li", {}, button));
  }
  container.append(list);
}

/** Marks the selected foyer without rebuilding the list, so focus stays put. */
export function markSelectedFoyer(container: HTMLElement, selected: number | null): void {
  for (const button of container.querySelectorAll<HTMLButtonElement>("button[data-foyer]")) {
    button.setAttribute("aria-pressed", String(button.dataset["foyer"] === String(selected)));
  }
}

// ------------------------------------------------------------------ detail

function row(term: string, value: string): Node[] {
  return [el("dt", {}, term), el("dd", {}, value)];
}

export interface WindPoint {
  kind: "wind";
  lat: number;
  lon: number;
  /** Wind at the point for the hour shown, or null where there is none. */
  sample: WindSample | null;
  /** Hour of the wind shown, or null when the file has none for the instant. */
  time: Date | null;
  /** Run of the model, when known. */
  run: Date | null;
  /** True when the hour is after the run of the model: a forecast. */
  forecast: boolean;
}

export type Selection =
  | { kind: "foyer"; foyer: Foyer }
  | { kind: "detection"; detection: Detection }
  | { kind: "burned"; area: BurnedArea }
  | WindPoint
  | null;

const OPEN_METEO = "https://open-meteo.com/";
const MODEL_NAME = "modèle AROME HD de Météo-France";

function kmh(value: number): string {
  return `${format.number(Math.round(value))} km/h`;
}

function renderWind(container: HTMLElement, w: WindPoint): void {
  container.append(el("h3", {}, "Vent à ce point"));
  if (w.sample === null || w.time === null) {
    container.append(
      el(
        "p",
        {},
        w.time === null
          ? "Pas de donnée de vent pour l'instant affiché."
          : "Pas de donnée de vent à ce point : il est en dehors de la zone couverte par le modèle sur cette carte.",
      ),
    );
    return;
  }
  const s = w.sample;
  container.append(
    el(
      "dl",
      {},
      ...row("Position", format.coordinates(w.lat, w.lon)),
      ...row("Heure", format.dateTimeLong(w.time)),
      ...row("Vent moyen à 10 m", kmh(s.speed)),
      ...row("Direction", `de ${compassPoint(s.from)} (${String(s.from)}°)`),
      ...(s.gusts === null ? [] : row("Rafales", kmh(s.gusts))),
      ...row(
        "Source",
        w.run ? `${MODEL_NAME}, calcul du ${format.dateTimeLong(w.run)}` : MODEL_NAME,
      ),
    ),
    el(
      "p",
      { class: "muted" },
      w.forecast
        ? "Prévision du modèle. "
        : "Heure passée : prévision archivée du modèle, pas une mesure. ",
      "Valeur interpolée sur une grille de 0,5° (de 35 à 56 km selon la direction et la latitude) : un ordre de grandeur pour la zone, pas la valeur exacte à ce point. Données ",
      link("Open-Meteo.com", OPEN_METEO),
      ".",
    ),
  );
}

// ------------------------------------------------------- weather of a fire

export type FoyerWeatherModel =
  | { state: "loading" }
  | { state: "unavailable"; reason: string }
  /** No detection in the 24 hours before the update: no weather asked for. */
  | { state: "old" }
  /** A recent cluster whose weather could not be fetched for this update. */
  | { state: "missing" }
  | {
      state: "ok";
      weather: FireWeather;
      /** Hour of the entry for the instant shown, or null when it has none. */
      hour: number | null;
      /** Distance from the centre of the cluster to the point of the model, km. */
      distanceKm: number;
    };

function degrees(value: number | null): string {
  return value === null ? "sans donnée" : `${format.decimal(value)} °C`;
}

function percent(value: number | null): string {
  return value === null ? "sans donnée" : `${format.number(value)} %`;
}

function millimetres(value: number | null): string {
  return value === null ? "sans donnée" : `${format.decimal(value)} mm`;
}

function windText(speed: number | null, from: number | null): string {
  if (speed === null) return "sans donnée";
  return from === null ? kmh(speed) : `${kmh(speed)}, de ${compassPoint(from)} (${String(from)}°)`;
}

/** A number of a table cell, the unit being in the column header. */
function cell(value: number | null, decimals = false): string {
  if (value === null) return "sans donnée";
  return decimals ? format.decimal(value) : format.number(Math.round(value));
}

function hourRows(rows: WeatherSample[]): HTMLTableElement {
  let day = "";
  const body = rows.map((r) => {
    const time = new Date(r.time * 1000);
    const today = format.dayShort(time);
    const label = today === day ? format.hour(time) : `${today} ${format.hour(time)}`;
    day = today;
    const wind =
      r.speed === null || r.direction === null
        ? cell(r.speed)
        : `${cell(r.speed)} ${compassAbbreviation(r.direction)}`;
    return el(
      "tr",
      {},
      el("th", { scope: "row" }, label),
      el("td", {}, cell(r.temperature, true)),
      el("td", {}, cell(r.humidity)),
      el("td", {}, wind),
      el("td", {}, cell(r.gusts)),
      el("td", {}, cell(r.precipitation, true)),
    );
  });
  const headers = [
    "Heure",
    "Temp. (°C)",
    "Humidité (%)",
    "Vent (km/h)",
    "Rafales sur 3 h (km/h)",
    "Pluie sur 3 h (mm)",
  ];
  return el(
    "table",
    { class: "weather-table" },
    el("caption", {}, "Heures suivantes, toutes les 3 heures"),
    el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...body),
  );
}

/** Weather of the AROME model at the fire cluster, at the instant shown. */
export function renderFoyerWeather(container: HTMLElement, model: FoyerWeatherModel): void {
  container.replaceChildren(el("h4", {}, "Météo au foyer"));
  if (model.state !== "ok") {
    const text = {
      loading: "Chargement de la météo…",
      unavailable: model.state === "unavailable" ? `Météo indisponible (${model.reason}).` : "",
      old: "Météo non calculée : aucune détection depuis 24 heures.",
      missing:
        "Météo pas encore disponible pour ce foyer : elle sera demandée à une prochaine mise à jour.",
    }[model.state];
    container.append(el("p", { class: "muted" }, text));
    return;
  }
  const w = model.weather;
  if (model.hour === null) {
    container.append(el("p", {}, "Pas de météo pour l'instant affiché."));
    return;
  }
  const s = sampleAt(w, model.hour);
  const time = new Date(s.time * 1000);
  const reference = w.run ?? w.fetchedAt;
  const forecast = time > reference;
  const rows = nextHours(w, model.hour);
  container.append(
    el(
      "dl",
      {},
      ...row("Heure", format.dateTimeLong(time)),
      ...row("Température à 2 m", degrees(s.temperature)),
      ...row("Humidité relative", percent(s.humidity)),
      ...row("Vent moyen à 10 m", windText(s.speed, s.direction)),
      ...row("Rafales sur l'heure", s.gusts === null ? "sans donnée" : kmh(s.gusts)),
      ...row("Pluie sur l'heure", millimetres(s.precipitation)),
      ...row(
        "Source",
        w.run ? `${MODEL_NAME}, calcul du ${format.dateTimeLong(w.run)}` : MODEL_NAME,
      ),
    ),
    rows.length > 0 ? hourRows(rows) : el("p", {}, "Pas d'heure suivante dans les données."),
    el(
      "p",
      { class: "muted" },
      forecast
        ? "Prévision du modèle. "
        : "Heure passée : prévision archivée du modèle, pas une mesure. ",
      `Valeurs d'un point du modèle sur terre, à ${format.decimal(model.distanceKm)} km du centre du foyer`,
      w.elevation === null ? "" : `, altitude ${format.number(Math.round(w.elevation))} m`,
      ". Les conditions sur le feu lui-même peuvent être très différentes. Données ",
      link("Open-Meteo.com", OPEN_METEO),
      ".",
    ),
  );
}

export function renderDetail(container: HTMLElement, selection: Selection, now: Date): void {
  container.replaceChildren();
  if (selection === null) {
    container.append(
      el(
        "p",
        { class: "muted" },
        "Choisissez un foyer dans la liste ou sur la carte pour afficher son détail.",
      ),
    );
    return;
  }
  if (selection.kind === "wind") {
    renderWind(container, selection);
    return;
  }
  if (selection.kind === "foyer") {
    const f = selection.foyer;
    const since = ageMinutes(f.last, now);
    container.append(
      el("h3", {}, foyerTitle(f)),
      el(
        "dl",
        {},
        ...row("Position", format.coordinates(f.lat, f.lon)),
        ...row(
          "Détections",
          `${format.number(f.detections)} sur 7 jours, dont ${format.number(f.detections24h)} sur 24 heures`,
        ),
        ...row("Première détection", format.dateTimeLong(f.first)),
        ...row("Dernière détection", `${format.dateTimeLong(f.last)} (${format.elapsed(since)})`),
        ...row(
          "Activité",
          f.active
            ? "actif : détection dans les 6 heures précédant la mise à jour"
            : "aucune détection dans les 6 heures précédant la mise à jour",
        ),
        ...(f.maxFrp === null
          ? []
          : row("Puissance radiative maximale", `${format.decimal(f.maxFrp)} MW`)),
        ...(f.estimatedAreaHa === null
          ? []
          : row("Surface estimée", format.hectares(f.estimatedAreaHa))),
      ),
      el(
        "p",
        { class: "muted" },
        "La surface estimée découle de la taille des pixels détectés : c'est un ordre de grandeur, pas une mesure de la surface brûlée.",
      ),
      // Follows the timeline without being read again at each step: the
      // slider already says the instant.
      el("section", { class: "foyer-weather", "aria-live": "off" }),
    );
    return;
  }
  if (selection.kind === "detection") {
    const d = selection.detection;
    const confidence =
      d.confidence !== null
        ? format.CONFIDENCE_LABELS[d.confidence]
        : d.confidencePct !== null
          ? `${format.number(d.confidencePct)} %`
          : "non indiquée";
    container.append(
      el("h3", {}, "Détection satellite"),
      el(
        "dl",
        {},
        ...row("Acquisition", format.dateTimeLong(new Date(d.t * 1000))),
        ...row("Capteur", format.SATELLITE_LABELS[d.satellite]),
        ...row("Position", format.coordinates(d.lat, d.lon)),
        ...row("Confiance", confidence),
        ...(d.frp === null ? [] : row("Puissance radiative", `${format.decimal(d.frp)} MW`)),
        ...(d.daytime === null ? [] : row("Passage", d.daytime ? "de jour" : "de nuit")),
        ...row("Foyer", d.foyer === null ? "détection isolée" : `Foyer ${String(d.foyer)}`),
      ),
    );
    return;
  }
  const a = selection.area;
  if (a.kind === "nrt") {
    container.append(
      el("h3", {}, "Surface brûlée récente"),
      el(
        "p",
        {},
        "Surface cartographiée en temps quasi réel par EFFIS. Cette couche ne précise ni la date ni la commune.",
      ),
    );
    return;
  }
  container.append(
    el("h3", {}, "Surface brûlée"),
    el(
      "dl",
      {},
      ...(a.commune ? row("Commune", a.commune) : []),
      ...(a.province ? row("Département", a.province) : []),
      ...(a.date ? row("Date du feu", format.day(a.date)) : []),
      ...(a.areaHa === null ? [] : row("Surface", format.hectares(a.areaHa))),
      ...(a.updated ? row("Mise à jour EFFIS", format.day(a.updated)) : []),
    ),
  );
}

// ----------------------------------------------------------------- summary

export function renderSummary(container: HTMLElement, summary: LoadResult<Summary>): void {
  container.replaceChildren();
  if (summary.state !== "ok") {
    container.append(
      el("p", { class: "muted" }, "Bilan indisponible lors de la dernière mise à jour."),
    );
    return;
  }
  const s = summary.value;
  const until = s.lastWeekDate ? ` jusqu'à la semaine du ${format.day(s.lastWeekDate)}` : "";
  container.append(
    el(
      "p",
      {},
      `Saison ${String(s.year)}${until}, en France selon EFFIS : `,
      el("strong", {}, format.hectares(s.burnedHa)),
      " brûlés",
      s.events === null ? "" : `, ${plural(s.events, "feu cartographié", "feux cartographiés")}`,
      ".",
    ),
  );
  if (s.averageHa !== null) {
    container.append(
      el(
        "p",
        { class: "muted" },
        `Moyenne EFFIS depuis 2006 sur les mêmes semaines : ${format.hectares(s.averageHa)}.`,
      ),
    );
  }
}

// ---------------------------------------------------------- map captions

export function renderAttribution(container: HTMLElement, basemap: Basemap, wind = false): void {
  container.replaceChildren();
  const parts: Node[] = [];
  for (const item of BASEMAPS[basemap].attribution) {
    if (parts.length > 0) parts.push(document.createTextNode(" | "));
    parts.push(link(item.text, item.href));
  }
  parts.push(document.createTextNode(" | Détections "));
  parts.push(link("NASA FIRMS", "https://firms.modaps.eosdis.nasa.gov/"));
  parts.push(document.createTextNode(" | Surfaces brûlées "));
  parts.push(link("EFFIS", "https://forest-fire.emergency.copernicus.eu/"));
  if (wind) {
    parts.push(document.createTextNode(` | Vent ${MODEL_NAME}, données `));
    parts.push(link("Open-Meteo.com", OPEN_METEO));
  }
  parts.push(document.createTextNode(" | "));
  parts.push(link("MapLibre", "https://maplibre.org/"));
  container.append(...parts);
}

export function renderLegend(container: HTMLElement, colours: readonly string[]): void {
  const labels = ["moins de 6 h", "6 à 24 h", "1 à 3 jours", "3 à 7 jours"];
  const ages = el("ul", { class: "legend-list" });
  colours.forEach((colour, index) => {
    const swatch = el("span", { class: "swatch swatch-dot", "aria-hidden": "true" });
    swatch.style.background = colour;
    ages.append(el("li", {}, swatch, labels[index] ?? ""));
  });
  const shapes = el(
    "ul",
    { class: "legend-list" },
    el(
      "li",
      {},
      el("span", { class: "swatch swatch-foyer swatch-active", "aria-hidden": "true" }),
      "foyer actif",
    ),
    el(
      "li",
      {},
      el("span", { class: "swatch swatch-foyer", "aria-hidden": "true" }),
      "foyer sans détection récente",
    ),
    el(
      "li",
      {},
      el("span", { class: "swatch swatch-dated", "aria-hidden": "true" }),
      "surface brûlée datée",
    ),
    el(
      "li",
      {},
      el("span", { class: "swatch swatch-nrt", "aria-hidden": "true" }),
      "surface brûlée récente",
    ),
  );
  container.replaceChildren(
    el("h3", { class: "legend-title" }, "Légende"),
    el("p", { class: "legend-caption" }, "Âge des détections à l'instant affiché"),
    ages,
    shapes,
  );
}

export type WindLegendModel =
  | { state: "loading" }
  | { state: "unavailable"; reason: string }
  | {
      state: "ok";
      /** Hour of the wind shown, or null when the file has none for the instant. */
      time: Date | null;
      run: Date | null;
      forecast: boolean;
      animated: boolean;
    };

const SPEED_LABELS = [
  `moins de ${String(SPEED_CLASSES[0])} km/h`,
  `${String(SPEED_CLASSES[0])} à ${String(SPEED_CLASSES[1])} km/h`,
  `${String(SPEED_CLASSES[1])} à ${String(SPEED_CLASSES[2])} km/h`,
  `${String(SPEED_CLASSES[2])} à ${String(SPEED_CLASSES[3])} km/h`,
  `${String(SPEED_CLASSES[3])} km/h et plus`,
];

/** Legend of the wind layer: speed classes, hour shown, source. */
export function renderWindLegend(
  container: HTMLElement,
  model: WindLegendModel,
  colours: readonly string[],
): void {
  container.replaceChildren(el("h3", { class: "legend-title" }, "Vent à 10 m"));
  container.dataset["state"] =
    model.state === "ok" ? (model.animated ? "anime" : "fixe") : model.state;
  if (model.state === "loading") {
    container.append(el("p", { class: "legend-caption" }, "Chargement du vent…"));
    return;
  }
  if (model.state === "unavailable") {
    container.append(el("p", { class: "legend-caption" }, `Vent indisponible (${model.reason}).`));
    return;
  }
  const speeds = el("ul", { class: "legend-list" });
  colours.forEach((colour, index) => {
    const swatch = el("span", { class: "swatch swatch-wind", "aria-hidden": "true" });
    swatch.style.background = colour;
    speeds.append(el("li", {}, swatch, SPEED_LABELS[index] ?? ""));
  });
  const when =
    model.time === null
      ? "Pas de donnée de vent pour l'instant affiché."
      : `${model.forecast ? "Prévision" : "Prévision archivée"} pour le ${format.dateTime(model.time)}${
          model.run ? `, calcul du ${format.dateTime(model.run)}` : ""
        }.`;
  container.append(
    el(
      "p",
      { class: "legend-caption" },
      model.animated
        ? "Les traits suivent le vent ; leur vitesse à l'écran croît avec celle du vent."
        : "Les flèches indiquent où souffle le vent.",
    ),
    speeds,
    el("p", { class: "legend-caption" }, when),
    el(
      "p",
      { class: "legend-caption" },
      `${MODEL_NAME[0]?.toUpperCase() ?? ""}${MODEL_NAME.slice(1)}, données `,
      link("Open-Meteo.com", OPEN_METEO),
      ". Un clic sur la carte donne le vent au point.",
    ),
  );
}
