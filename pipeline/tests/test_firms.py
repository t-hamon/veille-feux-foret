from __future__ import annotations

import datetime as dt

import pytest

from tests.helpers import fixture_bytes
from veille_feux import firms, geo
from veille_feux.firms import Detection, FirmsFormatError
from veille_feux.sources import FIRMS_FEEDS

CAPTURE = "20261003T1128Z"
AREA = geo.load_france()
SITES = geo.load_industrial_sites()

# Counts measured on the capture of 3 October 2026, 11:28 UTC.
EXPECTED = {
    "viirs_snpp": (938, 10),
    "viirs_noaa20": (1559, 22),
    "viirs_noaa21": (1043, 10),
    "modis": (297, 4),
}


def _parse(feed_id: str) -> tuple[list[Detection], firms.ParseReport]:
    feed = next(f for f in FIRMS_FEEDS if f.id == feed_id)
    text = fixture_bytes(f"{CAPTURE}/firms_{feed.id}_24h.csv.gz").decode()
    return firms.parse_csv(text, feed.id, feed.sensor)


@pytest.mark.parametrize("feed_id", list(EXPECTED))
def test_real_capture_parses_completely(feed_id: str) -> None:
    detections, report = _parse(feed_id)
    rows, in_france = EXPECTED[feed_id]
    assert report.rows == rows
    assert report.kept == rows
    assert not report.skipped
    kept, selection = firms.select_france(detections, AREA, SITES)
    assert selection.inside == len(kept) == in_france
    assert selection.inside + selection.outside + sum(selection.industrial.values()) == rows


def test_viirs_fields() -> None:
    detections, _ = _parse("viirs_snpp")
    assert {d.confidence_class for d in detections} == {"low", "nominal", "high"}
    assert all(d.confidence_pct is None for d in detections)
    assert all(d.acquired.tzinfo is dt.UTC for d in detections)
    assert all(d.daynight in ("D", "N") for d in detections)
    assert all(d.frp_mw is not None and d.frp_mw >= 0 for d in detections)


def test_modis_keeps_the_percentage() -> None:
    detections, _ = _parse("modis")
    assert all(d.confidence_class is None for d in detections)
    pcts = [d.confidence_pct for d in detections]
    assert all(p is not None and 0 <= p <= 100 for p in pcts)


def test_industrial_sites_are_removed_from_the_real_capture() -> None:
    detections, _ = _parse("viirs_noaa20")
    _, selection = firms.select_france(detections, AREA, SITES)
    assert selection.industrial["Plateforme de Fos-sur-Mer (raffinage / pétrochimie)"] == 19
    assert selection.industrial["Aciérie ArcelorMittal Dunkerque"] == 20


HEADER = "latitude,longitude,acq_date,acq_time,confidence,frp,daynight\n"


def test_acq_time_is_zero_padded_utc() -> None:
    detections, _ = firms.parse_csv(
        HEADER + "44.9,-1.0,2026-07-26,18,nominal,3.5,N\n", "s", "viirs"
    )
    assert detections[0].acquired == dt.datetime(2026, 7, 26, 0, 18, tzinfo=dt.UTC)


@pytest.mark.parametrize(
    "row",
    [
        "abc,-1.0,2026-07-26,1830,nominal,3.5,D",
        "95.0,-1.0,2026-07-26,1830,nominal,3.5,D",
        "44.9,-1.0,2026-13-26,1830,nominal,3.5,D",
        "44.9,-1.0,2026-07-26,18h30,nominal,3.5,D",
        "44.9,-1.0,2026-07-26,1830,maybe,3.5,D",
        "44.9,-1.0,2026-07-26,1830,nominal,hot,D",
    ],
)
def test_malformed_rows_are_counted_not_guessed(row: str) -> None:
    good = "44.9,-1.0,2026-07-26,1830,high,3.5,D\n"
    detections, report = firms.parse_csv(HEADER + good + row + "\n", "s", "viirs")
    assert len(detections) == 1
    assert report.rows == 2
    assert sum(report.skipped.values()) == 1


def test_modis_confidence_out_of_range_is_rejected() -> None:
    _, report = firms.parse_csv(HEADER + "44.9,-1.0,2026-07-26,1830,120,3.5,D\n", "m", "modis")
    assert report.kept == 0
    assert sum(report.skipped.values()) == 1


def test_missing_frp_and_daynight_stay_unknown() -> None:
    detections, _ = firms.parse_csv(HEADER + "44.9,-1.0,2026-07-26,1830,low,,\n", "s", "viirs")
    assert detections[0].frp_mw is None
    assert detections[0].daynight is None


def test_not_a_firms_file() -> None:
    with pytest.raises(FirmsFormatError, match="missing columns"):
        firms.parse_csv("<html>Service unavailable</html>\n", "s", "viirs")
