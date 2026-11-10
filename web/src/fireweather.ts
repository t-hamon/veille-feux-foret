// The weather file of the fires written by the pipeline (meteo-foyers.json):
// weather of the AROME France HD model of Météo-France, read through
// Open-Meteo, at each fire cluster with a detection in the 24 hours before the
// update, hour by hour over the 7 past days and the forecast. Hours before the
// run of the model are archived forecasts, not measurements.
//
// Checked like the other data files: a file whose structure does not match is
// refused; an entry that does not match is dropped and counted; a value out of
// its physical range is left empty and counted, never corrected.

import { AREA, DataFormatError, LIMITS, parseInstant } from "./data";

export const FIRE_WEATHER_LIMITS = { hours: 400 } as const;

export interface FireWeather {
  /** Number of the fire cluster in foyers.geojson. */
  id: number;
  /** Point of the model the values come from: [lat, lon]. */
  cell: [number, number];
  /** Elevation of that point, metres, when known. */
  elevation: number | null;
  run: Date | null;
  fetchedAt: Date;
  /** First hour, seconds since 1970-01-01 UTC. */
  start: number;
  hours: number;
  /** Values by hour; null where the model gave none. */
  temperature: (number | null)[];
  humidity: (number | null)[];
  precipitation: (number | null)[];
  speed: (number | null)[];
  direction: (number | null)[];
  gusts: (number | null)[];
}

export interface FireWeatherFile {
  fires: Map<number, FireWeather>;
  /** Recent clusters whose weather could not be fetched for this update. */
  missing: Set<number>;
}

export interface ParsedFireWeather {
  file: FireWeatherFile;
  /** Entries dropped, plus values out of their physical range. */
  rejected: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DataFormatError(`meteo-foyers.json : ${message}`);
}

const SERIES = {
  temperature: { min: -60, max: 60, integer: false },
  humidity: { min: 0, max: 100, integer: true },
  precipitation: { min: 0, max: 500, integer: false },
  speed: { min: 0, max: 400, integer: true },
  direction: { min: 0, max: 359, integer: true },
  gusts: { min: 0, max: 500, integer: true },
} as const;

type SeriesName = keyof typeof SERIES;

function inArea(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [lat, lon] = value as unknown[];
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    lon >= AREA.west &&
    lon <= AREA.east &&
    lat >= AREA.south &&
    lat <= AREA.north
  );
}

/** One entry, or undefined when its structure does not match. */
function readEntry(entry: unknown, count: { rejected: number }): FireWeather | undefined {
  if (!isObject(entry)) return undefined;
  const id = entry["id"];
  const cell = entry["cell"];
  const elevation = entry["elevation"];
  const run = entry["run"] === null ? null : parseInstant(entry["run"]);
  const fetchedAt = parseInstant(entry["fetched_at"]);
  const start = entry["start"];
  const hours = entry["hours"];
  if (
    !Number.isInteger(id) ||
    (id as number) < 1 ||
    (id as number) > LIMITS.foyers ||
    !inArea(cell) ||
    !inArea(entry["point"]) ||
    !(
      elevation === null ||
      (typeof elevation === "number" && elevation >= -500 && elevation <= 5000)
    ) ||
    (entry["run"] !== null && !run) ||
    !fetchedAt ||
    !Number.isInteger(start) ||
    (start as number) < 946_684_800 ||
    (start as number) > 4_102_444_800 ||
    !Number.isInteger(hours) ||
    (hours as number) < 1 ||
    (hours as number) > FIRE_WEATHER_LIMITS.hours
  ) {
    return undefined;
  }
  const h = hours as number;
  const series = {} as Record<SeriesName, (number | null)[]>;
  let dropped = 0;
  for (const [name, bounds] of Object.entries(SERIES) as [
    SeriesName,
    (typeof SERIES)[SeriesName],
  ][]) {
    const raw = entry[name];
    if (!Array.isArray(raw) || raw.length !== h) return undefined;
    series[name] = raw.map((item: unknown) => {
      if (item === null) return null;
      const ok =
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= bounds.min &&
        item <= bounds.max &&
        (!bounds.integer || Number.isInteger(item));
      if (!ok) dropped += 1;
      return ok ? item : null;
    });
  }
  count.rejected += dropped;
  return {
    id: id as number,
    cell: [cell[0], cell[1]],
    elevation: elevation,
    run,
    fetchedAt,
    start: start as number,
    hours: h,
    ...series,
  };
}

export function parseFireWeather(document: unknown): ParsedFireWeather {
  if (!isObject(document)) fail("objet attendu");
  const fires = document["fires"];
  const missing = document["missing"];
  if (!Array.isArray(fires) || fires.length > LIMITS.foyers) fail("liste des foyers invalide");
  if (!Array.isArray(missing) || missing.length > LIMITS.foyers) {
    fail("liste des foyers sans météo invalide");
  }
  const count = { rejected: 0 };
  const byId = new Map<number, FireWeather>();
  for (const item of fires) {
    const entry = readEntry(item, count);
    // An entry that does not match, or a second entry for the same cluster.
    if (!entry || byId.has(entry.id)) {
      count.rejected += 1;
      continue;
    }
    byId.set(entry.id, entry);
  }
  const without = new Set<number>();
  for (const id of missing) {
    if (Number.isInteger(id) && (id as number) >= 1 && (id as number) <= LIMITS.foyers) {
      without.add(id as number);
    } else {
      count.rejected += 1;
    }
  }
  return { file: { fires: byId, missing: without }, rejected: count.rejected };
}

// ------------------------------------------------------------------ reading

export interface WeatherSample {
  /** Hour of the values, seconds since 1970-01-01 UTC. */
  time: number;
  /** Air temperature at 2 m, °C. */
  temperature: number | null;
  /** Relative humidity at 2 m, %. */
  humidity: number | null;
  /** Precipitation of the preceding hour, or hours for a table row, mm. */
  precipitation: number | null;
  /** Mean wind at 10 m, km/h. */
  speed: number | null;
  /** Direction the wind comes from, degrees clockwise from north. */
  direction: number | null;
  /** Strongest gust of the preceding hour, or hours for a table row, km/h. */
  gusts: number | null;
}

/**
 * Hour of the entry closest to the instant, or null when the instant is more
 * than half an hour outside the hours of the entry.
 */
export function weatherHour(weather: FireWeather, instant: number): number | null {
  const hour = Math.round((instant - weather.start) / 3600) + 0;
  return hour >= 0 && hour < weather.hours ? hour : null;
}

export function sampleAt(weather: FireWeather, hour: number): WeatherSample {
  return {
    time: weather.start + hour * 3600,
    temperature: weather.temperature[hour] ?? null,
    humidity: weather.humidity[hour] ?? null,
    precipitation: weather.precipitation[hour] ?? null,
    speed: weather.speed[hour] ?? null,
    direction: weather.direction[hour] ?? null,
    gusts: weather.gusts[hour] ?? null,
  };
}

/** Values of the hours before and including `hour`, or null if one is missing. */
function span(values: (number | null)[], hour: number, length: number): number[] | null {
  const out: number[] = [];
  for (let k = hour - length + 1; k <= hour; k += 1) {
    const value = values[k];
    if (value === null || value === undefined) return null;
    out.push(value);
  }
  return out;
}

/**
 * The hours after `hour`, every `every` hours, up to `count` rows, within the
 * entry. Each row gives the values of its hour, except the precipitation,
 * summed over the `every` hours up to it, and the gusts, the strongest of
 * those hours; either is null when one of those hours has no value.
 */
export function nextHours(
  weather: FireWeather,
  hour: number,
  every = 3,
  count = 8,
): WeatherSample[] {
  const rows: WeatherSample[] = [];
  for (let n = 1; n <= count; n += 1) {
    const at = hour + n * every;
    if (at >= weather.hours) break;
    const rain = span(weather.precipitation, at, every);
    const gusts = span(weather.gusts, at, every);
    rows.push({
      ...sampleAt(weather, at),
      // Sums of values rounded to 0.1 mm, kept to 0.1 mm.
      precipitation: rain === null ? null : Math.round(rain.reduce((a, b) => a + b, 0) * 10) / 10,
      gusts: gusts === null ? null : Math.max(...gusts),
    });
  }
  return rows;
}

/** Distance between two points, km, on a sphere of 6,371 km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
