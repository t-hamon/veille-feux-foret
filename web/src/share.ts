// View shared through the address: map position, base map, instant of the
// timeline, selected fire cluster and burned areas layer, in the URL fragment.
// The fragment is never sent to the server. Each value is checked against a
// strict pattern and a range; anything else is ignored, never echoed.

export type Basemap = "ign" | "osm";

export interface View {
  zoom: number;
  lat: number;
  lon: number;
}

export interface SharedState {
  view?: View;
  basemap?: Basemap;
  instant?: number;
  foyer?: number;
  burned?: boolean;
}

export const VIEW_LIMITS = {
  zoom: [3, 18],
  lat: [38, 54],
  lon: [-10, 15],
} as const;

const MAX_FRAGMENT = 300;
const VIEW = /^(\d{1,2}(?:\.\d{1,2})?)\/(-?\d{1,2}(?:\.\d{1,5})?)\/(-?\d{1,3}(?:\.\d{1,5})?)$/;

function within(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function parseFragment(fragment: string): SharedState {
  const state: SharedState = {};
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (raw === "" || raw.length > MAX_FRAGMENT) return state;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return state;
  }

  const view = VIEW.exec(params.get("carte") ?? "");
  if (view) {
    const zoom = Number(view[1]);
    const lat = Number(view[2]);
    const lon = Number(view[3]);
    if (
      within(zoom, VIEW_LIMITS.zoom) &&
      within(lat, VIEW_LIMITS.lat) &&
      within(lon, VIEW_LIMITS.lon)
    ) {
      state.view = { zoom, lat, lon };
    }
  }

  const basemap = params.get("fond");
  if (basemap === "ign" || basemap === "osm") state.basemap = basemap;

  const instant = params.get("instant") ?? "";
  if (/^\d{10}$/.test(instant)) state.instant = Number(instant);

  const foyer = params.get("foyer") ?? "";
  if (/^[1-9]\d{0,3}$/.test(foyer)) state.foyer = Number(foyer);

  if (params.get("brule") === "1") state.burned = true;
  return state;
}

export function formatFragment(state: SharedState): string {
  const params = new URLSearchParams();
  if (state.view) {
    const { zoom, lat, lon } = state.view;
    params.set("carte", `${zoom.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`);
  }
  if (state.basemap && state.basemap !== "ign") params.set("fond", state.basemap);
  if (state.instant !== undefined) params.set("instant", String(state.instant));
  if (state.foyer !== undefined) params.set("foyer", String(state.foyer));
  if (state.burned) params.set("brule", "1");
  // "/" is kept readable in the position: URLSearchParams would encode it.
  const text = params.toString().replace(/%2F/g, "/");
  return text === "" ? "" : `#${text}`;
}
