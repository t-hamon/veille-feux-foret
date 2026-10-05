from __future__ import annotations

import json
from email.message import Message
from pathlib import Path

import pytest

import check_deployment as cd

SITE = "https://site.example"
HEADERS_FILE = Path(__file__).resolve().parent.parent / "web" / "public" / "_headers"


def headers(values: dict[str, str]) -> Message:
    message = Message()
    for name, value in values.items():
        message[name] = value
    return message


def production_headers() -> dict[str, str]:
    """The headers of web/public/_headers for every path, as Cloudflare sends them."""
    values: dict[str, str] = {}
    in_all = False
    for line in HEADERS_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("/"):
            in_all = line.strip() == "/*"
        elif in_all and line.startswith("  ") and ":" in line:
            name, value = line.strip().split(":", 1)
            values[name.lower()] = value.strip()
    return values


def site(
    generation: str = "2026-10-05T10:00:00Z", overrides: dict[str, cd.Answer] | None = None
) -> cd.Getter:
    answers = {
        f"{SITE}/": cd.Answer(200, headers(production_headers()), b"<html>"),
        f"{SITE}/data/etat.json": cd.Answer(
            200, headers({}), json.dumps({"generated_at": generation}).encode()
        ),
        f"{SITE}/nexiste-pas": cd.Answer(404, headers({}), b""),
        f"{SITE}/_headers": cd.Answer(404, headers({}), b""),
    }
    answers.update(overrides or {})

    def get(url: str) -> cd.Answer:
        return answers[url]

    return get


def no_sleep(_: float) -> None:
    return None


def test_the_required_headers_are_those_of_the_headers_file() -> None:
    values = production_headers()
    for name, expected in cd.REQUIRED_HEADERS.items():
        assert expected in values[name], name


def test_a_good_deployment_passes() -> None:
    assert cd.check(site(), SITE, "2026-10-05T10:00:00Z", no_sleep) == []


def test_old_data_still_served_fails_after_retries() -> None:
    pauses: list[float] = []
    problems = cd.check(site("2026-10-05T09:30:00Z"), SITE, "2026-10-05T10:00:00Z", pauses.append)
    assert problems == [
        "data: etat.json generated at 2026-10-05T09:30:00Z is served, "
        "2026-10-05T10:00:00Z was built"
    ]
    assert len(pauses) == cd.ATTEMPTS - 1


def test_missing_or_weakened_headers_fail() -> None:
    weak = production_headers()
    del weak["x-frame-options"]
    weak["content-security-policy"] = "default-src *"
    get = site(overrides={f"{SITE}/": cd.Answer(200, headers(weak), b"")})
    problems = cd.check(get, SITE, "2026-10-05T10:00:00Z", no_sleep)
    assert "page: header x-frame-options missing" in problems
    assert any(p.startswith("page: header content-security-policy") for p in problems)


def test_exposed_headers_file_and_spa_fallback_fail() -> None:
    get = site(
        overrides={
            f"{SITE}/_headers": cd.Answer(200, headers({}), b"/*"),
            f"{SITE}/nexiste-pas": cd.Answer(200, headers({}), b"<html>"),
        }
    )
    problems = cd.check(get, SITE, "2026-10-05T10:00:00Z", no_sleep)
    assert "/_headers: HTTP 200, 404 expected" in problems
    assert "/nexiste-pas: HTTP 200, 404 expected" in problems


def test_unreadable_status_file_counts_as_not_served() -> None:
    get = site(overrides={f"{SITE}/data/etat.json": cd.Answer(200, headers({}), b"<html>")})
    problems = cd.check(get, SITE, "2026-10-05T10:00:00Z", no_sleep)
    assert problems[0].startswith("data: etat.json generated at None")


def test_an_unreachable_site_fails_without_crashing() -> None:
    down = cd.Answer(0, headers({}), b"")
    get = site(
        overrides={
            f"{SITE}/": down,
            f"{SITE}/data/etat.json": down,
            f"{SITE}/nexiste-pas": down,
            f"{SITE}/_headers": down,
        }
    )
    problems = cd.check(get, SITE, "2026-10-05T10:00:00Z", no_sleep)
    assert "page: HTTP 0" in problems
    assert len(problems) == 4


def test_only_https_is_fetched() -> None:
    with pytest.raises(ValueError, match="https only"):
        cd.http_get("http://site.example/")
