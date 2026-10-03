"""Parse NASA FIRMS active fire CSV files.

Field meanings follow the FIRMS attribute documentation: ``acq_date`` and
``acq_time`` are UTC, ``frp`` is the fire radiative power in MW, ``daynight`` is
D or N. VIIRS gives a confidence class (low, nominal, high). MODIS gives a
percentage that FIRMS maps to three classes without publishing the thresholds,
so the percentage is kept as is rather than turned into a guessed class.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from veille_feux.geo import FranceArea, IndustrialSite, industrial_site_at
from veille_feux.sources import Sensor

ConfidenceClass = Literal["low", "nominal", "high"]

_VIIRS_CLASSES: dict[str, ConfidenceClass] = {
    "l": "low",
    "low": "low",
    "n": "nominal",
    "nominal": "nominal",
    "h": "high",
    "high": "high",
}
REQUIRED_COLUMNS = ("latitude", "longitude", "acq_date", "acq_time", "confidence")


class FirmsFormatError(ValueError):
    """The file is not a FIRMS active fire CSV."""


@dataclass(frozen=True)
class Detection:
    lat: float
    lon: float
    acquired: dt.datetime
    source: str
    frp_mw: float | None
    confidence_class: ConfidenceClass | None
    confidence_pct: int | None
    daynight: Literal["D", "N"] | None


@dataclass
class ParseReport:
    rows: int = 0
    kept: int = 0
    skipped: Counter[str] = field(default_factory=Counter)


def _acquired(date: str, time: str) -> dt.datetime:
    hhmm = time.strip().zfill(4)
    if len(hhmm) != 4 or not hhmm.isdigit():
        raise ValueError(f"bad acq_time {time!r}")
    day = dt.date.fromisoformat(date.strip())
    return dt.datetime(day.year, day.month, day.day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=dt.UTC)


def _confidence(raw: str, sensor: Sensor) -> tuple[ConfidenceClass | None, int | None]:
    value = raw.strip().lower()
    if sensor == "viirs":
        if value not in _VIIRS_CLASSES:
            raise ValueError(f"unknown VIIRS confidence {raw!r}")
        return _VIIRS_CLASSES[value], None
    percent = int(value)
    if not 0 <= percent <= 100:
        raise ValueError(f"MODIS confidence out of range: {percent}")
    return None, percent


def _optional_float(raw: str | None) -> float | None:
    if raw is None or not raw.strip():
        return None
    return float(raw)


def parse_csv(text: str, source: str, sensor: Sensor) -> tuple[list[Detection], ParseReport]:
    """Parse one FIRMS CSV. Malformed rows are counted and skipped, never guessed."""
    reader = csv.DictReader(io.StringIO(text))
    missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
    if missing:
        raise FirmsFormatError(f"{source}: missing columns {missing}")
    report = ParseReport()
    detections: list[Detection] = []
    for row in reader:
        report.rows += 1
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("coordinates out of range")
            confidence_class, confidence_pct = _confidence(row["confidence"], sensor)
            daynight = (row.get("daynight") or "").strip().upper()
            detections.append(
                Detection(
                    lat=lat,
                    lon=lon,
                    acquired=_acquired(row["acq_date"], row["acq_time"]),
                    source=source,
                    frp_mw=_optional_float(row.get("frp")),
                    confidence_class=confidence_class,
                    confidence_pct=confidence_pct,
                    daynight="D" if daynight == "D" else "N" if daynight == "N" else None,
                )
            )
        except (ValueError, TypeError, KeyError) as exc:
            report.skipped[type(exc).__name__ + ": " + str(exc).split(":")[0]] += 1
    report.kept = len(detections)
    return detections, report


@dataclass
class SelectionReport:
    inside: int = 0
    outside: int = 0
    industrial: Counter[str] = field(default_factory=Counter)


# Coarse box around metropolitan France and Corsica: points outside it are
# dropped before the more expensive outline test.
_BOX = (41.2, -5.6, 51.3, 9.9)  # south, west, north, east


def select_france(
    detections: Iterable[Detection],
    area: FranceArea,
    sites: Iterable[IndustrialSite],
) -> tuple[list[Detection], SelectionReport]:
    """Keep detections in metropolitan France that are not known industrial sites."""
    site_list = list(sites)
    report = SelectionReport()
    kept: list[Detection] = []
    south, west, north, east = _BOX
    for d in detections:
        if not (south <= d.lat <= north and west <= d.lon <= east) or not area.contains(
            d.lon, d.lat
        ):
            report.outside += 1
            continue
        site = industrial_site_at(d.lat, d.lon, site_list)
        if site is not None:
            report.industrial[site.name] += 1
            continue
        report.inside += 1
        kept.append(d)
    return kept, report
