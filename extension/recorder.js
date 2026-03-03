let mediaStream = null;
let mediaRecorder = null;
let activeMode = "inactive";
let activeFileStem = null;
let activeMimeType = "video/webm";
let standardChunks = [];
let rollingChunks = [];
let maxRollingBufferMs = 180000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function sanitizeFileStem(stem) {
  const cleaned = String(stem || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `clip_${Date.now()}`;
}

function normalizeHelperUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "http://127.0.0.1:8799";
  return value.replace(/\/+$/, "");
}

function pickMimeType(requestedMimeType) {
  const candidates = [
    requestedMimeType,
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "video/webm";
}

function pruneRollingChunks() {
  const cutoff = Date.now() - maxRollingBufferMs;
  rollingChunks = rollingChunks.filter((entry) => entry.ts >= cutoff);
}

async function transcodeToMp4(webmBlob, helperUrl, fileStem) {
  const endpoint = `${normalizeHelperUrl(helperUrl)}/transcode/webm-to-mp4`;
  const form = new FormData();
  form.append("file", webmBlob, `${fileStem}.webm`);
  form.append("fileStem", fileStem);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      body: form
    });
  } catch (error) {
    throw new Error(
      `Cannot reach helper app at ${endpoint}. Start the helper server before MP4 conversion.`
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Helper conversion failed (${response.status}): ${details || "Unknown error"}`);
  }

  const buffer = await response.arrayBuffer();
  const mp4Blob = new Blob([buffer], { type: "video/mp4" });
  if (mp4Blob.size === 0) {
    throw new Error("Helper returned an empty MP4 file.");
  }

  return mp4Blob;
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return downloadId;
}

async function exportBlob({
  sourceBlob,
  fileStem,
  convertToMp4,
  helperUrl
}) {
  const safeStem = sanitizeFileStem(fileStem || activeFileStem);
  let finalBlob = sourceBlob;
  let finalName = `${safeStem}.webm`;
  let converted = false;
  let warning = null;

  if (convertToMp4) {
    try {
      finalBlob = await transcodeToMp4(sourceBlob, helperUrl, safeStem);
      finalName = `${safeStem}.mp4`;
      converted = true;
    } catch (error) {
      warning = error instanceof Error ? error.message : "MP4 conversion failed.";
    }
  }

  const downloadId = await downloadBlob(finalBlob, finalName);
  return {
    ok: true,
    bytes: finalBlob.size,
    downloadId,
    filename: finalName,
    converted,
    warning
  };
}

async function stopTracksAndRecorder() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      const finalize = () => resolve();
      mediaRecorder.onstop = finalize;
      mediaRecorder.stop();
    });
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }
}

function resetState() {
  mediaStream = null;
  mediaRecorder = null;
  activeMode = "inactive";
  activeFileStem = null;
  activeMimeType = "video/webm";
  standardChunks = [];
  rollingChunks = [];
}

async function startCapture({
  streamId,
  mimeType,
  fileStem,
  captureMode,
  maxBufferSec
}) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    throw new Error("Capture already running.");
  }
  if (!streamId) {
    throw new Error("Missing streamId.");
  }

  const mode = captureMode === "rolling" ? "rolling" : "standard";
  activeMode = mode;
  activeFileStem = sanitizeFileStem(fileStem);
  maxRollingBufferMs = clampInt(maxBufferSec, 180, 10, 1800) * 1000;

  standardChunks = [];
  rollingChunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: 30
      }
    }
  });

  activeMimeType = pickMimeType(mimeType);
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: activeMimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size <= 0) return;
    if (activeMode === "rolling") {
      rollingChunks.push({ blob: event.data, ts: Date.now() });
      pruneRollingChunks();
      return;
    }
    standardChunks.push(event.data);
  };

  mediaRecorder.start(500);

  return {
    ok: true,
    mode: activeMode,
    fileStem: activeFileStem,
    mimeType: activeMimeType
  };
}

async function stopCapture({
  fileStem,
  convertToMp4,
  helperUrl
}) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("No active capture to stop.");
  }

  const modeAtStop = activeMode;
  const finalStem = sanitizeFileStem(fileStem || activeFileStem);

  const blob = await new Promise((resolve, reject) => {
    mediaRecorder.onerror = (event) => {
      reject(event?.error || new Error("MediaRecorder error."));
    };

    mediaRecorder.onstop = () => {
      const data = modeAtStop === "rolling"
        ? rollingChunks.map((entry) => entry.blob)
        : standardChunks;
      resolve(new Blob(data, { type: activeMimeType || "video/webm" }));
    };

    mediaRecorder.stop();
  });

  await stopTracksAndRecorder();

  const result = await exportBlob({
    sourceBlob: blob,
    fileStem: finalStem,
    convertToMp4: Boolean(convertToMp4),
    helperUrl
  });

  resetState();
  return result;
}

async function exportLastNSeconds({
  seconds,
  fileStem,
  convertToMp4,
  helperUrl
}) {
  if (!mediaRecorder || mediaRecorder.state === "inactive" || activeMode !== "rolling") {
    throw new Error("Rolling buffer mode is not active.");
  }

  const clipSec = clampInt(seconds, 30, 1, 1800);
  mediaRecorder.requestData();
  await sleep(140);

  pruneRollingChunks();
  const cutoff = Date.now() - clipSec * 1000;
  const selected = rollingChunks.filter((entry) => entry.ts >= cutoff);

  if (!selected.length) {
    throw new Error("No buffered media available yet. Wait a moment and try again.");
  }

  const blob = new Blob(selected.map((entry) => entry.blob), {
    type: activeMimeType || "video/webm"
  });

  return exportBlob({
    sourceBlob: blob,
    fileStem: fileStem || activeFileStem,
    convertToMp4: Boolean(convertToMp4),
    helperUrl
  });
}

async function cancelCapture() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    resetState();
    return { ok: true };
  }

  await new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
    mediaRecorder.stop();
  });

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }

  resetState();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  const run = async () => {
    try {
      switch (message.type) {
        case "OFFSCREEN_START_CAPTURE":
          return await startCapture(message);

        case "OFFSCREEN_STOP_CAPTURE":
          return await stopCapture(message);

        case "OFFSCREEN_EXPORT_LAST_N":
          return await exportLastNSeconds(message);

        case "OFFSCREEN_CANCEL_CAPTURE":
          return await cancelCapture();

        default:
          return { ok: false, error: "Unknown offscreen request." };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Offscreen recorder failure."
      };
    }
  };

  run().then(sendResponse);
  return true;
});
