import { describe, expect, it } from "vitest";
import stationsFile from "../e2e/fixtures/stations/stations-vent.json?raw";
import { DATA_FILES, DataFormatError } from "./data";
import {
  LATEST_MAX_AGE,
  NEAREST_MAX_KM,
  measuredHour,
  nearestStation,
  parseStations,
  sampleAtStation,
  stationsAt,
  toKmh,
} from "./stations";

// stations-vent.json written by the pipeline from the capture of 11 November
// 2026 at 23:22 UTC: 120 hours from 7 November 00:00 UTC, 726 stations.
type Json = Record<string, unknown>;

function copy(): Json {
  return JSON.parse(stationsFile) as Json;
}

function stationsOf(document: Json): Json[] {
  return document["stations"] as Json[];
}

const { file } = parseStations(copy());
const START = Date.UTC(2026, 10, 7, 0) / 1000;
// 11 November 2026 at 23:00 UTC, the latest hour of the file.
const LATEST = Date.UTC(2026, 10, 11, 23) / 1000;
const H = 3600;

describe("stations file", () => {
  it("reads the file of the pipeline", () => {
    const parsed = parseStations(copy());
    expect(DATA_FILES.stations).toBe("stations-vent.json");
    expect(parsed.rejected).toBe(0);
    expect(parsed.file.start).toBe(START);
    expect(parsed.file.hours).toBe(120);
    expect(parsed.file.fetchedAt?.toISOString()).toBe("2026-11-11T23:22:44.000Z");
    expect(parsed.file.stations).toHaveLength(726);
    const arbent = parsed.file.stations[0];
    expect(arbent?.id).toBe("01014002");
    expect(arbent?.name).toBe("ARBENT");
    expect(arbent?.altitude).toBe(534);
    expect([arbent?.lat, arbent?.lon]).toEqual([46.278167, 5.669]);
    expect([arbent?.ff.at(-1), arbent?.dd.at(-1), arbent?.raf.at(-1)]).toEqual([0.8, 70, 2.4]);
  });

  it("reads an empty file", () => {
    const parsed = parseStations({ ...copy(), start: null, hours: 0, stations: [] });
    expect(parsed.file.start).toBeNull();
    expect(parsed.file.stations).toEqual([]);
    expect(stationsAt(parsed.file, LATEST)).toEqual([]);
  });

  it("refuses a file whose structure does not match", () => {
    expect(() => parseStations([])).toThrow(DataFormatError);
    expect(() => parseStations(null)).toThrow("stations-vent.json : objet attendu");
    expect(() => parseStations({ ...copy(), stations: {} })).toThrow(
      "stations-vent.json : liste des stations invalide",
    );
    for (const hours of [-1, 1.5, 169, "120"]) {
      expect(() => parseStations({ ...copy(), hours })).toThrow("nombre d'heures invalide");
    }
    for (const start of [START + 1, "1794009600", null, 12]) {
      expect(() => parseStations({ ...copy(), start })).toThrow("première heure invalide");
    }
    expect(() => parseStations({ ...copy(), start: START, hours: 0, stations: [] })).toThrow(
      "première heure invalide",
    );
    expect(() => parseStations({ ...copy(), fetched_at: "hier" })).toThrow(
      "date de lecture invalide",
    );
  });

  it("drops a station that does not match, and counts it", () => {
    const cases: [string, unknown][] = [
      ["id", "1014002"],
      ["id", 1014002],
      ["name", "<b>ARBENT</b>"],
      ["name", ""],
      ["altitude", 9000],
      ["altitude", 534.5],
      ["lat", 16.2],
      ["lon", "5.669"],
      ["ff", [0.8]],
      ["dd", null],
    ];
    for (const [key, value] of cases) {
      const document = copy();
      const first = stationsOf(document)[0];
      if (!first) throw new Error("no station");
      first[key] = value;
      const parsed = parseStations(document);
      expect(parsed.rejected, `${key} = ${JSON.stringify(value)}`).toBe(1);
      expect(parsed.file.stations).toHaveLength(725);
      expect(parsed.file.stations[0]?.id).not.toBe("01014002");
    }
    const twice = copy();
    stationsOf(twice).push(structuredClone(stationsOf(twice)[0] ?? {}));
    const parsed = parseStations(twice);
    expect(parsed.rejected).toBe(1);
    expect(parsed.file.stations).toHaveLength(726);
  });

  it("leaves a value out of its range empty, never corrected, and counts it", () => {
    const document = copy();
    const first = stationsOf(document)[0];
    if (!first) throw new Error("no station");
    const ff = first["ff"] as unknown[];
    const dd = first["dd"] as unknown[];
    const raf = first["raf"] as unknown[];
    ff[119] = 80;
    dd[119] = 70.5;
    raf[119] = "2.4";
    ff[118] = -1;
    const parsed = parseStations(document);
    expect(parsed.rejected).toBe(4);
    const arbent = parsed.file.stations[0];
    expect([arbent?.ff[119], arbent?.dd[119], arbent?.raf[119], arbent?.ff[118]]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(arbent?.ff[117]).toBe(file.stations[0]?.ff[117]);
  });
});

describe("reading the stations", () => {
  it("converts m/s to km/h, rounded", () => {
    expect(toKmh(0.8)).toBe(3);
    expect(toKmh(2.4)).toBe(9);
    expect(toKmh(0)).toBe(0);
    expect(toKmh(10)).toBe(36);
  });

  it("takes the latest hour measured at the instant", () => {
    expect(measuredHour(file, START)).toBe(0);
    expect(measuredHour(file, START + H - 1)).toBe(0);
    expect(measuredHour(file, START + H)).toBe(1);
    expect(measuredHour(file, LATEST + 59 * 60)).toBe(119);
    expect(measuredHour(file, START - 1)).toBeNull();
  });

  it("keeps the last hour of the file for less than 2 hours after it", () => {
    // An update at 00:07 UTC on 12 November only has the measurement of 23:00.
    expect(LATEST_MAX_AGE).toBe(2 * H);
    expect(measuredHour(file, LATEST + H + 7 * 60)).toBe(119);
    expect(measuredHour(file, LATEST + 2 * H - 1)).toBe(119);
    expect(measuredHour(file, LATEST + 2 * H)).toBeNull();
    expect(stationsAt(file, LATEST + H + 7 * 60)[0]).toMatchObject({ time: LATEST, speed: 3 });
  });

  it("gives the stations that measured something at that hour", () => {
    const latest = stationsAt(file, LATEST + 22 * 60);
    expect(latest).toHaveLength(719);
    const arbent = latest[0];
    expect(arbent).toMatchObject({ index: 0, time: LATEST, speed: 3, from: 70, gusts: 9 });
    expect(arbent?.station.name).toBe("ARBENT");
    // Before 21:00 UTC on 11 November, only the department package of the
    // Bouches-du-Rhône was read.
    expect(stationsAt(file, Date.UTC(2026, 10, 9, 12, 30) / 1000)).toHaveLength(16);
    expect(stationsAt(file, START - 1)).toEqual([]);
  });

  it("gives no direction for a calm", () => {
    // LURCY-LEVIS SA: 0 m/s, direction 0, gust 1.5 m/s at 23:00 UTC.
    const calm = stationsAt(file, LATEST).find((s) => s.station.name === "LURCY-LEVIS SA");
    expect(calm).toMatchObject({ speed: 0, from: null, gusts: 5 });
  });

  it("gives north as 0° and keeps a measurement without gust or mean wind", () => {
    const document = copy();
    const first = stationsOf(document)[0];
    if (!first) throw new Error("no station");
    (first["dd"] as unknown[])[119] = 360;
    const north = parseStations(document).file;
    expect(sampleAtStation(north, 0, LATEST)).toMatchObject({ from: 0, speed: 3 });
    (first["raf"] as unknown[])[119] = null;
    expect(sampleAtStation(parseStations(document).file, 0, LATEST)?.gusts).toBeNull();
    (first["ff"] as unknown[])[119] = null;
    (first["raf"] as unknown[])[119] = 2.4;
    expect(sampleAtStation(parseStations(document).file, 0, LATEST)).toMatchObject({
      speed: null,
      from: 0,
      gusts: 9,
    });
    (first["raf"] as unknown[])[119] = null;
    expect(sampleAtStation(parseStations(document).file, 0, LATEST)).toBeNull();
  });

  it("gives the measurement of one station, or nothing outside the file", () => {
    expect(sampleAtStation(file, 0, LATEST)).toMatchObject({ speed: 3, from: 70, gusts: 9 });
    expect(sampleAtStation(file, 0, LATEST + 2 * H)).toBeNull();
    expect(sampleAtStation(file, 726, LATEST)).toBeNull();
  });

  it("finds the closest station with a mean wind, within 50 km", () => {
    expect(NEAREST_MAX_KM).toBe(50);
    const here = nearestStation(file, 46.278167, 5.669, LATEST);
    expect(here?.sample.station.name).toBe("ARBENT");
    expect(here?.distanceKm).toBe(0);
    // In the Bay of Biscay, more than 50 km from any station.
    expect(nearestStation(file, 45.5, -3.5, LATEST)).toBeNull();
    // A closer limit leaves out a station farther away.
    const near = nearestStation(file, 46.4, 5.669, LATEST);
    if (!near) throw new Error("no station");
    expect(near.sample.station.name).toBe("ARBENT");
    expect(nearestStation(file, 46.4, 5.669, LATEST, near.distanceKm - 0.01)).toBeNull();
    // Nothing measured at that instant.
    expect(nearestStation(file, 46.278167, 5.669, START - 1)).toBeNull();
  });
});
