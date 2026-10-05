from __future__ import annotations

import filecmp
import json
from pathlib import Path

import build_web_fixtures as bwf

COMMITTED = bwf.ROOT / "web" / "e2e" / "fixtures"


def test_committed_web_fixtures_match_the_pipeline(tmp_path: Path) -> None:
    """The web tests must read what the current pipeline really writes."""
    assert bwf.main(["build_web_fixtures.py", str(tmp_path)]) == 0
    for scenario in bwf.SCENARIOS:
        fresh = sorted(p.name for p in (tmp_path / scenario).iterdir())
        committed = sorted(p.name for p in (COMMITTED / scenario).iterdir())
        assert fresh == committed, scenario
        match, mismatch, errors = filecmp.cmpfiles(
            tmp_path / scenario, COMMITTED / scenario, fresh, shallow=False
        )
        assert mismatch == [] and errors == [], (scenario, mismatch, errors)
        assert match == fresh


def test_failing_sources_are_reported_not_hidden(tmp_path: Path) -> None:
    assert bwf.main(["build_web_fixtures.py", str(tmp_path)]) == 0
    status = json.loads((tmp_path / "firms-en-panne" / "etat.json").read_text(encoding="utf-8"))
    firms = [s for i, s in status["sources"].items() if i.startswith("firms_")]
    assert len(firms) == 4
    assert all(s["ok"] is False and s["error"] for s in firms)
    assert not (tmp_path / "firms-en-panne" / "detections.geojson").exists()
