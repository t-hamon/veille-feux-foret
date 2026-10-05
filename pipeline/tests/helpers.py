"""Shared test helpers: a fake HTTP opener and access to the real fixtures."""

from __future__ import annotations

import gzip
import io
import urllib.request
from pathlib import Path
from typing import Any

from veille_feux.http import Opener

FIXTURES = Path(__file__).parent / "fixtures"


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status


def make_opener(bodies: dict[str, bytes | Exception], status: int = 200) -> Opener:
    """Answer each URL with its body, or raise the given exception."""

    def opener(request: urllib.request.Request, timeout: float) -> Any:
        result = bodies[request.full_url]
        if isinstance(result, Exception):
            raise result
        return FakeResponse(result, status)

    return opener


def fixture_bytes(name: str) -> bytes:
    """Content of a captured fixture, decompressed when it is gzip."""
    path = FIXTURES / name
    data = path.read_bytes()
    return gzip.decompress(data) if path.suffix == ".gz" else data
