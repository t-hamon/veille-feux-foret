"""Measured wind of the Météo-France ground stations: Package Observations API.

The API keeps the observations of the last 24 hours only, without archive. A
token valid one hour is asked for with the application ID of the subscribed
account (OAuth2 client credentials), then sent as a bearer token. Neither the
application ID nor the token is ever written to a file, a log line or an error
message, and requests that carry them are never redirected (``http.py``).
"""

from __future__ import annotations

import datetime as dt
import json
import re
import urllib.parse

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
