// Display of dates and numbers in French, in the time zone of metropolitan
// France, whatever the time zone of the device.

import type { Confidence, Satellite } from "./data";

const TIME_ZONE = "Europe/Paris";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE_TIME_YEAR = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const DAY = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const NUMBER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const COORD = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

export function dateTime(date: Date): string {
  return DATE_TIME.format(date);
}

export function dateTimeLong(date: Date): string {
  return DATE_TIME_YEAR.format(date);
}

/** A calendar day given as YYYY-MM-DD. */
export function day(isoDay: string): string {
  return DAY.format(new Date(`${isoDay}T00:00:00Z`));
}

export function number(value: number): string {
  return NUMBER.format(value);
}

export function decimal(value: number): string {
  return DECIMAL.format(value);
}

export function hectares(value: number): string {
  return `${NUMBER.format(value)} ha`;
}

export function coordinates(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "O";
  return `${COORD.format(Math.abs(lat))}° ${ns}, ${COORD.format(Math.abs(lon))}° ${ew}`;
}

/** "il y a 2 h 05" style duration, from whole minutes. */
export function elapsed(minutes: number): string {
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0
      ? `il y a ${String(hours)} h`
      : `il y a ${String(hours)} h ${String(rest).padStart(2, "0")}`;
  }
  return `il y a ${String(Math.floor(hours / 24))} jours`;
}

export const SATELLITE_LABELS: Record<Satellite, string> = {
  viirs_snpp: "VIIRS, satellite Suomi NPP",
  viirs_noaa20: "VIIRS, satellite NOAA-20",
  viirs_noaa21: "VIIRS, satellite NOAA-21",
  modis: "MODIS, satellites Aqua et Terra",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  low: "faible",
  nominal: "normale",
  high: "élevée",
};
