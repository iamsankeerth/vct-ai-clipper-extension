const OFFSCREEN_DOCUMENT = "recorder.html";
const CAPTURE_MIME = "video/webm;codecs=vp9,opus";
const DEFAULT_HELPER_URL = "http://127.0.0.1:8799";
const DEFAULT_ENGINE_URL = "http://127.0.0.1:8787";
const DEFAULT_ROLLING_MAX_SEC = 180;
const SERVICE_TIMEOUT_MS = 7000;
const SERVICE_COOLDOWN_MS = 30000;
const SERVICE_FAILURE_LIMIT = 3;

let activeCapture = null;
let serviceFailures = 0;
let serviceCircuitOpenUntil = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getActiveTab(tabId) {
  if (typeof tabId === "number") {
    return chrome.tabs.get(tabId);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeHelperUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return DEFAULT_HELPER_URL;
  return value.replace(/\/+$/, "");
}

function normalizeEngineUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return DEFAULT_ENGINE_URL;
  return value.replace(/\/+$/, "");
}

function sanitizePart(text, maxLen) {
  const raw = String(text || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[^\w\s-]+/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const fallback = "unknown";
  return (raw || fallback).slice(0, maxLen);
}

function formatNowForFile(date = new Date()) {
  const y = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${mm}${dd}_${hh}${mi}${ss}`;
}

function buildFileStem({
  videoTitle,
  channelName,
  kind,
  startSec,
  endSec,
  lastSeconds
}) {
  const channel = sanitizePart(channelName || "unknown-channel", 30);
  const title = sanitizePart(videoTitle || "youtube-video", 60);
  const datePart = formatNowForFile();

  const parts = [channel, title, datePart];

  if (kind === "vod") {
    parts.push(`vod_${Math.floor(startSec)}s_to_${Math.floor(endSec)}s`);
  } else if (kind === "live") {
    parts.push("live_manual");
  } else if (kind === "rolling") {
    parts.push("rolling_buffer");
  } else if (kind === "live_last") {
    parts.push(`live_last_${Math.floor(lastSeconds)}s`);
  } else {
    parts.push("clip");
  }

  return parts.join("__");
}

function isServiceCircuitOpen() {
  return Date.now() < serviceCircuitOpenUntil;
}

function resetServiceCircuit() {
  serviceFailures = 0;
  serviceCircuitOpenUntil = 0;
}

function markServiceFailure() {
  serviceFailures += 1;
  if (serviceFailures >= SERVICE_FAILURE_LIMIT) {
    serviceCircuitOpenUntil = Date.now() + SERVICE_COOLDOWN_MS;
  }
}

async function callLocalService(path, options = {}) {
  const baseUrl = normalizeEngineUrl(options.engineUrl);
  const target = `${baseUrl}${path}`;

  if (isServiceCircuitOpen()) {
    const waitMs = Math.max(0, serviceCircuitOpenUntil - Date.now());
    const waitSec = Math.ceil(waitMs / 1000);
    throw new Error(`AI service temporarily paused after repeated failures. Retry in ${waitSec}s.`);
  }

  const timeoutMs = clampInt(options.timeoutMs, SERVICE_TIMEOUT_MS, 1000, 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(parsed?.error || `Service request failed (${response.status}).`);
    }

    resetServiceCircuit();
    return parsed;
  } catch (error) {
    markServiceFailure();

    if (error?.name === "AbortError") {
      throw new Error("AI service timeout.");
    }

    throw new Error(error instanceof Error ? error.message : "AI service request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function hasOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
    justification: "Capture tab media, record clips, and save them as downloads."
  });
}

async function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...payload });
}

async function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload);
}

async function beginCaptureForTab(tabId, options) {
  if (activeCapture) {
    throw new Error("Another capture is already running. Stop it first.");
  }

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const start = await sendToOffscreen({
    type: "OFFSCREEN_START_CAPTURE",
    streamId,
    mimeType: CAPTURE_MIME,
    fileStem: options.fileStem,
    captureMode: options.captureMode || "standard",
    maxBufferSec: options.maxBufferSec
  });

  if (!start?.ok) {
    throw new Error(start?.error || "Failed to start capture.");
  }

  activeCapture = {
    tabId,
    mode: options.mode || "unknown",
    captureMode: options.captureMode || "standard",
    fileStem: options.fileStem,
    maxBufferSec: options.maxBufferSec || null,
    startedAt: Date.now()
  };
}

async function stopCapture(options = {}) {
  const stop = await sendToOffscreen({
    type: "OFFSCREEN_STOP_CAPTURE",
    fileStem: options.fileStem || activeCapture?.fileStem,
    convertToMp4: Boolean(options.convertToMp4),
    helperUrl: normalizeHelperUrl(options.helperUrl)
  });

  if (!stop?.ok) {
    throw new Error(stop?.error || "Failed to stop capture.");
  }

  activeCapture = null;
  return stop;
}

async function cancelCaptureSilently() {
  if (!activeCapture) return;
  await sendToOffscreen({ type: "OFFSCREEN_CANCEL_CAPTURE" }).catch(() => undefined);
  activeCapture = null;
}

async function handleStartVodClip(request) {
  const tab = await getActiveTab(request.tabId);
  if (!tab?.id) throw new Error("Could not find target tab.");

  const startSec = Number(request.startSec);
  const endSec = Number(request.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error("Invalid timestamp range.");
  }

  const fileStem = buildFileStem({
    videoTitle: request.videoTitle,
    channelName: request.channelName,
    kind: "vod",
    startSec,
    endSec
  });

  const durationMs = Math.max(250, Math.round((endSec - startSec) * 1000));

  let prepared = false;
  let playbackStarted = false;

  try {
    await sendToTab(tab.id, { type: "PREPARE_CLIP_PLAYBACK", startSec });
    prepared = true;

    await beginCaptureForTab(tab.id, {
      mode: "vod",
      captureMode: "standard",
      fileStem
    });

    const startPlayback = await sendToTab(tab.id, { type: "START_CLIP_PLAYBACK" });
    if (!startPlayback?.ok) {
      throw new Error(startPlayback?.error || "Unable to play video for clipping.");
    }
    playbackStarted = true;

    await sleep(durationMs);

    if (playbackStarted) {
      await sendToTab(tab.id, { type: "PAUSE_CLIP_PLAYBACK" }).catch(() => undefined);
    }

    const result = await stopCapture({
      fileStem,
      convertToMp4: request.convertToMp4,
      helperUrl: request.helperUrl
    });

    if (prepared) {
      await sendToTab(tab.id, { type: "RESTORE_CLIP_PLAYBACK" }).catch(() => undefined);
    }

    return {
      ok: true,
      mode: "vod",
      ...result
    };
  } catch (error) {
    await cancelCaptureSilently();

    if (prepared) {
      await sendToTab(tab.id, { type: "RESTORE_CLIP_PLAYBACK" }).catch(() => undefined);
    }

    throw error;
  }
}

async function handleStartLiveCapture(request) {
  const tab = await getActiveTab(request.tabId);
  if (!tab?.id) throw new Error("Could not find target tab.");
  if (activeCapture) {
    throw new Error("A capture is already running. Stop it before starting a live clip.");
  }

  const fileStem = buildFileStem({
    videoTitle: request.videoTitle,
    channelName: request.channelName,
    kind: "live"
  });

  await beginCaptureForTab(tab.id, {
    mode: "live",
    captureMode: "standard",
    fileStem
  });

  await sendToTab(tab.id, { type: "ADD_TIMESTAMP", label: "LIVE_START" }).catch(() => undefined);

  return {
    ok: true,
    mode: "live",
    tabId: tab.id,
    startedAt: activeCapture.startedAt,
    fileStem
  };
}

async function handleStopLiveCapture(request) {
  if (!activeCapture || activeCapture.mode !== "live") {
    throw new Error("No active live capture found.");
  }

  if (typeof request.tabId === "number" && request.tabId !== activeCapture.tabId) {
    throw new Error("Live capture belongs to a different tab.");
  }

  const tabId = activeCapture.tabId;
  const fileStem = activeCapture.fileStem;

  const result = await stopCapture({
    fileStem,
    convertToMp4: request.convertToMp4,
    helperUrl: request.helperUrl
  });

  await sendToTab(tabId, { type: "ADD_TIMESTAMP", label: "LIVE_END" }).catch(() => undefined);

  return {
    ok: true,
    mode: "live",
    ...result
  };
}

async function handleStartRollingBuffer(request) {
  const tab = await getActiveTab(request.tabId);
  if (!tab?.id) throw new Error("Could not find target tab.");
  if (activeCapture) {
    throw new Error("A capture is already running. Stop it before starting rolling buffer mode.");
  }

  const maxBufferSec = clampInt(request.maxBufferSec, DEFAULT_ROLLING_MAX_SEC, 10, 1800);
  const fileStem = buildFileStem({
    videoTitle: request.videoTitle,
    channelName: request.channelName,
    kind: "rolling"
  });

  await beginCaptureForTab(tab.id, {
    mode: "rolling",
    captureMode: "rolling",
    fileStem,
    maxBufferSec
  });

  await sendToTab(tab.id, { type: "ADD_TIMESTAMP", label: "ROLLING_ON" }).catch(() => undefined);

  return {
    ok: true,
    mode: "rolling",
    tabId: tab.id,
    startedAt: activeCapture.startedAt,
    maxBufferSec
  };
}

async function handleExportLastNSeconds(request) {
  if (!activeCapture || activeCapture.mode !== "rolling") {
    throw new Error("Rolling buffer mode is not active.");
  }

  if (typeof request.tabId === "number" && request.tabId !== activeCapture.tabId) {
    throw new Error("Rolling buffer is active in another tab.");
  }

  const maxForCapture = activeCapture.maxBufferSec || DEFAULT_ROLLING_MAX_SEC;
  const seconds = clampInt(request.seconds, 30, 1, maxForCapture);
  const fileStem = buildFileStem({
    videoTitle: request.videoTitle,
    channelName: request.channelName,
    kind: "live_last",
    lastSeconds: seconds
  });

  const result = await sendToOffscreen({
    type: "OFFSCREEN_EXPORT_LAST_N",
    seconds,
    fileStem,
    convertToMp4: Boolean(request.convertToMp4),
    helperUrl: normalizeHelperUrl(request.helperUrl)
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not export the rolling buffer clip.");
  }

  await sendToTab(activeCapture.tabId, {
    type: "ADD_TIMESTAMP",
    label: `LAST_${seconds}s`
  }).catch(() => undefined);

  return {
    ok: true,
    mode: "rolling",
    ...result
  };
}

async function handleStopRollingBuffer(request) {
  if (!activeCapture || activeCapture.mode !== "rolling") {
    throw new Error("No active rolling buffer found.");
  }

  if (typeof request.tabId === "number" && request.tabId !== activeCapture.tabId) {
    throw new Error("Rolling buffer belongs to a different tab.");
  }

  const tabId = activeCapture.tabId;
  await cancelCaptureSilently();
  await sendToTab(tabId, { type: "ADD_TIMESTAMP", label: "ROLLING_OFF" }).catch(() => undefined);

  return {
    ok: true,
    mode: "rolling"
  };
}

function mergeWarnings(...warnings) {
  const merged = warnings
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!merged.length) return null;
  return merged.join(" ");
}

async function handleCreateClipFromRange(request, senderTabId) {
  const tabId = typeof request.tabId === "number" ? request.tabId : senderTabId;
  if (!tabId) {
    throw new Error("Could not resolve the source tab for clip creation.");
  }

  const startSec = Number(request.startSec);
  const endSec = Number(request.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new Error("Invalid clip range.");
  }
  if (endSec <= startSec) {
    throw new Error("End timestamp must be after start timestamp.");
  }

  const isLive = Boolean(request.isLive);

  if (!isLive) {
    return handleStartVodClip({
      ...request,
      tabId,
      startSec,
      endSec
    });
  }

  if (!activeCapture || activeCapture.mode !== "rolling" || activeCapture.tabId !== tabId) {
    throw new Error("Start Rolling Buffer first, then create a live quick clip.");
  }

  const maxForCapture = activeCapture.maxBufferSec || DEFAULT_ROLLING_MAX_SEC;
  const rawSeconds = endSec - startSec;
  const seconds = clampInt(rawSeconds, 1, 1, maxForCapture);
  const clamped = seconds !== Math.round(rawSeconds);

  const exportResult = await handleExportLastNSeconds({
    ...request,
    tabId,
    seconds
  });

  const clampWarning = clamped
    ? `Requested range exceeded buffer; exported last ${seconds}s instead.`
    : null;

  return {
    ...exportResult,
    mode: "live",
    warning: mergeWarnings(exportResult.warning, clampWarning)
  };
}

async function handleGetEngineHealth(request) {
  try {
    const response = await callLocalService("/health", {
      engineUrl: request.engineUrl,
      method: "GET",
      timeoutMs: 2500
    });

    return {
      ok: true,
      status: response.status || "ok",
      engineReady: Boolean(response.engine_ready ?? true),
      sourcesReady: Boolean(response.sources_ready ?? true),
      circuitOpen: false,
      failures: serviceFailures
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "AI service unavailable.",
      engineReady: false,
      sourcesReady: false,
      circuitOpen: isServiceCircuitOpen(),
      failures: serviceFailures,
      fallback: true
    };
  }
}

async function handleAiFetchLiveEvents(request) {
  try {
    const response = await callLocalService("/events/live", {
      engineUrl: request.engineUrl,
      method: "POST",
      body: {
        match_context: request.matchContext || {}
      },
      timeoutMs: SERVICE_TIMEOUT_MS
    });

    return {
      ok: true,
      events: Array.isArray(response.events) ? response.events : [],
      sourceStatus: response.source_status || "ok",
      lagMs: response.lag_ms ?? null,
      fallback: false
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not fetch live events.",
      events: [],
      sourceStatus: "degraded",
      fallback: true
    };
  }
}

async function handleAiSuggestClips(request) {
  try {
    const response = await callLocalService("/highlights/suggest", {
      engineUrl: request.engineUrl,
      method: "POST",
      body: {
        match_context: request.matchContext || {},
        events: Array.isArray(request.events) ? request.events : [],
        max_suggestions: clampInt(request.maxSuggestions, 5, 1, 20)
      },
      timeoutMs: SERVICE_TIMEOUT_MS
    });

    return {
      ok: true,
      suggestions: Array.isArray(response.suggestions) ? response.suggestions : [],
      sourceStatus: response.source_status || "ok",
      fallback: false
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not generate suggestions.",
      suggestions: [],
      sourceStatus: "degraded",
      fallback: true
    };
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeCapture || activeCapture.tabId !== tabId) return;
  cancelCaptureSilently();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const run = async () => {
    try {
      switch (request?.type) {
        case "PING_BACKGROUND":
          return { ok: true, activeCapture };

        case "START_VOD_CLIP":
          return await handleStartVodClip(request);

        case "START_LIVE_CAPTURE":
          return await handleStartLiveCapture(request);

        case "STOP_LIVE_CAPTURE":
          return await handleStopLiveCapture(request);

        case "START_ROLLING_BUFFER":
          return await handleStartRollingBuffer(request);

        case "EXPORT_LAST_N_SECONDS":
          return await handleExportLastNSeconds(request);

        case "STOP_ROLLING_BUFFER":
          return await handleStopRollingBuffer(request);

        case "CREATE_CLIP_FROM_RANGE":
          return await handleCreateClipFromRange(request, sender?.tab?.id);

        case "GET_CAPTURE_STATE":
          return { ok: true, activeCapture };

        case "GET_ENGINE_HEALTH":
          return await handleGetEngineHealth(request);

        case "AI_FETCH_LIVE_EVENTS":
          return await handleAiFetchLiveEvents(request);

        case "AI_SUGGEST_CLIPS":
          return await handleAiSuggestClips(request);

        default:
          return { ok: false, error: "Unknown background request." };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected background error."
      };
    }
  };

  run().then(sendResponse);
  return true;
});
