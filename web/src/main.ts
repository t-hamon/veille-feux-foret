import "./styles.css";
import {
  type BurnedArea,
  type Detection,
  type Foyer,
  type LoadResult,
  type Outline,
  type Status,
  loadFile,
  parseBurned,
  parseDetections,
  parseFoyers,
  parseOutlines,
  parseStatus,
  parseSummary,
} from "./data";
import * as format from "./format";
import type { MapHandle, Picked } from "./map";
import { AGE_COLOURS, WIND_COLOURS } from "./palette";
import { type Basemap, type SharedState, type View, formatFragment, parseFragment } from "./share";
import { LABELS, applyTheme, loadPreference, nextPreference, savePreference } from "./theme";
import { type Range, instantAt, rangeOf, stepOf } from "./timeline";
import {
  type Selection,
  type WindLegendModel,
  type WindPoint,
  markSelectedFoyer,
  renderAttribution,
  renderDetail,
  renderFoyers,
  renderLegend,
  renderStatus,
  renderSummary,
  renderWindLegend,
} from "./ui";
import { type WindField, hourAt, hourTime, parseWind, sampleAt } from "./wind";

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  type: new () => T = HTMLElement as unknown as new () => T,
): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`élément absent : ${selector}`);
  return node;
}

// ------------------------------------------------------------------- theme

const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: dark)");
let themePreference = loadPreference(storage());
const themeButton = $("#theme-toggle", HTMLButtonElement);

function renderTheme(): void {
  applyTheme(root, themePreference, media.matches);
  themeButton.textContent = LABELS[themePreference];
  themeButton.setAttribute("aria-label", `${LABELS[themePreference]}. Changer de thème`);
}

themeButton.addEventListener("click", () => {
  themePreference = nextPreference(themePreference);
  savePreference(storage(), themePreference);
  renderTheme();
});
media.addEventListener("change", renderTheme);
renderTheme();

// -------------------------------------------------------------- page state

const BASEMAP_KEY = "veille-feux:fond";

function loadBasemap(): Basemap | undefined {
  try {
    const value = storage()?.getItem(BASEMAP_KEY);
    return value === "ign" || value === "osm" ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveBasemap(value: Basemap): void {
  try {
    storage()?.setItem(BASEMAP_KEY, value);
  } catch {
    // Not remembered, nothing else to do.
  }
}

const shared = parseFragment(window.location.hash);

interface PageState {
  basemap: Basemap;
  view: View | undefined;
  instant: number | null;
  range: Range | null;
  selection: Selection;
  burnedVisible: boolean;
  windVisible: boolean;
  windAnimated: boolean;
}

// Visitors who ask for reduced motion get still arrows; they can still start
// the animation.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state: PageState = {
  basemap: shared.basemap ?? loadBasemap() ?? "ign",
  view: shared.view,
  instant: null,
  range: null,
  selection: null,
  burnedVisible: shared.burned ?? false,
  windVisible: shared.wind ?? false,
  windAnimated: !reducedMotion,
};

let map: MapHandle | null = null;
let burned: LoadResult<BurnedArea[]> | null = null;
let burnedRejected = 0;
let wind: LoadResult<WindField> | null = null;
let windRejected = 0;
let refreshStatus = (): void => undefined;

const panel = {
  status: $("#etat"),
  detail: $("#detail"),
  foyers: $("#foyers"),
  summary: $("#bilan"),
};
const notice = $("#notice");
const mapMessage = $("#carte-message");

function updateAddress(): void {
  const next: SharedState = { basemap: state.basemap };
  if (state.view) next.view = state.view;
  if (state.range && state.instant !== null && state.instant < state.range.end) {
    next.instant = state.instant;
  }
  if (state.selection?.kind === "foyer") next.foyer = state.selection.foyer.id;
  if (state.burnedVisible) next.burned = true;
  if (state.windVisible) next.wind = true;
  const fragment = formatFragment(next);
  const url = `${window.location.pathname}${window.location.search}${fragment}`;
  window.history.replaceState(null, "", url);
}

// One message at a time over the map, about the base map, the burned areas or the wind.
type NoticeTopic = "basemap" | "burned" | "wind";
let noticeTopic: NoticeTopic | null = null;

function showNotice(
  topic: NoticeTopic,
  message: string,
  action?: { label: string; run: () => void },
): void {
  noticeTopic = topic;
  notice.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    notice.append(" ", button);
  }
  notice.hidden = false;
}

function hideNotice(topic: NoticeTopic): void {
  if (noticeTopic !== topic) return;
  noticeTopic = null;
  notice.hidden = true;
  notice.replaceChildren();
}

// --------------------------------------------------------------- the data

function items<T>(result: LoadResult<{ items: T[]; rejected: number }>): LoadResult<T[]> {
  return result.state === "ok" ? { state: "ok", value: result.value.items } : result;
}

function rejectedOf(result: LoadResult<{ items: unknown[]; rejected: number }>): number {
  return result.state === "ok" ? result.value.rejected : 0;
}

const fetcher = (url: string): Promise<Response> => fetch(url, { cache: "no-cache" });

async function start(): Promise<void> {
  const [status, detections, foyers, outlines, summary] = await Promise.all([
    loadFile("status", parseStatus, fetcher),
    loadFile("detections", parseDetections, fetcher),
    loadFile("foyers", parseFoyers, fetcher),
    loadFile("outlines", parseOutlines, fetcher),
    loadFile("summary", parseSummary, fetcher),
  ]);

  const missingFiles = (
    [
      ["detections.geojson", detections],
      ["foyers.geojson", foyers],
      ["foyers-emprises.geojson", outlines],
      ["bilan.json", summary],
    ] as const
  )
    .filter(([, result]) => result.state === "missing")
    .map(([name]) => name);
  const rejected = rejectedOf(detections) + rejectedOf(foyers) + rejectedOf(outlines);

  refreshStatus = () => {
    renderStatus(panel.status, {
      status,
      rejected: rejected + burnedRejected + windRejected,
      now: new Date(),
      missingFiles,
    });
  };
  refreshStatus();
  // Keeps "il y a ..." right; the panel is not a live region, so this does
  // not make screen readers read it again.
  window.setInterval(refreshStatus, 60_000);
  renderSummary(panel.summary, summary);

  const foyerList = items(foyers);
  const detectionList = items(detections);
  const outlineList = items(outlines);

  const onSelectFoyer = (foyer: Foyer): void => {
    select({ kind: "foyer", foyer }, true);
  };

  function select(selection: Selection, fly: boolean): void {
    state.selection = selection;
    renderDetail(panel.detail, selection, new Date());
    markSelectedFoyer(panel.foyers, selection?.kind === "foyer" ? selection.foyer.id : null);
    map?.select(selection?.kind === "foyer" ? selection.foyer : null, fly);
    updateAddress();
  }

  renderFoyers(panel.foyers, foyerList, null, onSelectFoyer);
  if (shared.foyer !== undefined && foyerList.state === "ok") {
    const foyer = foyerList.value.find((f) => f.id === shared.foyer);
    if (foyer) select({ kind: "foyer", foyer }, false);
  }

  if (status.state === "ok") setupTimeline(status.value, detectionList);

  await startMap({
    detections: detectionList.state === "ok" ? detectionList.value : [],
    foyers: foyerList.state === "ok" ? foyerList.value : [],
    outlines: outlineList.state === "ok" ? outlineList.value : [],
    select,
  });
}

// ----------------------------------------------------------- the timeline

function setupTimeline(status: Status, detections: LoadResult<Detection[]>): void {
  const range = rangeOf(status.generatedAt, status.windowHours);
  state.range = range;
  const frise = $("#frise");
  const input = $("#instant", HTMLInputElement);
  const output = $("#instant-texte", HTMLOutputElement);
  const play = $("#lecture", HTMLButtonElement);
  const latest = $("#maintenant", HTMLButtonElement);
  const times = detections.state === "ok" ? detections.value.map((d) => d.t) : [];

  input.max = String(range.steps);
  const initial = shared.instant !== undefined ? stepOf(range, shared.instant) : range.steps;
  input.value = String(initial);
  state.instant = instantAt(range, initial);
  // The wind file can arrive before the status file: show its hour now.
  refreshWind();

  function describe(): void {
    const instant = state.instant ?? range.end;
    const shown = times.filter((t) => t <= instant).length;
    const when = format.dateTime(new Date(instant * 1000));
    const label = instant >= range.end ? `${when}, dernière mise à jour` : when;
    output.textContent = `État au ${label} : ${format.number(shown)} détection${shown > 1 ? "s" : ""}`;
    input.setAttribute("aria-valuetext", `État au ${label}`);
    latest.disabled = instant >= range.end;
  }

  let frame = 0;
  function apply(step: number, address: boolean): void {
    state.instant = instantAt(range, step);
    input.value = String(step);
    describe();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      map?.setInstant(state.instant ?? range.end);
      refreshWind();
    });
    if (address) updateAddress();
  }

  let timer = 0;
  function stop(): void {
    window.clearInterval(timer);
    timer = 0;
    play.textContent = "Lire";
    play.setAttribute("aria-label", "Lire les 7 derniers jours heure par heure");
  }

  play.addEventListener("click", () => {
    if (timer) {
      stop();
      updateAddress();
      return;
    }
    let step = Number(input.value);
    if (step >= range.steps) step = 0;
    apply(step, false);
    play.textContent = "Pause";
    play.setAttribute("aria-label", "Mettre la lecture en pause");
    timer = window.setInterval(() => {
      step += 1;
      apply(step, false);
      if (step >= range.steps) {
        stop();
        updateAddress();
      }
    }, 150);
  });

  input.addEventListener("input", () => {
    if (timer) stop();
    apply(Number(input.value), true);
  });
  latest.addEventListener("click", () => {
    if (timer) stop();
    apply(range.steps, true);
  });

  stop();
  describe();
  frise.hidden = false;
}

// ---------------------------------------------------------------- the map

interface MapStart {
  detections: Detection[];
  foyers: Foyer[];
  outlines: Outline[];
  select: (selection: Selection, fly: boolean) => void;
}

async function loadBurned(): Promise<void> {
  if (burned?.state === "ok") return;
  showNotice("burned", "Chargement des surfaces brûlées…");
  const result = await loadFile("burned", parseBurned, fetcher);
  burned = result.state === "ok" ? { state: "ok", value: result.value.items } : result;
  if (result.state === "ok" && result.value.rejected > 0) {
    burnedRejected = result.value.rejected;
    refreshStatus();
  }
  if (burned.state === "ok") {
    hideNotice("burned");
    map?.setBurned(burned.value);
  } else {
    const reason = burned.state === "missing" ? "non publiées" : burned.message;
    showNotice("burned", `Surfaces brûlées indisponibles (${reason}).`);
  }
}

// ---------------------------------------------------------------- the wind

function windHour(): { field: WindField; hour: number | null } | null {
  if (wind?.state !== "ok") return null;
  const instant = state.instant ?? state.range?.end ?? null;
  return { field: wind.value, hour: instant === null ? null : hourAt(wind.value, instant) };
}

/** Hour of the wind shown, run of the model, and whether the hour is forecast. */
function windTime(): { time: Date | null; run: Date | null; forecast: boolean } {
  const current = windHour();
  const time = current && current.hour !== null ? hourTime(current.field, current.hour) : null;
  const run = current?.field.run ?? null;
  return {
    time: time === null ? null : new Date(time * 1000),
    run,
    forecast: time !== null && run !== null && time * 1000 > run.getTime(),
  };
}

function windPoint(lat: number, lon: number): WindPoint {
  const current = windHour();
  return {
    kind: "wind",
    lat,
    lon,
    sample:
      current && current.hour !== null ? sampleAt(current.field, current.hour, lat, lon) : null,
    ...windTime(),
  };
}

/** The wind at a point follows the instant of the timeline. */
function refreshDetail(): void {
  if (state.selection?.kind !== "wind") return;
  state.selection = windPoint(state.selection.lat, state.selection.lon);
  renderDetail(panel.detail, state.selection, new Date());
}

const windLegend = $("#legende-vent");
const windButton = $("#vent-animation", HTMLButtonElement);

function renderWindControls(): void {
  windLegend.hidden = !state.windVisible;
  windButton.hidden = !state.windVisible || wind?.state !== "ok";
  windButton.textContent = state.windAnimated ? "Mettre le vent en pause" : "Animer le vent";
  renderAttribution(controls.attribution, state.basemap, state.windVisible);
  let model: WindLegendModel;
  if (wind === null || (wind.state !== "ok" && state.windVisible && windLoading)) {
    model = { state: "loading" };
  } else if (wind.state !== "ok") {
    model = {
      state: "unavailable",
      reason: wind.state === "missing" ? "non publié" : wind.message,
    };
  } else {
    model = { state: "ok", ...windTime(), animated: state.windAnimated };
  }
  renderWindLegend(windLegend, model, WIND_COLOURS);
}

function refreshWind(): void {
  const current = windHour();
  map?.setWind(current?.field ?? null, current?.hour ?? null);
  if (state.windVisible) renderWindControls();
  refreshDetail();
}

let windLoading = false;
async function loadWind(): Promise<void> {
  if (wind?.state === "ok" || windLoading) return;
  windLoading = true;
  renderWindControls();
  const result = await loadFile("wind", parseWind, fetcher);
  windLoading = false;
  if (result.state === "ok") {
    wind = { state: "ok", value: result.value.field };
    if (result.value.rejected > 0) {
      windRejected = result.value.rejected;
      refreshStatus();
    }
    hideNotice("wind");
  } else {
    wind = result;
    const reason = result.state === "missing" ? "non publié" : result.message;
    showNotice("wind", `Vent indisponible (${reason}).`);
  }
  refreshWind();
  renderWindControls();
}

const controls = {
  basemap: $("#fond", HTMLSelectElement),
  attribution: $("#attribution"),
  foyers: $("#couche-foyers", HTMLInputElement),
  detections: $("#couche-detections", HTMLInputElement),
  burned: $("#couche-brule", HTMLInputElement),
  wind: $("#couche-vent", HTMLInputElement),
};

function showBasemap(value: Basemap): void {
  state.basemap = value;
  controls.basemap.value = value;
  renderAttribution(controls.attribution, value, state.windVisible);
}

// The controls work from the first render, before the data and the map code
// have arrived: the map reads their state when it starts.
function setupControls(): void {
  showBasemap(state.basemap);
  controls.burned.checked = state.burnedVisible;
  renderLegend($("#legende"), AGE_COLOURS);

  controls.basemap.addEventListener("change", () => {
    const value = controls.basemap.value === "osm" ? "osm" : "ign";
    showBasemap(value);
    saveBasemap(value);
    hideNotice("basemap");
    map?.setBasemap(value);
    updateAddress();
  });
  controls.foyers.addEventListener("change", () => {
    map?.setVisible("foyers", controls.foyers.checked);
  });
  controls.detections.addEventListener("change", () => {
    map?.setVisible("detections", controls.detections.checked);
  });
  controls.burned.addEventListener("change", () => {
    state.burnedVisible = controls.burned.checked;
    map?.setVisible("burned", state.burnedVisible);
    updateAddress();
    if (state.burnedVisible) void loadBurned();
  });
  if (state.burnedVisible) void loadBurned();

  controls.wind.checked = state.windVisible;
  controls.wind.addEventListener("change", () => {
    state.windVisible = controls.wind.checked;
    map?.setWindVisible(state.windVisible);
    if (!state.windVisible) hideNotice("wind");
    renderWindControls();
    updateAddress();
    if (state.windVisible) void loadWind();
  });
  windButton.addEventListener("click", () => {
    state.windAnimated = !state.windAnimated;
    map?.setWindAnimated(state.windAnimated);
    renderWindControls();
  });
  if (state.windVisible) {
    renderWindControls();
    void loadWind();
  }
}

const BASEMAP_NAMES: Record<Basemap, string> = { ign: "Plan IGN", osm: "OpenStreetMap" };

async function startMap(start: MapStart): Promise<void> {
  let module: typeof import("./map");
  try {
    module = await import("./map");
  } catch (error) {
    console.error("Code de la carte indisponible :", error);
    mapMessage.textContent =
      "La carte n'a pas pu être chargée. La liste des foyers et l'état des données restent disponibles.";
    return;
  }

  try {
    map = await module.createMap({
      container: $("#carte"),
      basemap: state.basemap,
      view: state.view,
      instant: state.instant ?? Math.floor(Date.now() / 1000),
      data: { detections: start.detections, foyers: start.foyers, outlines: start.outlines },
      onPick: (picked: Picked | null) => {
        if (picked?.kind !== "wind") start.select(picked, false);
        // The wind at a point, once the wind file is there.
        else start.select(wind?.state === "ok" ? windPoint(picked.lat, picked.lon) : null, false);
      },
      onMove: (view) => {
        state.view = view;
        updateAddress();
      },
      onBasemapError: (failed, kept) => {
        mapMessage.hidden = true;
        if (kept !== null) {
          // The previous base map is displayed again: say so, and make the
          // controls and the credits match it.
          showBasemap(kept);
          updateAddress();
          showNotice(
            "basemap",
            `Le fond de carte ${BASEMAP_NAMES[failed]} ne répond pas : le fond ${BASEMAP_NAMES[kept]} reste affiché.`,
          );
          return;
        }
        const other: Basemap = failed === "ign" ? "osm" : "ign";
        showNotice("basemap", `Le fond de carte ${BASEMAP_NAMES[failed]} ne répond pas.`, {
          label: `Utiliser ${other === "ign" ? "le Plan IGN" : "OpenStreetMap"}`,
          run: () => {
            controls.basemap.value = other;
            controls.basemap.dispatchEvent(new Event("change"));
          },
        });
      },
      onBasemapReady: () => {
        mapMessage.hidden = true;
        if (noticeTopic === "basemap" && notice.querySelector("button")) hideNotice("basemap");
      },
    });
  } catch (error) {
    console.error("Carte indisponible :", error);
    const unavailable = error instanceof module.MapUnavailableError;
    mapMessage.textContent = unavailable
      ? "Ce navigateur ne peut pas afficher la carte (WebGL 2 indisponible). La liste des foyers et l'état des données restent disponibles."
      : "La carte n'a pas pu être affichée. La liste des foyers et l'état des données restent disponibles.";
    return;
  }

  // Catch up with what changed while the map code was loading.
  map.setBasemap(state.basemap);
  map.setVisible("foyers", controls.foyers.checked);
  map.setVisible("detections", controls.detections.checked);
  map.setVisible("burned", state.burnedVisible);
  if (burned?.state === "ok") map.setBurned(burned.value);
  map.setWindAnimated(state.windAnimated);
  map.setWindVisible(state.windVisible);
  if (state.instant !== null) map.setInstant(state.instant);
  refreshWind();
  const current = state.selection;
  if (current?.kind === "foyer") map.select(current.foyer, !state.view);
}

setupControls();
void start();
