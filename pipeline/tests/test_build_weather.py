"""Build of the wind and weather files, on the Open-Meteo answers of 11 October 2026.

Fire detections are written for the test: three at Aix-en-Provence, three in
the Landes forest, the places of the weather sample of the capture. The other
sources answer with the 3 October capture; only the weather is checked here.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import fixture_bytes, make_opener
from veille_feux import build, geo, sources
from veille_feux.sources import (
    EFFIS_DATED_LAYER,
    EFFIS_NRT_LAYER,
    FIRMS_FEEDS,
    OPEN_METEO_META,
    WEATHER_VARIABLES,
    effis_stats_url,
    effis_wfs_url,
    open_meteo_url,
    open_meteo_wind_urls,
)

CAPTURE = "20261011T1721Z"
NOW = dt.datetime(2026, 10, 11, 17, 21, 23, tzinfo=dt.UTC)
GRID = geo.france_grid(sources.FRANCE_BBOX, sources.WIND_GRID_STEP)
WIND_URLS = open_meteo_wind_urls(GRID)
FIRES_URL = open_meteo_url([(43.53, 5.45), (44.92, -1.0)], WEATHER_VARIABLES, "land")
AIX_URL = open_meteo_url([(43.53, 5.45)], WEATHER_VARIABLES, "land")
LANDES_URL = open_meteo_url([(44.92, -1.0)], WEATHER_VARIABLES, "land")
HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_ti5,frp,daynight\n"
)


AIX = (43.5297, 5.4474, 4)
LANDES = (44.923, -0.997, 3)


def firms_csv(*places: tuple[float, float, int]) -> bytes:
    """Detections a few hundred metres apart, one cluster per place."""
    rows = []
    for lat, lon, count in places or (AIX, LANDES):
        for k in range(count):
            rows.append(
                f"{lat + k * 0.001:.4f},{lon + k * 0.001:.4f},330.1,0.4,0.4,"
                f"2026-10-11,{1000 + k},N,nominal,2.0NRT,290.2,5.5,D\n"
            )
    return (HEADER + "".join(rows)).encode()


@pytest.fixture(autouse=True)
def plain_log(monkeypatch: pytest.MonkeyPatch) -> None:
    """Log lines as printed outside GitHub Actions, wherever the tests run.

    Under GitHub Actions the build writes them as notice annotations; the one
    test of that format sets the variable itself.
    """
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)


def weather(name: str) -> bytes:
    return fixture_bytes(f"{CAPTURE}/{name}")


def bodies() -> dict[str, bytes | Exception]:
    answers: dict[str, bytes | Exception] = {
        feed.url("7d"): firms_csv() if feed.id == "viirs_snpp" else HEADER.encode()
        for feed in FIRMS_FEEDS
    }
    old = "20261003T1128Z"
    answers[effis_wfs_url(EFFIS_DATED_LAYER)] = fixture_bytes(
        f"{old}/effis_burned_dated.extract.geojson.gz"
    )
    answers[effis_wfs_url(EFFIS_NRT_LAYER)] = fixture_bytes(
        f"{old}/effis_burned_nrt.extract.geojson.gz"
    )
    answers[effis_stats_url(2026)] = fixture_bytes(f"{old}/effis_weekly_stats.json.gz")
    answers[OPEN_METEO_META] = weather("open_meteo_meta.json.gz")
    answers[WIND_URLS[0]] = weather("open_meteo_wind_grid_1.json.gz")
    answers[WIND_URLS[1]] = weather("open_meteo_wind_grid_2.json.gz")
    answers[FIRES_URL] = weather("open_meteo_weather_sample.json.gz")
    return answers


def single(index: int) -> bytes:
    """Answer for one of the two places of the weather sample."""
    point = json.loads(weather("open_meteo_weather_sample.json.gz"))[index]
    point.pop("location_id", None)
    return json.dumps(point).encode()


def run(
    out: Path,
    answers: dict[str, bytes | Exception],
    previous: Path | None = None,
    now: dt.datetime = NOW,
) -> dict[str, Any]:
    return build.build(out, previous, now, make_opener(answers))


def read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def run_recorded(
    out: Path, answers: dict[str, bytes | Exception], previous: Path | None, now: dt.datetime
) -> tuple[dict[str, Any], list[str]]:
    """Build and return the Open-Meteo forecasts asked for, metadata left out."""
    base = make_opener(answers)
    calls: list[str] = []

    def opener(request: urllib.request.Request, timeout: float) -> Any:
        if request.full_url.startswith(sources.OPEN_METEO_FORECAST):
            calls.append(request.full_url)
        return base(request, timeout)

    return build.build(out, previous, now, opener), calls


# ----------------------------------------------------------------- first build


def test_wind_and_fire_weather_are_written(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    status = run(tmp_path, bodies())
    assert status["sources"]["open_meteo_wind"]["ok"] is True
    assert status["sources"]["open_meteo_wind"]["count"] == 415
    assert status["sources"]["open_meteo_fires"]["ok"] is True
    assert status["sources"]["open_meteo_fires"]["count"] == 2
    assert {build.WIND, build.FIRE_WEATHER} <= set(status["files"])

    wind = read(tmp_path / build.WIND)
    assert wind["run"] == "2026-10-11T12:00:00Z"
    assert wind["fetched_at"] == "2026-10-11T17:21:23Z"
    assert (wind["start"], wind["hours"], wind["step"]) == (1791133200, 215, 0.5)
    assert len(wind["points"]) == len(wind["speed"]) == 415
    assert all(len(row) == 215 for row in wind["gusts"])

    fires = read(tmp_path / build.FIRE_WEATHER)
    assert fires["run"] == "2026-10-11T12:00:00Z"
    assert fires["missing"] == []
    aix, landes = fires["fires"]
    assert (aix["id"], aix["point"], aix["cell"]) == (1, [43.53, 5.45], [43.53, 5.45])
    assert (landes["id"], landes["point"]) == (2, [44.92, -1.0])
    assert aix["run"] == "2026-10-11T12:00:00Z"
    assert aix["temperature"][0] == 24.6
    assert "Open-Meteo: 417 calls in this build" in capsys.readouterr().out


def test_the_wind_file_stays_small(tmp_path: Path) -> None:
    run(tmp_path, bodies())
    size = (tmp_path / build.WIND).stat().st_size
    # 415 points x 215 hours x 3 values, written as integers: about 820 kB.
    assert size < 900_000


# ------------------------------------------------------- following builds


def test_same_run_nothing_is_asked_again(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    later = NOW + dt.timedelta(minutes=30)
    status, calls = run_recorded(tmp_path / "second", bodies(), first, later)
    assert calls == []
    assert (tmp_path / "second" / build.WIND).read_bytes() == (first / build.WIND).read_bytes()
    wind = status["sources"]["open_meteo_wind"]
    assert wind["ok"] is True and wind["updated_at"] == "2026-10-11T17:21:23Z"
    fires = read(tmp_path / "second" / build.FIRE_WEATHER)
    assert [f["id"] for f in fires["fires"]] == [1, 2]
    assert fires["fires"][0]["fetched_at"] == "2026-10-11T17:21:23Z"


def test_a_new_fire_alone_is_asked_for(tmp_path: Path) -> None:
    first = tmp_path / "first"
    answers = bodies()
    # First build: only the Aix fire exists.
    answers[firms_url()] = firms_csv(AIX)
    answers[AIX_URL] = single(0)
    run(first, answers)
    assert [f["point"] for f in read(first / build.FIRE_WEATHER)["fires"]] == [[43.53, 5.45]]

    answers = bodies()
    answers[LANDES_URL] = single(1)
    status, calls = run_recorded(tmp_path / "second", answers, first, NOW)
    assert calls == [LANDES_URL]
    fires = read(tmp_path / "second" / build.FIRE_WEATHER)
    assert [(f["id"], f["point"]) for f in fires["fires"]] == [
        (1, [43.53, 5.45]),
        (2, [44.92, -1.0]),
    ]
    assert status["sources"]["open_meteo_fires"]["count"] == 2


def firms_url() -> str:
    return next(f.url("7d") for f in FIRMS_FEEDS if f.id == "viirs_snpp")


def newer_run(hours: int, available_minutes_ago: int, now: dt.datetime) -> bytes:
    meta = json.loads(weather("open_meteo_meta.json.gz"))
    meta["last_run_initialisation_time"] += hours * 3600
    meta["data_end_time"] += hours * 3600
    meta["last_run_availability_time"] = int(now.timestamp()) - available_minutes_ago * 60
    return json.dumps(meta).encode()


def test_a_new_run_is_fetched_again(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    answers[OPEN_METEO_META] = newer_run(3, 20, NOW)
    status, calls = run_recorded(tmp_path / "second", answers, first, NOW)
    assert sorted(calls) == sorted([*WIND_URLS, FIRES_URL])
    assert read(tmp_path / "second" / build.WIND)["run"] == "2026-10-11T15:00:00Z"
    assert status["sources"]["open_meteo_fires"]["ok"] is True


def test_a_run_announced_less_than_10_minutes_ago_waits(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    later = NOW + dt.timedelta(minutes=5)
    answers[OPEN_METEO_META] = newer_run(3, 5, later)
    _, calls = run_recorded(tmp_path / "second", answers, first, later)
    assert calls == []
    assert read(tmp_path / "second" / build.WIND)["run"] == "2026-10-11T12:00:00Z"


def test_without_metadata_recent_files_are_kept(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    answers[OPEN_METEO_META] = OSError("down")
    _, calls = run_recorded(tmp_path / "second", answers, first, NOW + dt.timedelta(hours=2))
    assert calls == []
    assert "open_meteo_meta: OSError: down" in capsys.readouterr().out


def test_without_metadata_old_files_are_fetched_again_without_a_run(tmp_path: Path) -> None:
    answers = bodies()
    answers[OPEN_METEO_META] = OSError("down")
    status = run(tmp_path, answers)
    assert status["sources"]["open_meteo_wind"]["ok"] is True
    assert read(tmp_path / build.WIND)["run"] is None
    fires = read(tmp_path / build.FIRE_WEATHER)
    assert fires["run"] is None
    assert fires["fires"][0]["run"] is None


# ---------------------------------------------------------------- outages


def test_wind_outage_keeps_the_previous_file(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    answers[OPEN_METEO_META] = newer_run(3, 20, NOW)
    answers[WIND_URLS[1]] = OSError("connection reset")
    status = run(tmp_path / "second", answers, first)
    wind = status["sources"]["open_meteo_wind"]
    assert wind["ok"] is False
    assert wind["error"] == "serveur injoignable"
    assert wind["updated_at"] == "2026-10-11T17:21:23Z"
    assert (tmp_path / "second" / build.WIND).read_bytes() == (first / build.WIND).read_bytes()


def test_wind_outage_without_previous_file(tmp_path: Path) -> None:
    answers = bodies()
    answers[WIND_URLS[0]] = b"<html>busy</html>"
    status = run(tmp_path, answers)
    assert status["sources"]["open_meteo_wind"]["ok"] is False
    assert status["sources"]["open_meteo_wind"]["error"] == "réponse du serveur inattendue"
    assert build.WIND not in status["files"]
    assert status["sources"]["open_meteo_fires"]["ok"] is True


def test_fire_weather_outage_keeps_what_is_known_of_each_place(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    answers[OPEN_METEO_META] = newer_run(3, 20, NOW)
    answers[FIRES_URL] = OSError("down")
    status = run(tmp_path / "second", answers, first)
    assert status["sources"]["open_meteo_fires"]["ok"] is False
    fires = read(tmp_path / "second" / build.FIRE_WEATHER)
    # Weather of the previous run, kept for the same places, with its own run.
    assert [f["run"] for f in fires["fires"]] == ["2026-10-11T12:00:00Z"] * 2
    assert fires["run"] == "2026-10-11T15:00:00Z"
    assert status["sources"]["open_meteo_wind"]["ok"] is True


def test_no_fire_data_keeps_the_previous_weather(tmp_path: Path) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    answers = bodies()
    for feed in FIRMS_FEEDS:
        answers[feed.url("7d")] = OSError("down")
    shutil.copy(first / build.FOYERS, tmp_path / "keep.geojson")
    status = run(tmp_path / "second", answers, first)
    assert status["sources"]["open_meteo_fires"]["ok"] is True
    second = tmp_path / "second"
    assert (second / build.FIRE_WEATHER).read_bytes() == (first / build.FIRE_WEATHER).read_bytes()
    assert (second / build.FOYERS).read_bytes() == (tmp_path / "keep.geojson").read_bytes()


def test_no_recent_fire_means_no_request(tmp_path: Path) -> None:
    answers = bodies()
    answers[firms_url()] = HEADER.encode()
    status, calls = run_recorded(tmp_path, answers, None, NOW)
    assert calls == WIND_URLS
    assert status["sources"]["open_meteo_fires"]["ok"] is True
    assert status["sources"]["open_meteo_fires"]["count"] == 0
    assert read(tmp_path / build.FIRE_WEATHER)["fires"] == []


def test_call_limit_leaves_places_for_the_next_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(build, "MAX_FIRE_POINTS", 1)
    answers = bodies()
    answers[AIX_URL] = single(0)
    status = run(tmp_path, answers)
    fires = read(tmp_path / build.FIRE_WEATHER)
    assert [f["id"] for f in fires["fires"]] == [1]
    assert fires["missing"] == [2]
    assert status["sources"]["open_meteo_fires"]["count"] == 1
    assert "1 places left for the next build (call limit)" in capsys.readouterr().out


def test_values_out_of_bounds_are_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    answers = bodies()
    document = json.loads(weather("open_meteo_wind_grid_1.json.gz"))
    document[0]["hourly"]["wind_speed_10m"][0] = 900
    answers[WIND_URLS[0]] = json.dumps(document).encode()
    run(tmp_path, answers)
    assert read(tmp_path / build.WIND)["speed"][0][0] is None
    assert "open_meteo_wind: 1 values out of bounds dropped" in capsys.readouterr().out


@pytest.mark.parametrize(
    "previous_wind",
    [
        {"run": "2026-10-11T12:00:00Z", "step": 0.25, "points": []},
        {"run": "2026-10-11T12:00:00Z", "step": 0.5, "points": "x"},
        {"run": "2026-10-11T12:00:00Z", "step": 0.5, "points": [[1, 2]]},
        [1, 2],
    ],
)
def test_a_previous_wind_file_of_another_shape_is_not_kept(
    tmp_path: Path, previous_wind: Any
) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    (first / build.WIND).write_text(json.dumps(previous_wind), encoding="utf-8")
    _, calls = run_recorded(tmp_path / "second", bodies(), first, NOW)
    assert sorted(calls) == sorted(WIND_URLS)


def test_in_github_actions_the_call_count_is_a_notice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    run(tmp_path, bodies())
    assert "::notice title=Open-Meteo::417 calls in this build" in capsys.readouterr().out


def test_fire_values_out_of_bounds_are_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    answers = bodies()
    document = json.loads(weather("open_meteo_weather_sample.json.gz"))
    document[1]["hourly"]["relative_humidity_2m"][4] = 140
    answers[FIRES_URL] = json.dumps(document).encode()
    run(tmp_path, answers)
    assert read(tmp_path / build.FIRE_WEATHER)["fires"][1]["humidity"][4] is None
    assert "open_meteo_fires: 1 values out of bounds dropped" in capsys.readouterr().out


def test_a_place_left_out_keeps_its_weather_of_an_older_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "first"
    run(first, bodies())
    monkeypatch.setattr(build, "MAX_FIRE_POINTS", 1)
    answers = bodies()
    answers[OPEN_METEO_META] = newer_run(3, 20, NOW)
    answers[AIX_URL] = single(0)
    status, calls = run_recorded(tmp_path / "second", answers, first, NOW)
    assert AIX_URL in calls and LANDES_URL not in calls
    fires = read(tmp_path / "second" / build.FIRE_WEATHER)
    assert [(f["id"], f["run"]) for f in fires["fires"]] == [
        (1, "2026-10-11T15:00:00Z"),
        (2, "2026-10-11T12:00:00Z"),
    ]
    assert fires["missing"] == []
    assert status["sources"]["open_meteo_fires"]["ok"] is True
