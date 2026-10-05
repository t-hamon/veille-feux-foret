// The timeline covers the window of the data (7 days before the last update)
// hour by hour. At a chosen instant the map shows every detection acquired up
// to that instant, coloured by its age at that instant.

export const STEP_SECONDS = 3600;

/** Upper bounds of the age classes, in hours. The last one is the window. */
export const AGE_CLASSES_HOURS = [6, 24, 72] as const;

export interface Range {
  /** Seconds since 1970-01-01 UTC. */
  start: number;
  end: number;
  steps: number;
}

export function rangeOf(generatedAt: Date, windowHours: number): Range {
  const end = Math.floor(generatedAt.getTime() / 1000);
  return { start: end - windowHours * 3600, end, steps: windowHours };
}

export function instantAt(range: Range, step: number): number {
  const bounded = Math.min(Math.max(Math.round(step), 0), range.steps);
  return bounded === range.steps ? range.end : range.start + bounded * STEP_SECONDS;
}

export function stepOf(range: Range, instant: number): number {
  if (instant >= range.end) return range.steps;
  if (instant <= range.start) return 0;
  return Math.floor((instant - range.start) / STEP_SECONDS);
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
