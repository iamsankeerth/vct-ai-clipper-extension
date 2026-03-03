from fastapi.testclient import TestClient

import service.app.main as app_main
from service.app.main import app


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["engine_ready"] is True


def test_suggest_endpoint_from_payload_events() -> None:
    response = client.post(
        "/highlights/suggest",
        json={
            "events": [
                {"id": "1", "type": "kill", "detected_at": 1},
                {"id": "2", "type": "ace", "detected_at": 2, "event_time": 120},
            ],
            "max_suggestions": 2,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["suggestions"]) == 2
    assert payload["suggestions"][0]["event_type"] == "ace"


def test_events_live_without_stream_url_returns_degraded_status() -> None:
    response = client.post("/events/live", json={"match_context": {}})
    assert response.status_code == 200
    payload = response.json()
    assert payload["events"] == []
    assert payload["source_status"] in {"no_stream_url", "unreachable"}


def test_clip_export_rejects_invalid_range() -> None:
    response = client.post(
        "/clip/export",
        json={
            "url": "https://www.youtube.com/watch?v=abc",
            "start_sec": 40,
            "end_sec": 30,
            "is_live": False,
        },
    )
    assert response.status_code == 400


def test_highlights_suggest_handles_provider_failure(monkeypatch) -> None:
    async def _boom(_context):
        raise RuntimeError("provider down")

    monkeypatch.setattr(app_main.provider, "fetch_live_events", _boom)
    response = client.post("/highlights/suggest", json={"match_context": {}})
    assert response.status_code == 200
    payload = response.json()
    assert payload["suggestions"] == []
    assert payload["source_status"] == "error"


def test_highlights_suggest_validates_max_suggestions_range() -> None:
    response = client.post(
        "/highlights/suggest",
        json={"events": [], "max_suggestions": 21},
    )
    assert response.status_code == 422
