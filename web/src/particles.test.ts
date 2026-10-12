import { describe, expect, it } from "vitest";
import ventFile from "../e2e/fixtures/vent/vent.json?raw";
import {
  type Arrow,
  type Bounds,
  type Rgb,
  Particles,
  VERTEX_FLOATS,
  arrowFloats,
  arrowVertices,
  mercatorX,
  mercatorY,
  particleCount,
  pixelsPerFrame,
  pushSegment,
  rgb,
  seeded,
  trailFloats,
  trailVertices,
} from "./particles";
import { type VectorSampler, parseWind, vectorsAt } from "./wind";

const BOUNDS: Bounds = { west: 0, south: 44, east: 4, north: 48 };
const COLOURS: Rgb[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [0, 1, 1],
];

/** The same wind everywhere: east and north components in km/h. */
function uniform(east: number, north: number): VectorSampler {
  return () => [east, north, Math.hypot(east, north)];
}

function head(particles: Particles, i: number): [number, number] {
  const at = i * particles.trail + particles.trail - 1;
  return [particles.lon[at] ?? NaN, particles.lat[at] ?? NaN];
}

describe("random numbers", () => {
  it("repeat for the same seed and stay between 0 and 1", () => {
    const a = seeded(7);
    const b = seeded(7);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(seeded(8)()).not.toBe(seeded(7)());
  });
});

describe("number of particles", () => {
  it("follows the size of the map, within limits", () => {
    expect(particleCount(100, 100)).toBe(300);
    expect(particleCount(1300, 500)).toBe(1000);
    expect(particleCount(4000, 3000)).toBe(2500);
  });
});

describe("speed on screen", () => {
  it("grows with the wind, a little slower than proportionally", () => {
    expect(pixelsPerFrame(0)).toBe(0);
    expect(pixelsPerFrame(-3)).toBe(0);
    const speeds = [1, 5, 10, 20, 50, 100];
    const pixels = speeds.map(pixelsPerFrame);
    for (let k = 1; k < pixels.length; k += 1) {
      expect(pixels[k]).toBeGreaterThan(pixels[k - 1] ?? Infinity);
    }
    expect(pixelsPerFrame(20) / pixelsPerFrame(10)).toBeLessThan(2);
    expect(pixelsPerFrame(20) / pixelsPerFrame(10)).toBeGreaterThan(1.5);
  });
});

describe("particles", () => {
  it("start where there is wind, inside the view", () => {
    const particles = new Particles(200, 5, seeded(1));
    particles.reset(BOUNDS, uniform(10, 0));
    for (let i = 0; i < particles.count; i += 1) {
      const [lon, lat] = head(particles, i);
      expect(particles.filled[i]).toBe(1);
      expect(lon).toBeGreaterThanOrEqual(BOUNDS.west);
      expect(lon).toBeLessThanOrEqual(BOUNDS.east);
      expect(lat).toBeGreaterThanOrEqual(BOUNDS.south);
      expect(lat).toBeLessThanOrEqual(BOUNDS.north);
      expect(particles.age[i]).toBeLessThan(particles.life[i] ?? 0);
      expect(particles.speedClass[i]).toBe(1);
    }
  });

  it("wait where there is no wind", () => {
    const particles = new Particles(20, 5, seeded(1));
    particles.reset(BOUNDS, () => null);
    expect(Array.from(particles.filled)).toEqual(new Array<number>(20).fill(0));
    particles.step(BOUNDS, () => null, 6, 1);
    expect(Array.from(particles.filled)).toEqual(new Array<number>(20).fill(0));
  });

  it("move with the wind: a west wind carries them east", () => {
    const particles = new Particles(1, 4, seeded(3));
    const wind = uniform(20, 0);
    particles.reset({ west: 1.9, south: 45.9, east: 2.1, north: 46.1 }, wind);
    particles.age[0] = 0;
    const [lon, lat] = head(particles, 0);
    particles.step(BOUNDS, wind, 6, 1);
    const [nextLon, nextLat] = head(particles, 0);
    // One frame at zoom 6: pixelsPerFrame(20) pixels of 360 / (512 * 64) degrees.
    expect(nextLon - lon).toBeCloseTo((pixelsPerFrame(20) * 360) / (512 * 64), 10);
    expect(nextLat).toBe(lat);
    expect(particles.filled[0]).toBe(2);
  });

  it("move north under a south wind, at the same speed on screen", () => {
    const particles = new Particles(1, 4, seeded(3));
    const wind = uniform(0, 20);
    particles.reset({ west: 1.9, south: 45.9, east: 2.1, north: 46.1 }, wind);
    particles.age[0] = 0;
    const [lon, lat] = head(particles, 0);
    particles.step(BOUNDS, wind, 6, 2);
    const [nextLon, nextLat] = head(particles, 0);
    expect(nextLon).toBe(lon);
    const degrees = (2 * pixelsPerFrame(20) * 360) / (512 * 64);
    expect(nextLat - lat).toBeCloseTo(degrees * Math.cos((lat * Math.PI) / 180), 10);
  });

  it("keep their last positions, newest last", () => {
    const particles = new Particles(1, 3, seeded(5));
    const wind = uniform(10, 10);
    particles.reset({ west: 1.9, south: 45.9, east: 2.1, north: 46.1 }, wind);
    particles.age[0] = 0;
    const start = head(particles, 0);
    particles.step(BOUNDS, wind, 6, 1);
    const second = head(particles, 0);
    particles.step(BOUNDS, wind, 6, 1);
    expect(particles.filled[0]).toBe(3);
    expect([particles.lon[0], particles.lat[0]]).toEqual(start);
    expect([particles.lon[1], particles.lat[1]]).toEqual(second);
    particles.step(BOUNDS, wind, 6, 1);
    expect(particles.filled[0]).toBe(3);
    expect([particles.lon[0], particles.lat[0]]).toEqual(second);
  });

  it("start again when they leave the view or reach the end of their life", () => {
    const particles = new Particles(1, 3, seeded(9));
    const tight = { west: 2, south: 46, east: 2.0001, north: 46.0001 };
    particles.reset(tight, uniform(50, 0));
    particles.age[0] = 0;
    particles.step(tight, uniform(50, 0), 6, 1);
    // Out of the view in one frame: started again, with a trail of one position.
    expect(particles.filled[0]).toBe(1);
    expect(particles.age[0]).toBe(0);

    particles.age[0] = particles.life[0] ?? 0;
    particles.step(BOUNDS, uniform(1, 0), 6, 1);
    expect(particles.age[0]).toBe(0);
    expect(particles.filled[0]).toBe(1);
  });

  it("start again where the wind stops", () => {
    const particles = new Particles(1, 3, seeded(2));
    let calls = 0;
    const patchy: VectorSampler = () => (calls++ === 0 ? [10, 0, 10] : null);
    particles.reset(BOUNDS, patchy);
    particles.age[0] = 0;
    particles.step(BOUNDS, patchy, 6, 1);
    expect(particles.filled[0]).toBe(0);
  });

  it("stay in the view on the wind of the 12 October file", () => {
    const { field } = parseWind(JSON.parse(ventFile) as unknown);
    const sampler = vectorsAt(field, 1);
    const particles = new Particles(500, 6, seeded(11));
    particles.reset(BOUNDS, sampler);
    for (let frame = 0; frame < 300; frame += 1) particles.step(BOUNDS, sampler, 6, 1);
    let moving = 0;
    for (let i = 0; i < particles.count; i += 1) {
      const [lon, lat] = head(particles, i);
      if ((particles.filled[i] ?? 0) === 0) continue;
      moving += 1;
      expect(lon).toBeGreaterThanOrEqual(BOUNDS.west);
      expect(lon).toBeLessThanOrEqual(BOUNDS.east);
      expect(lat).toBeGreaterThanOrEqual(BOUNDS.south);
      expect(lat).toBeLessThanOrEqual(BOUNDS.north);
    }
    expect(moving).toBe(500);
  });
});

describe("geometry", () => {
  it("projects on Web Mercator from 0 to 1", () => {
    expect(mercatorX(-180)).toBe(0);
    expect(mercatorX(0)).toBe(0.5);
    expect(mercatorX(180)).toBe(1);
    expect(mercatorY(0)).toBeCloseTo(0.5, 12);
    expect(mercatorY(85.0511287798)).toBeCloseTo(0, 6);
    expect(mercatorY(46)).toBeLessThan(0.5);
  });

  it("reads colours", () => {
    expect(rgb("#ff8000")).toEqual([1, 128 / 255, 0]);
  });

  it("draws a segment as two triangles of the given width", () => {
    const out = new Float32Array(6 * VERTEX_FLOATS);
    const end = pushSegment(out, 0, 0, 0, 10, 0, 1, [1, 0.5, 0], 0, 1);
    expect(end).toBe(6 * VERTEX_FLOATS);
    const vertex = (n: number) => Array.from(out.subarray(n * 6, n * 6 + 6));
    expect(vertex(0)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(vertex(1)).toEqual([0, -1, 0, 0, 0, 0]);
    // Premultiplied colour at the opaque end.
    expect(vertex(2)).toEqual([10, 1, 1, 0.5, 0, 1]);
    expect(vertex(5)).toEqual([10, -1, 1, 0.5, 0, 1]);
    // A segment of no length draws nothing.
    expect(pushSegment(out, 0, 3, 3, 3, 3, 1, [1, 1, 1], 1, 1)).toBe(0);
  });

  it("draws trails that fade towards their oldest position", () => {
    const particles = new Particles(2, 4, seeded(1));
    particles.reset(BOUNDS, uniform(30, 0));
    particles.age.fill(0);
    particles.life.fill(1000);
    for (let frame = 0; frame < 3; frame += 1) particles.step(BOUNDS, uniform(30, 0), 6, 1);
    expect(Array.from(particles.filled)).toEqual([4, 4]);
    const out = new Float32Array(trailFloats(particles));
    const written = trailVertices(particles, out, [0.5, 0.3], 1e-6, COLOURS);
    expect(written).toBe(trailFloats(particles));
    const alphas = [];
    for (let k = 5; k < 3 * 6 * VERTEX_FLOATS; k += VERTEX_FLOATS) alphas.push(out[k]);
    expect(alphas[0]).toBe(0);
    expect(alphas.at(-1)).toBeCloseTo(0.9, 6);
    // 30 km/h is the fourth class, drawn with the fourth colour, premultiplied.
    const last = 17 * VERTEX_FLOATS;
    expect(out[last + 2]).toBeCloseTo(out[last + 5] ?? NaN, 6);
    expect(out[last + 3]).toBeCloseTo(out[last + 5] ?? NaN, 6);
    expect(out[last + 4]).toBe(0);
  });

  it("draws no trail for particles that have not moved yet", () => {
    const particles = new Particles(3, 4, seeded(1));
    particles.reset(BOUNDS, uniform(30, 0));
    const out = new Float32Array(trailFloats(particles));
    expect(trailVertices(particles, out, [0.5, 0.3], 1e-6, COLOURS)).toBe(0);
  });

  it("draws arrows towards where the wind blows", () => {
    const arrows: Arrow[] = [{ lat: 0, lon: 0, from: 270, speed: 25 }];
    const out = new Float32Array(arrowFloats(arrows.length));
    const written = arrowVertices(arrows, out, [0.5, 0.5], 0.01, 20, COLOURS);
    expect(written).toBe(arrowFloats(1));
    // Shaft from x = -0.1 to x = 0.1: a west wind points east.
    const xs = [0, 1, 2, 3, 4, 5].map((n) => out[n * VERTEX_FLOATS] ?? NaN);
    expect(Math.min(...xs)).toBeCloseTo(-0.1, 6);
    expect(Math.max(...xs)).toBeCloseTo(0.1, 6);
    // Head strokes go back from the tip, towards the west (within the
    // half width of a stroke, 0.9 pixel).
    for (let n = 6; n < 18; n += 1) {
      expect(out[n * VERTEX_FLOATS] ?? NaN).toBeLessThanOrEqual(0.1 + 0.009 + 1e-6);
    }
    expect(out[8 * VERTEX_FLOATS]).toBeLessThan(0.1 - 0.05);
    // 25 km/h is the third class, drawn with the third colour.
    expect([out[2], out[3], out[4]]).toEqual([0, 0, Math.fround(0.95)]);

    const north: Arrow[] = [{ lat: 0, lon: 0, from: 180, speed: 5 }];
    arrowVertices(north, out, [0.5, 0.5], 0.01, 20, COLOURS);
    const ys = [0, 1, 2, 3, 4, 5].map((n) => out[n * VERTEX_FLOATS + 1] ?? NaN);
    // A south wind points north, where Mercator y is smaller.
    expect(ys[2]).toBeLessThan(ys[0] ?? NaN);
  });
});
