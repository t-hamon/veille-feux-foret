from __future__ import annotations

import copy
import datetime as dt
import json
from typing import Any

import pytest

from tests.helpers import fixture_bytes
from veille_feux import geo, meteo, sources
from veille_feux.foyers import Foyer
from veille_feux.meteo import MeteoFormatError

CAPTURE = "20261011T1721Z"
NOW = dt.datetime(2026, 10, 11, 17, 21, 23, tzinfo=dt.UTC)
SAMPLE_POINTS = [(43.5297, 5.4474), (44.923, -0.997)]
GRID = geo.france_grid(sources.FRANCE_BBOX, sources.WIND_GRID_STEP)


def load(name: str) -> Any:
    return json.loads(fixture_bytes(f"{CAPTURE}/{name}"))


def sample() -> Any:
    return load("open_meteo_weather_sample.json.gz")


def parse_sample(document: Any = None) -> tuple[list[meteo.PointSeries], int]:
    return meteo.parse_points(
        sample() if document is None else document,
        SAMPLE_POINTS,
        sources.WEATHER_VARIABLES,
        NOW,
        0.1,
    )


def foyer(fid: int, lat: float, lon: float, last: dt.datetime) -> Foyer:
    return Foyer(fid, lat, lon, 3, 3, last, last, None, 14, True, None)


# ------------------------------------------------------------------- model run


def test_run_of_the_capture() -> None:
    run = meteo.parse_run(load("open_meteo_meta.json.gz"), NOW)
    assert run.initialised == dt.datetime(2026, 10, 11, 12, tzinfo=dt.UTC)
    assert run.available == dt.datetime(2026, 10, 11, 15, 57, 32, tzinfo=dt.UTC)
    assert run.data_end == dt.datetime(2026, 10, 13, 16, tzinfo=dt.UTC)
    assert run.usable(NOW)
    assert not run.usable(run.available + dt.timedelta(minutes=9))
    assert run.usable(run.available + dt.timedelta(minutes=10))


@pytest.mark.parametrize(
    "change",
    [
        {"last_run_initialisation_time": None},
        {"last_run_initialisation_time": "1791720000"},
        {"last_run_initialisation_time": True},
        {"last_run_availability_time": 1791720000 - 1},  # before the run
        {"last_run_availability_time": int(NOW.timestamp()) + 7200},  # in the future
        {"data_end_time": 1791720000},  # no data after the run
        {"data_end_time": 1791720000 + 8 * 86400},  # too long
    ],
)
def test_malformed_run_is_refused(change: dict[str, Any]) -> None:
    document = {**load("open_meteo_meta.json.gz"), **change}
    with pytest.raises(MeteoFormatError):
        meteo.parse_run(document, NOW)


def test_run_metadata_must_be_an_object() -> None:
    with pytest.raises(MeteoFormatError):
        meteo.parse_run([], NOW)


# --------------------------------------------------------------- real answers


def test_wind_grid_of_the_capture() -> None:
    series: list[meteo.PointSeries] = []
    for number, start in ((1, 0), (2, 250)):
        points = GRID[start : start + sources.MAX_POINTS_PER_REQUEST]
        part, dropped = meteo.parse_points(
            load(f"open_meteo_wind_grid_{number}.json.gz"),
            points,
            sources.WIND_VARIABLES,
            NOW,
            0.02,
        )
        assert dropped == 0
        series.extend(part)
    assert len(series) == 415
    assert [(p.lat, p.lon) for p in series] == list(GRID)
    trimmed = meteo.trim(series)
    # 228 hours asked, the last 13 after the end of the run are empty.
    assert {p.hours for p in series} == {228}
    assert {p.hours for p in trimmed} == {215}
    assert trimmed[0].start == meteo.expected_start(NOW) == 1791133200
    last_hour = trimmed[0].start + (trimmed[0].hours - 1) * 3600
    assert last_hour == int(dt.datetime(2026, 10, 13, 15, tzinfo=dt.UTC).timestamp())
    assert all(v is not None for p in trimmed for column in p.values.values() for v in column)


def test_weather_sample_of_the_capture() -> None:
    series, dropped = parse_sample()
    assert dropped == 0
    aix, landes = meteo.trim(series)
    assert (aix.lat, aix.lon, aix.elevation) == (43.53, 5.45, 205.0)
    assert (landes.lat, landes.lon, landes.elevation) == (44.92, -1.0, 34.0)
    assert aix.hours == 215
    assert aix.values["temperature_2m"][0] == 24.6
    assert aix.values["wind_direction_10m"][0] == 140
    assert set(aix.values) == set(sources.WEATHER_VARIABLES)


# ------------------------------------------------------------ malformed answers


def broken(change: Any) -> Any:
    document = sample()
    change(document)
    return document


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.pop(), "1 points answered for 2 asked"),
        (lambda d: d.reverse(), "answered as location"),
        (lambda d: d[0].update(latitude=44.0), "too far"),
        (lambda d: d[0].update(longitude="5.4"), "longitude missing"),
        (lambda d: d[1].pop("hourly"), "hourly values missing"),
        (lambda d: d[0]["hourly_units"].update(wind_speed_10m="m/s"), "not in km/h"),
        (lambda d: d[0]["hourly_units"].update(temperature_2m="°F"), "not in °C"),
        (lambda d: d[0]["hourly"]["precipitation"].pop(), "does not match the time axis"),
        (lambda d: d[0]["hourly"].update(time=[]), "time axis missing"),
        (lambda d: d[0]["hourly"]["time"].__setitem__(5, 1), "not hourly"),
        (lambda d: d[0]["hourly"]["time"].__setitem__(5, "x"), "not in Unix time"),
        (lambda d: d[1]["hourly"]["time"].__setitem__(0, 0), "different time axes"),
        (lambda d: d[0]["hourly"]["wind_gusts_10m"].__setitem__(3, "fort"), "not a number"),
        (lambda d: d[0]["hourly"]["wind_gusts_10m"].__setitem__(3, True), "not a number"),
        (lambda d: d.__setitem__(0, "point"), "not an object"),
    ],
)
def test_malformed_answers_are_refused(change: Any, message: str) -> None:
    with pytest.raises(MeteoFormatError, match=message):
        parse_sample(broken(change))


def test_an_answer_for_another_hour_is_refused() -> None:
    later = NOW + dt.timedelta(hours=2)
    with pytest.raises(MeteoFormatError, match="does not start at the hour asked"):
        meteo.parse_points(sample(), SAMPLE_POINTS, sources.WEATHER_VARIABLES, later, 0.1)
    # One hour either way is accepted: the clock may cross an hour during a build.
    meteo.parse_points(
        sample(), SAMPLE_POINTS, sources.WEATHER_VARIABLES, NOW + dt.timedelta(hours=1), 0.1
    )


def test_a_single_point_answer_is_an_object() -> None:
    document = sample()[0]
    series, _ = meteo.parse_points(document, SAMPLE_POINTS[:1], sources.WEATHER_VARIABLES, NOW, 0.1)
    assert len(series) == 1


def test_values_out_of_bounds_are_dropped_and_counted() -> None:
    def change(d: Any) -> None:
        hourly = d[0]["hourly"]
        hourly["wind_speed_10m"][0] = -3
        hourly["relative_humidity_2m"][1] = 140
        hourly["temperature_2m"][2] = 1e400  # infinite once parsed

    series, dropped = parse_sample(broken(change))
    assert dropped == 3
    values = series[0].values
    assert values["wind_speed_10m"][0] is None
    assert values["relative_humidity_2m"][1] is None
    assert values["temperature_2m"][2] is None
    assert values["temperature_2m"][3] is not None


def test_trim_refuses_an_empty_answer_and_mixed_axes() -> None:
    def empty(d: Any) -> None:
        for point in d:
            for name in sources.WEATHER_VARIABLES:
                point["hourly"][name] = [None] * len(point["hourly"]["time"])

    series, _ = parse_sample(broken(empty))
    with pytest.raises(MeteoFormatError, match="no value"):
        meteo.trim(series)
    first, second = parse_sample()[0]
    shorter = meteo.PointSeries(1.0, 2.0, None, second.start, {"x": [1.0]})
    with pytest.raises(MeteoFormatError, match="different time axes"):
        meteo.trim([first, shorter])


# ---------------------------------------------------------------------- files


def test_wind_document() -> None:
    series = meteo.trim(parse_sample()[0])
    run = dt.datetime(2026, 10, 11, 12, tzinfo=dt.UTC)
    document = meteo.wind_document(series, 0.5, run, NOW)
    assert document["run"] == "2026-10-11T12:00:00Z"
    assert document["fetched_at"] == "2026-10-11T17:21:23Z"
    assert document["start"] == 1791133200
    assert document["hours"] == 215
    assert document["step"] == 0.5
    assert document["points"] == [[43.53, 5.45], [44.92, -1.0]]
    assert set(document) >= {"speed", "direction", "gusts"}
    assert document["speed"][0][:3] == [12, 9, 12]  # 11.8, 8.9, 11.5 km/h
    assert document["gusts"][0][:3] == [31, 23, 23]  # 30.6, 22.7, 23.0 km/h
    assert all(len(row) == 215 for row in document["direction"])
    assert meteo.wind_document(series, 0.5, None, NOW)["run"] is None
    with pytest.raises(MeteoFormatError):
        meteo.wind_document([], 0.5, run, NOW)


def test_directions_stay_between_0_and_359() -> None:
    def north(d: Any) -> None:
        d[0]["hourly"]["wind_direction_10m"][0] = 360
        d[0]["hourly"]["wind_direction_10m"][1] = 359.6

    series = meteo.trim(parse_sample(broken(north))[0])
    row = meteo.wind_document(series, 0.5, None, NOW)["direction"][0]
    assert row[:2] == [0, 0]


def test_fire_entry_rounds_each_variable() -> None:
    aix = meteo.trim(parse_sample()[0])[0]
    entry = meteo.fire_entry(foyer(4, 43.52971, 5.44738, NOW), aix, None, NOW)
    assert entry["id"] == 4
    assert entry["point"] == [43.53, 5.45]
    assert entry["cell"] == [43.53, 5.45]
    assert entry["run"] is None
    assert entry["hours"] == 215
    assert entry["temperature"][:2] == [24.6, 23.1]
    assert entry["humidity"][:2] == [48, 57]
    assert isinstance(entry["precipitation"][0], float)
    assert meteo.previous_fire_entries({"fires": [entry]}) == {(43.53, 5.45): entry}


def test_recent_fires_and_their_points() -> None:
    fires = [
        foyer(1, 43.52971, 5.44738, NOW - dt.timedelta(hours=2)),
        foyer(2, 45.0, 1.0, NOW - dt.timedelta(hours=24)),
        foyer(3, 44.9234, -0.9966, NOW - dt.timedelta(hours=23, minutes=59)),
    ]
    assert [f.id for f in meteo.recent_fires(fires, NOW)] == [1, 3]
    assert meteo.fire_point(fires[2]) == (44.92, -1.0)


def test_malformed_previous_entries_are_ignored() -> None:
    aix = meteo.trim(parse_sample()[0])[0]
    good = meteo.fire_entry(foyer(1, 43.53, 5.45, NOW), aix, None, NOW)
    bad_entries: list[dict[str, Any]] = []
    for key, value in [
        ("point", [43.5]),
        ("point", ["43.5", 5.4]),
        ("hours", 0),
        ("hours", True),
        ("start", "now"),
        ("fetched_at", "yesterday"),
        ("run", "noon"),
        ("speed", [1, 2]),
    ]:
        entry = copy.deepcopy(good)
        entry["point"] = [40.0 + len(bad_entries), 2.0]
        entry[key] = value
        bad_entries.append(entry)
    found = meteo.previous_fire_entries({"fires": [good, "x", *bad_entries]})
    assert list(found) == [(43.53, 5.45)]
    assert meteo.previous_fire_entries({"fires": "none"}) == {}
    assert meteo.previous_fire_entries(None) == {}
    assert meteo.parse_iso(12) is None


def test_an_elevation_that_is_not_a_number_is_left_out() -> None:
    series, _ = parse_sample(broken(lambda d: d[0].update(elevation="haut")))
    assert series[0].elevation is None
    assert series[1].elevation == 34.0
