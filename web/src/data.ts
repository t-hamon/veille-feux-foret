// Reading and validating the data files written by the pipeline
// (pipeline/src/veille_feux/build.py). Every file is checked field by field:
// an entry that does not match the expected shape is dropped and counted, never
// repaired or guessed, and the interface says how many entries were dropped.

export const DATA_FILES = {
  status: "etat.json",
  detections: "detections.geojson",
  foyers: "foyers.geojson",
  outlines: "foyers-emprises.geojson",
  burned: "surfaces-brulees.geojson",
  summary: "bilan.json",
} as const;

export type DataFile = keyof typeof DATA_FILES;

// Generous box around metropolitan France and Corsica: a point outside it cannot
// come from the pipeline and is rejected.
export const AREA = { west: -10, south: 38, east: 15, north: 54 } as const;

// Upper bounds well above anything the pipeline has produced, so that a broken
// or hostile file cannot freeze the page.
export const LIMITS = {
  /** Characters of a data file; also checked against Content-Length first. */
  textChars: 40 * 1024 * 1024,
  detections: 100_000,
  foyers: 10_000,
  outlines: 10_000,
  burned: 50_000,
  ringPoints: 20_000,
  sources: 50,
  label: 120,
} as const;

export type Satellite = "viirs_snpp" | "viirs_noaa20" | "viirs_noaa21" | "modis";
export type Confidence = "low" | "nominal" | "high";

export const SATELLITES: readonly Satellite[] = [
  "viirs_snpp",
  "viirs_noaa20",
  "viirs_noaa21",
  "modis",
];
const CONFIDENCES: readonly Confidence[] = ["low", "nominal", "high"];

export interface SourceStatus {
  id: string;
  label: string;
  ok: boolean;
  checkedAt: Date | null;
  updatedAt: Date | null;
  count: number | null;
  error: string | null;
}

export interface Status {
  generatedAt: Date;
  windowHours: number;
  sources: SourceStatus[];
  files: string[];
}

export interface Detection {
  lon: number;
  lat: number;
  /** Acquisition time, seconds since 1970-01-01 UTC. */
  t: number;
  satellite: Satellite;
  frp: number | null;
  confidence: Confidence | null;
  confidencePct: number | null;
  daytime: boolean | null;
  foyer: number | null;
}

export interface Foyer {
  id: number;
  lon: number;
  lat: number;
  detections: number;
  detections24h: number;
  first: Date;
  last: Date;
  maxFrp: number | null;
  estimatedAreaHa: number | null;
  active: boolean;
}

export interface Outline {
  id: number;
  ring: [number, number][];
}

export interface BurnedArea {
  kind: "dated" | "nrt";
  geometry: PolygonGeometry;
  date: string | null;
  updated: string | null;
  areaHa: number | null;
  commune: string | null;
  province: string | null;
}

export interface PolygonGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

export interface Summary {
  year: number;
  burnedHa: number;
  averageHa: number | null;
  events: number | null;
  weeksCounted: number;
  lastWeekDate: string | null;
}

export interface Parsed<T> {
  items: T[];
  rejected: number;
}

export class DataFormatError extends Error {
  override name = "DataFormatError";
}

// ------------------------------------------------------------ small checkers

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalNumber(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null || value === undefined) return null;
  return finite(value) && value >= min && value <= max ? value : undefined;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return finite(value) && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function inArea(lon: unknown, lat: unknown): lon is number {
  return (
    finite(lon) &&
    finite(lat) &&
    lon >= AREA.west &&
    lon <= AREA.east &&
    lat >= AREA.south &&
    lat <= AREA.north
  );
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDay(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ISO_DATE.test(value)) return undefined;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? undefined : value;
}

// Text from third parties is kept as plain text, trimmed and shortened. It is
// only ever inserted with textContent.
export function cleanText(value: unknown, max: number = LIMITS.label): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no place in a label.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text === "") return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function features(document: unknown, limit: number, file: string): unknown[] {
  if (!isObject(document) || document["type"] !== "FeatureCollection") {
    throw new DataFormatError(`${file} : collection GeoJSON attendue`);
  }
  const list = document["features"];
  if (!Array.isArray(list)) throw new DataFormatError(`${file} : liste d'entités absente`);
  if (list.length > limit) {
    throw new DataFormatError(`${file} : ${String(list.length)} entités, plus que la limite`);
  }
  return list;
}

function pointOf(feature: Json): [number, number] | undefined {
  const geometry = feature["geometry"];
  if (!isObject(geometry) || geometry["type"] !== "Point") return undefined;
  const coordinates = geometry["coordinates"];
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return undefined;
  const [lon, lat] = coordinates as unknown[];
  return inArea(lon, lat) ? [lon, lat as number] : undefined;
}

function collect<T>(list: unknown[], read: (feature: Json) => T | undefined): Parsed<T> {
  const items: T[] = [];
  let rejected = 0;
  for (const entry of list) {
    const item = isObject(entry) ? read(entry) : undefined;
    if (item === undefined) rejected += 1;
    else items.push(item);
  }
  return { items, rejected };
}

function propertiesOf(feature: Json): Json | undefined {
  const properties = feature["properties"];
  return isObject(properties) ? properties : undefined;
}

// ------------------------------------------------------------------ parsers

export function parseStatus(document: unknown): Status {
  if (!isObject(document)) throw new DataFormatError("etat.json : objet attendu");
  const generatedAt = parseInstant(document["generated_at"]);
  if (!generatedAt) throw new DataFormatError("etat.json : date de génération invalide");
  const windowHours = integer(document["window_hours"], 1, 24 * 31);
  if (windowHours === undefined) throw new DataFormatError("etat.json : fenêtre invalide");
  const rawSources = document["sources"];
  if (!isObject(rawSources)) throw new DataFormatError("etat.json : sources absentes");
  const entries = Object.entries(rawSources).slice(0, LIMITS.sources);
  const sources: SourceStatus[] = [];
  for (const [id, raw] of entries) {
    if (!/^[a-z0-9_]{1,40}$/.test(id) || !isObject(raw) || typeof raw["ok"] !== "boolean") {
      continue;
    }
    const count = integer(raw["count"], 0, 10_000_000);
    sources.push({
      id,
      label: cleanText(raw["label"]) ?? id,
      ok: raw["ok"],
      checkedAt: parseInstant(raw["checked_at"]),
      updatedAt: parseInstant(raw["updated_at"]),
      count: count ?? null,
      error: cleanText(raw["error"], 200),
    });
  }
  const rawFiles = document["files"];
  const files = Array.isArray(rawFiles)
    ? rawFiles.filter((f): f is string => typeof f === "string" && /^[a-z0-9.-]{1,60}$/.test(f))
    : [];
  return { generatedAt, windowHours, sources, files };
}

export function parseDetections(document: unknown): Parsed<Detection> {
  const list = features(document, LIMITS.detections, DATA_FILES.detections);
  return collect(list, (feature) => {
    const point = pointOf(feature);
    const p = propertiesOf(feature);
    if (!point || !p) return undefined;
    const t = integer(p["t"], 946_684_800, 4_102_444_800); // 2000 to 2100
    const satellite = p["src"];
    if (t === undefined || !SATELLITES.includes(satellite as Satellite)) return undefined;
    const frp = optionalNumber(p["frp"], 0, 100_000);
    const confidencePct = optionalNumber(p["conf_pct"], 0, 100);
    const conf = p["conf"];
    const confidence =
      conf === null || conf === undefined
        ? null
        : CONFIDENCES.includes(conf as Confidence)
          ? (conf as Confidence)
          : undefined;
    const dn = p["dn"];
    const daytime = dn === "D" ? true : dn === "N" ? false : dn === null ? null : undefined;
    const foyerRaw = p["foyer"];
    const foyer = foyerRaw === null ? null : integer(foyerRaw, 1, LIMITS.foyers);
    if (
      frp === undefined ||
      confidencePct === undefined ||
      confidence === undefined ||
      daytime === undefined ||
      foyer === undefined
    ) {
      return undefined;
    }
    return {
      lon: point[0],
      lat: point[1],
      t,
      satellite: satellite as Satellite,
      frp,
      confidence,
      confidencePct,
      daytime,
      foyer,
    };
  });
}

export function parseFoyers(document: unknown): Parsed<Foyer> {
  const list = features(document, LIMITS.foyers, DATA_FILES.foyers);
  return collect(list, (feature) => {
    const point = pointOf(feature);
    const p = propertiesOf(feature);
    if (!point || !p) return undefined;
    const id = integer(p["id"], 1, LIMITS.foyers);
    const detections = integer(p["detections"], 1, LIMITS.detections);
    const detections24h = integer(p["detections_24h"], 0, LIMITS.detections);
    const first = parseInstant(p["first"]);
    const last = parseInstant(p["last"]);
    const maxFrp = optionalNumber(p["max_frp"], 0, 100_000);
    const area = optionalNumber(p["estimated_area_ha"], 0, 10_000_000);
    const active = p["active"];
    if (
      id === undefined ||
      detections === undefined ||
      detections24h === undefined ||
      !first ||
      !last ||
      first > last ||
      maxFrp === undefined ||
      area === undefined ||
      typeof active !== "boolean"
    ) {
      return undefined;
    }
    return {
      id,
      lon: point[0],
      lat: point[1],
      detections,
      detections24h,
      first,
      last,
      maxFrp,
      estimatedAreaHa: area,
      active,
    };
  });
}

export function parseOutlines(document: unknown): Parsed<Outline> {
  const list = features(document, LIMITS.outlines, DATA_FILES.outlines);
  return collect(list, (feature) => {
    const p = propertiesOf(feature);
    const id = p ? integer(p["id"], 1, LIMITS.foyers) : undefined;
    const geometry = feature["geometry"];
    if (id === undefined || !isObject(geometry) || geometry["type"] !== "Polygon") {
      return undefined;
    }
    const rings = geometry["coordinates"];
    if (!Array.isArray(rings) || rings.length !== 1) return undefined;
    const ring = readRing(rings[0]);
    return ring ? { id, ring } : undefined;
  });
}

function readRing(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value) || value.length < 4 || value.length > LIMITS.ringPoints) {
    return undefined;
  }
  const ring: [number, number][] = [];
  for (const position of value) {
    if (!Array.isArray(position) || position.length !== 2) return undefined;
    const [lon, lat] = position as unknown[];
    if (!inArea(lon, lat)) return undefined;
    ring.push([lon, lat as number]);
  }
  const [firstLon, firstLat] = ring[0] ?? [];
  const [lastLon, lastLat] = ring[ring.length - 1] ?? [];
  return firstLon === lastLon && firstLat === lastLat ? ring : undefined;
}

function readPolygon(value: unknown): number[][][] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rings: number[][][] = [];
  for (const raw of value) {
    const ring = readRing(raw);
    if (!ring) return undefined;
    rings.push(ring);
  }
  return rings;
}

function readGeometry(value: unknown): PolygonGeometry | undefined {
  if (!isObject(value)) return undefined;
  if (value["type"] === "Polygon") {
    const coordinates = readPolygon(value["coordinates"]);
    return coordinates ? { type: "Polygon", coordinates } : undefined;
  }
  if (value["type"] === "MultiPolygon") {
    const parts = value["coordinates"];
    if (!Array.isArray(parts) || parts.length === 0) return undefined;
    const polygons: number[][][][] = [];
    for (const part of parts) {
      const polygon = readPolygon(part);
      if (!polygon) return undefined;
      polygons.push(polygon);
    }
    return { type: "MultiPolygon", coordinates: polygons };
  }
  return undefined;
}

export function parseBurned(document: unknown): Parsed<BurnedArea> {
  const list = features(document, LIMITS.burned, DATA_FILES.burned);
  return collect(list, (feature) => {
    const p = propertiesOf(feature);
    const geometry = readGeometry(feature["geometry"]);
    if (!p || !geometry) return undefined;
    const kind = p["kind"];
    if (kind === "nrt") {
      return {
        kind,
        geometry,
        date: null,
        updated: null,
        areaHa: null,
        commune: null,
        province: null,
      };
    }
    if (kind !== "dated") return undefined;
    const date = parseDay(p["date"]);
    const updated = parseDay(p["updated"]);
    const areaHa = optionalNumber(p["area_ha"], 0, 10_000_000);
    if (date === undefined || updated === undefined || areaHa === undefined) return undefined;
    return {
      kind,
      geometry,
      date,
      updated,
      areaHa,
      commune: cleanText(p["commune"]),
      province: cleanText(p["province"]),
    };
  });
}

export function parseSummary(document: unknown): Summary {
  if (!isObject(document)) throw new DataFormatError("bilan.json : objet attendu");
  const year = integer(document["year"], 2000, 2100);
  const burnedHa = optionalNumber(document["burned_ha"], 0, 100_000_000);
  const averageHa = optionalNumber(document["average_ha"], 0, 100_000_000);
  const events = optionalNumber(document["events"], 0, 1_000_000);
  const weeksCounted = integer(document["weeks_counted"], 0, 53);
  const lastWeekDate = parseDay(document["last_week_date"]);
  if (
    year === undefined ||
    burnedHa === undefined ||
    burnedHa === null ||
    averageHa === undefined ||
    events === undefined ||
    weeksCounted === undefined ||
    lastWeekDate === undefined
  ) {
    throw new DataFormatError("bilan.json : champ invalide");
  }
  return { year, burnedHa, averageHa, events, weeksCounted, lastWeekDate };
}

// ----------------------------------------------------------------- loading

export type Fetcher = (url: string) => Promise<Response>;

export type LoadResult<T> =
  { state: "ok"; value: T } | { state: "missing" } | { state: "error"; message: string };

/** Fetches one data file and parses it; never throws. */
export async function loadFile<T>(
  file: DataFile,
  parse: (document: unknown) => T,
  fetcher: Fetcher,
  base = "./data/",
): Promise<LoadResult<T>> {
  let response: Response;
  try {
    response = await fetcher(`${base}${DATA_FILES[file]}`);
  } catch {
    return { state: "error", message: "réseau indisponible" };
  }
  if (response.status === 404) return { state: "missing" };
  if (!response.ok) return { state: "error", message: `réponse HTTP ${String(response.status)}` };
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > LIMITS.textChars) return { state: "error", message: "fichier trop volumineux" };
  try {
    const text = await response.text();
    if (text.length > LIMITS.textChars) {
      return { state: "error", message: "fichier trop volumineux" };
    }
    return { state: "ok", value: parse(JSON.parse(text)) };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof DataFormatError ? error.message : "fichier illisible",
    };
  }
}
