"""Wind measured at the Météo-France stations, hour by hour: stations-vent.json.

The Package Observations API keeps few hours: 24 by its documentation, 120 in
the 24-hour package of a department captured on 11 November 2026. The file is
therefore built up from run to run: each build keeps the hours of the previous
file and adds those it fetches, over the last 7 days.

- At each run, the hours of the last 24 that the file lacks are asked for with
  the hourly package of all the stations, and the 3 latest hours again, since
  some stations send their measurements late.
- When the file lacks hours older than that (first run, outage longer than a
  day), the packages of the 95 metropolitan departments are asked for instead,
  at most once a day: they go back as far as the API keeps them.

Values are those of the API, in its units (m/s, degrees); a value outside its
physical bounds is left empty, never corrected.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field
from typing import Any

from veille_feux.meteofrance import (
    BOUNDS,
    WIND_PARAMETERS,
    Observation,
    StationInfo,
)

HOUR = 3600
WINDOW_HOURS = 168
RECENT_HOURS = 24
REFRESH_HOURS = 3
BACKFILL_HOURS = 120
BACKFILL_INTERVAL = dt.timedelta(hours=24)
# Metropolitan departments as numbered by the API: Corsica is 20.
DEPARTMENTS = tuple(range(1, 96))
MAX_STATIONS = 5000
SOURCE = "Météo-France, API Package Observations, mesures horaires des stations au sol"

_STATION_ID = re.compile(r"\d{8}")
_NAME = re.compile(r"[\w' ./()-]{1,60}")

Values = tuple[float | None, int | None, float | None]


@dataclass
class Stored:
    """Wind of each station by hour, with the position and name of the stations."""

    series: dict[str, dict[int, Values]] = field(default_factory=dict)
    positions: dict[str, tuple[float, float]] = field(default_factory=dict)
    infos: dict[str, StationInfo] = field(default_factory=dict)
    fetched_at: dt.datetime | None = None
    backfilled_at: dt.datetime | None = None

    def hours(self) -> set[int]:
        return {hour for by_hour in self.series.values() for hour in by_hour}


@dataclass(frozen=True)
class Plan:
    """What a run asks for: the hourly packages of ``hours``, or the packages of
    every department when ``backfill`` is set."""

    hours: list[int]
    backfill: bool


def latest_hour(now: dt.datetime) -> int:
    """Latest hour already published: the whole hour plus 10 minutes, 5 of margin."""
    latest = (now - dt.timedelta(minutes=15)).replace(minute=0, second=0, microsecond=0)
    return int(latest.timestamp())


def plan(stored: Stored, now: dt.datetime) -> Plan:
    latest = latest_hour(now)
    known = stored.hours()
    older = [latest - k * HOUR for k in range(RECENT_HOURS, BACKFILL_HOURS)]
    due = stored.backfilled_at is None or now - stored.backfilled_at >= BACKFILL_INTERVAL
    if due and any(hour not in known for hour in older):
        return Plan([], True)
    recent = [latest - k * HOUR for k in range(RECENT_HOURS)]
    wanted = {h for h in recent if h not in known} | set(recent[:REFRESH_HOURS])
    return Plan(sorted(wanted), False)


def merge(
    stored: Stored,
    observations: list[Observation],
    infos: dict[str, StationInfo],
    now: dt.datetime,
    backfilled: bool,
) -> Stored:
    """The previous hours, those just fetched (which win), within the window."""
    latest = latest_hour(now)
    first = latest - (WINDOW_HOURS - 1) * HOUR
    series = {
        station: {h: v for h, v in by_hour.items() if first <= h <= latest}
        for station, by_hour in stored.series.items()
    }
    positions = dict(stored.positions)
    for obs in observations:
        if not first <= obs.time <= latest:
            continue
        series.setdefault(obs.station, {})[obs.time] = (obs.ff, obs.dd, obs.raf)
        positions[obs.station] = (obs.lat, obs.lon)
    series = {s: by_hour for s, by_hour in series.items() if by_hour}
    names = {**stored.infos, **infos}
    return Stored(
        series=series,
        positions={s: positions[s] for s in series},
        infos={s: names[s] for s in series if s in names},
        fetched_at=now,
        backfilled_at=now if backfilled else stored.backfilled_at,
    )


def _iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC)
    except ValueError:
        return None


def document(stored: Stored) -> dict[str, Any]:
    """The file read by the map; stations sorted by number."""
    hours = sorted(stored.hours())
    start = hours[0] if hours else None
    count = (hours[-1] - hours[0]) // HOUR + 1 if hours else 0
    stations = []
    for station in sorted(stored.series):
        by_hour = stored.series[station]
        lat, lon = stored.positions[station]
        info = stored.infos.get(station)
        columns: list[list[float | int | None]] = [[], [], []]
        for k in range(count):
            values = by_hour.get((start or 0) + k * HOUR, (None, None, None))
            for column, value in zip(columns, values, strict=True):
                column.append(value)
        stations.append(
            {
                "id": station,
                "name": info.name if info else None,
                "altitude": info.altitude if info else None,
                "lat": lat,
                "lon": lon,
                "ff": columns[0],
                "dd": columns[1],
                "raf": columns[2],
            }
        )
    return {
        "source": SOURCE,
        "licence": "Licence Ouverte 2.0 (Etalab), source Météo-France",
        "units": {"ff": "m/s", "dd": "degrés, 360 pour le nord", "raf": "m/s"},
        "fetched_at": _iso(stored.fetched_at) if stored.fetched_at else None,
        "backfilled_at": _iso(stored.backfilled_at) if stored.backfilled_at else None,
        "start": start,
        "hours": count,
        "stations": stations,
    }


def _value(raw: Any, name: str) -> float | int | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        raise ValueError(name)
    low, high = BOUNDS[name]
    if not low <= raw <= high or (name == "dd" and raw != int(raw)):
        raise ValueError(name)
    return int(raw) if name == "dd" else float(raw)


def read_document(
    raw: Any, bbox: tuple[float, float, float, float], now: dt.datetime
) -> Stored | None:
    """A file written by ``document``, checked in full; None if anything differs.

    Used for the file of the previous deployment, read back from the site, and
    for the file handed over by the job that fetches the stations.
    """
    try:
        return _read(raw, bbox, now)
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def _read(raw: Any, bbox: tuple[float, float, float, float], now: dt.datetime) -> Stored:
    if not isinstance(raw, dict):
        raise ValueError("object")
    start, count, stations = raw["start"], raw["hours"], raw["stations"]
    if not isinstance(stations, list) or len(stations) > MAX_STATIONS:
        raise ValueError("stations")
    fetched_at = _parse_iso(raw.get("fetched_at"))
    backfilled_at = _parse_iso(raw.get("backfilled_at"))
    for moment in (fetched_at, backfilled_at):
        if moment is not None and moment > now:
            raise ValueError("time in the future")
    if count == 0 and start is None and not stations:
        return Stored(fetched_at=fetched_at, backfilled_at=backfilled_at)
    if (
        isinstance(start, bool)
        or not isinstance(start, int)
        or start % HOUR
        or start > now.timestamp()
        or isinstance(count, bool)
        or not isinstance(count, int)
        or not 1 <= count <= WINDOW_HOURS
    ):
        raise ValueError("hours")
    west, south, east, north = bbox
    stored = Stored(fetched_at=fetched_at, backfilled_at=backfilled_at)
    for entry in stations:
        station, lat, lon = entry["id"], entry["lat"], entry["lon"]
        if not isinstance(station, str) or not _STATION_ID.fullmatch(station):
            raise ValueError("id")
        if station in stored.series:
            raise ValueError("duplicate")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lon)):
            raise ValueError("position")
        if not (west <= lon <= east and south <= lat <= north):
            raise ValueError("position")
        name, altitude = entry["name"], entry["altitude"]
        if name is not None and (not isinstance(name, str) or not _NAME.fullmatch(name)):
            raise ValueError("name")
        if altitude is not None and (
            isinstance(altitude, bool)
            or not isinstance(altitude, int)
            or not -500 <= altitude <= 5000
        ):
            raise ValueError("altitude")
        columns = [entry[name] for name in WIND_PARAMETERS]
        if any(not isinstance(c, list) or len(c) != count for c in columns):
            raise ValueError("columns")
        by_hour: dict[int, Values] = {}
        for k, (ff, dd, raf) in enumerate(zip(*columns, strict=True)):
            values = (_value(ff, "ff"), _value(dd, "dd"), _value(raf, "raf"))
            if any(v is not None for v in values):
                by_hour[start + k * HOUR] = values  # type: ignore[assignment]
        if not by_hour:
            raise ValueError("empty station")
        stored.series[station] = by_hour
        stored.positions[station] = (float(lat), float(lon))
        if name is not None:
            stored.infos[station] = StationInfo(name, altitude)
    return stored
