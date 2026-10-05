"""Build the data files of the map from the public sources.

Run every 30 minutes by the deployment workflow. Each product is rebuilt from
fresh data when its sources answer; when they do not, the file of the previous
deployment is carried over and marked stale, so an outage never empties the
map and never passes old data off as new.

Products written to the output directory:
- detections.geojson: FIRMS detections in France over the last 7 days;
- foyers.geojson and foyers-emprises.geojson: clusters and their outlines;
- surfaces-brulees.geojson: EFFIS burnt areas, refreshed every 6 hours;
- bilan.json: EFFIS season summary for France, refreshed every 6 hours;
- etat.json: state of every source, read by the map's status panel.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from veille_feux import effis, firms, foyers, geo
from veille_feux.http import FETCH_ERRORS, Opener, default_opener, fetch
from veille_feux.sources import (
    EFFIS_DATED_LAYER,
    EFFIS_NRT_LAYER,
    FIRMS_FEEDS,
    effis_stats_url,
    effis_wfs_url,
)

MB = 1024 * 1024
WINDOW = dt.timedelta(days=7)
SLOW_REFRESH = dt.timedelta(hours=6)  # EFFIS republishes once or twice a day
KEEP_RATIO = 0.5  # a layer half as rich as the previous one is not trusted
# Seconds per network operation. In the worst case (every source at its limit)
# the build stays around 11 minutes, within the deployment job.
FIRMS_TIMEOUT = 90
EFFIS_TIMEOUT = 120
COORD_DECIMALS = 4

DETECTIONS = "detections.geojson"
FOYERS = "foyers.geojson"
OUTLINES = "foyers-emprises.geojson"
BURNED = "surfaces-brulees.geojson"
SUMMARY = "bilan.json"
STATUS = "etat.json"

FIRMS_ERRORS: tuple[type[BaseException], ...] = (
    *FETCH_ERRORS,
    firms.FirmsFormatError,
    UnicodeDecodeError,
)
EFFIS_ERRORS: tuple[type[BaseException], ...] = (*FETCH_ERRORS, effis.EffisFormatError, ValueError)

SOURCE_LABELS = {
    **{f"firms_{feed.id}": f"NASA FIRMS, {feed.label}" for feed in FIRMS_FEEDS},
    "effis_dated": "EFFIS, surfaces brûlées datées",
    "effis_nrt": "EFFIS, surfaces brûlées récentes (NRT)",
    "effis_stats": "EFFIS, statistiques hebdomadaires",
}


def _iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(raw: Any) -> dt.datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        return dt.datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC)
    except ValueError:
        return None


def _write_json(path: Path, document: Any) -> None:
    path.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def _read_json(path: Path | None) -> Any:
    if path is None or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _short_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


def _one_line(value: Any, limit: int = 300) -> str:
    """Text safe to print in a workflow log: one line, no control character."""
    return "".join(" " if ord(c) < 32 or ord(c) == 127 else c for c in str(value))[:limit]


# Previous data files are read back from the deployed site. Only files that are
# what the build writes are reused: a JSON object, and for GeoJSON files a
# feature collection whose features are objects. Anything else is ignored.
GEOJSON_FILES = (DETECTIONS, FOYERS, OUTLINES, BURNED)


def _usable_previous(path: Path) -> bool:
    document = _read_json(path)
    if not isinstance(document, dict):
        return False
    if path.name in GEOJSON_FILES:
        features = document.get("features")
        return (
            document.get("type") == "FeatureCollection"
            and isinstance(features, list)
            and all(isinstance(f, dict) for f in features)
        )
    return True


@dataclass
class Context:
    out: Path
    previous: Path | None
    now: dt.datetime
    opener: Opener
    status: dict[str, dict[str, Any]]
    previous_status: dict[str, Any]

    def previous_source(self, source_id: str) -> dict[str, Any]:
        sources = self.previous_status.get("sources")
        entry = sources.get(source_id) if isinstance(sources, dict) else None
        if not isinstance(entry, dict):
            return {}
        # Only the fields the build writes, in their own types.
        clean: dict[str, Any] = {}
        if isinstance(entry.get("ok"), bool):
            clean["ok"] = entry["ok"]
        for key in ("checked_at", "updated_at"):
            moment = _parse_iso(entry.get(key))
            if moment is not None and moment <= self.now:
                clean[key] = _iso(moment)
        count = entry.get("count")
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            clean["count"] = count
        if isinstance(entry.get("error"), str):
            clean["error"] = _one_line(entry["error"])
        return clean

    def record(
        self, source_id: str, ok: bool, count: int | None = None, error: str | None = None
    ) -> None:
        previous = self.previous_source(source_id)
        self.status[source_id] = {
            "label": SOURCE_LABELS[source_id],
            "ok": ok,
            "checked_at": _iso(self.now),
            "updated_at": _iso(self.now) if ok else previous.get("updated_at"),
            "count": count if ok else previous.get("count"),
            "error": None if ok else error,
        }

    def carry(self, source_id: str) -> None:
        """Keep the previous state of a source that was not fetched this run."""
        previous = self.previous_source(source_id)
        self.status[source_id] = {
            "label": SOURCE_LABELS[source_id],
            "ok": previous.get("ok", False),
            "checked_at": previous.get("checked_at"),
            "updated_at": previous.get("updated_at"),
            "count": previous.get("count"),
            "error": previous.get("error"),
        }

    def copy_previous(self, name: str) -> bool:
        if self.previous is None or not _usable_previous(self.previous / name):
            return False
        shutil.copyfile(self.previous / name, self.out / name)
        return True

    def get(self, url: str, max_bytes: int, timeout: float) -> bytes:
        _, body = fetch(url, max_bytes, timeout, self.opener)
        return body


# --------------------------------------------------------------------- fires


def _detection_feature(d: firms.Detection, foyer_id: int | None) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [round(d.lon, COORD_DECIMALS), round(d.lat, COORD_DECIMALS)],
        },
        "properties": {
            "t": int(d.acquired.timestamp()),
            "src": d.source,
            "frp": d.frp_mw,
            "conf": d.confidence_class,
            "conf_pct": d.confidence_pct,
            "dn": d.daynight,
            "foyer": foyer_id,
        },
    }


def _foyer_feature(f: foyers.Foyer) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [f.lon, f.lat]},
        "properties": {
            "id": f.id,
            "detections": f.detections,
            "detections_24h": f.detections_24h,
            "first": _iso(f.first),
            "last": _iso(f.last),
            "max_frp": f.max_frp_mw,
            "estimated_area_ha": f.estimated_area_ha,
            "active": f.active,
        },
    }


def _outline_feature(f: foyers.Foyer) -> dict[str, Any] | None:
    if f.hull is None:
        return None
    ring = [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in f.hull]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"id": f.id},
    }


def build_fires(ctx: Context, area: geo.FranceArea, sites: tuple[geo.IndustrialSite, ...]) -> None:
    detections: list[firms.Detection] = []
    answered = 0
    for feed in FIRMS_FEEDS:
        source_id = f"firms_{feed.id}"
        try:
            text = ctx.get(feed.url("7d"), 60 * MB, FIRMS_TIMEOUT).decode("utf-8")
            parsed, _ = firms.parse_csv(text, feed.id, feed.sensor)
        except FIRMS_ERRORS as exc:
            ctx.record(source_id, False, error=_short_error(exc))
            continue
        kept, _ = firms.select_france(parsed, area, sites)
        recent = [d for d in kept if ctx.now - d.acquired <= WINDOW]
        detections.extend(recent)
        answered += 1
        ctx.record(source_id, True, count=len(recent))

    if answered == 0:
        for name in (DETECTIONS, FOYERS, OUTLINES):
            ctx.copy_previous(name)
        return

    detections.sort(key=lambda d: (d.acquired, d.lat, d.lon, d.source))
    clusters, assignment = foyers.cluster(detections, ctx.now)
    _write_json(
        ctx.out / DETECTIONS,
        {
            "type": "FeatureCollection",
            "features": [
                _detection_feature(d, assignment.get(i)) for i, d in enumerate(detections)
            ],
        },
    )
    _write_json(
        ctx.out / FOYERS,
        {"type": "FeatureCollection", "features": [_foyer_feature(f) for f in clusters]},
    )
    outlines = [o for o in (_outline_feature(f) for f in clusters) if o is not None]
    _write_json(ctx.out / OUTLINES, {"type": "FeatureCollection", "features": outlines})


# ---------------------------------------------------------- slow EFFIS layers


def _is_fresh(ctx: Context, source_id: str) -> bool:
    # previous_source() drops times in the future, which would stay "fresh".
    updated = _parse_iso(ctx.previous_source(source_id).get("updated_at"))
    return updated is not None and ctx.now - updated < SLOW_REFRESH


def _previous_burned(ctx: Context, kind: str) -> list[dict[str, Any]]:
    if ctx.previous is None or not _usable_previous(ctx.previous / BURNED):
        return []
    features = _read_json(ctx.previous / BURNED)["features"]
    return [
        f
        for f in features
        if isinstance(f.get("properties"), dict) and f["properties"].get("kind") == kind
    ]


def _burned_layer(
    ctx: Context,
    source_id: str,
    kind: str,
    load: Callable[[Any], tuple[list[dict[str, Any]], effis.BurnReport]],
    url: str,
) -> list[dict[str, Any]]:
    previous = _previous_burned(ctx, kind)
    if previous and _is_fresh(ctx, source_id):
        ctx.carry(source_id)
        return previous
    try:
        features, _ = load(json.loads(ctx.get(url, 120 * MB, EFFIS_TIMEOUT)))
    except EFFIS_ERRORS as exc:
        ctx.record(source_id, False, error=_short_error(exc))
        return previous
    if previous and len(features) < len(previous) * KEEP_RATIO:
        ctx.record(
            source_id,
            False,
            error=f"{len(features)} areas against {len(previous)} before, result not trusted",
        )
        return previous
    ctx.record(source_id, True, count=len(features))
    return features


def build_burned(ctx: Context, area: geo.FranceArea) -> None:
    dated = _burned_layer(
        ctx, "effis_dated", "dated", effis.dated_areas, effis_wfs_url(EFFIS_DATED_LAYER)
    )
    nrt = _burned_layer(
        ctx,
        "effis_nrt",
        "nrt",
        lambda document: effis.nrt_areas(document, area),
        effis_wfs_url(EFFIS_NRT_LAYER),
    )
    if dated or nrt:
        _write_json(ctx.out / BURNED, {"type": "FeatureCollection", "features": dated + nrt})


def build_summary(ctx: Context) -> None:
    source_id = "effis_stats"
    if _is_fresh(ctx, source_id) and ctx.copy_previous(SUMMARY):
        ctx.carry(source_id)
        return
    try:
        document = json.loads(ctx.get(effis_stats_url(ctx.now.year), 5 * MB, 60))
        summary = effis.national_summary(document, ctx.now.date())
    except EFFIS_ERRORS as exc:
        ctx.record(source_id, False, error=_short_error(exc))
        ctx.copy_previous(SUMMARY)
        return
    ctx.record(source_id, True, count=summary.weeks_counted)
    _write_json(
        ctx.out / SUMMARY,
        {
            "year": summary.year,
            "burned_ha": summary.burned_ha,
            "average_ha": summary.average_ha,
            "events": summary.events,
            "weeks_counted": summary.weeks_counted,
            "last_week_date": summary.last_week_date,
        },
    )


# ---------------------------------------------------------------------- main


def build(
    out: Path,
    previous: Path | None,
    now: dt.datetime,
    opener: Opener = default_opener,
) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    previous_status = _read_json(previous / STATUS if previous else None)
    ctx = Context(
        out=out,
        previous=previous,
        now=now,
        opener=opener,
        status={},
        previous_status=previous_status if isinstance(previous_status, dict) else {},
    )
    area = geo.load_france()
    build_fires(ctx, area, geo.load_industrial_sites())
    build_burned(ctx, area)
    build_summary(ctx)
    status = {
        "generated_at": _iso(now),
        "window_hours": int(WINDOW.total_seconds() // 3600),
        "sources": ctx.status,
        "files": sorted(p.name for p in out.iterdir() if p.is_file()),
    }
    _write_json(out / STATUS, status)
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="directory that receives the data files")
    parser.add_argument(
        "--previous", type=Path, help="data files of the previous deployment, if any"
    )
    args = parser.parse_args(argv)
    status = build(args.out, args.previous, dt.datetime.now(dt.UTC))
    for source_id, entry in status["sources"].items():
        state = "ok" if entry["ok"] else f"FAILED ({_one_line(entry['error'])})"
        print(f"{source_id}: {state}")
    # The map can be deployed as long as fire detections exist, fresh or carried over.
    return 0 if DETECTIONS in status["files"] else 1


if __name__ == "__main__":
    sys.exit(main())
