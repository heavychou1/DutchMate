from __future__ import annotations

import time
from collections import OrderedDict
from threading import Lock
from typing import Any


class TTLCache:
    def __init__(self, max_entries: int, ttl_seconds: int) -> None:
        self.max_entries = max(1, max_entries)
        self.ttl_seconds = max(1, ttl_seconds)
        self._items: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._lock = Lock()

    def get(self, key: str) -> dict[str, Any] | None:
        now = time.monotonic()
        with self._lock:
            item = self._items.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at <= now:
                self._items.pop(key, None)
                return None
            self._items.move_to_end(key)
            return dict(value)

    def set(self, key: str, value: dict[str, Any]) -> None:
        expires_at = time.monotonic() + self.ttl_seconds
        with self._lock:
            self._items[key] = (expires_at, dict(value))
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def __len__(self) -> int:
        now = time.monotonic()
        with self._lock:
            expired = [key for key, (expires_at, _) in self._items.items() if expires_at <= now]
            for key in expired:
                self._items.pop(key, None)
            return len(self._items)
