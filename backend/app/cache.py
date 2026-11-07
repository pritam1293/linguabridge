"""Small async TTL + LRU cache for translation results."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any


class TTLCache:
    def __init__(self, max_entries: int, ttl_s: int) -> None:
        self._max_entries = max(1, max_entries)
        self._ttl_s = max(1, ttl_s)
        self._data: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> dict[str, Any] | None:
        async with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at <= time.monotonic():
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    async def set(self, key: str, value: dict[str, Any]) -> None:
        async with self._lock:
            self._data[key] = (time.monotonic() + self._ttl_s, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max_entries:
                self._data.popitem(last=False)

    async def clear(self) -> None:
        async with self._lock:
            self._data.clear()
