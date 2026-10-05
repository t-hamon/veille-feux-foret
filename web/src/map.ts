// The map itself. This module and MapLibre are loaded after the first render,
// so the status, the warning and the list of foyers appear without waiting for
// the map code (about 300 kB gzip for MapLibre).

import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type {
  GeoJSONSource,
  LayerSpecification,
  MapGeoJSONFeature,
  Map as MapLibreMap,
  PointLike,
} from "maplibre-gl";
import { BASEMAPS, rewriteUrl } from "./basemaps";
import type { BurnedArea, Detection, Foyer, Outline } from "./data";
import { loadMapLibre } from "./maplibre";
import { AGE_COLOURS, DATED_COLOUR, FOYER_COLOUR, NRT_COLOUR, SELECTION_COLOUR } from "./palette";
import type { Basemap, View } from "./share";
import { type Expression, byAge, visibleFilter } from "./timeline";

// Metropolitan France and Corsica, shown whole when no position is shared.
// The northern edge leaves room for the foyer markers near Dunkirk and Lille.
const METROPOLE: [[number, number], [number, number]] = [
  [-5.2, 41.3],
  [9.6, 51.4],
];
const FRANCE_BOUNDS: [[number, number], [number, number]] = [
  [-12, 38],
  [17, 54],
];

const AGE_RADIUS = [7, 6, 5, 4];

export type LayerGroup = "detections" | "foyers" | "burned";

export type Picked =
  | { kind: "foyer"; foyer: Foyer }
  | { kind: "detection"; detection: Detection }
  | { kind: "burned"; area: BurnedArea };

export interface MapData {
  detections: Detection[];
  foyers: Foyer[];
  outlines: Outline[];
}

export interface MapOptions {
  container: HTMLElement;
  basemap: Basemap;
  view: View | undefined;
  instant: number;
  data: MapData;
  onPick: (picked: Picked | null) => void;
  onMove: (view: View) => void;
  /**
   * A base map did not answer. `kept` is the base map still displayed (the
   * previous one, restored), or null when nothing could be displayed yet.
   */
  onBasemapError: (failed: Basemap, kept: Basemap | null) => void;
  onBasemapReady: (basemap: Basemap) => void;
}

export interface MapHandle {
  setInstant(instant: number): void;
  setBasemap(basemap: Basemap): void;
  setBurned(areas: BurnedArea[]): void;
  setVisible(group: LayerGroup, visible: boolean): void;
  select(foyer: Foyer | null, fly: boolean): void;
  resize(): void;
}

export class MapUnavailableError extends Error {
  override name = "MapUnavailableError";
}

const LOCALE = {
  "AttributionControl.ToggleAttribution": "Afficher ou masquer les sources",
  "FullscreenControl.Enter": "Plein écran",
  "FullscreenControl.Exit": "Quitter le plein écran",
  "GeolocateControl.FindMyLocation": "Me localiser",
  "GeolocateControl.LocationNotAvailable": "Position indisponible",
  "LogoControl.Title": "MapLibre",
  "Map.Title": "Carte des feux de forêt en France",
  "Marker.Title": "Repère",
  "NavigationControl.ResetBearing": "Remettre le nord en haut",
  "NavigationControl.ZoomIn": "Zoomer",
  "NavigationControl.ZoomOut": "Dézoomer",
  "Popup.Close": "Fermer",
  "ScaleControl.Feet": "pieds",
  "ScaleControl.Meters": "m",
  "ScaleControl.Kilometers": "km",
  "ScaleControl.Miles": "miles",
  "ScaleControl.NauticalMiles": "milles nautiques",
  "GlobeControl.Enable": "Vue en globe",
  "GlobeControl.Disable": "Vue à plat",
  "TerrainControl.Enable": "Activer le relief",
  "TerrainControl.Disable": "Désactiver le relief",
  "CooperativeGesturesHandler.WindowsHelpText": "Ctrl + molette pour zoomer",
  "CooperativeGesturesHandler.MacHelpText": "⌘ + molette pour zoomer",
  "CooperativeGesturesHandler.MobileHelpText": "Deux doigts pour déplacer la carte",
};

// ------------------------------------------------------------- GeoJSON data

type Collection = FeatureCollection;

function detectionsCollection(detections: Detection[]): Collection {
  return {
    type: "FeatureCollection",
    features: detections.map((d, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [d.lon, d.lat] },
      properties: { i, t: d.t },
    })),
  };
}

function foyersCollection(foyers: Foyer[]): Collection {
  return {
    type: "FeatureCollection",
    features: foyers.map((f) => ({
      type: "Feature",
      id: f.id,
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
      properties: {
        id: f.id,
        label: String(f.id),
        first: Math.floor(f.first.getTime() / 1000),
        active: f.active,
      },
    })),
  };
}

function outlinesCollection(outlines: Outline[], foyers: Foyer[]): Collection {
  const first = new Map(foyers.map((f) => [f.id, Math.floor(f.first.getTime() / 1000)]));
  return {
    type: "FeatureCollection",
    features: outlines.map((o) => ({
      type: "Feature",
      id: o.id,
      geometry: { type: "Polygon", coordinates: [o.ring] },
      properties: { id: o.id, first: first.get(o.id) ?? 0 },
    })),
  };
}

function burnedCollection(areas: BurnedArea[]): Collection {
  return {
    type: "FeatureCollection",
    features: areas.map((a, i) => ({
      type: "Feature",
      id: i,
      geometry: a.geometry as Polygon | MultiPolygon,
      properties: { i, kind: a.kind },
    })),
  };
}

// ---------------------------------------------------------------- the layers

const SOURCES = {
  detections: "vff-detections",
  foyers: "vff-foyers",
  outlines: "vff-emprises",
  burned: "vff-surfaces",
} as const;

const GROUP_LAYERS: Record<LayerGroup, string[]> = {
  burned: ["vff-surfaces-fill", "vff-surfaces-line", "vff-surfaces-line-nrt"],
  detections: ["vff-detections"],
  foyers: [
    "vff-emprises-fill",
    "vff-emprises-line",
    "vff-foyers-halo",
    "vff-foyers",
    "vff-foyers-label",
  ],
};

function untilFilter(instant: number, property: string): Expression {
  return ["<=", ["get", property], instant];
}

function haloFilter(selected: number | null, instant: number): Expression {
  return ["all", ["==", ["get", "id"], selected ?? -1], untilFilter(instant, "first")];
}

function layers(instant: number, font: string[], selected: number | null): LayerSpecification[] {
  return [
    {
      id: "vff-surfaces-fill",
      type: "fill",
      source: SOURCES.burned,
      paint: {
        "fill-color": ["match", ["get", "kind"], "nrt", NRT_COLOUR, DATED_COLOUR],
        "fill-opacity": 0.3,
      },
    },
    {
      id: "vff-surfaces-line",
      type: "line",
      source: SOURCES.burned,
      filter: ["==", ["get", "kind"], "dated"],
      paint: { "line-color": DATED_COLOUR, "line-width": 1 },
    },
    {
      id: "vff-surfaces-line-nrt",
      type: "line",
      source: SOURCES.burned,
      filter: ["==", ["get", "kind"], "nrt"],
      paint: { "line-color": NRT_COLOUR, "line-width": 1.2, "line-dasharray": [2, 1] },
    },
    {
      id: "vff-emprises-fill",
      type: "fill",
      source: SOURCES.outlines,
      filter: untilFilter(instant, "first") as never,
      paint: { "fill-color": FOYER_COLOUR, "fill-opacity": 0.08 },
    },
    {
      id: "vff-emprises-line",
      type: "line",
      source: SOURCES.outlines,
      filter: untilFilter(instant, "first") as never,
      paint: { "line-color": FOYER_COLOUR, "line-width": 1.5, "line-dasharray": [3, 2] },
    },
    {
      id: "vff-detections",
      type: "circle",
      source: SOURCES.detections,
      filter: visibleFilter(instant) as never,
      paint: {
        "circle-color": byAge(instant, AGE_COLOURS) as never,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          byAge(
            instant,
            AGE_RADIUS.map((r) => r * 0.6),
          ),
          10,
          byAge(instant, AGE_RADIUS),
        ] as never,
        "circle-stroke-color": "#3b0a00",
        "circle-stroke-width": 0.8,
        "circle-opacity": 0.92,
      },
    },
    {
      id: "vff-foyers-halo",
      type: "circle",
      source: SOURCES.foyers,
      filter: haloFilter(selected, instant) as never,
      paint: {
        "circle-radius": 20,
        "circle-color": "rgba(0, 0, 0, 0)",
        "circle-stroke-color": SELECTION_COLOUR,
        "circle-stroke-width": 3,
      },
    },
    {
      id: "vff-foyers",
      type: "circle",
      source: SOURCES.foyers,
      filter: untilFilter(instant, "first") as never,
      paint: {
        "circle-radius": 12,
        "circle-color": ["case", ["get", "active"], FOYER_COLOUR, "rgba(255, 255, 255, 0.75)"],
        "circle-stroke-color": FOYER_COLOUR,
        "circle-stroke-width": 2.5,
      },
    },
    {
      id: "vff-foyers-label",
      type: "symbol",
      source: SOURCES.foyers,
      filter: untilFilter(instant, "first") as never,
      layout: {
        "text-field": ["get", "label"],
        "text-font": font,
        "text-size": 12,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": ["case", ["get", "active"], "#ffffff", FOYER_COLOUR],
      },
    },
  ];
}

// ------------------------------------------------------------------ creation

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

export async function createMap(options: MapOptions): Promise<MapHandle> {
  if (!webglAvailable()) throw new MapUnavailableError("WebGL 2 indisponible");
  const lib = await loadMapLibre();

  const { data } = options;
  // Base map displayed, and base map being loaded in its place.
  let current: Basemap | null = null;
  let pending: Basemap | null = options.basemap;
  let instant = options.instant;
  let selected: number | null = null;
  let burned: BurnedArea[] = [];
  const visible: Record<LayerGroup, boolean> = { detections: true, foyers: true, burned: false };
  const foyersById = new Map(data.foyers.map((f) => [f.id, f]));

  const start = options.view;
  let map: MapLibreMap;
  try {
    map = new lib.Map({
      container: options.container,
      style: BASEMAPS[options.basemap].style,
      ...(start
        ? { center: [start.lon, start.lat] as [number, number], zoom: start.zoom }
        : { bounds: METROPOLE, fitBoundsOptions: { padding: 24 } }),
      minZoom: 3,
      maxZoom: 18,
      maxBounds: FRANCE_BOUNDS,
      // Attribution is rendered by the page, from our own text: MapLibre would
      // insert the HTML of the tile servers' attribution as is.
      attributionControl: false,
      locale: LOCALE,
      dragRotate: false,
      // Lighter rendering: no fade of labels (each fade redraws the map for
      // 300 ms), and no more than two device pixels per CSS pixel, which
      // already looks sharp and spares phones with denser screens.
      fadeDuration: 0,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      pitchWithRotate: false,
      transformRequest: (url) => ({ url: rewriteUrl(url) }),
    });
  } catch (error) {
    throw new MapUnavailableError(error instanceof Error ? error.message : "carte indisponible");
  }
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new lib.ScaleControl({ unit: "metric" }), "bottom-right");

  const detectionsData = detectionsCollection(data.detections);
  const foyersData = foyersCollection(data.foyers);
  const outlinesData = outlinesCollection(data.outlines, data.foyers);

  function install(): void {
    const font = BASEMAPS[current ?? options.basemap].font;
    map.addSource(SOURCES.burned, { type: "geojson", data: burnedCollection(burned) });
    map.addSource(SOURCES.outlines, { type: "geojson", data: outlinesData });
    map.addSource(SOURCES.detections, { type: "geojson", data: detectionsData });
    map.addSource(SOURCES.foyers, { type: "geojson", data: foyersData });
    for (const layer of layers(instant, font, selected)) map.addLayer(layer);
    for (const group of Object.keys(visible) as LayerGroup[]) applyVisibility(group);
  }

  function applyVisibility(group: LayerGroup): void {
    for (const id of GROUP_LAYERS[group]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible[group] ? "visible" : "none");
      }
    }
  }

  // A new style replaces everything, our layers included: they are added
  // again each time a style has loaded.
  map.on("style.load", () => {
    current = pending ?? current;
    pending = null;
    install();
    if (current) options.onBasemapReady(current);
  });

  map.on("error", (event) => {
    if (pending === null) {
      // Tiles that fail once the style is there: MapLibre retries them.
      console.warn("Carte :", event.error.message);
      return;
    }
    const failed = pending;
    pending = null;
    if (current !== null) {
      // Back to the base map that was working.
      pending = current;
      map.setStyle(BASEMAPS[current].style, { diff: false });
    }
    options.onBasemapError(failed, current);
  });

  map.on("moveend", () => {
    const center = map.getCenter();
    options.onMove({ zoom: map.getZoom(), lat: center.lat, lon: center.lng });
  });

  const clickable = ["vff-foyers", "vff-detections", "vff-surfaces-fill"];

  function pick(features: MapGeoJSONFeature[]): Picked | null {
    for (const layer of clickable) {
      const feature = features.find((f) => f.layer.id === layer);
      if (!feature) continue;
      const props = feature.properties as Record<string, unknown>;
      if (layer === "vff-foyers") {
        const foyer = foyersById.get(Number(props["id"]));
        if (foyer) return { kind: "foyer", foyer };
      } else if (layer === "vff-detections") {
        const detection = data.detections[Number(props["i"])];
        if (detection) return { kind: "detection", detection };
      } else {
        const area = burned[Number(props["i"])];
        if (area) return { kind: "burned", area };
      }
    }
    return null;
  }

  map.on("click", (event) => {
    const box: [PointLike, PointLike] = [
      [event.point.x - 6, event.point.y - 6],
      [event.point.x + 6, event.point.y + 6],
    ];
    const present = clickable.filter((id) => map.getLayer(id));
    options.onPick(pick(map.queryRenderedFeatures(box, { layers: present })));
  });

  for (const layer of clickable) {
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  function refreshTime(): void {
    if (!map.getLayer("vff-detections")) return;
    const filter = visibleFilter(instant) as never;
    map.setFilter("vff-detections", filter);
    map.setPaintProperty("vff-detections", "circle-color", byAge(instant, AGE_COLOURS) as never);
    map.setPaintProperty("vff-detections", "circle-radius", [
      "interpolate",
      ["linear"],
      ["zoom"],
      5,
      byAge(
        instant,
        AGE_RADIUS.map((r) => r * 0.6),
      ),
      10,
      byAge(instant, AGE_RADIUS),
    ] as never);
    for (const id of ["vff-foyers", "vff-foyers-label", "vff-emprises-fill", "vff-emprises-line"]) {
      map.setFilter(id, untilFilter(instant, "first") as never);
    }
    map.setFilter("vff-foyers-halo", haloFilter(selected, instant) as never);
  }

  return {
    setInstant(next) {
      instant = next;
      refreshTime();
    },
    setBasemap(next) {
      if (next === (pending ?? current)) return;
      pending = next;
      map.setStyle(BASEMAPS[next].style, { diff: false });
    },
    setBurned(areas) {
      burned = areas;
      const source = map.getSource<GeoJSONSource>(SOURCES.burned);
      void source?.setData(burnedCollection(areas));
    },
    setVisible(group, value) {
      visible[group] = value;
      applyVisibility(group);
    },
    select(foyer, fly) {
      selected = foyer?.id ?? null;
      if (map.getLayer("vff-foyers-halo")) {
        map.setFilter("vff-foyers-halo", haloFilter(selected, instant) as never);
      }
      if (foyer && fly) {
        map.flyTo({ center: [foyer.lon, foyer.lat], zoom: Math.max(map.getZoom(), 10) });
      }
    },
    resize() {
      map.resize();
    },
  };
}
