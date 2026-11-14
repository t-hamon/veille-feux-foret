from __future__ import annotations

import datetime as dt
import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import FakeResponse, fixture_bytes
from veille_feux import build, meteofrance, stations
from veille_feux.meteofrance import StationInfo

CAPTURE = "20261111T2322Z"
FRANCE = (-5.5, 41.0, 10.0, 51.5)
NOW = dt.datetime(2026, 11, 11, 23, 22, 44, tzinfo=dt.UTC)
AUTH_URL = "https://portail-api.meteofrance.fr/token"
APPLICATION_ID = "QUJDOkRFRg=="
FAKE_JWT = "header.payload.signature"
LIST_URL = meteofrance.stations_url()


def hour_url(hour: int) -> str:
    return meteofrance.hourly_url(dt.datetime(2026, 11, 11, hour, tzinfo=dt.UTC))


HOURLY = {
    hour_url(h): fixture_bytes(f"{CAPTURE}/meteofrance_hourly_20261111T{h}Z.json.gz")
    for h in (21, 22, 23)
}
DEPARTMENT_13 = fixture_bytes(f"{CAPTURE}/meteofrance_department_13_24h.json.gz")
STATION_LIST = fixture_bytes(f"{CAPTURE}/meteofrance_stations.csv.gz")


class Api:
    """The portal and the API: answers by URL, records each request."""

    def __init__(self, bodies: dict[str, bytes | Exception]) -> None:
        self.bodies = {AUTH_URL: json.dumps({"access_token": FAKE_JWT}).encode(), **bodies}
        self.requests: list[tuple[str, str | None]] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Any:
        self.requests.append((request.full_url, request.get_header("Authorization")))
        body = self.bodies[request.full_url]
        if isinstance(body, Exception):
            raise body
        return FakeResponse(body)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def context(out: Path, previous: Path | None, api: Api) -> build.Context:
    out.mkdir(parents=True, exist_ok=True)
    status = build._read_json(previous / build.STATUS if previous else None)
    return build.Context(
        out=out,
        previous=previous,
        now=NOW,
        opener=api,
        status={},
        previous_status=status if isinstance(status, dict) else {},
    )


def department_file() -> dict[str, Any]:
    """A previous file: the 120 hours of the Bouches-du-Rhône, backfilled an hour ago."""
    document = json.loads(DEPARTMENT_13)
    observations, _ = meteofrance.parse_observations(document, FRANCE)
    stored = stations.merge(
        stations.Stored(), observations, {"13001009": StationInfo("AIX", 173)}, NOW, True
    )
    stored.backfilled_at = stored.fetched_at = NOW - dt.timedelta(hours=1)
    return stations.document(stored)


def write_previous(path: Path, document: dict[str, Any] | None = None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    build._write_json(path / build.STATIONS, document or department_file())
    previous_status = {
        "sources": {
            build.STATIONS_SOURCE: {
                "ok": True,
                "checked_at": "2026-11-11T22:22:44Z",
                "updated_at": "2026-11-11T22:22:44Z",
                "count": 16,
                "error": None,
            }
        }
    }
    build._write_json(path / build.STATUS, previous_status)
    return path


def read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def run(ctx: build.Context, application_id: str = APPLICATION_ID) -> Clock:
    clock = Clock()
    build.fetch_stations(ctx, application_id, build.Pacer(0.65, clock.time, clock.sleep))
    return clock


def test_a_run_adds_the_latest_hours_to_the_previous_file(tmp_path: Path) -> None:
    api = Api({**HOURLY, LIST_URL: STATION_LIST})
    ctx = context(tmp_path / "out", write_previous(tmp_path / "previous"), api)
    clock = run(ctx)
    # The token, the 3 latest hours, then the names of the stations not yet named.
    assert [url for url, _ in api.requests] == [AUTH_URL, *HOURLY, LIST_URL]
    assert api.requests[0][1] == f"Basic {APPLICATION_ID}"
    assert all(auth == f"Bearer {FAKE_JWT}" for _, auth in api.requests[1:])
    # At least 0.65 s between two requests: under 100 a minute.
    assert clock.sleeps == pytest.approx([0.65] * 4)
    document = read(ctx.out / build.STATIONS)
    assert document["hours"] == 120
    # Stations with wind at 21:00, 22:00 or 23:00: 726 (719 at 23:00 alone).
    assert len(document["stations"]) == 726
    assert document["fetched_at"] == "2026-11-11T23:22:44Z"
    assert document["backfilled_at"] == "2026-11-11T22:22:44Z"
    named = {s["id"]: s["name"] for s in document["stations"]}
    assert named["13001009"] == "AIX EN PROVENCE"
    assert named["01014002"] == "ARBENT"
    entry = ctx.status[build.STATIONS_SOURCE]
    assert (entry["ok"], entry["count"], entry["updated_at"]) == (True, 726, "2026-11-11T23:22:44Z")
    assert entry["label"] == "Météo-France, vent mesuré aux stations"


def test_first_run_reads_the_packages_of_every_department(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    bodies: dict[str, bytes | Exception] = {
        meteofrance.department_url(d): b"[]" for d in stations.DEPARTMENTS
    }
    bodies[meteofrance.department_url(13)] = DEPARTMENT_13
    for d in (2, 7, 20):
        bodies[meteofrance.department_url(d)] = urllib.error.URLError("down")
    api = Api({**bodies, LIST_URL: STATION_LIST})
    ctx = context(tmp_path / "out", None, api)
    run(ctx)
    assert "Météo-France: 92 of 95 department packages read; not read: 2, 7, 20" in (
        capsys.readouterr().out.splitlines()
    )
    asked = [url for url, _ in api.requests]
    assert asked[1:-1] == [meteofrance.department_url(d) for d in range(1, 96)]
    assert asked[-1] == LIST_URL
    document = read(ctx.out / build.STATIONS)
    assert (document["hours"], len(document["stations"])) == (120, 16)
    assert document["backfilled_at"] == "2026-11-11T23:22:44Z"
    assert ctx.status[build.STATIONS_SOURCE]["count"] == 16


def test_packages_that_fail_are_asked_again_next_time(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    urls = list(HOURLY)
    api = Api({**HOURLY, urls[0]: OSError("reset"), urls[1]: b"{}", LIST_URL: STATION_LIST})
    ctx = context(tmp_path / "out", write_previous(tmp_path / "previous"), api)
    run(ctx)
    assert ctx.status[build.STATIONS_SOURCE]["ok"] is True
    # The log names the packages not read.
    assert "Météo-France: 1 of 3 hourly packages read; not read: 21:00Z, 22:00Z" in (
        capsys.readouterr().out.splitlines()
    )
    document = read(ctx.out / build.STATIONS)
    # 23:00 came: the stations of all France; 21:00 and 22:00 did not.
    aix = next(s for s in document["stations"] if s["id"] == "01014002")
    assert aix["ff"][-3:] == [None, None, 0.8]


@pytest.mark.parametrize(
    ("actions", "line"),
    [
        (None, "Météo-France: 3 of 3 hourly packages read, 1 values or records dropped"),
        (
            "true",
            "::notice title=Météo-France::3 of 3 hourly packages read, 1 values or records dropped",
        ),
    ],
)
def test_values_out_of_bounds_are_counted_in_the_log(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    actions: str | None,
    line: str,
) -> None:
    # A plain line locally, a notice annotation in GitHub Actions.
    if actions is None:
        monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    else:
        monkeypatch.setenv("GITHUB_ACTIONS", actions)
    urls = list(HOURLY)
    record = json.loads(HOURLY[urls[2]])[0]
    api = Api({**HOURLY, urls[2]: json.dumps([{**record, "ff": 99.0}]).encode()})
    api.bodies[LIST_URL] = STATION_LIST
    ctx = context(tmp_path / "out", write_previous(tmp_path / "previous"), api)
    run(ctx)
    assert line in capsys.readouterr().out.splitlines()


def test_without_the_list_of_the_stations_the_names_are_those_kept(tmp_path: Path) -> None:
    api = Api({**HOURLY, LIST_URL: urllib.error.URLError("down")})
    ctx = context(tmp_path / "out", write_previous(tmp_path / "previous"), api)
    run(ctx)
    assert ctx.status[build.STATIONS_SOURCE]["ok"] is True
    named = {s["id"]: s["name"] for s in read(ctx.out / build.STATIONS)["stations"]}
    assert (named["13001009"], named["01014002"]) == ("AIX", None)


@pytest.mark.parametrize(
    ("application_id", "token_answer"),
    [
        ("", None),
        ("not base64!", None),
        (
            APPLICATION_ID,
            urllib.error.HTTPError(AUTH_URL, 401, "Unauthorized", {}, io.BytesIO()),  # type: ignore[arg-type]
        ),
        (APPLICATION_ID, b"{}"),
    ],
)
def test_without_a_token_the_previous_file_is_kept(
    tmp_path: Path, application_id: str, token_answer: bytes | Exception | None
) -> None:
    api = Api({})
    if token_answer is not None:
        api.bodies[AUTH_URL] = token_answer
    previous = write_previous(tmp_path / "previous")
    ctx = context(tmp_path / "out", previous, api)
    run(ctx, application_id)
    assert (ctx.out / build.STATIONS).read_bytes() == (previous / build.STATIONS).read_bytes()
    entry = ctx.status[build.STATIONS_SOURCE]
    assert entry["ok"] is False
    assert entry["count"] == 16
    assert entry["updated_at"] == "2026-11-11T22:22:44Z"
    expected = (
        "le serveur a répondu par une erreur (HTTP 401)"
        if isinstance(token_answer, Exception)
        else "accès à l'API refusé ou impossible"
    )
    assert entry["error"] == expected
    assert all(url == AUTH_URL for url, _ in api.requests)


def test_when_every_package_fails_the_previous_file_is_kept(tmp_path: Path) -> None:
    api = Api({url: TimeoutError() for url in HOURLY})
    previous = write_previous(tmp_path / "previous")
    ctx = context(tmp_path / "out", previous, api)
    run(ctx)
    assert (ctx.out / build.STATIONS).read_bytes() == (previous / build.STATIONS).read_bytes()
    assert ctx.status[build.STATIONS_SOURCE]["ok"] is False
    assert ctx.status[build.STATIONS_SOURCE]["error"] == "délai de réponse dépassé"


def test_the_log_names_ten_packages_not_read_at_most(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    bodies: dict[str, bytes | Exception] = {
        meteofrance.department_url(d): TimeoutError() for d in stations.DEPARTMENTS
    }
    bodies[meteofrance.department_url(13)] = DEPARTMENT_13
    run(context(tmp_path / "out", None, Api({**bodies, LIST_URL: STATION_LIST})))
    assert (
        "Météo-France: 1 of 95 department packages read; "
        "not read: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 84 more"
    ) in capsys.readouterr().out.splitlines()


def test_a_previous_file_that_differs_is_not_reused(tmp_path: Path) -> None:
    tampered = department_file()
    tampered["stations"][0]["name"] = "<img src=x>"
    bodies: dict[str, bytes | Exception] = {
        meteofrance.department_url(d): b"[]" for d in stations.DEPARTMENTS
    }
    api = Api({**bodies, LIST_URL: STATION_LIST})
    ctx = context(tmp_path / "out", write_previous(tmp_path / "previous", tampered), api)
    run(ctx)
    # Treated as a first run: every department is read again.
    assert len(api.requests) == 1 + 95 + 1
    assert read(ctx.out / build.STATIONS)["stations"] == []


def test_the_stations_job_writes_its_file_and_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api = Api({**HOURLY, LIST_URL: STATION_LIST})
    monkeypatch.setattr(build, "default_opener", api)
    monkeypatch.setattr(build, "STATIONS_MIN_INTERVAL", 0)
    monkeypatch.setenv(meteofrance.APPLICATION_ID_VARIABLE, APPLICATION_ID)
    previous = write_previous(tmp_path / "previous")
    out = tmp_path / "stations"
    # At the time of the capture, whatever the time of the test.
    assert build.stations_main([str(out), "--previous", str(previous)], NOW) == 0
    assert sorted(p.name for p in out.iterdir()) == [build.STATIONS_STATUS, build.STATIONS]
    status = read(out / build.STATIONS_STATUS)
    assert list(status["sources"]) == [build.STATIONS_SOURCE]
    assert status["sources"][build.STATIONS_SOURCE]["ok"] is True
    printed = capsys.readouterr().out
    assert "meteofrance_stations: ok" in printed
    # Neither the application ID nor the token is written or printed anywhere.
    for path in out.iterdir():
        assert APPLICATION_ID.encode() not in path.read_bytes()
        assert FAKE_JWT.encode() not in path.read_bytes()
    assert APPLICATION_ID not in printed and FAKE_JWT not in printed


def test_the_stations_job_without_the_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(meteofrance.APPLICATION_ID_VARIABLE, raising=False)
    monkeypatch.setattr(build, "default_opener", Api({}))
    out = tmp_path / "stations"
    assert build.stations_main([str(out)], NOW) == 0
    entry = read(out / build.STATIONS_STATUS)["sources"][build.STATIONS_SOURCE]
    assert (entry["ok"], entry["error"]) == (False, "accès à l'API refusé ou impossible")
    assert not (out / build.STATIONS).exists()


# --------------------------------------------- handing over to the build job


def handed(path: Path, ok: bool = True, document: dict[str, Any] | None = None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if document is not None:
        build._write_json(path / build.STATIONS, document)
    entry = {
        "label": "anything",
        "ok": ok,
        "checked_at": "2026-11-11T23:22:44Z",
        "updated_at": "2026-11-11T23:22:44Z" if ok else "2026-11-11T22:22:44Z",
        "count": 16,
        "error": None if ok else "délai de réponse dépassé",
    }
    build._write_json(path / build.STATIONS_STATUS, {"sources": {build.STATIONS_SOURCE: entry}})
    return path


def test_the_build_takes_over_the_file_of_the_stations_job(tmp_path: Path) -> None:
    ctx = context(tmp_path / "out", None, Api({}))
    build.merge_stations(ctx, handed(tmp_path / "handed", document=department_file()))
    assert read(ctx.out / build.STATIONS) == department_file()
    entry = ctx.status[build.STATIONS_SOURCE]
    assert entry == {
        "label": "Météo-France, vent mesuré aux stations",
        "ok": True,
        "checked_at": "2026-11-11T23:22:44Z",
        "updated_at": "2026-11-11T23:22:44Z",
        "count": 16,
        "error": None,
    }


def test_the_build_keeps_the_previous_file_when_the_job_failed(tmp_path: Path) -> None:
    previous = write_previous(tmp_path / "previous")
    ctx = context(tmp_path / "out", previous, Api({}))
    build.merge_stations(ctx, handed(tmp_path / "handed", ok=False))
    assert (ctx.out / build.STATIONS).read_bytes() == (previous / build.STATIONS).read_bytes()
    entry = ctx.status[build.STATIONS_SOURCE]
    assert (entry["ok"], entry["error"]) == (False, "délai de réponse dépassé")


def test_the_build_carries_the_previous_file_when_the_job_wrote_nothing(tmp_path: Path) -> None:
    previous = write_previous(tmp_path / "previous")
    ctx = context(tmp_path / "out", previous, Api({}))
    build.merge_stations(ctx, tmp_path / "missing")
    assert read(ctx.out / build.STATIONS) == department_file()
    entry = ctx.status[build.STATIONS_SOURCE]
    assert (entry["ok"], entry["checked_at"], entry["count"]) == (True, "2026-11-11T22:22:44Z", 16)
    # Neither a file nor a previous state: the source shows as down, with no data.
    ctx = context(tmp_path / "out2", None, Api({}))
    build.merge_stations(ctx, tmp_path / "missing")
    assert not (ctx.out / build.STATIONS).exists()
    assert ctx.status[build.STATIONS_SOURCE]["ok"] is False


def test_the_build_checks_what_the_job_handed_over(tmp_path: Path) -> None:
    tampered = department_file()
    tampered["stations"][0]["lat"] = 90
    previous = write_previous(tmp_path / "previous")
    ctx = context(tmp_path / "out", previous, Api({}))
    build.merge_stations(ctx, handed(tmp_path / "handed", document=tampered))
    assert read(ctx.out / build.STATIONS) == department_file()
    # A state from the future or of another shape is not taken either.
    for entry in ({"ok": "yes"}, {"ok": True, "checked_at": "2030-01-01T00:00:00Z"}):
        path = tmp_path / "odd"
        path.mkdir(exist_ok=True)
        build._write_json(path / build.STATIONS, department_file())
        build._write_json(path / build.STATIONS_STATUS, {"sources": {build.STATIONS_SOURCE: entry}})
        assert build._handed_status(read(path / build.STATIONS_STATUS), NOW) is None


def test_build_with_the_stations_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Path] = []
    monkeypatch.setattr(build, "build_fires", lambda ctx, area, sites: None)
    monkeypatch.setattr(build, "build_burned", lambda ctx, area: None)
    monkeypatch.setattr(build, "build_summary", lambda ctx: None)
    monkeypatch.setattr(build, "merge_stations", lambda ctx, path: calls.append(path))
    build.build(tmp_path / "out", None, NOW, Api({}), with_weather=False)
    assert calls == []
    build.build(
        tmp_path / "out", None, NOW, Api({}), with_weather=False, handed_stations=tmp_path / "h"
    )
    assert calls == [tmp_path / "h"]


def test_pacer() -> None:
    clock = Clock()
    pacer = build.Pacer(1.0, clock.time, clock.sleep)
    pacer.wait()
    clock.now += 0.25
    pacer.wait()
    clock.now += 2.0
    pacer.wait()
    assert clock.sleeps == [0.75]
