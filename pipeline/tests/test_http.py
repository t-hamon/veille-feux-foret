from __future__ import annotations

import io
import urllib.request

import pytest

from tests.helpers import make_opener
from veille_feux import http
from veille_feux.http import FetchError

FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv"


@pytest.mark.parametrize(
    "url",
    [
        "http://firms.modaps.eosdis.nasa.gov/data.csv",
        "https://example.org/data.csv",
        "https://firms.modaps.eosdis.nasa.gov.evil.example/data.csv",
        "https://evil.example/?u=https://firms.modaps.eosdis.nasa.gov/",
        "file:///etc/passwd",
        "https://169.254.169.254/latest/meta-data/",
        "https://127.0.0.1/",
    ],
)
def test_check_url_rejects_unsafe_targets(url: str) -> None:
    with pytest.raises(FetchError):
        http.check_url(url)


@pytest.mark.parametrize(
    "url",
    [
        FIRMS_URL,
        "https://maps.effis.emergency.copernicus.eu/effis?x=1",
        "https://api2.effis.emergency.copernicus.eu/statistics",
        "https://geo.api.gouv.fr/communes?lat=1&lon=2",
    ],
)
def test_check_url_accepts_the_sources(url: str) -> None:
    http.check_url(url)


def test_read_limited_stops_at_the_cap() -> None:
    with pytest.raises(FetchError):
        http.read_limited(io.BytesIO(b"x" * 2000), max_bytes=1000)
    assert http.read_limited(io.BytesIO(b"abc"), max_bytes=3) == b"abc"


def test_redirect_to_foreign_host_is_refused() -> None:
    handler = http._AllowListRedirectHandler()
    request = urllib.request.Request(FIRMS_URL)
    with pytest.raises(FetchError):
        handler.redirect_request(
            request, io.BytesIO(), 302, "Found", {}, "https://example.org/elsewhere"
        )


def test_fetch_returns_the_body() -> None:
    status, body = http.fetch(FIRMS_URL, 100, 5, make_opener({FIRMS_URL: b"ok"}))
    assert (status, body) == (200, b"ok")


def test_fetch_rejects_a_non_200_status() -> None:
    with pytest.raises(FetchError, match="HTTP 204"):
        http.fetch(FIRMS_URL, 100, 5, make_opener({FIRMS_URL: b""}, status=204))
