"""Build the data files used by the web tests, with the real pipeline.

The build command (veille_feux.build) runs on the pipeline test fixtures of a
capture, at the time of that capture, with the captured responses served in
place of the sources. The 24-hour FIRMS files are served for the 7-day URLs,
the only ones the build reads; EFFIS layers are the reduced extracts of the
pipeline fixtures. Degraded scenarios are produced the same way, by making some
sources fail: the files and etat.json are then exactly what the pipeline writes
in that situation, nothing is edited by hand.

Most scenarios use the capture of 3 October 2026, which predates the Open-Meteo
sources of lot 2: the build runs without them (with_weather=False), as it did
then. The "vent" scenario uses the capture of 12 October 2026, the first with
the weather at the captured clusters, and runs every source.

Running the script again gives the same files.

Usage: python tools/build_web_fixtures.py OUT_DIR
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import shutil
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from veille_feux import build, capture

ROOT = Path(__file__).resolve().parent.parent
PIPELINE_FIXTURES = ROOT / "pipeline" / "tests" / "fixtures"

# Files of the pipeline fixtures, by capture source id.
FILES = {
    "firms_viirs_snpp_24h": "firms_viirs_snpp_24h.csv.gz",
    "firms_viirs_noaa20_24h": "firms_viirs_noaa20_24h.csv.gz",
    "firms_viirs_noaa21_24h": "firms_viirs_noaa21_24h.csv.gz",
    "firms_modis_24h": "firms_modis_24h.csv.gz",
    "effis_burned_dated": "effis_burned_dated.extract.geojson.gz",
    "effis_burned_nrt": "effis_burned_nrt.extract.geojson.gz",
    "effis_weekly_stats": "effis_weekly_stats.json.gz",
}
WEATHER_FILES = {
    "open_meteo_meta": "open_meteo_meta.json.gz",
    "open_meteo_wind_grid_1": "open_meteo_wind_grid_1.json.gz",
    "open_meteo_wind_grid_2": "open_meteo_wind_grid_2.json.gz",
}


@dataclass(frozen=True)
class Capture:
    folder: str
    captured_at: dt.datetime
    with_weather: bool


OCTOBER_3 = Capture("20261003T1128Z", dt.datetime(2026, 10, 3, 11, 28, tzinfo=dt.UTC), False)
OCTOBER_12 = Capture("20261012T0043Z", dt.datetime(2026, 10, 12, 0, 43, 9, tzinfo=dt.UTC), True)
# Kept for the tools and tests that name the first capture.
FIXTURES = PIPELINE_FIXTURES / OCTOBER_3.folder
CAPTURED_AT = OCTOBER_3.captured_at

# Scenario name: capture, and capture source ids that fail with a network error.
SCENARIOS: dict[str, tuple[Capture, frozenset[str]]] = {
    "complet": (OCTOBER_3, frozenset()),
    "firms-partiel": (OCTOBER_3, frozenset({"firms_viirs_noaa21_24h"})),
    "firms-en-panne": (OCTOBER_3, frozenset(i for i in FILES if i.startswith("firms_"))),
    "effis-en-panne": (OCTOBER_3, frozenset(i for i in FILES if i.startswith("effis_"))),
    "vent": (OCTOBER_12, frozenset()),
}


class _Response(io.BytesIO):
    status = 200


def _bodies(source: Capture, failing: frozenset[str]) -> dict[str, bytes | None]:
    folder = PIPELINE_FIXTURES / source.folder
    names = {**FILES, **(WEATHER_FILES if source.with_weather else {})}
    sources = capture.default_sources(source.captured_at.date())
    if source.with_weather:
        sources += capture.fire_weather_sources(folder, source.captured_at)
        names.update({s.id: f"{s.id}.json.gz" for s in sources if "fire_weather" in s.id})
    bodies: dict[str, bytes | None] = {}
    for item in sources:
        name = names.get(item.id)
        if name is None:
            continue
        body = None if item.id in failing else gzip.decompress((folder / name).read_bytes())
        bodies[item.url] = body
        if item.id.startswith("firms_"):
            bodies[item.url.replace("_24h.csv", "_7d.csv")] = body
    return bodies


def _opener(bodies: dict[str, bytes | None]) -> Callable[[urllib.request.Request, float], Any]:
    def opener(request: urllib.request.Request, timeout: float) -> Any:
        body = bodies.get(request.full_url)
        if body is None:
            raise urllib.error.URLError("source unavailable in this scenario")
        return _Response(body)

    return opener


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    out = Path(argv[1])
    for name, (source, failing) in SCENARIOS.items():
        target = out / name
        if target.exists():
            shutil.rmtree(target)
        build.build(
            target,
            None,
            source.captured_at,
            _opener(_bodies(source, failing)),
            with_weather=source.with_weather,
        )
        print(f"{name}: {', '.join(sorted(p.name for p in target.iterdir()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
