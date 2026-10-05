"""Check the deployed site after each deployment.

Run by the deployment workflow right after wrangler deploy, against the
project's own site only. It checks that:
- the data just built is the one served (same generation time in etat.json),
  retrying 12 times at 10 second intervals (about 2 minutes, up to 6 if every
  request times out): a new version takes a few seconds to reach every
  Cloudflare location, and the very first deployment of the workers.dev
  address can take longer;
- the page answers, with every security header of web/public/_headers;
- unknown paths and the _headers file answer 404.

Each problem is printed as a GitHub Actions error annotation and the script
exits with 1, so a broken deployment fails the workflow.

Usage: python tools/check_deployment.py SITE_URL BUILT_ETAT_JSON
"""

from __future__ import annotations

import http.client
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from email.message import Message
from pathlib import Path

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 20
ATTEMPTS = 12
PAUSE = 10.0

# Header name: text the value must contain. Kept in line with web/public/_headers.
REQUIRED_HEADERS = {
    "content-security-policy": "frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "strict-transport-security": "max-age=",
}


@dataclass(frozen=True)
class Answer:
    status: int
    headers: Message
    body: bytes


Getter = Callable[[str], Answer]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_get(url: str) -> Answer:
    if not url.startswith("https://"):
        raise ValueError("https only")
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})  # noqa: S310
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            return Answer(response.status, response.headers, response.read(MAX_BYTES))
    except urllib.error.HTTPError as error:
        return Answer(error.code, error.headers, b"")
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
        # Not reachable (yet): reported as status 0.
        return Answer(0, Message(), b"")


def header_problems(answer: Answer) -> Iterator[str]:
    if answer.status != 200:
        yield f"page: HTTP {answer.status}"
        return
    for name, expected in REQUIRED_HEADERS.items():
        value = answer.headers.get(name)
        if value is None:
            yield f"page: header {name} missing"
        elif expected not in value:
            yield f"page: header {name} does not contain {expected!r}"


def served_generation(get: Getter, site: str) -> str | None:
    answer = get(f"{site}/data/etat.json")
    if answer.status != 200:
        return None
    try:
        document = json.loads(answer.body)
    except ValueError:
        return None
    value = document.get("generated_at") if isinstance(document, dict) else None
    return value if isinstance(value, str) else None


def check(
    get: Getter,
    site: str,
    expected_generation: str,
    sleep: Callable[[float], None] = time.sleep,
) -> list[str]:
    site = site.rstrip("/")
    problems: list[str] = []

    served = None
    for attempt in range(ATTEMPTS):
        served = served_generation(get, site)
        if served == expected_generation:
            break
        if attempt < ATTEMPTS - 1:
            sleep(PAUSE)
    if served != expected_generation:
        problems.append(
            f"data: etat.json generated at {served} is served, {expected_generation} was built"
        )

    problems.extend(header_problems(get(f"{site}/")))
    for path in ("/nexiste-pas", "/_headers"):
        status = get(f"{site}{path}").status
        if status != 404:
            problems.append(f"{path}: HTTP {status}, 404 expected")
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    site, built = argv[1], Path(argv[2])
    expected = json.loads(built.read_text(encoding="utf-8"))["generated_at"]
    problems = check(http_get, site, expected)
    for problem in problems:
        print(f"::error title=Deployment check::{problem}")
    if not problems:
        print(f"Deployment checked: {site} serves the data generated at {expected}.")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
