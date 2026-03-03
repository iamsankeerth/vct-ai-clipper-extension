from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MatchContext(BaseModel):
    event: str | None = None
    team_a: str | None = None
    team_b: str | None = None
    map: str | None = None
    stream_url: str | None = None
    source: Literal["vlr", "tracker", "manual"] = "vlr"


class LiveEvent(BaseModel):
    id: str
    type: str
    player: str | None = None
    team: str | None = None
    round: int | None = None
    event_time: float | None = Field(default=None, ge=0)
    detected_at: float = Field(default=0, ge=0)
    source: str = "vlr"


class ClipSuggestion(BaseModel):
    id: str
    label: str
    event_type: str
    confidence: float = Field(default=0, ge=0)
    score: float = Field(default=0, ge=0)
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)
    reason: str


class EventsLiveRequest(BaseModel):
    match_context: MatchContext = Field(default_factory=MatchContext)


class EventsLiveResponse(BaseModel):
    events: list[LiveEvent]
    source_status: str = "ok"
    lag_ms: int | None = None


class SuggestHighlightsRequest(BaseModel):
    match_context: MatchContext = Field(default_factory=MatchContext)
    events: list[LiveEvent] = Field(default_factory=list)
    max_suggestions: int = Field(default=5, ge=1, le=20)


class SuggestHighlightsResponse(BaseModel):
    suggestions: list[ClipSuggestion]
    source_status: str = "ok"


class ClipExportRequest(BaseModel):
    url: str
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    is_live: bool = False
    file_stem: str | None = None


class ClipExportResponse(BaseModel):
    ok: bool
    output_file: str | None = None
    warnings: list[str] = Field(default_factory=list)
