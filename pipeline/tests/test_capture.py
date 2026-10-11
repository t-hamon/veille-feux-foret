from __future__ import annotations

import datetime as dt
import gzip
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from tests.helpers import make_opener
from veille_feux import capture
from veille_feux.capture import Source
from veille_feux.http import check_url
from veille_feux.sources import OPEN_METEO_META, WEATHER_VARIABLES, open_meteo_url

NOW = dt.datetime(2026, 8, 1, 12, 0, tzinfo=dt.UTC)


def source(url: str, max_bytes: int = 1024, source_id: str = "s") -> Source:
    return Source(source_id, url, "csv", max_bytes, 5, "test licence")


FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv"


def test_default_sources_are_all_allowed() -> None:
    sources = capture.default_sources(NOW.date())
    assert len(sources) == 12
    assert len({s.id for s in sources}) == 12
    for s in sources:
        check_url(s.url)
    stats = next(s for s in sources if s.id == "effis_weekly_stats")
    assert "year=2026" in stats.url
    assert "country=FRA" in stats.url
    geo = next(s for s in sources if s.id == "geo_api_commune_sample")
    assert geo.url.startswith("https://geo.api.gouv.fr/communes?lat=43.52970&lon=5.44740")


def test_open_meteo_sources() -> None:
    sources = {s.id: s for s in capture.default_sources(NOW.date())}
    assert sources["open_meteo_meta"].url == OPEN_METEO_META
    grid = [sources[f"open_meteo_wind_grid_{n}"] for n in (1, 2)]
    points = sum(len(parse_qs(urlsplit(s.url).query)["latitude"][0].split(",")) for s in grid)
    assert points == 415
    weather = parse_qs(urlsplit(sources["open_meteo_weather_sample"].url).query)
    assert weather["latitude"] == ["43.5297,44.923"]
    assert weather["cell_selection"] == ["land"]
    assert weather["hourly"][0].startswith("temperature_2m,")
    for s in [*grid, sources["open_meteo_meta"], sources["open_meteo_weather_sample"]]:
        assert s.licence.startswith("CC BY 4.0 (Open-Meteo.com")
        assert s.extension == "json"


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


FIRES_NOW = dt.datetime(2026, 10, 11, 17, 21, 23, tzinfo=dt.UTC)
FIRMS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_ti5,frp,daynight\n"
)


def write_firms(dest: Path) -> None:
    rows = [
        f"{lat + k * 0.001:.4f},{lon + k * 0.001:.4f},330.1,0.4,0.4,2026-10-11,{1000 + k},"
        "N,nominal,2.0NRT,290.2,5.5,D\n"
        for lat, lon, count in ((43.5297, 5.4474, 4), (44.923, -0.997, 3))
        for k in range(count)
    ]
    dest.mkdir(parents=True, exist_ok=True)
    with gzip.open(dest / "firms_viirs_snpp_24h.csv.gz", "wb") as handle:
        handle.write((FIRMS_HEADER + "".join(rows)).encode())
    # Unreadable files of other feeds are skipped, as the build would record an outage.
    (dest / "firms_viirs_noaa20_24h.csv.gz").write_bytes(b"not gzip")
    (dest / "firms_modis_24h.csv.gz").write_bytes(gzip.compress(b"latitude\n")[:-4])


def test_fire_weather_is_asked_where_the_build_would(tmp_path: Path) -> None:
    write_firms(tmp_path)
    extra = capture.fire_weather_sources(tmp_path, FIRES_NOW)
    assert [s.id for s in extra] == ["open_meteo_fire_weather_1"]
    assert extra[0].url == open_meteo_url([(43.53, 5.45), (44.92, -1.0)], WEATHER_VARIABLES, "land")
    check_url(extra[0].url)
    # A day later, the clusters are no longer recent: nothing to ask for.
    assert capture.fire_weather_sources(tmp_path, FIRES_NOW + dt.timedelta(days=1)) == []
    assert capture.fire_weather_sources(tmp_path / "empty", FIRES_NOW) == []


def test_main_adds_the_fire_weather_to_the_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[list[str], int]] = []

    def fake_capture(
        sources: Any, dest: Path, now: dt.datetime, entries: Any = None
    ) -> dict[str, Any]:
        ids = [s.id for s in sources]
        calls.append((ids, len(entries or [])))
        if not entries:
            write_firms(dest)
        return {"sources": [*(entries or []), *({"id": i, "ok": True} for i in ids)]}

    monkeypatch.setattr(capture, "capture", fake_capture)
    assert capture.main([str(tmp_path)], FIRES_NOW + dt.timedelta(microseconds=456)) == 0
    assert len(calls) == 2
    assert calls[1] == (["open_meteo_fire_weather_1"], 12)
