// Base maps. Both are vector tiles read directly by the browser from their
// public servers, without key. Conditions checked on 5 October 2026 (see
// CREDITS.md): Plan IGN under Licence Ouverte 2.0, OpenFreeMap free of use with
// the attribution of OpenMapTiles and OpenStreetMap.

import type { Basemap } from "./share";

export interface AttributionLink {
  text: string;
  href: string;
}

export interface BasemapDefinition {
  id: Basemap;
  label: string;
  style: string;
  /** Font stack for our own labels, served by the glyph server of the style. */
  font: string[];
  /** Hosts the browser talks to; mirrored in the Content-Security-Policy. */
  hosts: string[];
  attribution: AttributionLink[];
}

export const IGN_HOST = "https://data.geopf.fr";
export const OSM_HOST = "https://tiles.openfreemap.org";

export const BASEMAPS: Record<Basemap, BasemapDefinition> = {
  ign: {
    id: "ign",
    label: "Plan IGN (gris)",
    style: `${IGN_HOST}/annexes/ressources/vectorTiles/styles/PLAN.IGN/gris.json`,
    font: ["Source Sans Pro Bold"],
    hosts: [IGN_HOST],
    attribution: [
      { text: "© IGN, Plan IGN", href: "https://cartes.gouv.fr" },
      {
        text: "Licence Ouverte 2.0",
        href: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
      },
    ],
  },
  osm: {
    id: "osm",
    label: "OpenStreetMap (OpenFreeMap, Positron)",
    style: `${OSM_HOST}/styles/positron`,
    font: ["Noto Sans Bold"],
    hosts: [OSM_HOST],
    attribution: [
      { text: "OpenFreeMap", href: "https://openfreemap.org" },
      { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
      {
        text: "Données © contributeurs OpenStreetMap",
        href: "https://www.openstreetmap.org/copyright",
      },
    ],
  },
};

// The Plan IGN styles publish their sprite at one resolution only: the "@2x"
// files MapLibre asks for on high density screens answer 404, which would drop
// every icon of the base map. The single resolution sprite is used instead.
const IGN_SPRITE = `${IGN_HOST}/annexes/ressources/vectorTiles/styles/PLAN.IGN/sprite/`;

export function rewriteUrl(url: string): string {
  if (url.startsWith(IGN_SPRITE) && url.includes("@2x.")) return url.replace("@2x.", ".");
  return url;
}
