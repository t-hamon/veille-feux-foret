from __future__ import annotations

import datetime as dt
import gzip
import json
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import make_opener
from veille_feux import capture
from veille_feux.capture import Source
from veille_feux.http import check_url

NOW = dt.datetime(2026, 8, 1, 12, 0, tzinfo=dt.UTC)


def source(url: str, max_bytes: int = 1024, source_id: str = "s") -> Source:
    return Source(source_id, url, "csv", max_bytes, 5, "test licence")


FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv"


def test_default_sources_are_all_allowed() -> None:
    sources = capture.default_sources(NOW.date())
    assert len(sources) == 8
    assert len({s.id for s in sources}) == 8
    for s in sources:
        check_url(s.url)
    stats = next(s for s in sources if s.id == "effis_weekly_stats")
    assert "year=2026" in stats.url
    assert "country=FRA" in stats.url
    geo = next(s for s in sources if s.id == "geo_api_commune_sample")
    assert geo.url.startswith("https://geo.api.gouv.fr/communes?lat=43.52970&lon=5.44740")


def test_firms_ids_match_the_first_capture() -> None:
    # Fixtures taken from earlier captures are named after these ids.
    ids = [s.id for s in capture.default_sources(NOW.date())][:4]
    assert ids == [
        "firms_viirs_snpp_24h",
        "firms_viirs_noaa20_24h",
        "firms_viirs_noaa21_24h",
        "firms_modis_24h",
    ]


def test_capture_writes_gzip_and_manifest(tmp_path: Path) -> None:
    body = b"latitude,longitude\n43.5,5.4\n"
    manifest = capture.capture([source(FIRMS_URL)], tmp_path, NOW, make_opener({FIRMS_URL: body}))
    entry = manifest["sources"][0]
    assert entry["ok"] is True
    assert entry["bytes"] == len(body)
    with gzip.open(tmp_path / entry["file"]) as handle:
        assert handle.read() == body
    on_disk = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert on_disk == manifest


def test_capture_is_reproducible(tmp_path: Path) -> None:
    opener = make_opener({FIRMS_URL: b"same content"})
    capture.capture([source(FIRMS_URL)], tmp_path / "a", NOW, opener)
    capture.capture([source(FIRMS_URL)], tmp_path / "b", NOW, opener)
    assert (tmp_path / "a" / "s.csv.gz").read_bytes() == (tmp_path / "b" / "s.csv.gz").read_bytes()


def test_failing_source_is_recorded_not_fatal(tmp_path: Path) -> None:
    other = "https://api2.effis.emergency.copernicus.eu/stats"
    opener = make_opener({FIRMS_URL: OSError("connection reset"), other: b"{}"})
    manifest = capture.capture(
        [source(FIRMS_URL, source_id="down"), source(other, source_id="up")],
        tmp_path,
        NOW,
        opener,
    )
    down, up = manifest["sources"]
    assert down["ok"] is False and "connection reset" in down["error"]
    assert up["ok"] is True
    assert not (tmp_path / "down.csv.gz").exists()


def test_oversized_source_is_recorded_as_failure(tmp_path: Path) -> None:
    opener = make_opener({FIRMS_URL: b"x" * 5000})
    manifest = capture.capture([source(FIRMS_URL, max_bytes=100)], tmp_path, NOW, opener)
    assert manifest["sources"][0]["ok"] is False
    assert "larger than" in manifest["sources"][0]["error"]


def test_main_exit_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Path] = []

    def fake_capture(sources: Any, dest: Path, now: dt.datetime) -> dict[str, Any]:
        calls.append(dest)
        return {"sources": [{"id": "a", "ok": False, "error": "down"}]}

    monkeypatch.setattr(capture, "capture", fake_capture)
    assert capture.main([str(tmp_path)]) == 1

    def fake_capture_ok(sources: Any, dest: Path, now: dt.datetime) -> dict[str, Any]:
        return {"sources": [{"id": "a", "ok": True}]}

    monkeypatch.setattr(capture, "capture", fake_capture_ok)
    assert capture.main([str(tmp_path)]) == 0
    assert calls == [tmp_path]
