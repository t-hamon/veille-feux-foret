import { describe, expect, it } from "vitest";
import ventFile from "../e2e/fixtures/vent/vent.json?raw";
import { DATA_FILES, DataFormatError, loadFile } from "./data";
import {
  type WindField,
  compassPoint,
  components,
  directionOf,
  hourAt,
  hourTime,
  parseWind,
  sampleAt,
  speedClass,
  vectorsAt,
} from "./wind";

// vent.json written by the pipeline from the capture of 12 October 2026.
const document = JSON.parse(ventFile) as Record<string, unknown>;
const { field } = parseWind(document);

function copy(): Record<string, unknown> {
  return JSON.parse(ventFile) as Record<string, unknown>;
}

function pointIndex(f: WindField, lat: number, lon: number): number {
  return f.points.findIndex(([a, b]) => a === lat && b === lon);
}

describe("wind file", () => {
  it("reads the file of the pipeline", () => {
    const parsed = parseWind(document);
    expect(parsed.rejected).toBe(0);
    expect(field.points).toHaveLength(415);
    expect(field.hours).toBe(214);
    expect(field.start).toBe(Date.UTC(2026, 9, 5, 0) / 1000);
    expect(field.run?.toISOString()).toBe("2026-10-11T18:00:00.000Z");
    expect(field.fetchedAt.toISOString()).toBe("2026-10-12T00:43:09.000Z");
    expect([field.south, field.west, field.step]).toEqual([41, -5.5, 0.5]);
    expect([field.rows, field.columns]).toEqual([22, 32]);
    expect(DATA_FILES.wind).toBe("vent.json");
  });

  it("refuses a file of another structure", () => {
    const cases: [string, (d: Record<string, unknown>) => void][] = [
      ["date de collecte", (d) => (d["fetched_at"] = "hier")],
      ["heure du calcul", (d) => (d["run"] = "midi")],
      ["première heure", (d) => (d["start"] = "1791158400")],
      ["nombre d'heures", (d) => (d["hours"] = 0)],
      ["nombre d'heures", (d) => (d["hours"] = 401)],
      ["pas de grille", (d) => (d["step"] = 0)],
      ["liste de points", (d) => (d["points"] = [])],
      ["point invalide", (d) => ((d["points"] as unknown[])[0] = [46])],
      ["hors de la zone", (d) => ((d["points"] as unknown[])[0] = [60, 2])],
      ["hors de la grille", (d) => ((d["points"] as unknown[])[3] = [41.25, 9.5])],
      ["en double", (d) => ((d["points"] as unknown[])[1] = (d["points"] as unknown[])[0])],
      ["une série par point", (d) => (d["speed"] as unknown[]).pop()],
      ["une valeur par heure", (d) => ((d["gusts"] as unknown[][])[2] ?? []).pop()],
    ];
    expect(() => parseWind([document]), "objet").toThrow("objet attendu");
    for (const [message, change] of cases) {
      const broken = copy();
      change(broken);
      expect(() => parseWind(broken), message).toThrow(DataFormatError);
      expect(() => parseWind(broken), message).toThrow(message);
    }
  });

  it("drops values out of their range and counts them", () => {
    const broken = copy();
    const speed = broken["speed"] as unknown[][];
    const direction = broken["direction"] as unknown[][];
    const gusts = broken["gusts"] as unknown[][];
    (speed[0] as unknown[])[0] = -2;
    (speed[0] as unknown[])[1] = 3.5;
    (direction[0] as unknown[])[0] = 360;
    (gusts[0] as unknown[])[0] = "fort";
    const parsed = parseWind(broken);
    expect(parsed.rejected).toBe(4);
    expect(parsed.field.speed[0]?.slice(0, 3)).toEqual([null, null, speed[0]?.[2]]);
    expect(parsed.field.direction[0]?.[0]).toBeNull();
    expect(parsed.field.gusts[0]?.[0]).toBeNull();
  });

  it("is loaded like the other data files", async () => {
    const asked: string[] = [];
    const fetcher = (url: string) => {
      asked.push(url);
      return Promise.resolve(new Response(ventFile, { status: 200 }));
    };
    const result = await loadFile("wind", parseWind, fetcher);
    expect(asked).toEqual(["./data/vent.json"]);
    expect(result.state === "ok" && result.value.field.points.length).toBe(415);
  });
});

describe("wind in time", () => {
  it("finds the hour closest to an instant, within the file", () => {
    expect(hourAt(field, field.start)).toBe(0);
    expect(hourAt(field, field.start + 1799)).toBe(0);
    expect(hourAt(field, field.start + 1800)).toBe(1);
    expect(hourAt(field, field.start - 1800)).toBe(0);
    expect(hourAt(field, field.start - 1801)).toBeNull();
    const last = hourTime(field, field.hours - 1);
    expect(last).toBe(Date.UTC(2026, 9, 13, 21) / 1000);
    expect(hourAt(field, last + 1799)).toBe(field.hours - 1);
    expect(hourAt(field, last + 1801)).toBeNull();
  });
});

describe("wind at a point", () => {
  it("gives the values of a grid point on that point", () => {
    // 46 N, 2 E at the first hour: 3 km/h from 162 degrees, gusts 9 km/h.
    const i = pointIndex(field, 46, 2);
    expect(field.speed[i]?.[0]).toBe(3);
    const sample = sampleAt(field, 0, 46, 2);
    expect(sample).toEqual({ speed: 3, from: 162, gusts: 9 });
  });

  it("interpolates between the four grid points around", () => {
    // Corners at the first hour: 3, 6, 4 and 3 km/h; gusts 9, 12, 7 and 2.
    const sample = sampleAt(field, 0, 46.25, 2.25);
    expect(sample?.speed).toBeCloseTo((3 + 6 + 4 + 3) / 4, 10);
    expect(sample?.gusts).toBeCloseTo((9 + 12 + 7 + 2) / 4, 10);
    const sampler = vectorsAt(field, 0);
    const [u, v, speed] = sampler(46.25, 2.25) ?? [0, 0, 0];
    expect(speed).toBeCloseTo(sample?.speed ?? 0, 5);
    expect(directionOf(u, v)).toBe(sample?.from);
  });

  it("gives no wind outside the grid or next to a point without value", () => {
    expect(sampleAt(field, 0, 40, 2)).toBeNull();
    expect(sampleAt(field, 0, 46, 12)).toBeNull();
    expect(sampleAt(field, -1, 46, 2)).toBeNull();
    expect(sampleAt(field, field.hours, 46, 2)).toBeNull();
    // At sea, far from the coast, the grid has no point: no wind is shown.
    expect(sampleAt(field, 0, 46, -5)).toBeNull();
    expect(vectorsAt(field, 0)(46, -5)).toBeNull();

    const broken = copy();
    const i = pointIndex(field, 46, 2.5);
    ((broken["speed"] as unknown[][])[i] as unknown[])[0] = null;
    const holed = parseWind(broken).field;
    expect(sampleAt(holed, 0, 46.25, 2.25)).toBeNull();
    expect(sampleAt(holed, 0, 46, 2)).toBeNull();
    expect(vectorsAt(holed, 0)(46.25, 2.25)).toBeNull();
    expect(sampleAt(holed, 1, 46.25, 2.25)).not.toBeNull();
  });

  it("averages directions through their components", () => {
    // 350 and 10 degrees: north, not south.
    const [u1, v1] = components(10, 350);
    const [u2, v2] = components(10, 10);
    expect(directionOf((u1 + u2) / 2, (v1 + v2) / 2)).toBe(0);
    expect(directionOf(...components(20, 270))).toBe(270);
    const [east, north] = components(10, 270);
    // A wind from the west blows towards the east.
    expect(east).toBeCloseTo(10, 10);
    expect(north).toBeCloseTo(0, 10);
  });
});

describe("display of the wind", () => {
  it("classes speeds and names directions", () => {
    expect([0, 9.9, 10, 19, 20, 30, 49, 50, 120].map(speedClass)).toEqual([
      0, 0, 1, 1, 2, 3, 3, 4, 4,
    ]);
    expect(compassPoint(0)).toBe("nord");
    expect(compassPoint(11)).toBe("nord");
    expect(compassPoint(12)).toBe("nord-nord-est");
    expect(compassPoint(225)).toBe("sud-ouest");
    expect(compassPoint(340)).toBe("nord-nord-ouest");
    expect(compassPoint(349)).toBe("nord");
    expect(compassPoint(-90)).toBe("ouest");
  });
});
