"""Wind and weather of the AROME France HD model of Météo-France, read through Open-Meteo.

Two files are written for the map:
- the wind on a regular grid over France (speed, direction, gusts), for the
  animated wind and the wind at any point;
- the weather at each fire cluster with a detection in the last 24 hours
  (temperature, humidity, precipitation and wind), asked at the cluster itself.

Every answer is checked before use: one entry per point asked, in the same
order, close to the point asked, on the expected hourly time axis, in the
expected units. A value outside a physical range is dropped (written as null)
and counted, never corrected. Values are rounded for the file: 1 km/h for the
speeds, 1 degree for the direction, 0.1 degree Celsius, 1 % and 0.1 mm.

The past hours of an answer are the archived forecasts of the model, not
measurements: the map has to say so.
"""

from __future__ import annotations

import datetime as dt
import itertools
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from veille_feux.foyers import Foyer
from veille_feux.sources import PAST_HOURS

HOUR = 3600
# Open-Meteo advises waiting 10 minutes after a run is announced: its servers
# are updated one after the other.
AVAILABILITY_MARGIN = dt.timedelta(minutes=10)
# Weather is asked for clusters with a detection in the last 24 hours.
RECENT_FIRE = dt.timedelta(hours=24)
# A fire cluster is asked for at its position rounded to 0.01 degree, the mesh
# of the model (about 1.1 km): nearby centroids share one request.
FIRE_POINT_DECIMALS = 2

UNITS = {
    "wind_speed_10m": "km/h",
    "wind_direction_10m": "°",
    "wind_gusts_10m": "km/h",
    "temperature_2m": "°C",
    "relative_humidity_2m": "%",
    "precipitation": "mm",
}
# Physical bounds: a value outside is an error of the answer, not weather.
BOUNDS = {
    "wind_speed_10m": (0.0, 400.0),
    "wind_direction_10m": (0.0, 360.0),
    "wind_gusts_10m": (0.0, 500.0),
    "temperature_2m": (-60.0, 60.0),
    "relative_humidity_2m": (0.0, 100.0),
    "precipitation": (0.0, 500.0),
}
# Names of the variables in the files of the map.
FILE_NAMES = {
    "wind_speed_10m": "speed",
    "wind_direction_10m": "direction",
    "wind_gusts_10m": "gusts",
    "temperature_2m": "temperature",
    "relative_humidity_2m": "humidity",
    "precipitation": "precipitation",
}
DECIMALS = {
    "wind_speed_10m": 0,
    "wind_direction_10m": 0,
    "wind_gusts_10m": 0,
    "temperature_2m": 1,
    "relative_humidity_2m": 0,
    "precipitation": 1,
}
# Longest answer accepted: 168 past hours, 60 forecast hours and a margin.
MAX_HOURS = 400


class MeteoFormatError(ValueError):
    """An answer of Open-Meteo does not have the expected form."""


@dataclass(frozen=True)
class ModelRun:
    initialised: dt.datetime
    available: dt.datetime
    # First hour without data: the forecast ends one hour before.
    data_end: dt.datetime

    def usable(self, now: dt.datetime) -> bool:
        return now >= self.available + AVAILABILITY_MARGIN


def _timestamp(value: Any, name: str) -> dt.datetime:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise MeteoFormatError(f"{name} is not a Unix time")
    return dt.datetime.fromtimestamp(value, dt.UTC)


def parse_run(document: Any, now: dt.datetime) -> ModelRun:
    """Read the metadata of the model: time of the last run and end of its data."""
    if not isinstance(document, dict):
        raise MeteoFormatError("metadata is not an object")
    run = ModelRun(
        initialised=_timestamp(document.get("last_run_initialisation_time"), "run time"),
        available=_timestamp(document.get("last_run_availability_time"), "availability time"),
        data_end=_timestamp(document.get("data_end_time"), "data end"),
    )
    if not run.initialised <= run.available <= now + dt.timedelta(hours=1):
        raise MeteoFormatError("run times out of order or in the future")
    if not run.initialised < run.data_end <= run.initialised + dt.timedelta(days=7):
        raise MeteoFormatError("data end out of range")
    return run


@dataclass(frozen=True)
class PointSeries:
    """Hourly values at one point, as answered by Open-Meteo."""

    lat: float  # centre of the model cell used
    lon: float
    elevation: float | None
    start: int  # Unix time of the first hour
    values: dict[str, list[float | None]]

    @property
    def hours(self) -> int:
        return len(next(iter(self.values.values()), []))


def expected_start(now: dt.datetime) -> int:
    """First hour of an answer asked at ``now``: the current hour minus the past hours."""
    hour = int(now.timestamp()) // HOUR * HOUR
    return hour - PAST_HOURS * HOUR


def _number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MeteoFormatError("a value is not a number")
    return float(value)


def _coordinate(entry: dict[str, Any], key: str) -> float:
    value = entry.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MeteoFormatError(f"{key} missing")
    return float(value)


def parse_points(
    document: Any,
    asked: Sequence[tuple[float, float]],
    variables: Sequence[str],
    now: dt.datetime,
    max_offset: float,
) -> tuple[list[PointSeries], int]:
    """Check an answer for the points ``asked`` and return their series.

    ``max_offset`` is the largest distance in degrees, on each axis, accepted
    between a point asked and the model cell answered. Returns the series and
    the number of values dropped for being out of bounds.
    """
    entries = document if isinstance(document, list) else [document]
    if len(entries) != len(asked):
        raise MeteoFormatError(f"{len(entries)} points answered for {len(asked)} asked")
    start_ok = {expected_start(now) + shift * HOUR for shift in (-1, 0, 1)}
    series: list[PointSeries] = []
    dropped = 0
    times: list[int] | None = None
    for index, (entry, (lat, lon)) in enumerate(zip(entries, asked, strict=True)):
        if not isinstance(entry, dict):
            raise MeteoFormatError("a point is not an object")
        location = entry.get("location_id", 0)
        if location != index:
            raise MeteoFormatError(f"point {index} answered as location {location}")
        cell_lat, cell_lon = _coordinate(entry, "latitude"), _coordinate(entry, "longitude")
        if abs(cell_lat - lat) > max_offset or abs(cell_lon - lon) > max_offset:
            raise MeteoFormatError(f"point {index} answered too far from the point asked")
        elevation = entry.get("elevation")
        if isinstance(elevation, bool) or not isinstance(elevation, (int, float)):
            elevation = None
        hourly, units = entry.get("hourly"), entry.get("hourly_units")
        if not isinstance(hourly, dict) or not isinstance(units, dict):
            raise MeteoFormatError("hourly values missing")
        point_times = hourly.get("time")
        if times is None:
            times = _check_times(point_times, start_ok)
        elif point_times != times:
            raise MeteoFormatError("points answered on different time axes")
        values: dict[str, list[float | None]] = {}
        for name in variables:
            if units.get(name) != UNITS[name]:
                raise MeteoFormatError(f"{name} not in {UNITS[name]}")
            raw = hourly.get(name)
            if not isinstance(raw, list) or len(raw) != len(times):
                raise MeteoFormatError(f"{name} does not match the time axis")
            low, high = BOUNDS[name]
            column: list[float | None] = []
            for item in raw:
                number = _number(item)
                if number is not None and not (math.isfinite(number) and low <= number <= high):
                    dropped += 1
                    number = None
                column.append(number)
            values[name] = column
        series.append(
            PointSeries(
                lat=round(cell_lat, 4),
                lon=round(cell_lon, 4),
                elevation=float(elevation) if elevation is not None else None,
                start=times[0],
                values=values,
            )
        )
    return series, dropped


def _check_times(value: Any, start_ok: set[int]) -> list[int]:
    if not isinstance(value, list) or not 0 < len(value) <= MAX_HOURS:
        raise MeteoFormatError("time axis missing or too long")
    if not all(isinstance(t, int) and not isinstance(t, bool) for t in value):
        raise MeteoFormatError("time axis is not in Unix time")
    if value[0] not in start_ok:
        raise MeteoFormatError("time axis does not start at the hour asked")
    if any(b - a != HOUR for a, b in itertools.pairwise(value)):
        raise MeteoFormatError("time axis is not hourly")
    return value


def trim(series: Sequence[PointSeries]) -> list[PointSeries]:
    """Drop the trailing hours where no point has any value (end of the forecast).

    The points must share one time axis. An answer without any value is refused.
    """
    if len({(p.start, p.hours) for p in series}) > 1:
        raise MeteoFormatError("points on different time axes")
    last = -1
    for point in series:
        for column in point.values.values():
            for index in range(len(column) - 1, last, -1):
                if column[index] is not None:
                    last = index
                    break
    if last < 0:
        raise MeteoFormatError("no value in the answer")
    return [
        PointSeries(
            p.lat, p.lon, p.elevation, p.start, {k: v[: last + 1] for k, v in p.values.items()}
        )
        for p in series
    ]


def _rounded(name: str, column: Iterable[float | None]) -> list[float | int | None]:
    digits = DECIMALS[name]
    out: list[float | int | None] = []
    for value in column:
        if value is None:
            out.append(None)
        elif name == "wind_direction_10m":
            out.append(round(value) % 360)
        elif digits == 0:
            out.append(round(value))
        else:
            out.append(round(value, digits))
    return out


def _iso(moment: dt.datetime | None) -> str | None:
    return None if moment is None else moment.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def wind_document(
    series: Sequence[PointSeries],
    step: float,
    run: dt.datetime | None,
    fetched_at: dt.datetime,
) -> dict[str, Any]:
    """The wind file: grid points, then one row of hourly values per point."""
    if not series:
        raise MeteoFormatError("no wind point")
    start, hours = series[0].start, series[0].hours
    document: dict[str, Any] = {
        "model": "AROME France HD (Météo-France), via Open-Meteo",
        "run": _iso(run),
        "fetched_at": _iso(fetched_at),
        "start": start,
        "hours": hours,
        "step": step,
        "points": [[p.lat, p.lon] for p in series],
    }
    for name in ("wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"):
        document[FILE_NAMES[name]] = [_rounded(name, p.values[name]) for p in series]
    return document


def fire_point(foyer: Foyer) -> tuple[float, float]:
    return (round(foyer.lat, FIRE_POINT_DECIMALS), round(foyer.lon, FIRE_POINT_DECIMALS))


def recent_fires(clusters: Iterable[Foyer], now: dt.datetime) -> list[Foyer]:
    """Clusters with a detection in the last 24 hours, in their order (largest first)."""
    return [f for f in clusters if now - f.last < RECENT_FIRE]


def fire_entry(
    foyer: Foyer, point: PointSeries, run: dt.datetime | None, fetched_at: dt.datetime
) -> dict[str, Any]:
    """Weather at one cluster. Each entry keeps the run and time it was fetched at."""
    entry: dict[str, Any] = {
        "id": foyer.id,
        "point": list(fire_point(foyer)),
        "cell": [point.lat, point.lon],
        "elevation": point.elevation,
        "run": _iso(run),
        "fetched_at": _iso(fetched_at),
        "start": point.start,
        "hours": point.hours,
    }
    for name, column in point.values.items():
        entry[FILE_NAMES[name]] = _rounded(name, column)
    return entry


def previous_fire_entries(previous: Any) -> dict[tuple[float, float], dict[str, Any]]:
    """Well-formed entries of the previous weather file, by point asked."""
    entries = previous.get("fires") if isinstance(previous, dict) else None
    if not isinstance(entries, list):
        return {}
    by_point: dict[tuple[float, float], dict[str, Any]] = {}
    for entry in entries:
        if isinstance(entry, dict) and _has_fire_shape(entry):
            lat, lon = entry["point"]
            by_point[(float(lat), float(lon))] = entry
    return by_point


def _has_fire_shape(entry: Mapping[str, Any]) -> bool:
    point, hours = entry.get("point"), entry.get("hours")
    if not (isinstance(point, list) and len(point) == 2):
        return False
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point):
        return False
    if not isinstance(hours, int) or isinstance(hours, bool) or not 0 < hours <= MAX_HOURS:
        return False
    if not isinstance(entry.get("start"), int) or isinstance(entry.get("start"), bool):
        return False
    if parse_iso(entry.get("fetched_at")) is None:
        return False
    run = entry.get("run")
    if run is not None and parse_iso(run) is None:
        return False
    return all(
        isinstance(entry.get(name), list) and len(entry[name]) == hours
        for name in FILE_NAMES.values()
    )


def parse_iso(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC)
    except ValueError:
        return None
