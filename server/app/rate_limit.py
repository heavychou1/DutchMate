from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock


class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int, window_seconds: int = 60) -> None:
        self.max_requests = max(1, max_requests)
        self.window_seconds = max(1, window_seconds)
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] < cutoff:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return False
            hits.append(now)
            return True
