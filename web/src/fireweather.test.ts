import { describe, expect, it } from "vitest";
import meteoFile from "../e2e/fixtures/vent/meteo-foyers.json?raw";
import { DATA_FILES, DataFormatError } from "./data";
import { distanceKm, nextHours, parseFireWeather, sampleAt, weatherHour } from "./fireweather";

// meteo-foyers.json written by the pipeline from the capture of 12 October 2026.
function copy(): Record<string, unknown> {
  return JSON.parse(meteoFile) as Record<string, unknown>;
}

function firstEntry(document: Record<string, unknown>): Record<string, unknown> {
  return (document["fires"] as Record<string, unknown>[])[0] ?? {};
}

const { file } = parseFireWeather(copy());
const weather = file.fires.get(1);
if (!weather) throw new Error("no weather for fire 1");
// 12 October 2026 at 01:00 UTC, the hour shown at the update of 00:43.
const ONE_AM = Date.UTC(2026, 9, 12, 1) / 1000;

describe("weather file of the fires", () => {
  it("reads the file of the pipeline", () => {
    const parsed = parseFireWeather(copy());
    expect(DATA_FILES.fireWeather).toBe("meteo-foyers.json");
    expect(parsed.rejected).toBe(0);
    expect([...parsed.file.fires.keys()]).toEqual([1, 2, 3]);
    expect(parsed.file.missing.size).toBe(0);
    expect(weather.hours).toBe(214);
    expect(weather.start).toBe(Date.UTC(2026, 9, 5, 0) / 1000);
    expect(weather.cell).toEqual([49.4, 1.61]);
    expect(weather.elevation).toBe(154);
    expect(weather.run?.toISOString()).toBe("2026-10-11T18:00:00.000Z");
    expect(weather.fetchedAt.toISOString()).toBe("2026-10-12T00:43:09.000Z");
  });

  it("refuses a file whose structure does not match", () => {
    expect(() => parseFireWeather([])).toThrow(DataFormatError);
    expect(() => parseFireWeather({ ...copy(), fires: {} })).toThrow(
      "meteo-foyers.json : liste des foyers invalide",
    );
    expect(() => parseFireWeather({ ...copy(), missing: "1" })).toThrow(
      "liste des foyers sans météo invalide",
    );
  });

  it("drops an entry that does not match, and counts it", () => {
    const cases: [string, unknown][] = [
      ["id", 0],
      ["id", "1"],
      ["cell", [60, 2]],
      ["point", null],
      ["elevation", 9000],
      ["run", "hier"],
      ["fetched_at", null],
      ["start", 12],
      ["hours", 0],
      ["hours", 213],
      ["temperature", null],
      ["gusts", [1, 2]],
    ];
    for (const [key, value] of cases) {
      const document = copy();
      firstEntry(document)[key] = value;
      const parsed = parseFireWeather(document);
      expect(parsed.file.fires.has(1), key).toBe(false);
      expect(parsed.file.fires.size, key).toBe(2);
      expect(parsed.rejected, key).toBe(1);
    }
  });

  it("keeps the first entry of a cluster given twice", () => {
    const document = copy();
    const fires = document["fires"] as Record<string, unknown>[];
    fires.push({ ...firstEntry(document), elevation: 10 });
    const parsed = parseFireWeather(document);
    expect(parsed.file.fires.get(1)?.elevation).toBe(154);
    expect(parsed.rejected).toBe(1);
  });

  it("leaves a value out of its physical range empty, and counts it", () => {
    const document = copy();
    const entry = firstEntry(document);
    const temperature = entry["temperature"] as unknown[];
    const humidity = entry["humidity"] as unknown[];
    const direction = entry["direction"] as unknown[];
    temperature[0] = 75;
    humidity[1] = 101;
    direction[2] = 12.5;
    const parsed = parseFireWeather(document);
    const read = parsed.file.fires.get(1);
    expect(read?.temperature[0]).toBeNull();
    expect(read?.humidity[1]).toBeNull();
    expect(read?.direction[2]).toBeNull();
    expect(parsed.rejected).toBe(3);
  });

  it("reads the clusters left without weather", () => {
    const parsed = parseFireWeather({ ...copy(), missing: [4, 7, -1] });
    expect([...parsed.file.missing]).toEqual([4, 7]);
    expect(parsed.rejected).toBe(1);
  });
});

describe("weather at an instant", () => {
  it("gives the hour of the entry closest to the instant", () => {
    expect(weatherHour(weather, ONE_AM)).toBe(169);
    expect(weatherHour(weather, ONE_AM - 17 * 60)).toBe(169);
    expect(weatherHour(weather, weather.start - 1800)).toBe(0);
    expect(weatherHour(weather, weather.start - 1801)).toBeNull();
    expect(weatherHour(weather, weather.start + 213 * 3600 + 1799)).toBe(213);
    expect(weatherHour(weather, weather.start + 214 * 3600)).toBeNull();
  });

  it("gives the values of the hour", () => {
    expect(sampleAt(weather, 169)).toEqual({
      time: ONE_AM,
      temperature: 5.8,
      humidity: 100,
      precipitation: 0,
      speed: 5,
      direction: 127,
      gusts: 9,
    });
  });

  it("gives the next hours every 3 hours, with the rain and gusts of the 3 hours", () => {
    const rows = nextHours(weather, 169);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.time)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ONE_AM + n * 3 * 3600),
    );
    // 04:00 UTC: values of the hour, strongest gust of 02:00, 03:00 and 04:00.
    expect(rows[0]).toEqual({
      time: ONE_AM + 3 * 3600,
      temperature: 5.3,
      humidity: 98,
      precipitation: 0,
      speed: 9,
      direction: 113,
      gusts: 13,
    });
  });

  it("sums the rain of the 3 hours, and gives none when one of them is missing", () => {
    const document = copy();
    const entry = firstEntry(document);
    const rain = entry["precipitation"] as (number | null)[];
    rain.splice(170, 3, 0.1, 0.2, 0.4);
    rain[175] = null;
    const read = parseFireWeather(document).file.fires.get(1);
    if (!read) throw new Error("no weather");
    const rows = nextHours(read, 169);
    expect(rows[0]?.precipitation).toBe(0.7);
    expect(rows[1]?.precipitation).toBeNull();
    expect(rows[1]?.temperature).toBe(6.8);
  });

  it("stops at the last hour of the entry", () => {
    expect(nextHours(weather, 200)).toHaveLength(4);
    expect(nextHours(weather, 211)).toHaveLength(0);
  });

  it("measures the distance to the point of the model", () => {
    expect(distanceKm([49.3989, 1.6074], [49.4, 1.61])).toBeCloseTo(0.224, 3);
    // One degree of latitude: about 111.2 km.
    expect(distanceKm([45, 2], [46, 2])).toBeCloseTo(111.19, 1);
  });
});
