from __future__ import annotations

import itertools
import math

import pytest

from veille_feux import fuel_moisture as fm


def test_code_and_moisture_scales() -> None:
    assert fm.moisture_from_code(85.0) == pytest.approx(147.2 * 16 / 144.5)
    assert fm.moisture_from_code(101.0) == 0.0
    assert fm.code_from_moisture(250.0) == 0.0
    # Equations 1 and 10 are close to inverse, not exactly.
    for code in (40.0, 85.0, 93.3, 99.0):
        back = fm.code_from_moisture(fm.moisture_from_code(code))
        assert back == pytest.approx(code, abs=0.06)
    assert fm.code_from_moisture(0.0) == 101.0
    assert fm.code_from_moisture(300.0) == 0.0


def test_dry_limit_of_cruz_and_alexander_in_code() -> None:
    assert fm.code_from_moisture(fm.DRY_LIMIT) == pytest.approx(93.27, abs=0.01)


def test_rain_wets_and_is_capped() -> None:
    assert fm.after_rain(16.3, 0.0) == 16.3
    one, five = fm.after_rain(16.3, 1.0), fm.after_rain(16.3, 5.0)
    assert 16.3 < one < five
    assert one == pytest.approx(16.3 + 42.5 * math.exp(-100 / (251 - 16.3)) * (1 - math.exp(-6.93)))
    assert fm.after_rain(240.0, 50.0) == fm.MAX_MOISTURE


def test_extra_wetting_term_above_150_percent() -> None:
    base = 160.0 + 42.5 * 2.0 * math.exp(-100 / 91) * (1 - math.exp(-6.93 / 2.0))
    assert fm.after_rain(160.0, 2.0) == pytest.approx(base + 0.0015 * 100 * math.sqrt(2.0))


def test_drying_wetting_and_rest() -> None:
    t, h, w = 25.0, 30.0, 10.0
    dry_eq = fm.after_drying(1000.0, t, h, w, factor=100.0)
    wet_eq = fm.after_drying(0.0, t, h, w, factor=100.0)
    assert wet_eq < dry_eq
    # Above the drying equilibrium: dries towards it, without passing it.
    assert dry_eq < fm.after_drying(30.0, t, h, w) < 30.0
    # Below the wetting equilibrium: wets towards it.
    assert 0.5 < fm.after_drying(0.5, t, h, w) < wet_eq
    # In between: unchanged.
    middle = (dry_eq + wet_eq) / 2
    assert fm.after_drying(middle, t, h, w) == middle


def test_hourly_rate_is_twice_the_1977_rate() -> None:
    # Time lag cut in half: one hour of FWI2025 equals two hours of 1977.
    once = fm.after_drying(30.0, 22.0, 40.0, 12.0)
    twice = fm.after_drying(
        fm.after_drying(30.0, 22.0, 40.0, 12.0, 0.0579), 22.0, 40.0, 12.0, 0.0579
    )
    assert once == pytest.approx(twice)
    assert fm.HOURLY_RATE == pytest.approx(2 * 0.0579)


def test_canopy_intercepts_the_first_half_millimetre_of_an_event() -> None:
    canopy = fm.Canopy()
    assert canopy.reaching_litter(0.3) == 0.0
    assert canopy.reaching_litter(0.3) == pytest.approx(0.1)
    # Five dry hours: the same event goes on.
    for _ in range(5):
        assert canopy.reaching_litter(0.0) == 0.0
    assert canopy.reaching_litter(0.4) == pytest.approx(0.4)
    # Six dry hours: the canopy is dry, a new event starts.
    for _ in range(6):
        canopy.reaching_litter(0.0)
    assert canopy.reaching_litter(0.4) == 0.0
    assert canopy.reaching_litter(0.4) == pytest.approx(0.3)


def test_hourly_series_from_the_standard_start() -> None:
    hours = 48
    out = fm.hourly_fine_fuel_moisture(
        [25.0] * hours, [30.0] * hours, [10.0] * hours, [0.0] * hours
    )
    assert len(out.code) == len(out.moisture) == hours
    codes = [c for c in out.code if c is not None]
    assert codes[0] > fm.START_FFMC  # dry weather from 85
    assert all(a <= b for a, b in itertools.pairwise(codes))
    equilibrium = fm.after_drying(1000.0, 25.0, 30.0, 10.0, factor=100.0)
    assert out.moisture[-1] == pytest.approx(equilibrium, abs=0.01)


def test_rain_of_an_hour_wets_before_drying() -> None:
    wet = fm.hourly_fine_fuel_moisture([15.0] * 2, [90.0] * 2, [5.0] * 2, [0.0, 10.0])
    dry = fm.hourly_fine_fuel_moisture([15.0] * 2, [90.0] * 2, [5.0] * 2, [0.0, 0.0])
    assert wet.code[1] is not None and dry.code[1] is not None
    assert wet.code[1] < dry.code[1] - 20


def test_a_missing_input_empties_that_hour_and_the_next_ones() -> None:
    out = fm.hourly_fine_fuel_moisture(
        [20.0, 20.0, 20.0, 20.0], [40.0, None, 40.0, 40.0], [10.0] * 4, [0.0] * 4
    )
    assert out.code[0] is not None
    assert out.code[1:] == [None, None, None]
    assert out.moisture[1:] == [None, None, None]


def test_series_of_different_lengths_are_refused() -> None:
    with pytest.raises(ValueError):
        fm.hourly_fine_fuel_moisture([20.0], [40.0, 40.0], [10.0], [0.0])
