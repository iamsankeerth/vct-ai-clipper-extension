from __future__ import annotations

from time import time

from fastapi import FastAPI, HTTPException

from .models import (
    ClipExportRequest,
    ClipExportResponse,
    EventsLiveRequest,
    EventsLiveResponse,
    SuggestHighlightsRequest,
    SuggestHighlightsResponse,
)
from .providers.vlr import VlrProvider
from .scoring import suggest_highlights

app = FastAPI(title="VCT AI Clipper Service", version="0.1.0")
provider = VlrProvider()


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "engine_ready": True,
        "sources_ready": True,
        "timestamp": time(),
    }


@app.post("/events/live", response_model=EventsLiveResponse)
async def events_live(request: EventsLiveRequest) -> EventsLiveResponse:
    try:
        events, status = await provider.fetch_live_events(request.match_context)
    except Exception:
        events, status = [], "error"
    return EventsLiveResponse(events=events, source_status=status, lag_ms=None)


@app.post("/highlights/suggest", response_model=SuggestHighlightsResponse)
async def highlights_suggest(request: SuggestHighlightsRequest) -> SuggestHighlightsResponse:
    events = request.events
    source_status = "from_request"

    if not events:
        try:
            events, source_status = await provider.fetch_live_events(request.match_context)
        except Exception:
            events, source_status = [], "error"

    suggestions = suggest_highlights(events, max_suggestions=request.max_suggestions)
    return SuggestHighlightsResponse(suggestions=suggestions, source_status=source_status)


@app.post("/clip/export", response_model=ClipExportResponse)
async def clip_export(request: ClipExportRequest) -> ClipExportResponse:
    if request.end_sec <= request.start_sec:
        raise HTTPException(status_code=400, detail="end_sec must be greater than start_sec")

    # Export integration hook for yt_clipper/native pipeline.
    # Returning validated metadata keeps the extension non-blocking while the clip
    # worker is not active.
    return ClipExportResponse(
        ok=True,
        output_file=request.file_stem or "pending-export.webm",
        warnings=["Clip export validated only; worker integration pending."],
    )
