from service.app.models import LiveEvent
from service.app.scoring import score_event, suggest_highlights, to_suggestion, ScoringConfig


def test_scoring_priority_ace_above_clutch_and_kill() -> None:
    ace = LiveEvent(id="1", type="ace", player="foo", detected_at=1.0)
    clutch = LiveEvent(id="2", type="clutch", player="bar", detected_at=1.0)
    kill = LiveEvent(id="3", type="kill", player="baz", detected_at=1.0)

    assert score_event(ace) > score_event(clutch) > score_event(kill)


def test_suggestions_limit_and_sort() -> None:
    events = [
        LiveEvent(id="a", type="kill", detected_at=1.0),
        LiveEvent(id="b", type="ace", detected_at=2.0, event_time=100),
        LiveEvent(id="c", type="clutch", detected_at=3.0, event_time=200),
    ]

    suggestions = suggest_highlights(events, max_suggestions=2)
    assert len(suggestions) == 2
    assert suggestions[0].event_type == "ace"


def test_to_suggestion_builds_clip_window_from_event_time() -> None:
    event = LiveEvent(id="w1", type="ace", detected_at=1.0, event_time=50)
    suggestion = to_suggestion(event, ScoringConfig(pre_event_sec=10, post_event_sec=15))
    assert suggestion.start_sec == 40
    assert suggestion.end_sec == 65


def test_unknown_event_type_uses_default_weight() -> None:
    event = LiveEvent(id="u1", type="wallbang", detected_at=1.0)
    assert score_event(event) == 0.35
