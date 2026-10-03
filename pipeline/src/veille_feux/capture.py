"""Capture raw samples of the public data sources used by the map.

The samples are stored as test fixtures, so parsers are tested against what the
sources really return. The list of sources is fixed in code: nothing in the
workflow that runs this script can change a URL, which keeps the capture job
from being turned into a generic downloader.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from veille_feux.http import FETCH_ERRORS, Opener, default_opener, fetch
from veille_feux.sources import (
    EFFIS_DATED_LAYER,
    EFFIS_LICENCE,
    EFFIS_NRT_LAYER,
    FIRMS_FEEDS,
    FIRMS_LICENCE,
    GEO_API_LICENCE,
    effis_stats_url,
    effis_wfs_url,
    geo_api_commune_url,
)

MB = 1024 * 1024

# A fixed point (Aix-en-Provence) for a sample of the commune lookup used to
# name fire clusters. Any point inside France would do; a fixed one keeps the
# capture reproducible.
GEO_SAMPLE_POINT = (43.5297, 5.4474)


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    extension: str
    max_bytes: int
    timeout: float
    licence: str


def default_sources(today: dt.date) -> list[Source]:
    sources = [
        Source(f"firms_{feed.id}_24h", feed.url("24h"), "csv", 40 * MB, 120, FIRMS_LICENCE)
        for feed in FIRMS_FEEDS
    ]
    sources += [
        Source(
            "effis_burned_dated",
            effis_wfs_url(EFFIS_DATED_LAYER),
            "geojson",
            80 * MB,
            300,
            EFFIS_LICENCE,
        ),
        Source(
            "effis_burned_nrt",
            effis_wfs_url(EFFIS_NRT_LAYER),
            "geojson",
            80 * MB,
            300,
            EFFIS_LICENCE,
        ),
        Source(
            "effis_weekly_stats",
            effis_stats_url(today.year),
            "json",
            5 * MB,
            60,
            EFFIS_LICENCE,
        ),
        Source(
            "geo_api_commune_sample",
            geo_api_commune_url(*GEO_SAMPLE_POINT),
            "json",
            1 * MB,
            30,
            GEO_API_LICENCE,
        ),
    ]
    return sources


def capture(
    sources: Iterable[Source],
    dest: Path,
    now: dt.datetime,
    opener: Opener = default_opener,
) -> dict[str, Any]:
    """Fetch every source, write gzip files and return the manifest.

    A failing source is recorded in the manifest instead of stopping the run:
    an outage is itself useful information for the degraded-mode tests.
    """
    dest.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for source in sources:
        entry: dict[str, Any] = {
            "id": source.id,
            "url": source.url,
            "licence": source.licence,
            "fetched_at": now.isoformat(timespec="seconds"),
        }
        try:
            status, body = fetch(source.url, source.max_bytes, source.timeout, opener)
        except FETCH_ERRORS as exc:
            entry.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        else:
            file_name = f"{source.id}.{source.extension}.gz"
            # mtime=0 keeps the archive byte-identical for identical content.
            with gzip.GzipFile(dest / file_name, "wb", mtime=0) as handle:
                handle.write(body)
            entry.update(
                {
                    "ok": True,
                    "http_status": status,
                    "file": file_name,
                    "bytes": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                }
            )
        entries.append(entry)
    manifest = {"captured_at": now.isoformat(timespec="seconds"), "sources": entries}
    (dest / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dest", type=Path, help="directory that receives the samples")
    args = parser.parse_args(argv)
    now = dt.datetime.now(dt.UTC)
    manifest = capture(default_sources(now.date()), args.dest, now)
    for entry in manifest["sources"]:
        state = "ok" if entry["ok"] else f"FAILED ({entry['error']})"
        print(f"{entry['id']}: {state}")
    return 0 if any(entry["ok"] for entry in manifest["sources"]) else 1


if __name__ == "__main__":
    sys.exit(main())
