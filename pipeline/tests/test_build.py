from __future__ import annotations

import csv
import datetime as dt
import http.client
import json
import ssl
import urllib.error
from email.message import Message
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import fixture_bytes, make_opener
from veille_feux import build
from veille_feux.http import FetchError, HttpStatusError, ResponseTooLargeError
from veille_feux.sources import (
    EFFIS_DATED_LAYER,
    EFFIS_NRT_LAYER,
    FIRMS_FEEDS,
    effis_stats_url,
    effis_wfs_url,
)

CAPTURE = "20261003T1128Z"
NOW = dt.datetime(2026, 10, 3, 11, 28, tzinfo=dt.UTC)
DATED_URL = effis_wfs_url(EFFIS_DATED_LAYER)
NRT_URL = effis_wfs_url(EFFIS_NRT_LAYER)
STATS_URL = effis_stats_url(2026)


def real_bodies() -> dict[str, bytes | Exception]:
    """Every source answered with the real capture. The 24 h FIRMS files stand
    in for the 7 day ones: same format, fewer rows."""
    bodies: dict[str, bytes | Exception] = {
        feed.url("7d"): fixture_bytes(f"{CAPTURE}/firms_{feed.id}_24h.csv.gz")
        for feed in FIRMS_FEEDS
    }
    bodies[DATED_URL] = fixture_bytes(f"{CAPTURE}/effis_burned_dated.extract.geojson.gz")
    bodies[NRT_URL] = fixture_bytes(f"{CAPTURE}/effis_burned_nrt.extract.geojson.gz")
    bodies[STATS_URL] = fixture_bytes(f"{CAPTURE}/effis_weekly_stats.json.gz")
    return bodies


def read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def run(out: Path, bodies: dict[str, bytes | Exception], previous: Path | None = None,
        now: dt.datetime = NOW) -> dict[str, Any]:  # fmt: skip
    return build.build(out, previous, now, make_opener(bodies))


def test_all_sources_answer(tmp_path: Path) -> None:
    status = run(tmp_path, real_bodies())
    assert all(entry["ok"] for entry in status["sources"].values())
    assert set(status["sources"]) == set(build.SOURCE_LABELS)
    assert status["files"] == sorted(
        [build.DETECTIONS, build.FOYERS, build.OUTLINES, build.BURNED, build.SUMMARY]
    )
    detections = read(tmp_path / build.DETECTIONS)["features"]
    assert len(detections) == 46
    times = [f["properties"]["t"] for f in detections]
    assert times == sorted(times)
    foyers = read(tmp_path / build.FOYERS)["features"]
    assert len(foyers) == 7
    clustered = [f for f in detections if f["properties"]["foyer"] is not None]
    assert len(clustered) == sum(f["properties"]["detections"] for f in foyers)
    burned = read(tmp_path / build.BURNED)["features"]
    assert sum(f["properties"]["kind"] == "dated" for f in burned) == 43
    assert sum(f["properties"]["kind"] == "nrt" for f in burned) == 28
    assert read(tmp_path / build.SUMMARY)["burned_ha"] == 97971
    assert read(tmp_path / build.STATUS)["generated_at"] == "2026-10-03T11:28:00Z"


def test_detections_older_than_the_window_are_dropped(tmp_path: Path) -> None:
    status = run(tmp_path, real_bodies(), now=NOW + dt.timedelta(days=8))
    assert read(tmp_path / build.DETECTIONS)["features"] == []
    assert status["sources"]["firms_viirs_snpp"]["count"] == 0


def test_one_feed_down_is_reported_and_others_still_count(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[1].url("7d")] = OSError("connection reset")
    status = run(tmp_path, bodies)
    feed = status["sources"]["firms_viirs_noaa20"]
    assert feed["ok"] is False
    # The page gets a short reason, the log keeps the technical detail.
    assert feed["error"] == "serveur injoignable"
    assert "firms_viirs_noaa20: OSError: connection reset" in capsys.readouterr().out
    assert feed["updated_at"] is None
    assert len(read(tmp_path / build.DETECTIONS)["features"]) == 46 - 22


def test_html_error_page_instead_of_csv(tmp_path: Path) -> None:
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[0].url("7d")] = b"<html>Service Unavailable</html>"
    status = run(tmp_path, bodies)
    assert status["sources"]["firms_viirs_snpp"]["error"] == "réponse du serveur inattendue"


def test_total_firms_outage_carries_the_previous_files(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    bodies = real_bodies()
    for feed in FIRMS_FEEDS:
        bodies[feed.url("7d")] = TimeoutError("timed out")
    second = tmp_path / "second"
    later = NOW + dt.timedelta(minutes=30)
    status = run(second, bodies, previous=first, now=later)
    assert read(second / build.DETECTIONS) == read(first / build.DETECTIONS)
    entry = status["sources"]["firms_modis"]
    assert entry["ok"] is False
    assert entry["checked_at"] == "2026-10-03T11:58:00Z"
    assert entry["updated_at"] == "2026-10-03T11:28:00Z"  # age of the data shown
    assert entry["count"] == 4


def test_total_firms_outage_without_previous_fails_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bodies: dict[str, bytes | Exception] = {feed.url("7d"): OSError("down") for feed in FIRMS_FEEDS}
    bodies.update({DATED_URL: OSError("down"), NRT_URL: OSError("down"), STATS_URL: OSError("x")})
    status = run(tmp_path, bodies)
    assert status["files"] == []
    monkeypatch.setattr(build, "build", lambda out, previous, now: {"sources": {}, "files": []})
    assert build.main([str(tmp_path)]) == 1


def test_effis_is_not_fetched_again_within_six_hours(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    bodies = real_bodies()
    for url in (DATED_URL, NRT_URL, STATS_URL):
        bodies[url] = AssertionError(f"{url} should not be fetched")
    second = tmp_path / "second"
    status = run(second, bodies, previous=first, now=NOW + dt.timedelta(hours=1))
    assert read(second / build.BURNED) == read(first / build.BURNED)
    assert read(second / build.SUMMARY) == read(first / build.SUMMARY)
    assert status["sources"]["effis_dated"]["checked_at"] == "2026-10-03T11:28:00Z"


def test_effis_is_fetched_again_after_six_hours(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    second = tmp_path / "second"
    status = run(second, real_bodies(), previous=first, now=NOW + dt.timedelta(hours=7))
    assert status["sources"]["effis_dated"]["updated_at"] == "2026-10-03T18:28:00Z"


def test_a_much_poorer_effis_layer_is_not_trusted(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    raw = json.loads(fixture_bytes(f"{CAPTURE}/effis_burned_dated.extract.geojson.gz"))
    raw["features"] = raw["features"][:10]
    bodies = real_bodies()
    bodies[DATED_URL] = json.dumps(raw).encode()
    second = tmp_path / "second"
    status = run(second, bodies, previous=first, now=NOW + dt.timedelta(hours=7))
    entry = status["sources"]["effis_dated"]
    assert entry["ok"] is False
    assert entry["error"] == (
        "couche anormalement pauvre, non retenue : 10 surfaces contre 43 la fois précédente"
    )
    kinds = [f["properties"]["kind"] for f in read(second / build.BURNED)["features"]]
    assert kinds.count("dated") == 43


def test_statistics_outage_keeps_the_previous_summary(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    bodies = real_bodies()
    bodies[STATS_URL] = b"{}"
    second = tmp_path / "second"
    status = run(second, bodies, previous=first, now=NOW + dt.timedelta(hours=7))
    assert status["sources"]["effis_stats"]["ok"] is False
    assert read(second / build.SUMMARY) == read(first / build.SUMMARY)


def test_unreadable_previous_status_is_ignored(tmp_path: Path) -> None:
    previous = tmp_path / "previous"
    previous.mkdir()
    (previous / build.STATUS).write_text("not json", encoding="utf-8")
    status = run(tmp_path / "out", real_bodies(), previous=previous)
    assert all(entry["ok"] for entry in status["sources"].values())


# Previous files are read back from the deployed site: a broken or hostile one
# must never stop the build nor be deployed again.


def test_malformed_previous_burned_areas_are_ignored(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    (first / build.BURNED).write_text('{"type":"FeatureCollection","features":[null]}')
    second = tmp_path / "second"
    status = run(second, real_bodies(), previous=first, now=NOW + dt.timedelta(hours=1))
    # Within 6 hours EFFIS would not be fetched, but the previous layer is unusable.
    assert status["sources"]["effis_dated"]["updated_at"] == "2026-10-03T12:28:00Z"
    assert len(read(second / build.BURNED)["features"]) == 43 + 28


def test_a_previous_update_time_in_the_future_is_not_trusted(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    previous = read(first / build.STATUS)
    previous["sources"]["effis_stats"]["updated_at"] = "2099-01-01T00:00:00Z"
    (first / build.STATUS).write_text(json.dumps(previous))
    second = tmp_path / "second"
    status = run(second, real_bodies(), previous=first, now=NOW + dt.timedelta(hours=1))
    assert status["sources"]["effis_stats"]["updated_at"] == "2026-10-03T12:28:00Z"


def test_unreadable_previous_detections_are_not_carried(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    (first / build.DETECTIONS).write_text("<html>not data</html>")
    bodies = real_bodies()
    for feed in FIRMS_FEEDS:
        bodies[feed.url("7d")] = TimeoutError("timed out")
    second = tmp_path / "second"
    status = run(second, bodies, previous=first, now=NOW + dt.timedelta(minutes=30))
    assert build.DETECTIONS not in status["files"]
    assert build.FOYERS in status["files"]  # still a valid previous file


def test_carried_errors_stay_on_one_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "first"
    run(first, real_bodies())
    previous = read(first / build.STATUS)
    previous["sources"]["effis_nrt"].update(
        {"ok": False, "error": "x\n::error::injected", "count": "many", "label": "<b>"}
    )
    (first / build.STATUS).write_text(json.dumps(previous))
    second = tmp_path / "second"
    status = run(second, real_bodies(), previous=first, now=NOW + dt.timedelta(hours=1))
    entry = status["sources"]["effis_nrt"]
    assert entry["error"] == "x ::error::injected"
    assert entry["count"] is None
    assert entry["label"] == "EFFIS, surfaces brûlées récentes (NRT)"
    monkeypatch.setattr(build, "build", lambda out, previous, now: status)
    build.main([str(second)])
    assert all(not line.startswith("::") for line in capsys.readouterr().out.splitlines())


@pytest.mark.parametrize(
    ("exc", "reason"),
    [
        (HttpStatusError(204, "https://x"), "réponse HTTP 204 inattendue"),
        (
            urllib.error.HTTPError("https://x", 502, "Bad Gateway", Message(), None),
            "le serveur a répondu par une erreur (HTTP 502)",
        ),
        (ResponseTooLargeError("too big"), "réponse trop volumineuse"),
        (FetchError("refusing host"), "adresse refusée par les contrôles de sécurité"),
        (TimeoutError("timed out"), "délai de réponse dépassé"),
        (urllib.error.URLError(TimeoutError("timed out")), "délai de réponse dépassé"),
        (ConnectionResetError("reset"), "connexion interrompue"),
        (urllib.error.URLError(ConnectionResetError("reset")), "connexion interrompue"),
        (urllib.error.URLError(OSError(101, "Network is unreachable")), "serveur injoignable"),
        (OSError("connection refused"), "serveur injoignable"),
        (http.client.IncompleteRead(b"partial"), "connexion interrompue"),
        (http.client.RemoteDisconnected("closed"), "connexion interrompue"),
        (
            ssl.SSLCertVerificationError("certificate verify failed"),
            "connexion sécurisée impossible",
        ),
        (urllib.error.URLError(ssl.SSLError("handshake")), "connexion sécurisée impossible"),
        (http.client.BadStatusLine("garbage"), "réponse du serveur inattendue"),
        (csv.Error("field larger than field limit"), "réponse du serveur inattendue"),
        (RecursionError("maximum recursion depth exceeded"), "réponse du serveur inattendue"),
        (AttributeError("'int' object has no attribute 'get'"), "réponse du serveur inattendue"),
        (TypeError("list indices must be integers"), "réponse du serveur inattendue"),
        (KeyError("properties"), "réponse du serveur inattendue"),
        (ValueError("bad position"), "réponse du serveur inattendue"),
        (
            UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte"),
            "réponse du serveur inattendue",
        ),
        (RuntimeError("anything else"), "erreur inattendue"),
    ],
)
def test_outages_are_explained_in_french_without_technical_detail(
    exc: BaseException, reason: str
) -> None:
    assert build._public_error(exc) == reason


def test_network_unreachable_as_on_10_october(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The four FIRMS feeds failed with errno 101 on 10 October at 23:37 UTC."""
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    bodies = real_bodies()
    for feed in FIRMS_FEEDS:
        bodies[feed.url("7d")] = urllib.error.URLError(OSError(101, "Network is unreachable"))
    status = run(tmp_path, bodies)
    for feed in FIRMS_FEEDS:
        assert status["sources"][f"firms_{feed.id}"]["error"] == "serveur injoignable"
    assert capsys.readouterr().out.count("Network is unreachable") == len(FIRMS_FEEDS)


def test_in_github_actions_the_detail_is_a_notice_annotation(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[0].url("7d")] = OSError("100% lost\n::error::injected")
    run(tmp_path, bodies)
    lines = [line for line in capsys.readouterr().out.splitlines() if "firms_viirs_snpp" in line]
    assert lines == [
        "::notice title=Source firms_viirs_snpp (detail)::OSError: 100%25 lost ::error::injected"
    ]


def test_unexpected_answers_never_stop_the_build(tmp_path: Path) -> None:
    """A response cut short, an oversized CSV field or EFFIS JSON of another
    shape are recorded as outages; the other sources are still built."""
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[0].url("7d")] = http.client.IncompleteRead(b"latitude,longitude")
    header = fixture_bytes(f"{CAPTURE}/firms_{FIRMS_FEEDS[1].id}_24h.csv.gz").split(b"\n")[0]
    bodies[FIRMS_FEEDS[1].url("7d")] = header + b"\n" + b"x" * 200_000 + b"\n"
    bodies[DATED_URL] = json.dumps({"type": "FeatureCollection", "features": [1, 2]}).encode()
    bodies[STATS_URL] = b"[" * 100_000 + b"]" * 100_000
    status = run(tmp_path, bodies)
    sources = status["sources"]
    assert sources["firms_viirs_snpp"]["error"] == "connexion interrompue"
    assert sources["firms_viirs_noaa20"]["error"] == "réponse du serveur inattendue"
    assert sources["effis_dated"]["error"] == "réponse du serveur inattendue"
    assert sources["effis_stats"]["error"] == "réponse du serveur inattendue"
    assert sources["firms_viirs_noaa21"]["ok"] is True
    assert sources["effis_nrt"]["ok"] is True
    assert build.DETECTIONS in status["files"]
