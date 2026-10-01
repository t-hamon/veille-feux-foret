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
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

USER_AGENT = "veille-feux-foret/0.1 (+https://github.com/t-hamon/veille-feux-foret)"
CHUNK_SIZE = 64 * 1024

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"
EFFIS_STATS = "https://api2.effis.emergency.copernicus.eu/statistics/v2/effis/weekly"
# west, south, east, north: metropolitan France and Corsica with a small margin.
FRANCE_BBOX = (-5.5, 41.0, 10.0, 51.5)

ALLOWED_HOSTS = frozenset(
    {
        "firms.modaps.eosdis.nasa.gov",
        "maps.effis.emergency.copernicus.eu",
        "api2.effis.emergency.copernicus.eu",
    }
)


class CaptureError(Exception):
    """Raised when a source cannot be captured safely."""


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    extension: str
    max_bytes: int
    timeout: float
    licence: str


def _effis_wfs_url(typename: str) -> str:
    west, south, east, north = FRANCE_BBOX
    query = urllib.parse.urlencode(
        {
            "service": "WFS",
            "version": "1.0.0",
            "request": "GetFeature",
            "typename": f"ms:{typename}",
            "outputformat": "geojson",
            "bbox": f"{west},{south},{east},{north}",
        }
    )
    return f"{EFFIS_WFS}?{query}"


def default_sources(today: dt.date) -> list[Source]:
    firms_licence = "NASA open data policy, citation and LANCE disclaimer required"
    effis_licence = "CC BY 4.0 (EFFIS, European Commission JRC)"
    mb = 1024 * 1024
    firms_feeds = {
        "firms_viirs_snpp_24h": "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv",
        "firms_viirs_noaa20_24h": "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv",
        "firms_viirs_noaa21_24h": "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv",
        "firms_modis_24h": "modis-c6.1/csv/MODIS_C6_1_Europe_24h.csv",
    }
    sources = [
        Source(name, f"{FIRMS_BASE}/{path}", "csv", 40 * mb, 120, firms_licence)
        for name, path in firms_feeds.items()
    ]
    sources += [
        Source(
            "effis_burned_dated",
            _effis_wfs_url("modis.ba.poly.season"),
            "geojson",
            80 * mb,
            300,
            effis_licence,
        ),
        Source(
            "effis_burned_nrt",
            _effis_wfs_url("effis.nrt.ba.poly"),
            "geojson",
            80 * mb,
            300,
            effis_licence,
        ),
        Source(
            "effis_weekly_stats",
            f"{EFFIS_STATS}?{urllib.parse.urlencode({'country': 'FRA', 'year': today.year})}",
            "json",
            5 * mb,
            60,
            effis_licence,
        ),
    ]
    return sources


def check_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        raise CaptureError(f"refusing non-https URL: {url}")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise CaptureError(f"refusing host outside the allow list: {parsed.hostname}")


class _AllowListRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only towards hosts of the allow list."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


Opener = Callable[[urllib.request.Request, float], Any]


def _default_opener(request: urllib.request.Request, timeout: float) -> Any:
    opener = urllib.request.build_opener(_AllowListRedirectHandler())
    # The URL has been checked against the https allow list before this call.
    return opener.open(request, timeout=timeout)  # nosec B310


def read_limited(stream: IO[bytes], max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise CaptureError(f"response larger than {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def fetch(source: Source, opener: Opener = _default_opener) -> tuple[int, bytes]:
    check_url(source.url)
    # check_url() has just restricted the URL to https and the allow list.
    request = urllib.request.Request(  # noqa: S310
        source.url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
    )
    with opener(request, source.timeout) as response:
        status = int(getattr(response, "status", 200))
        return status, read_limited(response, source.max_bytes)


def capture(
    sources: Iterable[Source],
    dest: Path,
    now: dt.datetime,
    opener: Opener = _default_opener,
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
            status, body = fetch(source, opener)
        except (CaptureError, urllib.error.URLError, TimeoutError, OSError) as exc:
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
