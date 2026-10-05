"""Defensive HTTP fetching for the pipeline.

The pipeline runs in CI with write access, so every fetch is restricted to
https URLs on the hosts of ``sources.ALLOWED_HOSTS``, redirects included, and
responses are read in chunks up to a size cap.
"""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import IO, Any

from veille_feux.sources import ALLOWED_HOSTS

USER_AGENT = "veille-feux-foret/0.1 (+https://github.com/t-hamon/veille-feux-foret)"
CHUNK_SIZE = 64 * 1024


class FetchError(Exception):
    """Raised when a URL cannot be fetched safely or completely."""


def check_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        raise FetchError(f"refusing non-https URL: {url}")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise FetchError(f"refusing host outside the allow list: {parsed.hostname}")


class _AllowListRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only towards hosts of the allow list."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


Opener = Callable[[urllib.request.Request, float], Any]


def default_opener(request: urllib.request.Request, timeout: float) -> Any:
    opener = urllib.request.build_opener(_AllowListRedirectHandler())
    # The URL has been checked against the https allow list before this call.
    return opener.open(request, timeout=timeout)  # nosec B310


def read_limited(stream: IO[bytes], max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise FetchError(f"response larger than {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


# Errors a fetch may raise: callers catch this tuple to record a source outage.
FETCH_ERRORS: tuple[type[BaseException], ...] = (
    FetchError,
    urllib.error.URLError,
    TimeoutError,
    OSError,
)


def fetch(
    url: str, max_bytes: int, timeout: float, opener: Opener = default_opener
) -> tuple[int, bytes]:
    check_url(url)
    # check_url() has just restricted the URL to https and the allow list.
    request = urllib.request.Request(  # noqa: S310
        url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
    )
    with opener(request, timeout) as response:
        status = int(getattr(response, "status", 200))
        if status != 200:
            raise FetchError(f"HTTP {status} for {url}")
        return status, read_limited(response, max_bytes)
