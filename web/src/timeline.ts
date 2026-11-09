// The timeline covers the window of the data (7 days before the last update)
// hour by hour. At a chosen instant the map shows every detection acquired up
// to that instant, coloured by its age at that instant.
//
// When a forecast is shown (the wind of the model), the timeline goes on past
// the last update, hour by hour, until the last hour of the forecast. There is
// no fire data for those hours: the fires stay as they were at the last update.

export const STEP_SECONDS = 3600;

/** Upper bounds of the age classes, in hours. The last one is the window. */
export const AGE_CLASSES_HOURS = [6, 24, 72] as const;

export interface Range {
  /** Seconds since 1970-01-01 UTC. */
  start: number;
  /** The last update. */
  now: number;
  /** The last instant: the last update, or the last hour of the forecast. */
  end: number;
  /** Step of the last update. */
  nowStep: number;
  /** Last step. */
  steps: number;
}

/** First whole hour after the last update: the first step of the forecast. */
function firstForecastHour(now: number): number {
  return (Math.floor(now / STEP_SECONDS) + 1) * STEP_SECONDS;
}

/**
 * The window before the last update, then, when `forecastEnd` is given, the
 * whole hours after the last update up to it.
 */
export function rangeOf(
  generatedAt: Date,
  windowHours: number,
  forecastEnd: number | null = null,
): Range {
  const now = Math.floor(generatedAt.getTime() / 1000);
  const first = firstForecastHour(now);
  const forecastSteps =
    forecastEnd !== null && forecastEnd >= first
      ? Math.floor((forecastEnd - first) / STEP_SECONDS) + 1
      : 0;
  return {
    start: now - windowHours * 3600,
    now,
    end: forecastSteps > 0 ? first + (forecastSteps - 1) * STEP_SECONDS : now,
    nowStep: windowHours,
    steps: windowHours + forecastSteps,
  };
}

export function instantAt(range: Range, step: number): number {
  const bounded = Math.min(Math.max(Math.round(step), 0), range.steps);
  if (bounded < range.nowStep) return range.start + bounded * STEP_SECONDS;
  if (bounded === range.nowStep) return range.now;
  return firstForecastHour(range.now) + (bounded - range.nowStep - 1) * STEP_SECONDS;
}

export function stepOf(range: Range, instant: number): number {
  if (instant <= range.start) return 0;
  if (instant < range.now) return Math.floor((instant - range.start) / STEP_SECONDS);
  const first = firstForecastHour(range.now);
  if (instant < first || range.steps === range.nowStep) return range.nowStep;
  return Math.min(range.steps, range.nowStep + 1 + Math.floor((instant - first) / STEP_SECONDS));
}

/** True for the hours after the last update. */
export function isForecast(range: Range, instant: number): boolean {
  return instant > range.now;
}

/** The instant the fires are shown at: the last update for the forecast hours. */
export function fireInstant(range: Range, instant: number): number {
  return Math.min(instant, range.now);
}

/** Age class of a detection at the given instant, or null if not yet acquired. */
export function ageClass(acquired: number, instant: number): number | null {
  if (acquired > instant) return null;
  const hours = (instant - acquired) / 3600;
  const index = AGE_CLASSES_HOURS.findIndex((limit) => hours < limit);
  return index === -1 ? AGE_CLASSES_HOURS.length : index;
}

// MapLibre expressions kept as plain data so they can be unit tested.
export type Expression = (string | number | Expression)[];

export function visibleFilter(instant: number): Expression {
  return ["<=", ["get", "t"], instant];
}

/** A "step" expression on the age in hours, returning one value per class. */
export function byAge(instant: number, values: readonly (string | number)[]): Expression {
  if (values.length !== AGE_CLASSES_HOURS.length + 1) {
    throw new Error("one value per age class is expected");
  }
  const age: Expression = ["/", ["-", instant, ["get", "t"]], 3600];
  const expression: Expression = ["step", age, values[0] ?? 0];
  AGE_CLASSES_HOURS.forEach((limit, index) => {
    expression.push(limit, values[index + 1] ?? 0);
  });
  return expression;
}
