from __future__ import annotations

from dataclasses import dataclass

from .models import ClipSuggestion, LiveEvent


EVENT_WEIGHTS = {
    "ace": 1.0,
    "clutch": 0.9,
    "multikill": 0.75,
    "entry": 0.55,
    "kill": 0.45,
}


@dataclass(frozen=True)
class ScoringConfig:
    pre_event_sec: float = 12.0
    post_event_sec: float = 18.0


def event_weight(event_type: str) -> float:
    key = (event_type or "").strip().lower()
    return EVENT_WEIGHTS.get(key, 0.35)


def score_event(event: LiveEvent) -> float:
    score = event_weight(event.type)
    if event.round and event.round >= 20:
        score += 0.05
    if event.player:
        score += 0.03
    return round(min(score, 1.0), 4)


def to_suggestion(event: LiveEvent, cfg: ScoringConfig) -> ClipSuggestion:
    score = score_event(event)
    label_player = event.player or "Unknown"
    label_team = f" ({event.team})" if event.team else ""
    label = f"{event.type.title()} - {label_player}{label_team}"

    start_sec = None
    end_sec = None
    if event.event_time is not None:
        start_sec = max(0.0, round(event.event_time - cfg.pre_event_sec, 3))
        end_sec = round(event.event_time + cfg.post_event_sec, 3)

    reason = f"Weighted {event.type} event (score={score:.2f})."
    return ClipSuggestion(
        id=f"suggestion:{event.id}",
        label=label,
        event_type=event.type,
        confidence=score,
        score=score,
        start_sec=start_sec,
        end_sec=end_sec,
        reason=reason,
    )


def suggest_highlights(
    events: list[LiveEvent],
    max_suggestions: int = 5,
    cfg: ScoringConfig | None = None,
) -> list[ClipSuggestion]:
    if not events:
        return []

    cfg = cfg or ScoringConfig()
    suggestions = [to_suggestion(event, cfg) for event in events]
    suggestions.sort(key=lambda item: (item.score, item.start_sec is not None, item.id), reverse=True)
    return suggestions[:max_suggestions]
