from __future__ import annotations

import datetime as dt
import io
import json
import urllib.error
import urllib.request
from typing import Any

import pytest

from tests.helpers import FakeResponse, fixture_bytes
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


# ------------------------------------------------------------- observations

CAPTURE = "20261111T2322Z"
FRANCE = (-5.5, 41.0, 10.0, 51.5)


def hourly(name: str = "meteofrance_hourly_20261111T23Z") -> Any:
    return json.loads(fixture_bytes(f"{CAPTURE}/{name}.json.gz"))


def test_wind_of_the_hourly_package_of_all_the_stations() -> None:
    document = hourly()
    assert len(document) == 2035
    observations, dropped = meteofrance.parse_observations(document, FRANCE)
    # 822 stations measure the wind, 719 of them in metropolitan France and Corsica.
    assert (len(observations), dropped) == (719, 0)
    assert len({o.station for o in observations}) == 719
    first = observations[0]
    assert first == meteofrance.Observation("01014002", 46.278167, 5.669, 1794438000, 0.8, 70, 2.4)
    assert dt.datetime.fromtimestamp(first.time, dt.UTC).isoformat() == "2026-11-11T23:00:00+00:00"
    # A calm is given as direction 0, north as 360.
    calm = [o for o in observations if o.dd == 0]
    assert calm and all(o.ff == 0 for o in calm)
    assert any(o.dd == 360 and o.ff for o in observations)
    assert sum(o.raf is None for o in observations) == 2


def test_department_package_goes_back_120_hours() -> None:
    document = hourly("meteofrance_department_13_24h")
    observations, dropped = meteofrance.parse_observations(document, FRANCE)
    hours = sorted({o.time for o in observations})
    assert (len(hours), dropped) == (120, 0)
    assert dt.datetime.fromtimestamp(hours[0], dt.UTC).isoformat() == "2026-11-07T00:00:00+00:00"
    assert len({o.station for o in observations}) == 16
    assert len(observations) == 1919


def test_observations_outside_their_bounds_are_dropped_and_counted() -> None:
    base = hourly()[0]
    cases: list[tuple[dict[str, Any], tuple[Any, Any, Any]]] = [
        ({"ff": 80.0}, (None, 70, 2.4)),
        ({"ff": -0.1}, (None, 70, 2.4)),
        ({"dd": 365.0}, (0.8, None, 2.4)),
        ({"dd": 45.5}, (0.8, None, 2.4)),
        ({"raf": "12"}, (0.8, 70, None)),
        ({"raf": True}, (0.8, 70, None)),
        ({"raf": float("nan")}, (0.8, 70, None)),
    ]
    for change, values in cases:
        observations, dropped = meteofrance.parse_observations([{**base, **change}], FRANCE)
        assert dropped == 1, change
        assert (observations[0].ff, observations[0].dd, observations[0].raf) == values


@pytest.mark.parametrize(
    "change",
    [
        {"geo_id_insee": "1014002"},
        {"geo_id_insee": 1014002},
        {"lat": None},
        {"lon": "5.6"},
        {"validity_time": "2026-11-11T23:06:00Z"},
        {"validity_time": "2026-11-11 23:00"},
        {"validity_time": "2026-13-11T23:00:00Z"},
    ],
)
def test_records_without_the_documented_structure_are_dropped(change: dict[str, Any]) -> None:
    base = hourly()[0]
    assert meteofrance.parse_observations([{**base, **change}, "x"], FRANCE) == ([], 2)


def test_overseas_and_stations_without_wind_are_left_out_uncounted() -> None:
    base = hourly()[0]
    overseas = {**base, "lat": 16.26, "lon": -61.52}
    calm_less = {**base, "ff": None, "dd": None, "raf": None}
    assert meteofrance.parse_observations([overseas, calm_less], FRANCE) == ([], 0)


@pytest.mark.parametrize("document", [{}, "[]", None, [None] * (meteofrance.MAX_RECORDS + 1)])
def test_an_answer_that_is_not_a_list_is_refused(document: Any) -> None:
    with pytest.raises(meteofrance.ObservationFormatError):
        meteofrance.parse_observations(document, FRANCE)


def test_list_of_the_stations() -> None:
    text = fixture_bytes(f"{CAPTURE}/meteofrance_stations.csv.gz").decode("utf-8")
    infos = meteofrance.parse_station_list(text)
    assert len(infos) == 2152
    assert infos["01014002"] == meteofrance.StationInfo("ARBENT", 534)
    with pytest.raises(meteofrance.ObservationFormatError):
        meteofrance.parse_station_list("Id;Nom\n1;2\n")
    odd = (
        "Id_station;Nom_usuel;Altitude\n"
        "01014002;ARBENT;534\n"
        "1234;COURT;10\n"
        "01014003;<script>;10\n"
        "01014004;HAUT;9000\n"
        "01014005;SANS ALTITUDE;\n"
    )
    assert meteofrance.parse_station_list(odd) == {
        "01014002": meteofrance.StationInfo("ARBENT", 534),
        "01014004": meteofrance.StationInfo("HAUT", None),
        "01014005": meteofrance.StationInfo("SANS ALTITUDE", None),
    }
