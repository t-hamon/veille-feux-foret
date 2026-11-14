// Estimated spread of an active fire cluster over the hours after the last
// update, from the wind forecast at the cluster (meteo-foyers.json). An order
// of magnitude, never a simulation:
//
// - forward spread: 3 % to 8 % of the mean wind at 10 m, in the same units.
//   8 % is the slope fitted on 118 wildfires in conifer forests, dry eucalypt
//   forests and temperate shrublands (Cruz and Alexander 2019, Annals of
//   Forest Science 76:44, page 3); 3 % is the "Valabre model" taught to French
//   fire officers (Sauvagnargues-Lesage et al. 2001, International Journal of
//   Wildland Fire 10:15-22);
// - the head of the fire follows the wind hour by hour; the shape is the
//   ellipse of the Canadian Fire Behavior Prediction System, whose length to
//   breadth ratio grows with the wind (Forestry Canada Fire Danger Group 1992,
//   Information Report ST-X-3, equation 79, forest stands), taken here at the
//   mean wind of the hours elapsed, with no spread backwards.

import type { FireWeather } from "./fireweather";

const HOUR = 3600;
/** Hours after the last update covered by the estimate. */
export const SPREAD_HOURS = 6;
/** Forward spread as a fraction of the mean wind at 10 m: low, then high. */
export const SPREAD_FRACTIONS = [0.03, 0.08] as const;

/**
 * Length to breadth ratio of a wind-driven fire in forest stands, for a wind
 * of `speed` km/h (FBP System, equation 79); it levels off at 9.7.
 */
export function lengthToBreadth(speed: number): number {
  return 1 + 8.729 * (1 - Math.exp(-0.03 * Math.max(speed, 0))) ** 2.155;
}

/** A point [lat, lon] moved by `km` towards `bearing` degrees (north 0, east 90). */
export function moved(point: [number, number], km: number, bearing: number): [number, number] {
  const rad = Math.PI / 180;
  const [lat, lon] = point;
  const dLat = (km * Math.cos(bearing * rad)) / 111.195;
  const dLon = (km * Math.sin(bearing * rad)) / (111.195 * Math.cos(lat * rad));
  return [lat + dLat, lon + dLon];
}

export interface SpreadSegment {
  /** Seconds since 1970-01-01 UTC at the end of the segment. */
  until: number;
  /** Mean wind at 10 m used for the segment, km/h. */
  speed: number;
  /** Direction the wind comes from, degrees. */
  from: number;
}

/** Wind at an instant, read linearly between the hourly values of the file. */
function windAt(
  weather: FireWeather,
  instant: number,
): { speed: number; east: number; north: number } | null {
  const position = (instant - weather.start) / HOUR;
  const before = Math.floor(position);
  const after = Math.ceil(position);
  if (before < 0 || after >= weather.hours) return null;
  const weight = position - before;
  let speed = 0;
  let east = 0;
  let north = 0;
  for (const [hour, share] of [
    [before, 1 - weight],
    [after, weight],
  ] as const) {
    if (share === 0) continue;
    const value = weather.speed[hour] ?? null;
    const from = weather.direction[hour] ?? null;
    if (value === null || from === null) return null;
    // Vector of the direction the wind goes to.
    const towards = ((from + 180) * Math.PI) / 180;
    speed += share * value;
    east += share * value * Math.sin(towards);
    north += share * value * Math.cos(towards);
  }
  return { speed, east, north };
}

/**
 * The wind of each piece of time between `from` and `to`, cut at the whole
 * hours: the hourly values of the model are read linearly in between, and each
 * piece takes the mean of its two ends, speed and direction. Null when an hour
 * needed has no value.
 */
export function windSegments(
  weather: FireWeather,
  from: number,
  to: number,
): SpreadSegment[] | null {
  const out: SpreadSegment[] = [];
  let t = from;
  let start = windAt(weather, t);
  while (t < to) {
    const next = Math.min(to, (Math.floor(t / HOUR) + 1) * HOUR);
    const end = windAt(weather, next);
    if (!start || !end) return null;
    const east = (start.east + end.east) / 2;
    const north = (start.north + end.north) / 2;
    const towards = (Math.atan2(east, north) * 180) / Math.PI;
    out.push({
      until: next,
      speed: (start.speed + end.speed) / 2,
      from: (((towards + 180) % 360) + 360) % 360,
    });
    t = next;
    start = end;
  }
  return out;
}

export interface SpreadPath {
  fraction: number;
  /** Positions of the head of the fire [lat, lon], from the cluster, at each segment end. */
  points: [number, number][];
  /** Distance along the path, km. */
  km: number;
}

/** Path of the head of the fire for one fraction of the wind speed. */
export function headPath(
  origin: [number, number],
  segments: SpreadSegment[],
  start: number,
  fraction: number,
): SpreadPath {
  const points: [number, number][] = [origin];
  let km = 0;
  let t = start;
  for (const segment of segments) {
    const hours = (segment.until - t) / HOUR;
    const step = fraction * segment.speed * hours;
    km += step;
    const last = points[points.length - 1] ?? origin;
    points.push(step > 0 ? moved(last, step, (segment.from + 180) % 360) : last);
    t = segment.until;
  }
  return { fraction, points, km };
}

/** Mean wind over the segments, weighted by their duration, km/h. */
export function meanSpeed(segments: SpreadSegment[], start: number): number {
  let total = 0;
  let seconds = 0;
  let t = start;
  for (const segment of segments) {
    total += segment.speed * (segment.until - t);
    seconds += segment.until - t;
    t = segment.until;
  }
  return seconds > 0 ? total / seconds : 0;
}

/**
 * Ellipse from the cluster to the head of the fire, as a closed ring of
 * [lon, lat] points: major axis along that line, breadth the distance along
 * the path divided by the length to breadth ratio. Null for a fire that has
 * not moved.
 */
export function ellipseRing(
  origin: [number, number],
  head: [number, number],
  pathKm: number,
  ratio: number,
  points = 48,
): [number, number][] | null {
  const rad = Math.PI / 180;
  const kmLat = 111.195;
  const kmLon = 111.195 * Math.cos(origin[0] * rad);
  const dx = (head[1] - origin[1]) * kmLon;
  const dy = (head[0] - origin[0]) * kmLat;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-6 || pathKm <= 0) return null;
  const a = chord / 2;
  const b = pathKm / ratio / 2;
  const ux = dx / chord;
  const uy = dy / chord;
  const cx = dx / 2;
  const cy = dy / 2;
  const ring: [number, number][] = [];
  for (let k = 0; k < points; k += 1) {
    const angle = (2 * Math.PI * k) / points;
    const along = a * Math.cos(angle);
    const across = b * Math.sin(angle);
    const x = cx + along * ux - across * uy;
    const y = cy + along * uy + across * ux;
    ring.push([origin[1] + x / kmLon, origin[0] + y / kmLat]);
  }
  const first = ring[0];
  if (first) ring.push([first[0], first[1]]);
  return ring;
}

export interface SpreadEstimate {
  /** Instant of the estimate, seconds since 1970-01-01 UTC. */
  at: number;
  /** Hours elapsed since the last update. */
  hours: number;
  /** Mean wind at 10 m over those hours, km/h. */
  speed: number;
  /** Length to breadth ratio at that wind. */
  ratio: number;
  /** Direction the head of the fire moves to, from the cluster, degrees. */
  towards: number;
  /** Low then high estimate. */
  paths: [SpreadPath, SpreadPath];
  /** Ellipses of the low then high estimate; null for a fire that does not move. */
  rings: [[number, number][] | null, [number, number][] | null];
}

function bearing(from: [number, number], to: [number, number]): number {
  const rad = Math.PI / 180;
  const dx = (to[1] - from[1]) * Math.cos(from[0] * rad);
  const dy = to[0] - from[0];
  return (((Math.atan2(dx, dy) / rad) % 360) + 360) % 360;
}

/**
 * Spread estimated at `instant`, from the last update `now`, at most
 * SPREAD_HOURS later. Null outside that window or when the wind is missing.
 */
export function spreadAt(
  weather: FireWeather,
  origin: [number, number],
  now: number,
  instant: number,
): SpreadEstimate | null {
  if (instant <= now || instant > now + SPREAD_HOURS * HOUR) return null;
  const segments = windSegments(weather, now, instant);
  if (!segments || segments.length === 0) return null;
  const speed = meanSpeed(segments, now);
  const ratio = lengthToBreadth(speed);
  const low = headPath(origin, segments, now, SPREAD_FRACTIONS[0]);
  const high = headPath(origin, segments, now, SPREAD_FRACTIONS[1]);
  const headLow = low.points[low.points.length - 1] ?? origin;
  const headHigh = high.points[high.points.length - 1] ?? origin;
  return {
    at: instant,
    hours: (instant - now) / HOUR,
    speed,
    ratio,
    towards: bearing(origin, headHigh),
    paths: [low, high],
    rings: [
      ellipseRing(origin, headLow, low.km, ratio),
      ellipseRing(origin, headHigh, high.km, ratio),
    ],
  };
}

/** Width of the ellipse at its widest, km. */
export function breadthKm(path: SpreadPath, ratio: number): number {
  return path.km / ratio;
}
