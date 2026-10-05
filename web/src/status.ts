// Freshness of the data, decided from etat.json. The pipeline runs every
// 30 minutes; GitHub can delay scheduled runs, so a margin is allowed before the
// page says the data is late.

import type { SourceStatus, Status } from "./data";

export const LATE_AFTER_MINUTES = 90;
export const OLD_AFTER_HOURS = 24;

export type Freshness = "fresh" | "late" | "old";

export function ageMinutes(generatedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - generatedAt.getTime()) / 60_000));
}

export function freshness(status: Status, now: Date): Freshness {
  const minutes = ageMinutes(status.generatedAt, now);
  if (minutes > OLD_AFTER_HOURS * 60) return "old";
  if (minutes > LATE_AFTER_MINUTES) return "late";
  return "fresh";
}

export type SourceGroup = "firms" | "effis";

export function groupOf(source: SourceStatus): SourceGroup | null {
  if (source.id.startsWith("firms_")) return "firms";
  if (source.id.startsWith("effis_")) return "effis";
  return null;
}

export interface Health {
  failed: SourceStatus[];
  /** True when no FIRMS feed answered on the last run. */
  firmsDown: boolean;
}

export function health(status: Status): Health {
  const failed = status.sources.filter((s) => !s.ok);
  const firms = status.sources.filter((s) => groupOf(s) === "firms");
  return {
    failed,
    firmsDown: firms.length > 0 && firms.every((s) => !s.ok),
  };
}
