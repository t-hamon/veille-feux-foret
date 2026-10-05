from __future__ import annotations

import json
from pathlib import Path

import pytest

import ci_annotations as ca


def test_command_escapes_messages_and_properties() -> None:
    line = ca.command("error", "50%\nnext", file="a,b:c.py", line=3)
    assert line == "::error file=a%2Cb%3Ac.py,line=3::50%25%0Anext"


def test_semgrep_results_become_annotations() -> None:
    report = {
        "results": [
            {
                "check_id": "rule.id",
                "path": ".github/dependabot.yml",
                "start": {"line": 3},
                "end": {"line": 9},
                "extra": {"message": "Add a cooldown", "severity": "ERROR"},
            },
            {
                "check_id": "other",
                "path": "x.py",
                "start": {"line": 1},
                "end": {"line": 1},
                "extra": {"message": "minor", "severity": "WARNING"},
            },
        ],
        "errors": [{"message": "parse failure"}],
    }
    lines = list(ca.semgrep_annotations(report))
    assert lines[0].startswith("::error file=.github/dependabot.yml,line=3,endLine=9,")
    assert lines[0].endswith("::Add a cooldown")
    assert lines[1].startswith("::warning file=x.py")
    assert "semgrep error" in lines[2]


def test_zap_alerts_list_a_few_instances() -> None:
    report = {
        "site": [
            {
                "alerts": [
                    {
                        "pluginid": "10063",
                        "alert": "Permissions Policy Header Not Set",
                        "riskdesc": "Low (Medium)",
                        "instances": [{"uri": f"http://127.0.0.1/{i}"} for i in range(5)],
                    },
                    {
                        "pluginid": "40012",
                        "alert": "XSS",
                        "riskdesc": "High (Medium)",
                        "instances": [{"uri": "http://127.0.0.1/"}],
                    },
                ]
            }
        ]
    }
    low, high = ca.zap_annotations(report)
    assert low.startswith("::warning title=ZAP 10063::")
    assert "(+2)" in low
    assert high.startswith("::error ")


def test_missing_report_is_reported_not_fatal(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert ca.main(["zap", str(tmp_path / "absent.json")]) == 0
    assert "report not found" in capsys.readouterr().out


def test_main_prints_annotations(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "semgrep.json"
    path.write_text(json.dumps({"results": [], "errors": []}), encoding="utf-8")
    assert ca.main(["semgrep", str(path)]) == 0
    assert capsys.readouterr().out == ""


def test_lighthouse_failures_and_summary(tmp_path: Path) -> None:
    (tmp_path / "assertion-results.json").write_text(
        json.dumps(
            [
                {
                    "name": "minScore",
                    "operator": ">=",
                    "expected": 0.9,
                    "actual": 0.82,
                    "auditId": "categories",
                    "auditProperty": "performance",
                    "level": "error",
                    "passed": False,
                },
                {"name": "minScore", "auditId": "categories", "passed": True},
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / "lhr-1.json").write_text(
        json.dumps(
            {
                "categories": {"performance": {"score": 0.82}},
                "audits": {
                    "total-blocking-time": {"score": 0.4, "displayValue": "900 ms"},
                    "errors-in-console": {
                        "score": 0,
                        "details": {"items": [{"source": "network", "description": "404"}]},
                    },
                    "largest-contentful-paint": {"score": 1, "displayValue": "1 s"},
                },
            }
        ),
        encoding="utf-8",
    )
    lines = list(ca.lighthouse_annotations(tmp_path))
    assert lines[0].startswith("::error title=Lighthouse categories.performance::")
    assert lines[0].endswith("expected >= 0.9, got 0.82")
    assert "performance 0.82" in lines[1]
    assert "total-blocking-time 900 ms" in lines[1]
    assert "errors-in-console 0" in lines[2]
    assert "total-blocking-time 0.4 900 ms" in lines[2]
    assert lines[3].endswith("::network: 404")
    assert len(lines) == 4


def test_missing_lighthouse_folder_is_a_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert ca.main(["lighthouse", str(tmp_path / "absent")]) == 0
    assert capsys.readouterr().out.startswith("::warning::report folder not found")
