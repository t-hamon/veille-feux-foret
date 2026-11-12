"""Measured wind of the Météo-France ground stations: Package Observations API.

The API keeps the observations of the last 24 hours only, without archive. A
token valid one hour is asked for with the application ID of the subscribed
account (OAuth2 client credentials), then sent as a bearer token. Neither the
application ID nor the token is ever written to a file, a log line or an error
message, and requests that carry them are never redirected (``http.py``).
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import math
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any

from veille_feux.http import FetchError, Opener, default_opener, fetch
from veille_feux.sources import METEOFRANCE_AUTH_URL, METEOFRANCE_OBSERVATIONS

# Name of the environment variable that holds the application ID, set from the
# secret of the GitHub environment meteo-france.
APPLICATION_ID_VARIABLE = "METEOFRANCE_APPLICATION_ID"

# The application ID is base64 text, the token a JWT: anything else could
# inject a header, so it is refused rather than sent.
_APPLICATION_ID = re.compile(r"[A-Za-z0-9+/=]{8,512}")
_TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{16,8192}")
TOKEN_MAX_BYTES = 64 * 1024


class TokenError(FetchError):
    """No usable token: the message never holds the application ID or a token."""


def stations_url() -> str:
    """CSV list of the stations, metropolitan France and overseas."""
    return f"{METEOFRANCE_OBSERVATIONS}/liste-stations"


def _query(params: dict[str, str | int]) -> str:
    return urllib.parse.urlencode(params, safe=":")


def hourly_url(hour: dt.datetime, file_format: str = "json") -> str:
    """Hourly observations of all the stations at a whole hour, UTC."""
    if hour.tzinfo is None or hour.utcoffset() != dt.timedelta(0):
        raise ValueError("the hour must be given in UTC")
    if hour.minute or hour.second or hour.microsecond:
        raise ValueError("the observations are hourly: minutes and seconds must be 0")
    date = hour.strftime("%Y-%m-%dT%H:00:00Z")
    return f"{METEOFRANCE_OBSERVATIONS}/paquet/stations/horaire?" + _query(
        {"date": date, "format": file_format}
    )


def department_url(department: int, file_format: str = "json") -> str:
    """Hourly observations of the last 24 hours at the stations of a department."""
    return f"{METEOFRANCE_OBSERVATIONS}/paquet/horaire?" + _query(
        {"id-departement": department, "format": file_format}
    )


def last_hours(now: dt.datetime, count: int) -> list[dt.datetime]:
    """The ``count`` latest whole hours already published, latest first.

    The hourly observations are published at the whole hour plus 10 minutes:
    the latest hour asked for is the last one at least 15 minutes old.
    """
    latest = (now - dt.timedelta(minutes=15)).replace(minute=0, second=0, microsecond=0)
    return [latest - dt.timedelta(hours=k) for k in range(count)]


def obtain_token(application_id: str, opener: Opener = default_opener, timeout: float = 30) -> str:
    """Ask the portal for a token valid one hour."""
    if not _APPLICATION_ID.fullmatch(application_id):
        raise TokenError("the application ID is not base64 text")
    _, body = fetch(
        METEOFRANCE_AUTH_URL,
        TOKEN_MAX_BYTES,
        timeout,
        opener,
        headers={
            "Authorization": f"Basic {application_id}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=b"grant_type=client_credentials",
    )
    try:
        token = json.loads(body).get("access_token")
    except (ValueError, AttributeError):
        token = None
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        raise TokenError("the portal answered without a usable access_token")
    return token


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------- observations

# Hourly wind parameters kept, as named by the API (technical description of
# 30 June 2026): ff mean wind over 10 minutes at 10 m (m/s), dd its direction
# (degrees, 360 for north; 0 goes with a calm, ff = 0, in the capture of
# 11 November 2026) and raf the strongest gust of the hour at 10 m (m/s).
WIND_PARAMETERS = ("ff", "dd", "raf")
# Physical bounds: a value outside is left empty and counted, never corrected.
BOUNDS = {"ff": (0.0, 75.0), "dd": (0.0, 360.0), "raf": (0.0, 120.0)}
MAX_RECORDS = 300_000
_STATION_ID = re.compile(r"\d{8}")
_HOUR = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:00:00Z")


class ObservationFormatError(ValueError):
    """An answer of the API that does not have the documented structure."""


@dataclass(frozen=True)
class Observation:
    station: str
    lat: float
    lon: float
    # Hour of the measurement, seconds since 1970-01-01 UTC.
    time: int
    ff: float | None
    dd: int | None
    raf: float | None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _hour(value: Any) -> int | None:
    if not isinstance(value, str) or not _HOUR.fullmatch(value):
        return None
    try:
        moment = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC)
    except ValueError:
        return None
    return int(moment.timestamp())


def parse_observations(
    document: Any, bbox: tuple[float, float, float, float]
) -> tuple[list[Observation], int]:
    """Wind measured at the stations inside ``bbox`` (west, south, east, north).

    Returns the observations and the count of what was dropped: records that do
    not have the documented structure, and values outside their physical bounds.
    Stations outside the box (overseas) and stations without any wind value are
    left out without being counted.
    """
    if not isinstance(document, list) or len(document) > MAX_RECORDS:
        raise ObservationFormatError("a list of observations was expected")
    west, south, east, north = bbox
    out: list[Observation] = []
    dropped = 0
    for record in document:
        if not isinstance(record, dict):
            dropped += 1
            continue
        station = record.get("geo_id_insee")
        lat, lon = _number(record.get("lat")), _number(record.get("lon"))
        time = _hour(record.get("validity_time"))
        if (
            not isinstance(station, str)
            or not _STATION_ID.fullmatch(station)
            or lat is None
            or lon is None
            or time is None
        ):
            dropped += 1
            continue
        if not (west <= lon <= east and south <= lat <= north):
            continue
        values: dict[str, float | None] = {}
        for name in WIND_PARAMETERS:
            raw = record.get(name)
            value = _number(raw)
            low, high = BOUNDS[name]
            if raw is not None and (value is None or not low <= value <= high):
                dropped += 1
                value = None
            values[name] = value
        if all(v is None for v in values.values()):
            continue
        direction = values["dd"]
        if direction is not None and direction != int(direction):
            dropped += 1
            direction = None
        out.append(
            Observation(
                station,
                lat,
                lon,
                time,
                values["ff"],
                None if direction is None else int(direction),
                values["raf"],
            )
        )
    return out, dropped


@dataclass(frozen=True)
class StationInfo:
    name: str
    altitude: int | None


_NAME = re.compile(r"[\w' ./()-]{1,60}")


def parse_station_list(text: str) -> dict[str, StationInfo]:
    """Name and altitude of each station, from the CSV list of the API."""
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    fields = set(reader.fieldnames or [])
    if not {"Id_station", "Nom_usuel", "Altitude"} <= fields:
        raise ObservationFormatError("the list of the stations lacks its columns")
    out: dict[str, StationInfo] = {}
    for row in reader:
        station = (row.get("Id_station") or "").strip()
        name = (row.get("Nom_usuel") or "").strip()
        if not _STATION_ID.fullmatch(station) or not _NAME.fullmatch(name):
            continue
        try:
            altitude: int | None = int((row.get("Altitude") or "").strip())
        except ValueError:
            altitude = None
        if altitude is not None and not -500 <= altitude <= 5000:
            altitude = None
        out[station] = StationInfo(name, altitude)
    return out
