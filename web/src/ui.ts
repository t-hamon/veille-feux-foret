// Rendering of the side panel and the map captions. Every text, and above all
// any text coming from a data source, goes through textContent: no HTML string
// is ever built.

import { BASEMAPS } from "./basemaps";
import type { BurnedArea, Detection, Foyer, LoadResult, Status, Summary } from "./data";
import * as format from "./format";
import type { Basemap } from "./share";
import { ageMinutes, freshness, groupOf, health } from "./status";

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

const SOURCE_NAMES: Record<string, string> = {
  firms: "Foyers (NASA FIRMS)",
  effis: "Surfaces brûlées et bilan (EFFIS)",
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
        `Sources concernées : ${names}. Les données affichées pour ces sources sont les dernières reçues, ou absentes.`,
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

export type Selection =
  | { kind: "foyer"; foyer: Foyer }
  | { kind: "detection"; detection: Detection }
  | { kind: "burned"; area: BurnedArea }
  | null;

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

export function renderAttribution(container: HTMLElement, basemap: Basemap): void {
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
