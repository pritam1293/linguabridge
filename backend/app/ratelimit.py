"""In-process sliding-window rate limiter.

The service is local-only, so this protects against runaway UI loops and
accidental double-clicks rather than hostile traffic.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque


class SlidingWindowRateLimiter:
    def __init__(self, limit: int, window_s: float = 60.0) -> None:
        self._limit = max(1, limit)
        self._window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = asyncio.Lock()

    async def hit(self, key: str) -> float | None:
        """Record a request. Returns ``retry_after`` seconds when limited."""

        now = time.monotonic()
        async with self._lock:
            bucket = self._hits.setdefault(key, deque())
            while bucket and now - bucket[0] >= self._window_s:
                bucket.popleft()
            if len(bucket) >= self._limit:
                return max(0.001, self._window_s - (now - bucket[0]))
            bucket.append(now)
            if len(self._hits) > 1024:
                self._hits = {k: v for k, v in self._hits.items() if v}
            return None
