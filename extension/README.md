# VCT Live AI Clipper (Chrome Extension)

## Capabilities

- Exact VOD clipping from timestamp ranges.
- Live manual capture (start/stop).
- Live rolling buffer export with one-click `Save Last 30 Seconds`.
- AI assist hooks:
  - `GET_ENGINE_HEALTH`
  - `AI_FETCH_LIVE_EVENTS`
  - `AI_SUGGEST_CLIPS`
- Safety fallback: clipping keeps working even if AI service is down.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. `Load unpacked` -> select this `extension/` directory.

## Local service expectation

Default AI service URL is `http://127.0.0.1:8787`.

If unreachable, the popup shows a warning and continues with manual clipping/live retro clipping.
