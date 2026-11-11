from __future__ import annotations

import datetime as dt
import io
import json
import urllib.error
import urllib.request
from typing import Any

import pytest

from tests.helpers import FakeResponse
from veille_feux import http, meteofrance
from veille_feux.http import FetchError

AUTH_URL = "https://portail-api.meteofrance.fr/token"
BASE = "https://public-api.meteofrance.fr/public/DPPaquetObs/v2"
APPLICATION_ID = "QUJDOkRFRg=="
# Three parts separated by dots, like a JWT; obviously not a real one.
FAKE_JWT = "header.payload.signature"


def test_urls_of_the_package_observations_api() -> None:
    assert meteofrance.stations_url() == f"{BASE}/liste-stations"
    hour = dt.datetime(2026, 11, 11, 9, tzinfo=dt.UTC)
    assert meteofrance.hourly_url(hour) == (
        f"{BASE}/paquet/stations/horaire?date=2026-11-11T09:00:00Z&format=json"
    )
    assert meteofrance.hourly_url(hour, "geojson").endswith("&format=geojson")
    assert meteofrance.department_url(5) == f"{BASE}/paquet/horaire?id-departement=5&format=json"
    for url in (meteofrance.stations_url(), meteofrance.hourly_url(hour), AUTH_URL):
        http.check_url(url)


def test_hourly_url_needs_a_whole_hour_in_utc() -> None:
    with pytest.raises(ValueError, match="minutes"):
        meteofrance.hourly_url(dt.datetime(2026, 11, 11, 9, 6, tzinfo=dt.UTC))
    with pytest.raises(ValueError, match="UTC"):
        meteofrance.hourly_url(dt.datetime(2026, 11, 11, 9))
    paris = dt.timezone(dt.timedelta(hours=1))
    with pytest.raises(ValueError, match="UTC"):
        meteofrance.hourly_url(dt.datetime(2026, 11, 11, 10, tzinfo=paris))


def test_last_hours_are_those_already_published() -> None:
    # Published at the whole hour plus 10 minutes: at 22:14, 22:00 is not sure yet.
    at = dt.datetime(2026, 11, 11, 22, 14, 59, tzinfo=dt.UTC)
    assert [h.hour for h in meteofrance.last_hours(at, 3)] == [21, 20, 19]
    at = dt.datetime(2026, 11, 11, 22, 15, tzinfo=dt.UTC)
    assert [h.hour for h in meteofrance.last_hours(at, 2)] == [22, 21]
    at = dt.datetime(2026, 11, 12, 0, 5, tzinfo=dt.UTC)
    assert meteofrance.last_hours(at, 1) == [dt.datetime(2026, 11, 11, 23, tzinfo=dt.UTC)]


def token_opener(body: bytes, seen: dict[str, Any]) -> Any:
    def opener(request: urllib.request.Request, timeout: float) -> Any:
        seen.update(
            url=request.full_url,
            method=request.get_method(),
            data=request.data,
            authorization=request.get_header("Authorization"),
            content_type=request.get_header("Content-type"),
        )
        return FakeResponse(body)

    return opener


def test_token_is_asked_with_the_application_id() -> None:
    seen: dict[str, Any] = {}
    answer = {"access_token": FAKE_JWT, "token_type": "Bearer", "expires_in": 3600}
    body = json.dumps(answer).encode()
    token = meteofrance.obtain_token(APPLICATION_ID, token_opener(body, seen))
    assert token == FAKE_JWT
    assert seen == {
        "url": AUTH_URL,
        "method": "POST",
        "data": b"grant_type=client_credentials",
        "authorization": f"Basic {APPLICATION_ID}",
        "content_type": "application/x-www-form-urlencoded",
    }
    assert meteofrance.bearer(token) == {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize(
    "application_id", ["", "abc", "QUJD\r\nX-Injected: 1", "QUJD OkRF", "é" * 12, "A" * 513]
)
def test_an_application_id_that_is_not_base64_is_never_sent(application_id: str) -> None:
    seen: dict[str, Any] = {}
    with pytest.raises(meteofrance.TokenError, match="not base64") as error:
        meteofrance.obtain_token(application_id, token_opener(b"{}", seen))
    assert seen == {}
    if application_id:
        assert application_id not in str(error.value)


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b"{}",
        b'{"access_token": 12}',
        b'{"access_token": "short"}',
        b'{"access_token": "abcdefghijklmnop\\r\\nX-Injected: 1"}',
    ],
)
def test_an_unusable_token_answer_is_refused(body: bytes) -> None:
    with pytest.raises(meteofrance.TokenError, match="usable access_token") as error:
        meteofrance.obtain_token(APPLICATION_ID, token_opener(body, {}))
    # Neither the application ID nor the answer goes into the message.
    assert APPLICATION_ID not in str(error.value)
    assert body.decode(errors="replace") not in str(error.value)


def test_a_refused_application_id_is_an_outage_without_the_secret() -> None:
    def opener(request: urllib.request.Request, timeout: float) -> Any:
        raise urllib.error.HTTPError(AUTH_URL, 401, "Unauthorized", {}, io.BytesIO(b""))  # type: ignore[arg-type]

    with pytest.raises(http.FETCH_ERRORS) as error:
        meteofrance.obtain_token(APPLICATION_ID, opener)
    assert APPLICATION_ID not in str(error.value)


def test_a_request_with_credentials_is_never_redirected() -> None:
    handler = http._AllowListRedirectHandler()
    request = urllib.request.Request(AUTH_URL, headers={"Authorization": "Basic x"})
    # Not even to a host of the allow list.
    with pytest.raises(FetchError, match="credentials"):
        handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, f"{BASE}/liste-stations")
    public = urllib.request.Request(f"{BASE}/liste-stations")  # noqa: S310
    assert handler.redirect_request(public, io.BytesIO(), 302, "Found", {}, AUTH_URL) is not None
