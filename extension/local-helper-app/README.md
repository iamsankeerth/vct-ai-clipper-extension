# Exact Clipper Local Helper (MP4 Conversion)

This optional helper converts recorded WebM clips to MP4 for the Chrome extension.

## Requirements
- Node.js 18+
- `ffmpeg` installed and available in PATH  
  or set `FFMPEG_PATH` environment variable

## Install
```bash
cd local-helper-app
npm install
```

## Run
```bash
npm start
```

Default server URL:
`http://127.0.0.1:8799`

Health check:
`GET /health`

## API
`POST /transcode/webm-to-mp4` (multipart/form-data)
- field: `file` (required, WebM file)
- field: `fileStem` (optional)

Response:
- MP4 file bytes (`video/mp4`)

## Notes
- If helper is offline, extension falls back to WebM download.
- Conversion quality is tuned for speed and compatibility (`libx264 + aac`).
