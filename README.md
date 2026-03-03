# VCT AI Clipper Extension (Lawn-First)

This repository is a Lawn-based workspace with an isolated Chrome clipping extension and a local Python AI service.

## Structure

- `ui/` - full `pingdotgg/lawn` codebase (UI foundation)
- `extension/` - MV3 YouTube clipper (VOD + live + rolling last-30s)
- `service/` - FastAPI highlight scoring service
- `tests/` - end-to-end validation checklist
- `.venv/` - Python virtual environment

## Why this split

- Clipping reliability is independent from AI/provider availability.
- Lawn UI base can evolve separately from extension runtime.
- Service failures degrade to manual/live clipping instead of breaking clip creation.

## Quick start

### 1) Service

```powershell
cd C:\Users\lenovo\Desktop\San\Fun_Projects\vct-ai-clipper-extension
.\.venv\Scripts\python.exe -m pip install -r .\service\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn service.app.main:app --host 127.0.0.1 --port 8787 --reload
```

### 2) Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `C:\Users\lenovo\Desktop\San\Fun_Projects\vct-ai-clipper-extension\extension`

### 3) Use

- VOD: mark two timestamps and download exact segment.
- Live: start rolling buffer and click `Save Last 30 Seconds`.
- AI: set match context and fetch/suggest highlights. If service fails, fallback remains manual/live.
- Feature flags in extension settings:
  - `ai_enabled` (`Enable AI suggestions`)
  - `live_auto_suggest` (`Auto-suggest every 8s on live streams`)
  - `provider_mode` (`vlr` / `tracker` / `manual`)
