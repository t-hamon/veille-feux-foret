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
- vent.json: wind of the AROME France HD model on a grid over France,
  fetched again from Open-Meteo at each new run of the model (every 3 hours);
- meteo-foyers.json: weather of the same model at each fire cluster with a
  detection in the last 24 hours;
- stations-vent.json: wind measured at the Météo-France stations over the last
  7 days, handed over by the job that fetches it (``--stations``), since it
  alone holds the application ID of the Météo-France API;
- etat.json: state of every source, read by the map's status panel.

``veille-feux-stations`` is that job: it fetches the stations and writes
stations-vent.json and etat-stations.json, the state of its source.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import http.client
import json
import os
import shutil
import ssl
import sys
import time
import urllib.error
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from veille_feux import effis, firms, foyers, geo, meteo, meteofrance, stations
from veille_feux.http import (
    FETCH_ERRORS,
    FetchError,
    HttpStatusError,
    Opener,
    ResponseTooLargeError,
    default_opener,
    fetch,
)
from veille_feux.sources import (
    EFFIS_DATED_LAYER,
    EFFIS_NRT_LAYER,
    FIRMS_FEEDS,
    FRANCE_BBOX,
    OPEN_METEO_META,
    WEATHER_VARIABLES,
    WIND_GRID_STEP,
    WIND_VARIABLES,
    FirmsFeed,
    chunks,
    effis_stats_url,
    effis_wfs_url,
    open_meteo_url,
)

MB = 1024 * 1024
WINDOW = dt.timedelta(days=7)
SLOW_REFRESH = dt.timedelta(hours=6)  # EFFIS republishes once or twice a day
KEEP_RATIO = 0.5  # a layer half as rich as the previous one is not trusted
# Seconds per network operation. In the worst case (every source at its limit)
# the build stays around 11 minutes, within the deployment job.
FIRMS_TIMEOUT = 90
EFFIS_TIMEOUT = 120
OPEN_METEO_TIMEOUT = 60
COORD_DECIMALS = 4
# New weather is asked for at most this many fire clusters per build. With the
# 415 points of the wind grid, a build stays under the 600 calls a minute of
# the free Open-Meteo API; the clusters left out are asked for at the next build.
MAX_FIRE_POINTS = 150
# Without a known model run, data fetched less than one run interval ago is kept.
RUN_INTERVAL = dt.timedelta(hours=3)
# Largest distance, in degrees on each axis, between a point asked and the model
# cell answered: the grid asks for the nearest cell (0.01 degree mesh), a fire
# for a land cell of similar elevation, which may be a little further.
GRID_OFFSET = 0.02
FIRE_OFFSET = 0.1

DETECTIONS = "detections.geojson"
FOYERS = "foyers.geojson"
OUTLINES = "foyers-emprises.geojson"
BURNED = "surfaces-brulees.geojson"
SUMMARY = "bilan.json"
WIND = "vent.json"
FIRE_WEATHER = "meteo-foyers.json"
STATIONS = "stations-vent.json"
STATUS = "etat.json"
# State of the stations source, written by the job that fetches them.
STATIONS_STATUS = "etat-stations.json"
STATIONS_SOURCE = "meteofrance_stations"
STATIONS_TIMEOUT = 60
# Below the 100 requests a minute of the subscription, token included.
STATIONS_MIN_INTERVAL = 0.65

# A source that answers something unexpected is recorded as down; it never
# stops the build, so the other sources are still updated.
FIRMS_ERRORS: tuple[type[BaseException], ...] = (
    *FETCH_ERRORS,
    firms.FirmsFormatError,
    UnicodeDecodeError,
    csv.Error,
)
EFFIS_ERRORS: tuple[type[BaseException], ...] = (
    *FETCH_ERRORS,
    effis.EffisFormatError,
    ValueError,
    # JSON nested too deeply, or valid JSON of another shape than expected.
    RecursionError,
    TypeError,
    AttributeError,
    KeyError,
)
STATIONS_ERRORS: tuple[type[BaseException], ...] = (
    *FETCH_ERRORS,
    meteofrance.ObservationFormatError,
    UnicodeDecodeError,
    csv.Error,
    ValueError,
    RecursionError,
    TypeError,
    AttributeError,
    KeyError,
)
METEO_ERRORS: tuple[type[BaseException], ...] = (
    *FETCH_ERRORS,
    meteo.MeteoFormatError,
    ValueError,
    RecursionError,
    TypeError,
    AttributeError,
    KeyError,
)

SOURCE_LABELS = {
    **{f"firms_{feed.id}": f"NASA FIRMS, {feed.label}" for feed in FIRMS_FEEDS},
    "effis_dated": "EFFIS, surfaces brûlées datées",
    "effis_nrt": "EFFIS, surfaces brûlées récentes (NRT)",
    "effis_stats": "EFFIS, statistiques hebdomadaires",
    "open_meteo_wind": "Open-Meteo, vent du modèle AROME HD de Météo-France (grille)",
    "open_meteo_fires": "Open-Meteo, météo du modèle AROME HD de Météo-France aux foyers",
    STATIONS_SOURCE: "Météo-France, vent mesuré aux stations",
}
WEATHER_SOURCES = ("open_meteo_wind", "open_meteo_fires")


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


def _log_detail(source_id: str, detail: str) -> None:
    """Technical detail of an outage, for the maintainer.

    In GitHub Actions it is written as a notice annotation, readable in the run
    summary without opening the log (percent signs escaped as the workflow
    command format requires); elsewhere as a plain line.
    """
    text = _one_line(detail)
    _notice(f"Source {source_id} (detail)", text, plain_prefix=source_id)


def _notice(title: str, text: str, plain_prefix: str | None = None) -> None:
    """A notice annotation in GitHub Actions, a plain line elsewhere."""
    text = _one_line(text)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::notice title={title}::{text.replace('%', '%25')}")
    else:
        print(f"{plain_prefix or title}: {text}")


def _public_error(exc: BaseException) -> str:
    """Reason of a source outage, in French, as shown on the page.

    The technical detail (exception type and message) only goes to the log of
    the workflow: visitors get a short, stable reason instead.
    """
    if isinstance(exc, HttpStatusError):
        return f"réponse HTTP {exc.status} inattendue"
    if isinstance(exc, urllib.error.HTTPError):
        return f"le serveur a répondu par une erreur (HTTP {exc.code})"
    if isinstance(exc, ResponseTooLargeError):
        return "réponse trop volumineuse"
    if isinstance(exc, meteofrance.TokenError):
        return "accès à l'API refusé ou impossible"
    if isinstance(exc, FetchError):
        return "adresse refusée par les contrôles de sécurité"
    cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(cause, TimeoutError):
        return "délai de réponse dépassé"
    if isinstance(
        cause,
        (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, http.client.IncompleteRead),
    ):
        return "connexion interrompue"
    if isinstance(cause, ssl.SSLError):
        return "connexion sécurisée impossible"
    if isinstance(exc, (urllib.error.URLError, OSError)):
        return "serveur injoignable"
    if isinstance(
        exc,
        (
            ValueError,
            http.client.HTTPException,
            csv.Error,
            RecursionError,
            TypeError,
            AttributeError,
            KeyError,
        ),
    ):
        return "réponse du serveur inattendue"
    return "erreur inattendue"


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
    # Open-Meteo calls of this build: one per location asked (pricing page).
    open_meteo_calls: int = 0

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

    def fail(self, source_id: str, exc: BaseException) -> None:
        """Record an outage: short reason in the status file, detail in the log."""
        _log_detail(source_id, _short_error(exc))
        self.record(source_id, False, error=_public_error(exc))

    def carry(self, source_id: str, kept: tuple[str | None, int] | None = None) -> None:
        """Keep the previous state of a source that was not fetched this run.

        `kept` gives the fetch time and the count of the data file kept from
        the previous build. When the previous status file could not be read,
        the state is taken from that file instead: its data is still current,
        and the source must not show as down for no reason (23 October 2026).
        """
        previous = self.previous_source(source_id)
        if not previous and kept is not None:
            fetched_at, count = kept
            self.status[source_id] = {
                "label": SOURCE_LABELS[source_id],
                "ok": True,
                "checked_at": fetched_at,
                "updated_at": fetched_at,
                "count": count,
                "error": None,
            }
            return
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

    def get_open_meteo(self, url: str, points: int) -> Any:
        """JSON answer of Open-Meteo for ``points`` locations, counted as calls."""
        self.open_meteo_calls += points
        return json.loads(self.get(url, 16 * MB, OPEN_METEO_TIMEOUT))

    def previous_document(self, name: str) -> dict[str, Any] | None:
        if self.previous is None or not _usable_previous(self.previous / name):
            return None
        document = _read_json(self.previous / name)
        return document if isinstance(document, dict) else None


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


def france_detections(
    text: str,
    feed: FirmsFeed,
    area: geo.FranceArea,
    sites: tuple[geo.IndustrialSite, ...],
    now: dt.datetime,
) -> list[firms.Detection]:
    """Detections of one FIRMS file kept for the map: in France, in the window."""
    parsed, _ = firms.parse_csv(text, feed.id, feed.sensor)
    kept, _ = firms.select_france(parsed, area, sites)
    return [d for d in kept if now - d.acquired <= WINDOW]


def clusters_of(
    detections: list[firms.Detection], now: dt.datetime
) -> tuple[list[firms.Detection], list[foyers.Foyer], dict[int, int]]:
    """Detections in a stable order, their clusters and the cluster of each one."""
    ordered = sorted(detections, key=lambda d: (d.acquired, d.lat, d.lon, d.source))
    clusters, assignment = foyers.cluster(ordered, now)
    return ordered, clusters, assignment


def build_fires(
    ctx: Context, area: geo.FranceArea, sites: tuple[geo.IndustrialSite, ...]
) -> list[foyers.Foyer] | None:
    """Write the fire files; return the clusters, or None if the previous files were kept."""
    found: list[firms.Detection] = []
    answered = 0
    for feed in FIRMS_FEEDS:
        source_id = f"firms_{feed.id}"
        try:
            text = ctx.get(feed.url("7d"), 60 * MB, FIRMS_TIMEOUT).decode("utf-8")
            recent = france_detections(text, feed, area, sites, ctx.now)
        except FIRMS_ERRORS as exc:
            ctx.fail(source_id, exc)
            continue
        found.extend(recent)
        answered += 1
        ctx.record(source_id, True, count=len(recent))

    if answered == 0:
        for name in (DETECTIONS, FOYERS, OUTLINES):
            ctx.copy_previous(name)
        return None

    detections, clusters, assignment = clusters_of(found, ctx.now)
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
    return clusters


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
        ctx.fail(source_id, exc)
        return previous
    if previous and len(features) < len(previous) * KEEP_RATIO:
        _log_detail(source_id, f"{len(features)} areas against {len(previous)} before, not trusted")
        ctx.record(
            source_id,
            False,
            error=(
                f"couche anormalement pauvre, non retenue : {len(features)} surfaces "
                f"contre {len(previous)} la fois précédente"
            ),
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
        ctx.fail(source_id, exc)
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


# ------------------------------------------------------------------ weather


def _model_run(ctx: Context) -> meteo.ModelRun | None:
    """Last run of the model, from the Open-Meteo metadata (not counted as calls)."""
    try:
        document = json.loads(ctx.get(OPEN_METEO_META, 1 * MB, OPEN_METEO_TIMEOUT))
        return meteo.parse_run(document, ctx.now)
    except METEO_ERRORS as exc:
        _log_detail("open_meteo_meta", _short_error(exc))
        return None


def _keeps_previous_wind(
    ctx: Context, previous: dict[str, Any] | None, run: dt.datetime | None, points: int
) -> bool:
    """True when the previous wind file is as recent as what Open-Meteo would give."""
    if previous is None or previous.get("step") != WIND_GRID_STEP:
        return False
    if not isinstance(previous.get("points"), list) or len(previous["points"]) != points:
        return False
    if run is not None:
        return bool(previous.get("run") == _iso(run))
    # Run unknown (metadata unavailable, or new run not yet on every server).
    fetched = meteo.parse_iso(previous.get("fetched_at"))
    return fetched is not None and fetched <= ctx.now and ctx.now - fetched < RUN_INTERVAL


def _past(ctx: Context, value: Any) -> dt.datetime | None:
    """A time read from a previous file, if valid and not in the future."""
    moment = meteo.parse_iso(value)
    return moment if moment is not None and moment <= ctx.now else None


def build_wind(ctx: Context, run: dt.datetime | None) -> None:
    source_id = "open_meteo_wind"
    grid = geo.france_grid(FRANCE_BBOX, WIND_GRID_STEP)
    previous = ctx.previous_document(WIND)
    if _keeps_previous_wind(ctx, previous, run, len(grid)) and ctx.copy_previous(WIND):
        fetched = _past(ctx, previous.get("fetched_at")) if previous is not None else None
        ctx.carry(source_id, kept=(_iso(fetched) if fetched else None, len(grid)))
        return
    series: list[meteo.PointSeries] = []
    dropped = 0
    try:
        for points in chunks(grid):
            url = open_meteo_url(points, WIND_VARIABLES, "nearest")
            document = ctx.get_open_meteo(url, len(points))
            part, part_dropped = meteo.parse_points(
                document, points, WIND_VARIABLES, ctx.now, GRID_OFFSET
            )
            series.extend(part)
            dropped += part_dropped
        series = meteo.trim(series)
    except METEO_ERRORS as exc:
        ctx.fail(source_id, exc)
        ctx.copy_previous(WIND)
        return
    if dropped:
        _log_detail(source_id, f"{dropped} values out of bounds dropped")
    _write_json(ctx.out / WIND, meteo.wind_document(series, WIND_GRID_STEP, run, ctx.now))
    ctx.record(source_id, True, count=len(series))


def _reusable(entry: dict[str, Any], run: dt.datetime | None, now: dt.datetime) -> bool:
    if run is not None:
        return bool(entry.get("run") == _iso(run))
    fetched = meteo.parse_iso(entry.get("fetched_at"))
    return fetched is not None and fetched <= now and now - fetched < RUN_INTERVAL


def build_fire_weather(
    ctx: Context, clusters: list[foyers.Foyer] | None, run: dt.datetime | None
) -> None:
    """Weather at each recent fire cluster, matched by position, never by number.

    Cluster numbers change from one build to the next; the weather of the
    previous file is reused for a cluster at the same rounded position when it
    comes from the current model run, and asked for again otherwise.
    """
    source_id = "open_meteo_fires"
    if clusters is None:
        # No fire data this time: the previous clusters and their weather are kept.
        if ctx.copy_previous(FIRE_WEATHER):
            kept = meteo.previous_fire_entries(ctx.previous_document(FIRE_WEATHER))
            times = [_past(ctx, e.get("fetched_at")) for e in kept.values()]
            latest = max((t for t in times if t is not None), default=None)
            ctx.carry(source_id, kept=(_iso(latest) if latest else None, len(kept)))
        else:
            ctx.carry(source_id)
        return
    fires = meteo.recent_fires(clusters, ctx.now)
    previous = meteo.previous_fire_entries(ctx.previous_document(FIRE_WEATHER))
    known = {point: e for point, e in previous.items() if _reusable(e, run, ctx.now)}
    wanted: list[tuple[float, float]] = []
    for foyer in fires:
        point = meteo.fire_point(foyer)
        if point not in known and point not in wanted:
            wanted.append(point)
    asked, left_out = wanted[:MAX_FIRE_POINTS], wanted[MAX_FIRE_POINTS:]
    fetched: dict[tuple[float, float], meteo.PointSeries] = {}
    error: BaseException | None = None
    dropped = 0
    try:
        for points in chunks(asked):
            url = open_meteo_url(points, WEATHER_VARIABLES, "land")
            document = ctx.get_open_meteo(url, len(points))
            part, part_dropped = meteo.parse_points(
                document, points, WEATHER_VARIABLES, ctx.now, FIRE_OFFSET
            )
            fetched.update(zip(points, meteo.trim(part), strict=True))
            dropped += part_dropped
    except METEO_ERRORS as exc:
        error = exc
        fetched = {}
    entries: list[dict[str, Any]] = []
    missing: list[int] = []
    for foyer in fires:
        point = meteo.fire_point(foyer)
        if point in fetched:
            entries.append(meteo.fire_entry(foyer, fetched[point], run, ctx.now))
        elif point in previous:
            # Same run, or an older one when the place could not be asked for
            # (outage, call limit): each entry keeps its own run and fetch time.
            entries.append({**previous[point], "id": foyer.id})
        else:
            missing.append(foyer.id)
    _write_json(
        ctx.out / FIRE_WEATHER,
        {
            "model": "AROME France HD (Météo-France), via Open-Meteo",
            "run": _iso(run) if run is not None else None,
            "fires": entries,
            "missing": missing,
        },
    )
    if error is not None:
        ctx.fail(source_id, error)
        return
    if dropped:
        _log_detail(source_id, f"{dropped} values out of bounds dropped")
    if left_out:
        _log_detail(source_id, f"{len(left_out)} places left for the next build (call limit)")
    ctx.record(source_id, True, count=len(entries))


def build_weather(ctx: Context, clusters: list[foyers.Foyer] | None) -> None:
    model_run = _model_run(ctx)
    run = model_run.initialised if model_run and model_run.usable(ctx.now) else None
    build_wind(ctx, run)
    build_fire_weather(ctx, clusters, run)
    if ctx.open_meteo_calls:
        _notice("Open-Meteo", f"{ctx.open_meteo_calls} calls in this build")


# ----------------------------------------------------------------- stations


class Pacer:
    """Keeps at least ``interval`` seconds between two requests."""

    def __init__(
        self,
        interval: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.interval, self.clock, self.sleep = interval, clock, sleep
        self.last: float | None = None

    def wait(self) -> None:
        if self.last is not None:
            delay = self.interval - (self.clock() - self.last)
            if delay > 0:
                self.sleep(delay)
        self.last = self.clock()


def _previous_stations(ctx: Context, name: str = STATIONS) -> stations.Stored | None:
    return stations.read_document(ctx.previous_document(name), FRANCE_BBOX, ctx.now)


def fetch_stations(ctx: Context, application_id: str, pacer: Pacer) -> None:
    """Fetch the hours the file lacks and write stations-vent.json.

    On an outage the previous file is kept and the source marked down. Some
    packages may fail while others answer: what came is kept, the hours missing
    are asked for again at the next run.
    """
    source_id = STATIONS_SOURCE
    stored = _previous_stations(ctx) or stations.Stored()
    wanted = stations.plan(stored, ctx.now)

    def get(url: str, max_bytes: int) -> bytes:
        pacer.wait()
        _, body = fetch(
            url, max_bytes, STATIONS_TIMEOUT, ctx.opener, headers=meteofrance.bearer(token)
        )
        return body

    try:
        if not application_id:
            raise meteofrance.TokenError(f"{meteofrance.APPLICATION_ID_VARIABLE} is not set")
        pacer.wait()
        token = meteofrance.obtain_token(application_id, ctx.opener, STATIONS_TIMEOUT)
    except STATIONS_ERRORS as exc:
        ctx.fail(source_id, exc)
        ctx.copy_previous(STATIONS)
        return
    if wanted.backfill:
        urls = [meteofrance.department_url(d) for d in stations.DEPARTMENTS]
    else:
        urls = [
            meteofrance.hourly_url(dt.datetime.fromtimestamp(hour, dt.UTC)) for hour in wanted.hours
        ]
    found: list[meteofrance.Observation] = []
    dropped = failed = 0
    last_error: BaseException | None = None
    for url in urls:
        try:
            part, part_dropped = meteofrance.parse_observations(
                json.loads(get(url, 32 * MB)), FRANCE_BBOX
            )
        except STATIONS_ERRORS as exc:
            failed += 1
            last_error = exc
            continue
        found.extend(part)
        dropped += part_dropped
    if failed == len(urls) and last_error is not None:
        ctx.fail(source_id, last_error)
        ctx.copy_previous(STATIONS)
        return
    infos: dict[str, meteofrance.StationInfo] = {}
    if wanted.backfill or any(obs.station not in stored.infos for obs in found):
        try:
            text = get(meteofrance.stations_url(), 8 * MB).decode("utf-8")
            infos = meteofrance.parse_station_list(text)
        except STATIONS_ERRORS as exc:
            _log_detail(source_id, f"list of the stations: {_short_error(exc)}")
    merged = stations.merge(stored, found, infos, ctx.now, wanted.backfill)
    _write_json(ctx.out / STATIONS, stations.document(merged))
    kind = "department packages" if wanted.backfill else "hourly packages"
    detail = f"{len(urls) - failed} of {len(urls)} {kind} read"
    if dropped:
        detail += f", {dropped} values or records dropped"
    _notice("Météo-France", detail)
    ctx.record(source_id, True, count=len(merged.series))


def stations_main(argv: list[str] | None = None, now: dt.datetime | None = None) -> int:
    """veille-feux-stations: the job that alone receives the application ID."""
    parser = argparse.ArgumentParser(description="Fetch the wind measured at the stations.")
    parser.add_argument("out", type=Path, help="directory that receives the files")
    parser.add_argument("--previous", type=Path, help="data files of the previous deployment")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    previous_status = _read_json(args.previous / STATUS if args.previous else None)
    ctx = Context(
        out=args.out,
        previous=args.previous,
        now=now or dt.datetime.now(dt.UTC).replace(microsecond=0),
        opener=default_opener,
        status={},
        previous_status=previous_status if isinstance(previous_status, dict) else {},
    )
    application_id = os.environ.get(meteofrance.APPLICATION_ID_VARIABLE, "")
    fetch_stations(ctx, application_id, Pacer(STATIONS_MIN_INTERVAL))
    _write_json(args.out / STATIONS_STATUS, {"sources": ctx.status})
    entry = ctx.status[STATIONS_SOURCE]
    state = "ok" if entry["ok"] else f"FAILED ({_one_line(entry['error'])})"
    print(f"{STATIONS_SOURCE}: {state}")
    return 0


def _handed_status(raw: Any, now: dt.datetime) -> dict[str, Any] | None:
    """State of the stations source written by their job, checked field by field."""
    sources = raw.get("sources") if isinstance(raw, dict) else None
    entry = sources.get(STATIONS_SOURCE) if isinstance(sources, dict) else None
    if not isinstance(entry, dict) or not isinstance(entry.get("ok"), bool):
        return None
    checked = _parse_iso(entry.get("checked_at"))
    if checked is None or checked > now:
        return None
    updated = _parse_iso(entry.get("updated_at"))
    count = entry.get("count")
    error = entry.get("error")
    return {
        "label": SOURCE_LABELS[STATIONS_SOURCE],
        "ok": entry["ok"],
        "checked_at": _iso(checked),
        "updated_at": _iso(updated) if updated and updated <= now else None,
        "count": count if isinstance(count, int) and not isinstance(count, bool) else None,
        "error": _one_line(error) if isinstance(error, str) else None,
    }


def merge_stations(ctx: Context, handed: Path) -> None:
    """Take over the file and state written by the stations job.

    Both are checked in full before use. When that job did not run or wrote
    nothing usable, the file of the previous deployment is kept and the state
    of the source carried over, as for a source not fetched this run.
    """
    status = _handed_status(_read_json(handed / STATIONS_STATUS), ctx.now)
    stored = stations.read_document(_read_json(handed / STATIONS), FRANCE_BBOX, ctx.now)
    if status is not None and stored is not None:
        _write_json(ctx.out / STATIONS, stations.document(stored))
        ctx.status[STATIONS_SOURCE] = status
        return
    if status is not None and not status["ok"] and ctx.copy_previous(STATIONS):
        ctx.status[STATIONS_SOURCE] = status
        return
    previous = _previous_stations(ctx)
    if previous is not None:
        _write_json(ctx.out / STATIONS, stations.document(previous))
        fetched = previous.fetched_at
        ctx.carry(STATIONS_SOURCE, kept=(_iso(fetched) if fetched else None, len(previous.series)))
    else:
        ctx.carry(STATIONS_SOURCE)


# ---------------------------------------------------------------------- main


def build(
    out: Path,
    previous: Path | None,
    now: dt.datetime,
    opener: Opener = default_opener,
    with_weather: bool = True,
    handed_stations: Path | None = None,
) -> dict[str, Any]:
    """Build every data file. ``with_weather=False`` leaves out the Open-Meteo
    sources, as before lot 2: the web test data captured then has none.
    ``handed_stations`` is the directory written by the stations job; without
    it, the stations source is left out."""
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
    clusters = build_fires(ctx, area, geo.load_industrial_sites())
    build_burned(ctx, area)
    build_summary(ctx)
    if with_weather:
        build_weather(ctx, clusters)
    if handed_stations is not None:
        merge_stations(ctx, handed_stations)
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
    parser.add_argument(
        "--stations", type=Path, help="directory written by veille-feux-stations, if any"
    )
    args = parser.parse_args(argv)
    status = build(args.out, args.previous, dt.datetime.now(dt.UTC), handed_stations=args.stations)
    for source_id, entry in status["sources"].items():
        state = "ok" if entry["ok"] else f"FAILED ({_one_line(entry['error'])})"
        print(f"{source_id}: {state}")
    # The map can be deployed as long as fire detections exist, fresh or carried over.
    return 0 if DETECTIONS in status["files"] else 1


if __name__ == "__main__":
    sys.exit(main())
