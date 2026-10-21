import { describe, expect, it } from "vitest";
import ventFile from "../e2e/fixtures/vent/vent.json?raw";
import { arrowsInView, translated } from "./windlayer";
import { parseWind } from "./wind";

const { field } = parseWind(JSON.parse(ventFile) as unknown);
const FRANCE = { west: -5.5, south: 41, east: 10, north: 51.5 };

describe("translation of the map matrix", () => {
  it("gives the same point as the matrix applied to the absolute position", () => {
    const matrix = Array.from<unknown, number>({ length: 16 }, (_, k) => (k * 7) % 11);
    const out = translated(matrix, 0.25, -0.5);
    const apply = (m: ArrayLike<number>, x: number, y: number) =>
      [0, 1, 2, 3].map((row) => (m[row] ?? 0) * x + (m[4 + row] ?? 0) * y + (m[12 + row] ?? 0));
    const relative = apply(out, 0.01, 0.02);
    const absolute = apply(matrix, 0.26, -0.48);
    relative.forEach((value, row) => {
      expect(value).toBeCloseTo(absolute[row] ?? NaN, 5);
    });
    // Only the last column changes.
    expect(Array.from(out.subarray(0, 12))).toEqual(matrix.slice(0, 12));
  });
});

describe("arrows of the still wind", () => {
  it("are on every grid point when the map is zoomed in", () => {
    const arrows = arrowsInView(field, 1, FRANCE, 8);
    const withWind = field.points.filter((_, index) => field.speed[index]?.[1] != null);
    expect(arrows).toHaveLength(withWind.length);
    const first = arrows[0];
    const index = field.points.findIndex(([lat, lon]) => lat === first?.lat && lon === first.lon);
    expect(first?.speed).toBe(field.speed[index]?.[1]);
    expect(first?.from).toBe(field.direction[index]?.[1]);
  });

  it("are thinned out when the map is zoomed out, so they do not crowd", () => {
    // At zoom 5, 0.5 degree is about 23 pixels: one point in two.
    const arrows = arrowsInView(field, 1, FRANCE, 5);
    for (const arrow of arrows) {
      expect(Math.round((arrow.lat - field.south) / field.step) % 2).toBe(0);
      expect(Math.round((arrow.lon - field.west) / field.step) % 2).toBe(0);
    }
    expect(arrows.length).toBeLessThan(arrowsInView(field, 1, FRANCE, 8).length / 3);
    expect(arrows.length).toBeGreaterThan(0);
  });

  it("are only those of the view", () => {
    const view = { west: 2, south: 46, east: 3, north: 47 };
    const arrows = arrowsInView(field, 1, view, 9);
    expect(arrows.length).toBeGreaterThan(0);
    for (const arrow of arrows) {
      expect(arrow.lon).toBeGreaterThanOrEqual(2);
      expect(arrow.lon).toBeLessThanOrEqual(3);
      expect(arrow.lat).toBeGreaterThanOrEqual(46);
      expect(arrow.lat).toBeLessThanOrEqual(47);
    }
  });
});
