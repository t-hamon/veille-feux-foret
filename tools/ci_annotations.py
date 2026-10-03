"""Turn semgrep and OWASP ZAP JSON reports into GitHub Actions annotations.

Job logs are hard to reach outside the GitHub interface, while annotations
are shown on the pull request and are available through the checks API.
This script only reads a report and prints workflow commands; it never
changes the exit status of the scan itself.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

MAX_INSTANCES = 3


def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def command(level: str, message: str, **props: str | int) -> str:
    rendered = ",".join(f"{key}={_escape_property(str(val))}" for key, val in props.items())
    head = f"::{level} {rendered}" if rendered else f"::{level}"
    return f"{head}::{_escape_data(message)}"


def semgrep_annotations(report: dict[str, Any]) -> Iterator[str]:
    for result in report.get("results", []):
        extra = result.get("extra", {})
        severity = str(extra.get("severity", "")).upper()
        level = "error" if severity in {"ERROR", "HIGH", "CRITICAL"} else "warning"
        yield command(
            level,
            str(extra.get("message", "")).strip(),
            file=str(result.get("path", "")),
            line=int(result.get("start", {}).get("line", 1)),
            endLine=int(result.get("end", {}).get("line", 1)),
            title=f"semgrep {result.get('check_id', '')}",
        )
    for error in report.get("errors", []):
        yield command("warning", str(error.get("message", error)), title="semgrep error")


def zap_annotations(report: dict[str, Any]) -> Iterator[str]:
    for site in report.get("site", []):
        for alert in site.get("alerts", []):
            uris = [str(i.get("uri", "")) for i in alert.get("instances", [])]
            shown = ", ".join(uris[:MAX_INSTANCES])
            more = f" (+{len(uris) - MAX_INSTANCES})" if len(uris) > MAX_INSTANCES else ""
            risk = str(alert.get("riskdesc", ""))
            level = "error" if risk.startswith("High") else "warning"
            yield command(
                level,
                f"{alert.get('alert', '')} [{alert.get('pluginid', '')}] {risk}: {shown}{more}",
                title=f"ZAP {alert.get('pluginid', '')}",
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["semgrep", "zap"])
    parser.add_argument("report", type=Path)
    args = parser.parse_args(argv)
    if not args.report.is_file():
        print(command("warning", f"report not found: {args.report}"))
        return 0
    report = json.loads(args.report.read_text(encoding="utf-8"))
    lines = semgrep_annotations(report) if args.kind == "semgrep" else zap_annotations(report)
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
