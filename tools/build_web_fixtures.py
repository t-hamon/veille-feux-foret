"""Build the data files used by the web tests, with the real pipeline.

The build command (veille_feux.build) runs on the pipeline test fixtures of the
3 October 2026 capture, at the time of that capture, with the captured
responses served in place of the sources. The 24-hour FIRMS files are served
for the 7-day URLs, the only ones the build reads; EFFIS layers are the reduced
extracts of the pipeline fixtures. Degraded scenarios are produced the same
way, by making some sources fail: the files and etat.json are then exactly
what the pipeline writes in that situation, nothing is edited by hand.

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
from pathlib import Path
from typing import Any

from veille_feux import build, capture

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "pipeline" / "tests" / "fixtures" / "20261003T1128Z"
CAPTURED_AT = dt.datetime(2026, 10, 3, 11, 28, tzinfo=dt.UTC)

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

# Scenario name: capture source ids that fail with a network error.
SCENARIOS: dict[str, frozenset[str]] = {
    "complet": frozenset(),
    "firms-partiel": frozenset({"firms_viirs_noaa21_24h"}),
    "firms-en-panne": frozenset(i for i in FILES if i.startswith("firms_")),
    "effis-en-panne": frozenset(i for i in FILES if i.startswith("effis_")),
}


class _Response(io.BytesIO):
    status = 200


def _bodies(failing: frozenset[str]) -> dict[str, bytes | None]:
    bodies: dict[str, bytes | None] = {}
    for source in capture.default_sources(CAPTURED_AT.date()):
        name = FILES.get(source.id)
        if name is None:
            continue
        body = None if source.id in failing else gzip.decompress((FIXTURES / name).read_bytes())
        bodies[source.url] = body
        if source.id.startswith("firms_"):
            bodies[source.url.replace("_24h.csv", "_7d.csv")] = body
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
    for name, failing in SCENARIOS.items():
        target = out / name
        if target.exists():
            shutil.rmtree(target)
        build.build(target, None, CAPTURED_AT, _opener(_bodies(failing)))
        print(f"{name}: {', '.join(sorted(p.name for p in target.iterdir()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
