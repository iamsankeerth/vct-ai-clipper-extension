from __future__ import annotations

from collections.abc import Sequence
from time import time

import httpx

from ..models import LiveEvent, MatchContext


class VlrProvider:
    """
    Free-first provider adapter.

    The service accepts either:
    - source URL from match_context.stream_url
    - or returns empty events when no compatible source is available.
    """

    async def fetch_live_events(self, context: MatchContext) -> tuple[list[LiveEvent], str]:
        if not context.stream_url:
            return [], "no_stream_url"

        # Optional lightweight integration point for external adapters.
        # Expected payload shape: {"events":[...]} where fields map to LiveEvent.
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                response = await client.get(context.stream_url)
                response.raise_for_status()
                payload = response.json()
        except Exception:
            return [], "unreachable"

        raw_events = payload.get("events", []) if isinstance(payload, dict) else []
        events = self._normalize_events(raw_events)
        return events, "ok"

    def _normalize_events(self, raw_events: Sequence[dict]) -> list[LiveEvent]:
        normalized: list[LiveEvent] = []

        for index, item in enumerate(raw_events):
            if not isinstance(item, dict):
                continue
            event_type = str(item.get("type") or "kill").strip().lower()
            event_id = str(item.get("id") or f"evt_{index}_{int(time())}")
            normalized.append(
                LiveEvent(
                    id=event_id,
                    type=event_type,
                    player=item.get("player"),
                    team=item.get("team"),
                    round=item.get("round"),
                    event_time=item.get("event_time"),
                    detected_at=float(item.get("detected_at") or time()),
                    source=str(item.get("source") or "vlr"),
                )
            )

        return normalized
