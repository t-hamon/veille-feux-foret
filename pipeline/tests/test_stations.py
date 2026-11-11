from __future__ import annotations

import copy
import datetime as dt
import json
from typing import Any

import pytest

from tests.helpers import fixture_bytes
from veille_feux import meteofrance, stations
from veille_feux.meteofrance import Observation, StationInfo

CAPTURE = "20261111T2322Z"
FRANCE = (-5.5, 41.0, 10.0, 51.5)
# Time of the capture: 23:00 UTC is the latest hour published.
NOW = dt.datetime(2026, 11, 11, 23, 22, 44, tzinfo=dt.UTC)
H = 3600
LATEST = int(dt.datetime(2026, 11, 11, 23, tzinfo=dt.UTC).timestamp())


def observations(name: str) -> list[Observation]:
    document = json.loads(fixture_bytes(f"{CAPTURE}/{name}.json.gz"))
    return meteofrance.parse_observations(document, FRANCE)[0]


def department() -> stations.Stored:
    """The 120 hours of the Bouches-du-Rhône package, backfilled an hour ago, with
    the name of one station from the list of the stations."""
    stored = stations.merge(
        stations.Stored(),
        observations("meteofrance_department_13_24h"),
        {"13001009": StationInfo("AIX EN PROVENCE", 173)},
        NOW,
        backfilled=True,
    )
    stored.backfilled_at = NOW - dt.timedelta(hours=1)
    return stored


def test_latest_hour_published() -> None:
    assert stations.latest_hour(NOW) == LATEST
    assert stations.latest_hour(NOW.replace(minute=14, second=59)) == LATEST - H
    assert stations.latest_hour(NOW.replace(minute=15, second=0)) == LATEST


def test_first_run_backfills_from_the_departments() -> None:
    assert stations.plan(stations.Stored(), NOW) == stations.Plan([], True)


def test_runs_ask_for_the_latest_hours_and_those_missing() -> None:
    stored = department()
    # Everything known: the 3 latest hours again, for late measurements.
    assert stations.plan(stored, NOW) == stations.Plan([LATEST - 2 * H, LATEST - H, LATEST], False)
    # An hour of the last day missing is asked for as well.
    for by_hour in stored.series.values():
        by_hour.pop(LATEST - 10 * H, None)
    assert stations.plan(stored, NOW).hours == [LATEST - 10 * H, LATEST - 2 * H, LATEST - H, LATEST]


def test_an_older_gap_backfills_at_most_once_a_day() -> None:
    stored = department()
    for by_hour in stored.series.values():
        by_hour.pop(LATEST - 30 * H, None)
    # Backfilled an hour ago: the gap waits.
    assert stations.plan(stored, NOW).backfill is False
    stored.backfilled_at = NOW - dt.timedelta(hours=24)
    assert stations.plan(stored, NOW) == stations.Plan([], True)
    # Gaps beyond the depth of the packages (120 hours) never start a backfill.
    stored = department()
    for by_hour in stored.series.values():
        by_hour.pop(LATEST - 120 * H, None)
    stored.backfilled_at = None
    assert stations.plan(stored, NOW).backfill is False


def test_merge_keeps_the_window_and_lets_new_values_win() -> None:
    stored = department()
    station = "13001009"
    assert stored.series[station][LATEST] == (1.2, 90, 4.9)
    fresh = [Observation(station, 43.53, 5.42, LATEST, 9.9, 90, 12.0)]
    later = NOW + dt.timedelta(days=3)
    merged = stations.merge(stored, fresh, {}, later, backfilled=False)
    assert merged.series[station][LATEST] == (9.9, 90, 12.0)
    assert merged.positions[station] == (43.53, 5.42)
    assert merged.infos[station] == StationInfo("AIX EN PROVENCE", 173)
    # Three days later, hours more than 7 days old are gone.
    first = stations.latest_hour(later) - 167 * H
    assert min(merged.hours()) == first
    assert merged.fetched_at == later
    assert merged.backfilled_at == stored.backfilled_at
    # Observations outside the window are ignored.
    old = [Observation("13999999", 43.0, 5.0, first - H, 1.0, 10, 2.0)]
    assert "13999999" not in stations.merge(merged, old, {}, later, backfilled=False).series


def test_document_and_back() -> None:
    stored = department()
    document = stations.document(stored)
    assert document["source"].startswith("Météo-France, API Package Observations")
    assert document["licence"] == "Licence Ouverte 2.0 (Etalab), source Météo-France"
    assert document["units"]["ff"] == "m/s"
    assert document["hours"] == 120
    assert document["start"] == LATEST - 119 * H
    assert document["fetched_at"] == "2026-11-11T23:22:44Z"
    assert document["backfilled_at"] == "2026-11-11T22:22:44Z"
    assert len(document["stations"]) == 16
    aix = next(s for s in document["stations"] if s["id"] == "13001009")
    assert (aix["name"], aix["altitude"]) == ("AIX EN PROVENCE", 173)
    assert (aix["lat"], aix["lon"]) == (43.5295, 5.4245)
    assert (aix["ff"][-1], aix["dd"][-1], aix["raf"][-1]) == (1.2, 90, 4.9)
    unnamed = next(s for s in document["stations"] if s["id"] != "13001009")
    assert (unnamed["name"], unnamed["altitude"]) == (None, None)
    again = stations.read_document(json.loads(json.dumps(document)), FRANCE, NOW)
    assert again is not None
    assert stations.document(again) == document


def test_empty_document_and_back() -> None:
    document = stations.document(stations.Stored(fetched_at=NOW))
    assert (document["start"], document["hours"], document["stations"]) == (None, 0, [])
    again = stations.read_document(document, FRANCE, NOW)
    assert again is not None and again.series == {}


def valid() -> dict[str, Any]:
    return stations.document(department())


def changed(path: list[Any], value: Any) -> dict[str, Any]:
    document = copy.deepcopy(valid())
    node: Any = document
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return document


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["start"], LATEST + 1),
        (["start"], LATEST + 2 * H),
        (["start"], "1794438000"),
        (["hours"], 0),
        (["hours"], 169),
        (["fetched_at"], "2026-11-12T00:00:00Z"),
        (["stations"], {}),
        (["stations", 0, "id"], "13001"),
        (["stations", 0, "lat"], 16.2),
        (["stations", 0, "lon"], True),
        (["stations", 0, "name"], "<b>"),
        (["stations", 0, "altitude"], 9000),
        (["stations", 0, "ff"], [1.0]),
        (["stations", 0, "ff", 0], 80.0),
        (["stations", 0, "dd", 0], 12.5),
        (["stations", 0, "raf", 0], "3"),
    ],
)
def test_a_document_that_differs_is_not_used(path: list[Any], value: Any) -> None:
    assert stations.read_document(changed(path, value), FRANCE, NOW) is None


def test_documents_that_are_not_used() -> None:
    document = valid()
    document["stations"].append(copy.deepcopy(document["stations"][0]))
    assert stations.read_document(document, FRANCE, NOW) is None
    document = valid()
    blank = document["stations"][0]
    for key in ("ff", "dd", "raf"):
        blank[key] = [None] * document["hours"]
    assert stations.read_document(document, FRANCE, NOW) is None
    assert stations.read_document(None, FRANCE, NOW) is None
    assert stations.read_document([], FRANCE, NOW) is None
    assert stations.read_document({"start": 0}, FRANCE, NOW) is None


def test_an_unreadable_time_is_left_out() -> None:
    document = valid()
    document["fetched_at"] = "2026-13-01T00:00:00Z"
    document["backfilled_at"] = 12
    again = stations.read_document(document, FRANCE, NOW)
    assert again is not None
    assert (again.fetched_at, again.backfilled_at) == (None, None)
