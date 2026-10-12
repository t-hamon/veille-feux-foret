// Animated wind: particles carried by the wind, and the geometry drawn for
// them. Everything here is plain computation, without WebGL, so that it can be
// tested; windlayer.ts only uploads the vertices and draws them.
//
// Particles live in geographic coordinates: they stay in place when the map
// moves. Each one keeps its last positions, drawn as a trail that fades out.
// Their speed on screen grows with the wind speed and does not depend on the
// zoom, as on most wind maps: the animation shows where the wind blows and how
// strong it is, not the true distance covered. The growth is a little slower
// than proportional, so that light winds still move visibly and strong winds
// do not race across the map; the colour gives the speed class.

import type { VectorSampler } from "./wind";
import { speedClass } from "./wind";

/** Screen pixels covered in one frame of 1/60 s by a wind of `speed` km/h. */
export function pixelsPerFrame(speed: number): number {
  return 0.12 * Math.max(0, speed) ** 0.8;
}
/** Frames a particle lives, at most and at least. */
const LIFE = [70, 160] as const;
/** World size in pixels at zoom 0 (512 px tiles, as MapLibre). */
const WORLD = 512;

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type Random = () => number;

/** Small deterministic generator (mulberry32), so that tests repeat. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number of particles for a map of this size, in CSS pixels. */
export function particleCount(width: number, height: number): number {
  return Math.round(Math.min(2500, Math.max(300, (width * height) / 650)));
}

export class Particles {
  readonly count: number;
  readonly trail: number;
  /** Positions, trail after trail, newest last: lon then lat. */
  readonly lon: Float64Array;
  readonly lat: Float64Array;
  /** Number of valid positions in each trail (0: particle waiting for wind). */
  readonly filled: Uint8Array;
  readonly age: Uint16Array;
  readonly life: Uint16Array;
  /** Speed class of each particle, for its colour. */
  readonly speedClass: Uint8Array;
  private readonly random: Random;

  constructor(count: number, trail: number, random: Random) {
    this.count = count;
    this.trail = trail;
    this.lon = new Float64Array(count * trail);
    this.lat = new Float64Array(count * trail);
    this.filled = new Uint8Array(count);
    this.age = new Uint16Array(count);
    this.life = new Uint16Array(count);
    this.speedClass = new Uint8Array(count);
    this.random = random;
  }

  /** Starts every particle again, spread over its life so they do not all expire together. */
  reset(bounds: Bounds, sampler: VectorSampler): void {
    for (let i = 0; i < this.count; i += 1) {
      this.spawn(i, bounds, sampler);
      this.age[i] = Math.floor(this.random() * (this.life[i] ?? 1));
    }
  }

  private spawn(i: number, bounds: Bounds, sampler: VectorSampler): void {
    this.filled[i] = 0;
    this.age[i] = 0;
    this.life[i] = LIFE[0] + Math.floor(this.random() * (LIFE[1] - LIFE[0]));
    // A few tries to land where there is wind; otherwise wait for the next frame.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const lon = bounds.west + this.random() * (bounds.east - bounds.west);
      const lat = bounds.south + this.random() * (bounds.north - bounds.south);
      const wind = sampler(lat, lon);
      if (!wind) continue;
      const base = i * this.trail;
      for (let k = 0; k < this.trail; k += 1) {
        this.lon[base + k] = lon;
        this.lat[base + k] = lat;
      }
      this.filled[i] = 1;
      this.speedClass[i] = speedClass(wind[2]);
      return;
    }
  }

  /**
   * Moves every particle for `frames` frames of 1/60 s at this zoom. A
   * particle that leaves the view, reaches a place without wind or the end of
   * its life starts again elsewhere in the view.
   */
  step(bounds: Bounds, sampler: VectorSampler, zoom: number, frames: number): void {
    const degreesPerPixel = 360 / (WORLD * 2 ** zoom);
    for (let i = 0; i < this.count; i += 1) {
      const age = (this.age[i] ?? 0) + 1;
      this.age[i] = age;
      if (this.filled[i] === 0 || age > (this.life[i] ?? 0)) {
        this.spawn(i, bounds, sampler);
        continue;
      }
      const base = i * this.trail;
      const head = base + this.trail - 1;
      const lon = this.lon[head] ?? 0;
      const lat = this.lat[head] ?? 0;
      const wind = sampler(lat, lon);
      if (!wind) {
        this.spawn(i, bounds, sampler);
        continue;
      }
      // Pixels this frame, along the wind; one pixel covers fewer degrees of
      // latitude than of longitude, by cos(lat).
      const norm = Math.hypot(wind[0], wind[1]);
      const scale = norm > 0 ? (pixelsPerFrame(wind[2]) * degreesPerPixel * frames) / norm : 0;
      const nextLon = lon + wind[0] * scale;
      const nextLat = lat + wind[1] * scale * Math.cos((lat * Math.PI) / 180);
      if (
        nextLon < bounds.west ||
        nextLon > bounds.east ||
        nextLat < bounds.south ||
        nextLat > bounds.north
      ) {
        this.spawn(i, bounds, sampler);
        continue;
      }
      this.lon.copyWithin(base, base + 1, base + this.trail);
      this.lat.copyWithin(base, base + 1, base + this.trail);
      this.lon[head] = nextLon;
      this.lat[head] = nextLat;
      this.filled[i] = Math.min(this.trail, (this.filled[i] ?? 0) + 1);
      this.speedClass[i] = speedClass(wind[2]);
    }
  }
}

// ------------------------------------------------------------------ geometry

/** Web Mercator coordinates of MapLibre: 0 to 1 across the world. */
export function mercatorX(lon: number): number {
  return (lon + 180) / 360;
}

export function mercatorY(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

/** Floats per vertex: x, y, then red, green, blue, alpha (premultiplied). */
export const VERTEX_FLOATS = 6;

export type Rgb = readonly [number, number, number];

export function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function vertex(
  out: Float32Array,
  at: number,
  x: number,
  y: number,
  colour: Rgb,
  alpha: number,
): void {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = colour[0] * alpha;
  out[at + 3] = colour[1] * alpha;
  out[at + 4] = colour[2] * alpha;
  out[at + 5] = alpha;
}

/**
 * Appends a segment, as two triangles of the given width in pixels, to the
 * vertex buffer. Positions are relative to `origin` (Mercator), which keeps
 * them small enough for 32-bit floats at any zoom.
 */
export function pushSegment(
  out: Float32Array,
  at: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  halfWidth: number,
  colour: Rgb,
  alpha1: number,
  alpha2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Math.sqrt rather than Math.hypot: this runs for every segment of every frame.
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return at;
  const nx = (-dy / length) * halfWidth;
  const ny = (dx / length) * halfWidth;
  vertex(out, at, x1 + nx, y1 + ny, colour, alpha1);
  vertex(out, at + VERTEX_FLOATS, x1 - nx, y1 - ny, colour, alpha1);
  vertex(out, at + 2 * VERTEX_FLOATS, x2 + nx, y2 + ny, colour, alpha2);
  vertex(out, at + 3 * VERTEX_FLOATS, x2 + nx, y2 + ny, colour, alpha2);
  vertex(out, at + 4 * VERTEX_FLOATS, x1 - nx, y1 - ny, colour, alpha1);
  vertex(out, at + 5 * VERTEX_FLOATS, x2 - nx, y2 - ny, colour, alpha2);
  return at + 6 * VERTEX_FLOATS;
}

/** Floats needed for the trails of these particles. */
export function trailFloats(particles: Particles): number {
  return particles.count * (particles.trail - 1) * 6 * VERTEX_FLOATS;
}

/**
 * Vertices of the trails: each trail fades from the particle (opaque) to its
 * oldest position (transparent). Returns the number of floats written.
 * Each position is projected once; this runs at every frame.
 */
export function trailVertices(
  particles: Particles,
  out: Float32Array,
  origin: [number, number],
  pixel: number,
  colours: readonly Rgb[],
): number {
  let at = 0;
  const halfWidth = 0.75 * pixel;
  const last = particles.trail - 1;
  const xs = new Float64Array(particles.trail);
  const ys = new Float64Array(particles.trail);
  for (let i = 0; i < particles.count; i += 1) {
    const filled = particles.filled[i] ?? 0;
    if (filled < 2) continue;
    const colour = colours[particles.speedClass[i] ?? 0] ?? colours[0] ?? [0, 0, 0];
    const base = i * particles.trail;
    const first = particles.trail - filled;
    for (let k = first; k <= last; k += 1) {
      xs[k] = mercatorX(particles.lon[base + k] ?? 0) - origin[0];
      ys[k] = mercatorY(particles.lat[base + k] ?? 0) - origin[1];
    }
    // Opaque at the particle, transparent at its oldest position.
    const fade = 0.9 / (last - first);
    for (let k = first; k < last; k += 1) {
      at = pushSegment(
        out,
        at,
        xs[k] ?? 0,
        ys[k] ?? 0,
        xs[k + 1] ?? 0,
        ys[k + 1] ?? 0,
        halfWidth,
        colour,
        fade * (k - first),
        fade * (k + 1 - first),
      );
    }
  }
  return at;
}

export interface Arrow {
  lat: number;
  lon: number;
  /** Direction the wind comes from, degrees. */
  from: number;
  speed: number;
}

/** Floats needed for these arrows: a shaft and two strokes of head each. */
export function arrowFloats(count: number): number {
  return count * 3 * 6 * VERTEX_FLOATS;
}

/**
 * Vertices of static arrows pointing where the wind blows, `length` pixels
 * long, centred on their point. Returns the number of floats written.
 */
export function arrowVertices(
  arrows: readonly Arrow[],
  out: Float32Array,
  origin: [number, number],
  pixel: number,
  length: number,
  colours: readonly Rgb[],
): number {
  let at = 0;
  const halfWidth = 0.9 * pixel;
  for (const arrow of arrows) {
    const colour = colours[speedClass(arrow.speed)] ?? colours[0] ?? [0, 0, 0];
    // Towards where the wind blows, in Mercator (y grows southward).
    const angle = ((arrow.from + 180) * Math.PI) / 180;
    const dx = Math.sin(angle) * length * pixel;
    const dy = -Math.cos(angle) * length * pixel;
    const cx = mercatorX(arrow.lon) - origin[0];
    const cy = mercatorY(arrow.lat) - origin[1];
    const tipX = cx + dx / 2;
    const tipY = cy + dy / 2;
    at = pushSegment(out, at, cx - dx / 2, cy - dy / 2, tipX, tipY, halfWidth, colour, 0.95, 0.95);
    for (const side of [-1, 1]) {
      const back = angle + Math.PI + (side * Math.PI) / 6;
      const hx = tipX + Math.sin(back) * length * 0.35 * pixel;
      const hy = tipY - Math.cos(back) * length * 0.35 * pixel;
      at = pushSegment(out, at, tipX, tipY, hx, hy, halfWidth, colour, 0.95, 0.95);
    }
  }
  return at;
}
