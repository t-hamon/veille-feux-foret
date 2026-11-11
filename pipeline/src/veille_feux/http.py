"""Defensive HTTP fetching for the pipeline.

The pipeline runs in CI with write access, so every fetch is restricted to
https URLs on the hosts of ``sources.ALLOWED_HOSTS``, redirects included, and
responses are read in chunks up to a size cap. A request that carries
credentials is never redirected, so they cannot leave for another URL.
"""

from __future__ import annotations

import http.client
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


class HttpStatusError(FetchError):
    """The server answered with another status than 200."""

    def __init__(self, status: int, url: str) -> None:
        super().__init__(f"HTTP {status} for {url}")
        self.status = status


class ResponseTooLargeError(FetchError):
    """The response went over the size cap."""


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
        # urllib would send the Authorization header again to the new URL.
        if req.has_header("Authorization"):
            raise FetchError(f"refusing to redirect a request with credentials to {newurl}")
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
            raise ResponseTooLargeError(f"response larger than {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


# Errors a fetch may raise: callers catch this tuple to record a source outage.
FETCH_ERRORS: tuple[type[BaseException], ...] = (
    FetchError,
    urllib.error.URLError,
    TimeoutError,
    OSError,
    # Response cut short (IncompleteRead) or not HTTP at all (BadStatusLine...).
    http.client.HTTPException,
)


def fetch(
    url: str,
    max_bytes: int,
    timeout: float,
    opener: Opener = default_opener,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
) -> tuple[int, bytes]:
    """GET the URL, or POST ``data`` when given, with the extra ``headers``.

    Error messages name the URL only: never a header, which may hold credentials.
    """
    check_url(url)
    # check_url() has just restricted the URL to https and the allow list.
    request = urllib.request.Request(  # noqa: S310
        url, data=data, headers={"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})}
    )
    with opener(request, timeout) as response:
        status = int(getattr(response, "status", 200))
        if status != 200:
            raise HttpStatusError(status, url)
        return status, read_limited(response, max_bytes)
