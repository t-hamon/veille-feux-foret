import { describe, expect, it } from "vitest";
import completEtat from "../e2e/fixtures/complet/etat.json?raw";
import partielEtat from "../e2e/fixtures/firms-partiel/etat.json?raw";
import panneEtat from "../e2e/fixtures/firms-en-panne/etat.json?raw";
import { parseStatus } from "./data";
import * as format from "./format";
import { formatFragment, parseFragment } from "./share";
import { ageMinutes, freshness, health } from "./status";
import {
  ageClass,
  byAge,
  fireInstant,
  instantAt,
  isForecast,
  rangeOf,
  stepOf,
  visibleFilter,
} from "./timeline";

const generated = new Date("2026-10-03T11:28:00Z");
const minutesLater = (m: number) => new Date(generated.getTime() + m * 60_000);

describe("freshness", () => {
  const status = parseStatus(JSON.parse(completEtat));

  it("is fresh up to 90 minutes, late up to 24 hours, then old", () => {
    expect(freshness(status, minutesLater(0))).toBe("fresh");
    expect(freshness(status, minutesLater(90))).toBe("fresh");
    expect(freshness(status, minutesLater(91))).toBe("late");
    expect(freshness(status, minutesLater(24 * 60))).toBe("late");
    expect(freshness(status, minutesLater(24 * 60 + 1))).toBe("old");
  });

  it("never gives a negative age when the device clock is behind", () => {
    expect(ageMinutes(generated, minutesLater(-30))).toBe(0);
  });

  it("lists failed sources and tells when every FIRMS feed is down", () => {
    expect(health(status)).toEqual({ failed: [], firmsDown: false });
    const partial = health(parseStatus(JSON.parse(partielEtat)));
    expect(partial.failed.map((s) => s.id)).toEqual(["firms_viirs_noaa21"]);
    expect(partial.firmsDown).toBe(false);
    const down = health(parseStatus(JSON.parse(panneEtat)));
    expect(down.firmsDown).toBe(true);
    expect(down.failed).toHaveLength(4);
  });
});

describe("timeline", () => {
  const range = rangeOf(generated, 168);
  const end = generated.getTime() / 1000;

  it("covers the window hour by hour and ends on the last update", () => {
    expect(range).toEqual({ start: end - 168 * 3600, now: end, end, nowStep: 168, steps: 168 });
    expect(instantAt(range, 168)).toBe(end);
    expect(instantAt(range, 0)).toBe(range.start);
    expect(instantAt(range, 500)).toBe(end);
    expect(instantAt(range, -3)).toBe(range.start);
    expect(stepOf(range, end)).toBe(168);
    expect(stepOf(range, end + 999)).toBe(168);
    expect(stepOf(range, range.start + 3600 * 10 + 5)).toBe(10);
  });

  it("goes on hour by hour after the last update when a forecast is shown", () => {
    // Last update at 11:28; the forecast runs to 13:00 the next day.
    const forecastEnd = Date.parse("2026-10-04T13:00:00Z") / 1000;
    const extended = rangeOf(generated, 168, forecastEnd);
    const noon = Date.parse("2026-10-03T12:00:00Z") / 1000;
    expect(extended).toEqual({
      start: end - 168 * 3600,
      now: end,
      end: forecastEnd,
      nowStep: 168,
      steps: 168 + 26,
    });
    expect(instantAt(extended, 168)).toBe(end);
    expect(instantAt(extended, 169)).toBe(noon);
    expect(instantAt(extended, 194)).toBe(forecastEnd);
    expect(instantAt(extended, 999)).toBe(forecastEnd);
    expect(instantAt(extended, 167)).toBe(end - 168 * 3600 + 167 * 3600);
    expect(stepOf(extended, end)).toBe(168);
    expect(stepOf(extended, end + 60)).toBe(168);
    expect(stepOf(extended, noon)).toBe(169);
    expect(stepOf(extended, noon + 3599)).toBe(169);
    expect(stepOf(extended, forecastEnd)).toBe(194);
    expect(stepOf(extended, forecastEnd + 7200)).toBe(194);
    // Every step gives back its own instant.
    for (let step = 0; step <= extended.steps; step += 1) {
      expect(stepOf(extended, instantAt(extended, step))).toBe(step);
    }
  });

  it("ignores a forecast that ends before the next whole hour", () => {
    expect(rangeOf(generated, 168, end + 600)).toEqual(range);
    expect(rangeOf(generated, 168, null)).toEqual(range);
  });

  it("keeps the fires of the last update for the forecast hours", () => {
    const extended = rangeOf(generated, 168, end + 10 * 3600);
    expect(isForecast(extended, end)).toBe(false);
    expect(isForecast(extended, end + 1)).toBe(true);
    expect(fireInstant(extended, end - 3600)).toBe(end - 3600);
    expect(fireInstant(extended, end + 5 * 3600)).toBe(end);
  });

  it("classes detections by age at the chosen instant", () => {
    expect(ageClass(end + 1, end)).toBeNull();
    expect(ageClass(end, end)).toBe(0);
    expect(ageClass(end - 6 * 3600 + 1, end)).toBe(0);
    expect(ageClass(end - 6 * 3600, end)).toBe(1);
    expect(ageClass(end - 24 * 3600, end)).toBe(2);
    expect(ageClass(end - 72 * 3600, end)).toBe(3);
    expect(ageClass(end - 160 * 3600, end)).toBe(3);
  });

  it("builds the map expressions matching the age classes", () => {
    expect(visibleFilter(end)).toEqual(["<=", ["get", "t"], end]);
    expect(byAge(end, ["a", "b", "c", "d"])).toEqual([
      "step",
      ["/", ["-", end, ["get", "t"]], 3600],
      "a",
      6,
      "b",
      24,
      "c",
      72,
      "d",
    ]);
    expect(() => byAge(end, ["a"])).toThrow();
  });
});

describe("shared view in the address", () => {
  it("reads a complete view", () => {
    expect(
      parseFragment(
        "#carte=8.50/43.52970/5.44740&fond=osm&instant=1791076800&foyer=3&brule=1&vent=1",
      ),
    ).toEqual({
      view: { zoom: 8.5, lat: 43.5297, lon: 5.4474 },
      basemap: "osm",
      instant: 1_791_076_800,
      foyer: 3,
      burned: true,
      wind: true,
    });
  });

  it("round-trips through the address", () => {
    const state = {
      view: { zoom: 6, lat: 46.6, lon: 2.4 },
      basemap: "osm" as const,
      instant: 1_791_076_800,
      foyer: 12,
      burned: true,
      wind: true,
    };
    expect(formatFragment(state)).toContain("&vent=1");
    expect(parseFragment(formatFragment(state))).toEqual(state);
    expect(formatFragment({ basemap: "ign" })).toBe("");
  });

  it("ignores anything that does not match exactly", () => {
    const hostile = [
      "#carte=8/43.5/5.4<script>",
      "#carte=40/43.5/5.4",
      "#carte=8/80/5.4",
      "#carte=8/43.5/-120",
      "#fond=javascript:alert(1)",
      "#instant=17910768000",
      "#instant=-1",
      "#foyer=0",
      "#foyer=1e3",
      "#foyer=12345",
      "#brule=true",
      "#vent=oui",
      "#vent=1x",
      `#carte=${"9".repeat(400)}`,
      "#%E0%A4%A",
    ];
    for (const fragment of hostile) {
      expect(parseFragment(fragment), fragment).toEqual({});
    }
  });
});

describe("format", () => {
  it("writes dates in the time zone of metropolitan France", () => {
    expect(format.dateTime(generated)).toBe("3 oct., 13:28");
    expect(format.dateTimeLong(generated)).toBe("3 octobre 2026 à 13:28");
    expect(format.hour(generated)).toBe("13:28");
    expect(format.dayShort(generated)).toBe("3 oct.");
    // 22:30 UTC on 3 October is already 4 October in Paris.
    expect(format.dayShort(new Date("2026-10-03T22:30:00Z"))).toBe("4 oct.");
    expect(format.day("2026-09-30")).toBe("30 septembre 2026");
  });

  it("writes elapsed times", () => {
    expect(format.elapsed(0)).toBe("à l'instant");
    expect(format.elapsed(42)).toBe("il y a 42 min");
    expect(format.elapsed(60)).toBe("il y a 1 h");
    expect(format.elapsed(125)).toBe("il y a 2 h 05");
    expect(format.elapsed(60 * 50)).toBe("il y a 2 jours");
  });

  it("writes delays until a forecast hour", () => {
    expect(format.until(42)).toBe("dans 42 min");
    expect(format.until(60)).toBe("dans 1 h");
    expect(format.until(13 * 60 + 29)).toBe("dans 13 h");
    expect(format.until(43 * 60 + 57)).toBe("dans 44 h");
    // A forecast hour already gone by, when the data is late.
    expect(format.until(0)).toBe("à l'instant");
    expect(format.until(-10)).toBe("il y a 10 min");
  });

  it("writes numbers and coordinates the French way", () => {
    expect(format.hectares(97_971)).toBe("97 971 ha");
    expect(format.coordinates(43.5297, -1.2)).toBe("43,5297° N, 1,2000° O");
    expect(format.decimal(3.34)).toBe("3,3");
  });
});
