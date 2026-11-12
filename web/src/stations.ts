// The wind measured at the Météo-France ground stations, written by the
// pipeline (stations-vent.json): mean wind over 10 minutes at 10 m (ff, m/s),
// its direction (dd, degrees, 360 for north, 0 with a calm) and the strongest
// gust of the hour (raf, m/s), hour by hour over the last 7 days at most.
//
// Checked like the other data files: a structure that does not match refuses
// the file; a station that does not match is dropped and counted; a value out
// of its physical range is left empty and counted, never corrected.

import { AREA, DataFormatError, parseInstant } from "./data";
import { distanceKm } from "./fireweather";

export const STATIONS_LIMITS = { stations: 5000, hours: 168 } as const;
const HOUR = 3600;
const BOUNDS = { ff: [0, 75], dd: [0, 360], raf: [0, 120] } as const;
type Parameter = keyof typeof BOUNDS;
const ID = /^\d{8}$/;
const NAME = /^[\p{L}\p{N}_' ./()-]{1,60}$/u;

export interface Station {
  id: string;
  name: string | null;
  altitude: number | null;
  lat: number;
  lon: number;
  /** Values by hour of the file; null where the station measured nothing. */
  ff: (number | null)[];
  dd: (number | null)[];
  raf: (number | null)[];
}

export interface StationsFile {
  fetchedAt: Date | null;
  /** First hour, seconds since 1970-01-01 UTC; null for an empty file. */
  start: number | null;
  hours: number;
  stations: Station[];
}

export interface ParsedStations {
  file: StationsFile;
  /** Stations dropped, plus values out of their physical range. */
  rejected: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DataFormatError(`stations-vent.json : ${message}`);
}

function inArea(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    lon >= AREA.west &&
    lon <= AREA.east &&
    lat >= AREA.south &&
    lat <= AREA.north
  );
}

function readStation(raw: unknown, hours: number, count: { rejected: number }): Station | null {
  if (!isObject(raw)) return null;
  const { id, name, altitude, lat, lon } = raw;
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    !inArea(lat, lon) ||
    !(name === null || (typeof name === "string" && NAME.test(name))) ||
    !(
      altitude === null ||
      (Number.isInteger(altitude) && (altitude as number) >= -500 && (altitude as number) <= 5000)
    )
  ) {
    return null;
  }
  const series = {} as Record<Parameter, (number | null)[]>;
  for (const parameter of Object.keys(BOUNDS) as Parameter[]) {
    const values = raw[parameter];
    if (!Array.isArray(values) || values.length !== hours) return null;
    const [low, high] = BOUNDS[parameter];
    series[parameter] = values.map((value: unknown) => {
      if (value === null) return null;
      const ok =
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= low &&
        value <= high &&
        (parameter !== "dd" || Number.isInteger(value));
      if (!ok) count.rejected += 1;
      return ok ? value : null;
    });
  }
  return {
    id,
    name: name,
    altitude: altitude as number | null,
    lat: lat as number,
    lon: lon as number,
    ...series,
  };
}

export function parseStations(document: unknown): ParsedStations {
  if (!isObject(document)) fail("objet attendu");
  const { start, hours, stations } = document;
  if (!Array.isArray(stations) || stations.length > STATIONS_LIMITS.stations) {
    fail("liste des stations invalide");
  }
  if (
    !Number.isInteger(hours) ||
    (hours as number) < 0 ||
    (hours as number) > STATIONS_LIMITS.hours
  ) {
    fail("nombre d'heures invalide");
  }
  const empty = hours === 0;
  if (
    empty
      ? start !== null
      : !Number.isInteger(start) ||
        (start as number) % HOUR !== 0 ||
        (start as number) < 946_684_800 ||
        (start as number) > 4_102_444_800
  ) {
    fail("première heure invalide");
  }
  const fetched = document["fetched_at"];
  const fetchedAt = fetched === null ? null : parseInstant(fetched);
  if (fetched !== null && !fetchedAt) fail("date de lecture invalide");
  const count = { rejected: 0 };
  const seen = new Set<string>();
  const out: Station[] = [];
  for (const raw of stations) {
    const station = readStation(raw, hours as number, count);
    if (!station || seen.has(station.id)) {
      count.rejected += 1;
      continue;
    }
    seen.add(station.id);
    out.push(station);
  }
  return {
    file: {
      fetchedAt,
      start: empty ? null : (start as number),
      hours: hours as number,
      stations: out,
    },
    rejected: count.rejected,
  };
}

// ------------------------------------------------------------------ reading

export interface StationSample {
  station: Station;
  /** Index of the station in the file. */
  index: number;
  /** Hour of the measurement, seconds since 1970-01-01 UTC. */
  time: number;
  /** km/h, rounded. */
  speed: number | null;
  /** Direction the wind comes from, degrees; null for a calm or no value. */
  from: number | null;
  /** km/h, rounded. */
  gusts: number | null;
}

/** m/s to km/h, rounded to the unit. */
export function toKmh(value: number): number {
  return Math.round(value * 3.6);
}

/**
 * Longest time after the last hour of the file during which that hour is still
 * shown: a measurement is published about 10 minutes after its hour and read
 * at the next update of the site, every 30 minutes. Past it, the stations are
 * late and nothing is shown.
 */
export const LATEST_MAX_AGE = 2 * HOUR;

/**
 * Hour of the file measured at or before the instant: the latest measurement
 * already made at that instant, or, after the end of the file, its last hour
 * for less than `LATEST_MAX_AGE`. Null when the file has none for it.
 */
export function measuredHour(file: StationsFile, instant: number): number | null {
  if (file.start === null || file.hours === 0) return null;
  const hour = Math.floor((instant - file.start) / HOUR);
  if (hour < 0) return null;
  if (hour < file.hours) return hour;
  const last = file.hours - 1;
  return instant - (file.start + last * HOUR) < LATEST_MAX_AGE ? last : null;
}

function sampleOf(
  file: StationsFile,
  index: number,
  station: Station,
  hour: number,
): StationSample | null {
  const ff = station.ff[hour] ?? null;
  const dd = station.dd[hour] ?? null;
  const raf = station.raf[hour] ?? null;
  if (ff === null && raf === null) return null;
  return {
    station,
    index,
    time: (file.start ?? 0) + hour * HOUR,
    speed: ff === null ? null : toKmh(ff),
    // Direction 0 goes with a calm in the data of Météo-France: no direction.
    from: dd === null || dd === 0 || ff === 0 ? null : dd % 360,
    gusts: raf === null ? null : toKmh(raf),
  };
}

/** The stations that measured something at the hour of the instant. */
export function stationsAt(file: StationsFile, instant: number): StationSample[] {
  const hour = measuredHour(file, instant);
  if (hour === null) return [];
  return file.stations.flatMap((station, index) => {
    const sample = sampleOf(file, index, station, hour);
    return sample ? [sample] : [];
  });
}

export function sampleAtStation(
  file: StationsFile,
  index: number,
  instant: number,
): StationSample | null {
  const station = file.stations[index];
  const hour = measuredHour(file, instant);
  if (!station || hour === null) return null;
  return sampleOf(file, index, station, hour);
}

export const NEAREST_MAX_KM = 50;

/**
 * The closest station with a mean wind measured at the hour of the instant,
 * within `maxKm`, or null.
 */
export function nearestStation(
  file: StationsFile,
  lat: number,
  lon: number,
  instant: number,
  maxKm = NEAREST_MAX_KM,
): { sample: StationSample; distanceKm: number } | null {
  let best: { sample: StationSample; distanceKm: number } | null = null;
  for (const sample of stationsAt(file, instant)) {
    if (sample.speed === null) continue;
    const distance = distanceKm([lat, lon], [sample.station.lat, sample.station.lon]);
    if (distance <= maxKm && (best === null || distance < best.distanceKm)) {
      best = { sample, distanceKm: distance };
    }
  }
  return best;
}
