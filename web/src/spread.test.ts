import { describe, expect, it } from "vitest";
import weatherFile from "../e2e/fixtures/vent/meteo-foyers.json?raw";
import { type FireWeather, distanceKm, parseFireWeather } from "./fireweather";
import {
  SPREAD_FRACTIONS,
  SPREAD_HOURS,
  breadthKm,
  ellipseRing,
  headPath,
  lengthToBreadth,
  meanSpeed,
  moved,
  spreadAt,
  windSegments,
} from "./spread";

// Weather of the clusters of 12 October 2026 (update at 00:43:09 UTC), as the
// pipeline wrote it: hour by hour from 5 October 00:00 UTC.
const { file } = parseFireWeather(JSON.parse(weatherFile));
const weather = file.fires.get(1) as FireWeather;
const NOW = Date.UTC(2026, 9, 12, 0, 43, 9) / 1000;
const H = 3600;
// Centre of the cluster 1 in foyers.geojson of the same update.
const ORIGIN: [number, number] = [49.39892, 1.60739];

function steady(speed: number, from: number): FireWeather {
  const n = 48;
  return {
    ...weather,
    start: NOW - (NOW % H) - 12 * H,
    hours: n,
    speed: Array.from({ length: n }, () => speed),
    direction: Array.from({ length: n }, () => from),
    gusts: Array.from({ length: n }, () => null),
  };
}

describe("estimated spread", () => {
  it("uses 3 % and 8 % of the wind over 6 hours", () => {
    expect(SPREAD_FRACTIONS).toEqual([0.03, 0.08]);
    expect(SPREAD_HOURS).toBe(6);
  });

  it("gives the length to breadth ratio of the FBP System, equation 79", () => {
    expect(lengthToBreadth(0)).toBe(1);
    expect(lengthToBreadth(-5)).toBe(1);
    // 1 + 8.729 x (1 - e^-0.9)^2.155
    expect(lengthToBreadth(30)).toBeCloseTo(3.835, 3);
    // It levels off below 1 + 8.729.
    expect(lengthToBreadth(400)).toBeCloseTo(9.729, 3);
    expect(lengthToBreadth(20)).toBeLessThan(lengthToBreadth(40));
  });

  it("moves a point along a bearing", () => {
    const east = moved(ORIGIN, 10, 90);
    expect(distanceKm(ORIGIN, east)).toBeCloseTo(10, 1);
    expect(east[0]).toBeCloseTo(ORIGIN[0], 3);
    expect(east[1]).toBeGreaterThan(ORIGIN[1]);
    const north = moved(ORIGIN, 5, 0);
    expect(distanceKm(ORIGIN, north)).toBeCloseTo(5, 2);
    expect(north[1]).toBeCloseTo(ORIGIN[1], 6);
  });

  it("cuts the time at whole hours, reading the hourly values linearly", () => {
    const segments = windSegments(weather, NOW, NOW + 2 * H);
    if (!segments) throw new Error("no wind");
    // 00:43:09 to 01:00, 01:00 to 02:00, 02:00 to 02:43:09.
    const one = Date.UTC(2026, 9, 12, 1) / 1000;
    expect(segments.map((s) => s.until)).toEqual([one, one + H, NOW + 2 * H]);
    const value = (t: number) => weather.speed[Math.round((t - weather.start) / H)] ?? NaN;
    // A whole hour: the mean of its two hourly values.
    expect(segments[1]?.speed).toBeCloseTo((value(one) + value(one + H)) / 2, 9);
    // From 00:43:09: the value read at that instant, then the one of 01:00.
    const share = (NOW - (one - H)) / H;
    const atNow = (1 - share) * value(one - H) + share * value(one);
    expect(segments[0]?.speed).toBeCloseTo((atNow + value(one)) / 2, 9);
  });

  it("averages the direction as a vector", () => {
    // From the north at one hour, from the east at the next: from the north-east between.
    const turning = {
      ...steady(10, 0),
      direction: Array.from({ length: 48 }, (_, k) => (k % 2 === 0 ? 0 : 90)),
    };
    const even = turning.start + 12 * H;
    const segments = windSegments(turning, even, even + H);
    expect(segments?.[0]?.from).toBeCloseTo(45, 9);
    expect(segments?.[0]?.speed).toBeCloseTo(10, 9);
  });

  it("has no wind outside the file or for a missing hour", () => {
    expect(windSegments(weather, weather.start - 2 * H, weather.start)).toBeNull();
    const gap = { ...weather, speed: weather.speed.map(() => null) };
    expect(windSegments(gap, NOW, NOW + H)).toBeNull();
  });

  it("moves the head of the fire downwind, by the fraction of the wind", () => {
    // 20 km/h from the west for 2 hours: 8 % gives 3.2 km to the east.
    const wind = steady(20, 270);
    const segments = windSegments(wind, NOW, NOW + 2 * H);
    if (!segments) throw new Error("no wind");
    expect(meanSpeed(segments, NOW)).toBeCloseTo(20, 9);
    const high = headPath(ORIGIN, segments, NOW, 0.08);
    expect(high.km).toBeCloseTo(3.2, 9);
    const head = high.points[high.points.length - 1] ?? ORIGIN;
    expect(distanceKm(ORIGIN, head)).toBeCloseTo(3.2, 1);
    expect(head[1]).toBeGreaterThan(ORIGIN[1]);
    const low = headPath(ORIGIN, segments, NOW, 0.03);
    expect(low.km).toBeCloseTo(1.2, 9);
    // Breadth: distance divided by the length to breadth ratio at 20 km/h.
    expect(breadthKm(high, lengthToBreadth(20))).toBeCloseTo(3.2 / lengthToBreadth(20), 9);
  });

  it("draws the ellipse from the cluster to the head of the fire", () => {
    const head = moved(ORIGIN, 4, 90);
    const ring = ellipseRing(ORIGIN, head, 4, 2, 8);
    if (!ring) throw new Error("no ellipse");
    expect(ring).toHaveLength(9);
    expect(ring[0]).toEqual(ring[8]);
    const at = (p: [number, number] | undefined): [number, number] => {
      if (!p) throw new Error("no point");
      return [p[1], p[0]];
    };
    // Front at the head of the fire, back at the cluster, 2 km wide.
    expect(distanceKm(at(ring[0]), head)).toBeLessThan(0.01);
    expect(distanceKm(at(ring[4]), ORIGIN)).toBeLessThan(0.01);
    expect(distanceKm(at(ring[2]), at(ring[6]))).toBeCloseTo(2, 1);
    expect(ellipseRing(ORIGIN, ORIGIN, 1, 2)).toBeNull();
    expect(ellipseRing(ORIGIN, head, 0, 2)).toBeNull();
  });

  it("estimates the spread of a cluster with the wind forecast of its file", () => {
    const at = NOW + 3 * H;
    const estimate = spreadAt(weather, ORIGIN, NOW, at);
    if (!estimate) throw new Error("no estimate");
    const segments = windSegments(weather, NOW, at);
    if (!segments) throw new Error("no wind");
    let windKm = 0;
    let t = NOW;
    for (const s of segments) {
      windKm += (s.speed * (s.until - t)) / H;
      t = s.until;
    }
    expect(estimate.hours).toBe(3);
    expect(estimate.paths[0].km).toBeCloseTo(0.03 * windKm, 9);
    expect(estimate.paths[1].km).toBeCloseTo(0.08 * windKm, 9);
    expect(estimate.speed).toBeCloseTo(windKm / 3, 9);
    expect(estimate.ratio).toBeCloseTo(lengthToBreadth(windKm / 3), 9);
    expect(estimate.rings[0]).not.toBeNull();
    expect(estimate.rings[1]).not.toBeNull();
    expect(estimate.towards).toBeGreaterThanOrEqual(0);
    expect(estimate.towards).toBeLessThan(360);
  });

  it("estimates nothing on past hours or after 6 hours", () => {
    expect(spreadAt(weather, ORIGIN, NOW, NOW)).toBeNull();
    expect(spreadAt(weather, ORIGIN, NOW, NOW - H)).toBeNull();
    expect(spreadAt(weather, ORIGIN, NOW, NOW + 6 * H)).not.toBeNull();
    expect(spreadAt(weather, ORIGIN, NOW, NOW + 6 * H + 1)).toBeNull();
  });
});
