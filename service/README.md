# VCT AI Clipper Service

Local FastAPI service for lag-tolerant highlight suggestions and clip-export validation.

## Run

```powershell
cd C:\Users\lenovo\Desktop\San\Fun_Projects\vct-ai-clipper-extension
.\.venv\Scripts\python.exe -m pip install -r .\service\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn service.app.main:app --host 127.0.0.1 --port 8787 --reload
```

## Endpoints

- `GET /health`
- `POST /events/live`
- `POST /highlights/suggest`
- `POST /clip/export`

## Notes

- Manual/live clipping in the extension is intentionally independent from this service.
- If the service is down, extension fallback keeps clipping available.
