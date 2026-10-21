// The wind file written by the pipeline (vent.json): wind of the AROME France
// HD model of Météo-France, read through Open-Meteo, on a regular grid over
// France, hour by hour over the 7 past days and the forecast. Hours before the
// time of the file are archived forecasts of the model, not measurements.
//
// The file is checked like the other data files: a structure that does not
// match is refused as a whole; a value out of its physical range is dropped
// (left empty) and counted, never corrected. The wind between grid points is
// interpolated from the four surrounding points; where one of them has no
// value, there is no wind, never a guess.

import { AREA, DataFormatError, parseInstant } from "./data";

export const WIND_LIMITS = { points: 2000, hours: 400, cells: 1_000_000 } as const;

/** Upper bounds of the speed classes of the map, in km/h. */
export const SPEED_CLASSES = [10, 20, 30, 50] as const;

export interface WindField {
  /** Time of the model run the values come from, when known. */
  run: Date | null;
  fetchedAt: Date;
  /** First hour, seconds since 1970-01-01 UTC. */
  start: number;
  hours: number;
  /** Grid step, in degrees. */
  step: number;
  south: number;
  west: number;
  rows: number;
  columns: number;
  /** Point index of each grid node, row by row from the south-west; -1 if none. */
  nodes: Int32Array;
  points: [number, number][];
  /** Values by point, then by hour; null where the model gave none. */
  speed: (number | null)[][];
  direction: (number | null)[][];
  gusts: (number | null)[][];
}

export interface ParsedWind {
  field: WindField;
  /** Values dropped for being out of their physical range. */
  rejected: number;
}

export interface WindSample {
  /** Mean wind speed at 10 m, km/h. */
  speed: number;
  /** Direction the wind comes from, degrees clockwise from north. */
  from: number;
  /** Strongest gust of the preceding hour, km/h, when known. */
  gusts: number | null;
}

// ------------------------------------------------------------------ parsing

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DataFormatError(`vent.json : ${message}`);
}

function readSeries(
  value: unknown,
  name: string,
  points: number,
  hours: number,
  max: number,
  integer: boolean,
): { series: (number | null)[][]; rejected: number } {
  if (!Array.isArray(value) || value.length !== points)
    fail(`${name} : une série par point attendue`);
  let rejected = 0;
  const series = value.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== hours)
      fail(`${name} : une valeur par heure attendue`);
    return row.map((item: unknown) => {
      if (item === null) return null;
      const ok =
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0 &&
        item <= max &&
        (!integer || Number.isInteger(item));
      if (!ok) rejected += 1;
      return ok ? item : null;
    });
  });
  return { series, rejected };
}

export function parseWind(document: unknown): ParsedWind {
  if (!isObject(document)) fail("objet attendu");
  const fetchedAt = parseInstant(document["fetched_at"]);
  if (!fetchedAt) fail("date de collecte invalide");
  const run = document["run"] === null ? null : parseInstant(document["run"]);
  if (document["run"] !== null && !run) fail("heure du calcul invalide");
  const start = document["start"];
  const hours = document["hours"];
  const step = document["step"];
  if (
    !Number.isInteger(start) ||
    (start as number) < 946_684_800 ||
    (start as number) > 4_102_444_800
  ) {
    fail("première heure invalide");
  }
  if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > WIND_LIMITS.hours) {
    fail("nombre d'heures invalide");
  }
  if (typeof step !== "number" || !Number.isFinite(step) || step < 0.05 || step > 5) {
    fail("pas de grille invalide");
  }
  const rawPoints = document["points"];
  if (
    !Array.isArray(rawPoints) ||
    rawPoints.length === 0 ||
    rawPoints.length > WIND_LIMITS.points
  ) {
    fail("liste de points invalide");
  }
  const points: [number, number][] = rawPoints.map((p: unknown) => {
    if (!Array.isArray(p) || p.length !== 2) fail("point invalide");
    const [lat, lon] = p as unknown[];
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !(lon >= AREA.west && lon <= AREA.east && lat >= AREA.south && lat <= AREA.north)
    ) {
      fail("point hors de la zone de la carte");
    }
    return [lat, lon];
  });

  const south = Math.min(...points.map((p) => p[0]));
  const west = Math.min(...points.map((p) => p[1]));
  const north = Math.max(...points.map((p) => p[0]));
  const east = Math.max(...points.map((p) => p[1]));
  const rows = Math.round((north - south) / step) + 1;
  const columns = Math.round((east - west) / step) + 1;
  if (rows * columns > WIND_LIMITS.cells) fail("grille trop grande");
  const nodes = new Int32Array(rows * columns).fill(-1);
  points.forEach(([lat, lon], index) => {
    const row = (lat - south) / step;
    const column = (lon - west) / step;
    if (Math.abs(row - Math.round(row)) > 1e-6 || Math.abs(column - Math.round(column)) > 1e-6) {
      fail("point hors de la grille");
    }
    const node = Math.round(row) * columns + Math.round(column);
    if (nodes[node] !== -1) fail("point en double");
    nodes[node] = index;
  });

  const count = points.length;
  const h = hours as number;
  const speed = readSeries(document["speed"], "vitesse", count, h, 400, true);
  const direction = readSeries(document["direction"], "direction", count, h, 359, true);
  const gusts = readSeries(document["gusts"], "rafales", count, h, 500, true);
  return {
    field: {
      run,
      fetchedAt,
      start: start as number,
      hours: h,
      step,
      south,
      west,
      rows,
      columns,
      nodes,
      points,
      speed: speed.series,
      direction: direction.series,
      gusts: gusts.series,
    },
    rejected: speed.rejected + direction.rejected + gusts.rejected,
  };
}

// ------------------------------------------------------------------- time

/** Time of an hour of the field, seconds since 1970-01-01 UTC. */
export function hourTime(field: WindField, hour: number): number {
  return field.start + hour * 3600;
}

/**
 * Hour of the field closest to the instant, or null when the instant is more
 * than half an hour outside the hours of the file.
 */
export function hourAt(field: WindField, instant: number): number | null {
  // Adding 0 turns -0 (an instant just before the first hour) into 0.
  const hour = Math.round((instant - field.start) / 3600) + 0;
  return hour >= 0 && hour < field.hours ? hour : null;
}

// ----------------------------------------------------------- interpolation

function corners(
  field: WindField,
  lat: number,
  lon: number,
): { indexes: [number, number, number, number]; fx: number; fy: number } | null {
  const y = (lat - field.south) / field.step;
  const x = (lon - field.west) / field.step;
  const row = Math.floor(y);
  const column = Math.floor(x);
  if (row < 0 || column < 0 || row >= field.rows - 1 || column >= field.columns - 1) return null;
  const at = (r: number, c: number) => field.nodes[r * field.columns + c] ?? -1;
  const indexes: [number, number, number, number] = [
    at(row, column),
    at(row, column + 1),
    at(row + 1, column),
    at(row + 1, column + 1),
  ];
  if (indexes.some((i) => i < 0)) return null;
  return { indexes, fx: x - column, fy: y - row };
}

function blend(values: (number | null)[], fx: number, fy: number): number | null {
  const [a, b, c, d] = values;
  if (a == null || b == null || c == null || d == null) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** East and north components of a wind blowing from `from` at `speed`. */
export function components(speed: number, from: number): [number, number] {
  const angle = (from * Math.PI) / 180;
  return [-speed * Math.sin(angle), -speed * Math.cos(angle)];
}

/** Direction the wind comes from, in whole degrees, from its components. */
export function directionOf(u: number, v: number): number {
  const degrees = (Math.atan2(-u, -v) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360) % 360;
}

/**
 * Wind at a point and hour, interpolated from the four grid points around it.
 * The direction is interpolated through the wind components, so that winds of
 * 350 and 10 degrees give north, not south; the speed is interpolated on its
 * own, so that a turning wind does not look weaker than it is.
 */
export function sampleAt(
  field: WindField,
  hour: number,
  lat: number,
  lon: number,
): WindSample | null {
  if (hour < 0 || hour >= field.hours) return null;
  const cell = corners(field, lat, lon);
  if (!cell) return null;
  const speeds = cell.indexes.map((i) => field.speed[i]?.[hour] ?? null);
  const froms = cell.indexes.map((i) => field.direction[i]?.[hour] ?? null);
  const speed = blend(speeds, cell.fx, cell.fy);
  if (speed === null || froms.some((f) => f === null)) return null;
  const vectors = speeds.map((s, k) => components(s ?? 0, froms[k] ?? 0));
  const u =
    blend(
      vectors.map((v) => v[0]),
      cell.fx,
      cell.fy,
    ) ?? 0;
  const v =
    blend(
      vectors.map((w) => w[1]),
      cell.fx,
      cell.fy,
    ) ?? 0;
  const gusts = blend(
    cell.indexes.map((i) => field.gusts[i]?.[hour] ?? null),
    cell.fx,
    cell.fy,
  );
  return { speed, from: directionOf(u, v), gusts };
}

export type VectorSampler = (lat: number, lon: number) => [number, number, number] | null;

/**
 * Fast wind lookup for one hour, for the animation: east and north components
 * (km/h) and speed at a point, interpolated as in sampleAt.
 */
export function vectorsAt(field: WindField, hour: number): VectorSampler {
  const count = field.points.length;
  const u = new Float32Array(count);
  const v = new Float32Array(count);
  const s = new Float32Array(count);
  const known = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const speed = field.speed[i]?.[hour] ?? null;
    const from = field.direction[i]?.[hour] ?? null;
    if (speed === null || from === null) continue;
    const [east, north] = components(speed, from);
    u[i] = east;
    v[i] = north;
    s[i] = speed;
    known[i] = 1;
  }
  return (lat, lon) => {
    const cell = corners(field, lat, lon);
    if (!cell) return null;
    const [a, b, c, d] = cell.indexes;
    if (!known[a] || !known[b] || !known[c] || !known[d]) return null;
    const { fx, fy } = cell;
    const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy] as const;
    return [
      (u[a] ?? 0) * w[0] + (u[b] ?? 0) * w[1] + (u[c] ?? 0) * w[2] + (u[d] ?? 0) * w[3],
      (v[a] ?? 0) * w[0] + (v[b] ?? 0) * w[1] + (v[c] ?? 0) * w[2] + (v[d] ?? 0) * w[3],
      (s[a] ?? 0) * w[0] + (s[b] ?? 0) * w[1] + (s[c] ?? 0) * w[2] + (s[d] ?? 0) * w[3],
    ];
  };
}

// ----------------------------------------------------------------- display

/** Index of the speed class of the map (0 to 4). */
export function speedClass(speed: number): number {
  const index = SPEED_CLASSES.findIndex((limit) => speed < limit);
  return index === -1 ? SPEED_CLASSES.length : index;
}

const POINTS = [
  "nord",
  "nord-nord-est",
  "nord-est",
  "est-nord-est",
  "est",
  "est-sud-est",
  "sud-est",
  "sud-sud-est",
  "sud",
  "sud-sud-ouest",
  "sud-ouest",
  "ouest-sud-ouest",
  "ouest",
  "ouest-nord-ouest",
  "nord-ouest",
  "nord-nord-ouest",
] as const;

/** Name of the direction, one of 16 points of the compass. */
export function compassPoint(degrees: number): string {
  return POINTS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16] ?? "nord";
}
