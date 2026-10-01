from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from veille_feux import capture
from veille_feux.capture import CaptureError, Source

NOW = dt.datetime(2026, 8, 1, 12, 0, tzinfo=dt.UTC)


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status


def make_opener(bodies: dict[str, bytes | Exception]) -> capture.Opener:
    def opener(request: urllib.request.Request, timeout: float) -> Any:
        result = bodies[request.full_url]
        if isinstance(result, Exception):
            raise result
        return FakeResponse(result)

    return opener


def source(url: str, max_bytes: int = 1024, source_id: str = "s") -> Source:
    return Source(source_id, url, "csv", max_bytes, 5, "test licence")


FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv"


def test_default_sources_are_all_allowed() -> None:
    sources = capture.default_sources(NOW.date())
    assert len(sources) == 7
    assert len({s.id for s in sources}) == 7
    for s in sources:
        capture.check_url(s.url)
    stats = next(s for s in sources if s.id == "effis_weekly_stats")
    assert "year=2026" in stats.url
    assert "country=FRA" in stats.url


@pytest.mark.parametrize(
    "url",
    [
        "http://firms.modaps.eosdis.nasa.gov/data.csv",
        "https://example.org/data.csv",
        "https://firms.modaps.eosdis.nasa.gov.evil.example/data.csv",
        "file:///etc/passwd",
        "https://169.254.169.254/latest/meta-data/",
    ],
)
def test_check_url_rejects_unsafe_targets(url: str) -> None:
    with pytest.raises(CaptureError):
        capture.check_url(url)


def test_read_limited_stops_at_the_cap() -> None:
    with pytest.raises(CaptureError):
        capture.read_limited(io.BytesIO(b"x" * 2000), max_bytes=1000)
    assert capture.read_limited(io.BytesIO(b"abc"), max_bytes=3) == b"abc"


def test_redirect_to_foreign_host_is_refused() -> None:
    handler = capture._AllowListRedirectHandler()
    request = urllib.request.Request(FIRMS_URL)
    with pytest.raises(CaptureError):
        handler.redirect_request(
            request, io.BytesIO(), 302, "Found", {}, "https://example.org/elsewhere"
        )


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
