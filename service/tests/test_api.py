from fastapi.testclient import TestClient

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
