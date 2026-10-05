from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import fixture_bytes, make_opener
from veille_feux import build
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


def test_one_feed_down_is_reported_and_others_still_count(tmp_path: Path) -> None:
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[1].url("7d")] = OSError("connection reset")
    status = run(tmp_path, bodies)
    feed = status["sources"]["firms_viirs_noaa20"]
    assert feed["ok"] is False
    assert "connection reset" in feed["error"]
    assert feed["updated_at"] is None
    assert len(read(tmp_path / build.DETECTIONS)["features"]) == 46 - 22


def test_html_error_page_instead_of_csv(tmp_path: Path) -> None:
    bodies = real_bodies()
    bodies[FIRMS_FEEDS[0].url("7d")] = b"<html>Service Unavailable</html>"
    status = run(tmp_path, bodies)
    assert "missing columns" in status["sources"]["firms_viirs_snpp"]["error"]


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
    assert "not trusted" in entry["error"]
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
