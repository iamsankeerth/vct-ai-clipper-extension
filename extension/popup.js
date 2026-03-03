let activeTab = null;
let currentState = null;
let aiState = {
  events: [],
  suggestions: []
};

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  engineUrl: "http://127.0.0.1:8787",
  convertToMp4: false,
  helperUrl: "http://127.0.0.1:8799",
  rollingMaxSec: 180,
  lastNSeconds: 30
};

let settings = { ...DEFAULT_SETTINGS };

const statusNode = document.getElementById("status");
const timestampList = document.getElementById("timestampList");
const suggestionList = document.getElementById("suggestionList");
const startSelect = document.getElementById("startSelect");
const endSelect = document.getElementById("endSelect");
const vodSection = document.getElementById("vodSection");
const liveSection = document.getElementById("liveSection");
const rollingSection = document.getElementById("rollingSection");

const addTimestampBtn = document.getElementById("addTimestamp");
const clearTimestampsBtn = document.getElementById("clearTimestamps");
const downloadVodBtn = document.getElementById("downloadVod");
const startLiveBtn = document.getElementById("startLive");
const stopLiveBtn = document.getElementById("stopLive");
const startRollingBtn = document.getElementById("startRolling");
const stopRollingBtn = document.getElementById("stopRolling");
const saveLast30Btn = document.getElementById("saveLast30");
const saveLastNBtn = document.getElementById("saveLastN");

const enableAiInput = document.getElementById("enableAi");
const engineUrlInput = document.getElementById("engineUrl");
const enableMp4Input = document.getElementById("enableMp4");
const helperUrlInput = document.getElementById("helperUrl");
const saveSettingsBtn = document.getElementById("saveSettings");
const rollingMaxSecInput = document.getElementById("rollingMaxSec");
const lastNSecondsInput = document.getElementById("lastNSeconds");

const matchEventInput = document.getElementById("matchEvent");
const teamAInput = document.getElementById("teamA");
const teamBInput = document.getElementById("teamB");
const mapNameInput = document.getElementById("mapName");
const engineHealthBtn = document.getElementById("engineHealth");
const fetchEventsBtn = document.getElementById("fetchEvents");
const suggestHighlightsBtn = document.getElementById("suggestHighlights");
const clipTopSuggestionBtn = document.getElementById("clipTopSuggestion");

function setStatus(text, isError = false) {
  statusNode.textContent = text;
  statusNode.style.color = isError ? "#b31228" : "#415165";
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeUrl(rawUrl, fallback) {
  const value = String(rawUrl || "").trim();
  if (!value) return fallback;
  return value.replace(/\/+$/, "");
}

function getVideoMeta() {
  return {
    videoTitle: currentState?.title || "youtube-video",
    channelName: currentState?.channelName || "unknown-channel"
  };
}

function getMatchContext() {
  return {
    event: matchEventInput.value.trim() || undefined,
    team_a: teamAInput.value.trim() || undefined,
    team_b: teamBInput.value.trim() || undefined,
    map: mapNameInput.value.trim() || undefined,
    stream_url: currentState?.url || undefined,
    source: "vlr"
  };
}

function renderSuggestions() {
  suggestionList.innerHTML = "";

  if (!settings.aiEnabled) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "AI is disabled in settings.";
    suggestionList.appendChild(li);
    return;
  }

  if (!aiState.suggestions.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No suggestions yet.";
    suggestionList.appendChild(li);
    return;
  }

  aiState.suggestions.forEach((item, index) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = `${index + 1}. ${item.label || item.event_type || "Highlight"}`;

    const right = document.createElement("strong");
    const score = Number(item.confidence ?? item.score ?? 0);
    right.textContent = Number.isFinite(score) ? score.toFixed(2) : "-";

    li.appendChild(left);
    li.appendChild(right);
    suggestionList.appendChild(li);
  });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "aiEnabled",
    "engineUrl",
    "convertToMp4",
    "helperUrl",
    "rollingMaxSec",
    "lastNSeconds"
  ]);

  settings = {
    aiEnabled: Boolean(stored.aiEnabled ?? DEFAULT_SETTINGS.aiEnabled),
    engineUrl: normalizeUrl(stored.engineUrl ?? DEFAULT_SETTINGS.engineUrl, DEFAULT_SETTINGS.engineUrl),
    convertToMp4: Boolean(stored.convertToMp4 ?? DEFAULT_SETTINGS.convertToMp4),
    helperUrl: normalizeUrl(stored.helperUrl ?? DEFAULT_SETTINGS.helperUrl, DEFAULT_SETTINGS.helperUrl),
    rollingMaxSec: clampInt(stored.rollingMaxSec, DEFAULT_SETTINGS.rollingMaxSec, 10, 1800),
    lastNSeconds: clampInt(stored.lastNSeconds, DEFAULT_SETTINGS.lastNSeconds, 1, 1800)
  };

  enableAiInput.checked = settings.aiEnabled;
  engineUrlInput.value = settings.engineUrl;
  enableMp4Input.checked = settings.convertToMp4;
  helperUrlInput.value = settings.helperUrl;
  rollingMaxSecInput.value = String(settings.rollingMaxSec);
  lastNSecondsInput.value = String(settings.lastNSeconds);

  renderSuggestions();
}

async function saveSettings(showStatus = true) {
  settings = {
    aiEnabled: Boolean(enableAiInput.checked),
    engineUrl: normalizeUrl(engineUrlInput.value, DEFAULT_SETTINGS.engineUrl),
    convertToMp4: Boolean(enableMp4Input.checked),
    helperUrl: normalizeUrl(helperUrlInput.value, DEFAULT_SETTINGS.helperUrl),
    rollingMaxSec: clampInt(rollingMaxSecInput.value, DEFAULT_SETTINGS.rollingMaxSec, 10, 1800),
    lastNSeconds: clampInt(lastNSecondsInput.value, DEFAULT_SETTINGS.lastNSeconds, 1, 1800)
  };

  engineUrlInput.value = settings.engineUrl;
  helperUrlInput.value = settings.helperUrl;
  rollingMaxSecInput.value = String(settings.rollingMaxSec);
  lastNSecondsInput.value = String(settings.lastNSeconds);

  await chrome.storage.local.set(settings);

  if (showStatus) {
    setStatus("Settings saved.");
  }

  renderSuggestions();
}

async function getActiveYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  if (!tab.url?.includes("youtube.com/watch")) return null;
  return tab;
}

async function sendToTab(message) {
  if (!activeTab?.id) {
    throw new Error("No active YouTube tab found.");
  }

  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(messageText);
    if (!noReceiver) throw error;

    await ensureContentScript();
    return chrome.tabs.sendMessage(activeTab.id, message);
  }
}

async function ensureContentScript() {
  if (!activeTab?.id) {
    throw new Error("No active YouTube tab found.");
  }

  try {
    const ping = await chrome.tabs.sendMessage(activeTab.id, { type: "PING_CONTENT" });
    if (ping?.ok) return;
  } catch {
    // Inject below.
  }

  await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    files: ["content.js"]
  });

  await new Promise((resolve) => setTimeout(resolve, 90));

  const pingAfter = await chrome.tabs.sendMessage(activeTab.id, { type: "PING_CONTENT" });
  if (!pingAfter?.ok) {
    throw new Error("Could not initialize YouTube player integration. Refresh the tab once and try again.");
  }
}

function optionLabel(marker, index) {
  return `${index + 1}. ${marker.label} (${marker.timeLabel})`;
}

function renderMarkerList(markers) {
  timestampList.innerHTML = "";

  if (!markers.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No timestamps yet.";
    timestampList.appendChild(li);
    return;
  }

  for (const marker of markers) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = marker.label;
    const right = document.createElement("strong");
    right.textContent = marker.timeLabel;
    li.appendChild(left);
    li.appendChild(right);
    timestampList.appendChild(li);
  }
}

function renderSelects(markers) {
  startSelect.innerHTML = "";
  endSelect.innerHTML = "";

  markers.forEach((marker, index) => {
    const startOpt = document.createElement("option");
    startOpt.value = marker.id;
    startOpt.textContent = optionLabel(marker, index);
    startSelect.appendChild(startOpt);

    const endOpt = document.createElement("option");
    endOpt.value = marker.id;
    endOpt.textContent = optionLabel(marker, index);
    endSelect.appendChild(endOpt);
  });

  if (markers.length >= 2) {
    startSelect.selectedIndex = 0;
    endSelect.selectedIndex = 1;
  }

  const disabled = markers.length < 2;
  startSelect.disabled = disabled;
  endSelect.disabled = disabled;
  downloadVodBtn.disabled = disabled;
}

function setMode(isLive) {
  vodSection.style.display = isLive ? "none" : "grid";
  liveSection.style.display = isLive ? "grid" : "none";
  rollingSection.style.display = isLive ? "grid" : "none";
}

async function refreshCaptureButtons() {
  const captureState = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATE" });
  const active = captureState?.activeCapture;
  const thisTabId = activeTab?.id;
  const thisTabActive = active && active.tabId === thisTabId;

  if (!currentState?.isLive) {
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = true;
    startRollingBtn.disabled = true;
    stopRollingBtn.disabled = true;
    saveLast30Btn.disabled = true;
    saveLastNBtn.disabled = true;
    return;
  }

  if (!active) {
    startLiveBtn.disabled = false;
    stopLiveBtn.disabled = true;
    startRollingBtn.disabled = false;
    stopRollingBtn.disabled = true;
    saveLast30Btn.disabled = true;
    saveLastNBtn.disabled = true;
    return;
  }

  if (active.mode === "live") {
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = !thisTabActive;
    startRollingBtn.disabled = true;
    stopRollingBtn.disabled = true;
    saveLast30Btn.disabled = true;
    saveLastNBtn.disabled = true;
    return;
  }

  if (active.mode === "rolling") {
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = true;
    startRollingBtn.disabled = true;
    stopRollingBtn.disabled = !thisTabActive;
    saveLast30Btn.disabled = !thisTabActive;
    saveLastNBtn.disabled = !thisTabActive;
    return;
  }

  startLiveBtn.disabled = true;
  stopLiveBtn.disabled = true;
  startRollingBtn.disabled = true;
  stopRollingBtn.disabled = true;
  saveLast30Btn.disabled = true;
  saveLastNBtn.disabled = true;
}

async function loadState() {
  activeTab = await getActiveYouTubeTab();

  if (!activeTab) {
    setStatus("Open a YouTube watch page first.", true);
    addTimestampBtn.disabled = true;
    clearTimestampsBtn.disabled = true;
    downloadVodBtn.disabled = true;
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = true;
    startRollingBtn.disabled = true;
    stopRollingBtn.disabled = true;
    saveLast30Btn.disabled = true;
    saveLastNBtn.disabled = true;
    return;
  }

  await ensureContentScript();

  const stateResponse = await sendToTab({ type: "GET_STATE" });
  if (!stateResponse?.ok) {
    throw new Error(stateResponse?.error || "Failed to load video state.");
  }

  currentState = stateResponse.state;
  const markers = currentState.markers || [];

  setMode(Boolean(currentState.isLive));
  renderMarkerList(markers);
  renderSelects(markers);

  const channelPart = currentState?.channelName ? ` | ${currentState.channelName}` : "";
  setStatus(
    `${currentState.isLive ? "Live" : "VOD"}${channelPart} | ${markers.length} timestamp${markers.length === 1 ? "" : "s"}`
  );

  addTimestampBtn.disabled = false;
  clearTimestampsBtn.disabled = markers.length === 0;

  await refreshCaptureButtons();
}

function markerById(id) {
  return (currentState?.markers || []).find((marker) => marker.id === id);
}

async function onCheckEngine() {
  await saveSettings(false);

  const response = await chrome.runtime.sendMessage({
    type: "GET_ENGINE_HEALTH",
    engineUrl: settings.engineUrl
  });

  if (response?.ok) {
    setStatus("AI service is reachable.");
    return;
  }

  setStatus(response?.error || "AI service unavailable. Manual clipping still works.", true);
}

async function onFetchEvents() {
  await saveSettings(false);
  if (!settings.aiEnabled) {
    throw new Error("AI is disabled in settings.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "AI_FETCH_LIVE_EVENTS",
    engineUrl: settings.engineUrl,
    matchContext: getMatchContext()
  });

  if (!response?.ok) {
    aiState.events = [];
    aiState.suggestions = [];
    renderSuggestions();
    throw new Error(response?.error || "Could not fetch live events.");
  }

  aiState.events = Array.isArray(response.events) ? response.events : [];
  aiState.suggestions = [];
  renderSuggestions();
  setStatus(`Fetched ${aiState.events.length} event${aiState.events.length === 1 ? "" : "s"}.`);
}

async function onSuggestHighlights() {
  await saveSettings(false);
  if (!settings.aiEnabled) {
    throw new Error("AI is disabled in settings.");
  }

  if (!aiState.events.length) {
    await onFetchEvents();
  }

  const response = await chrome.runtime.sendMessage({
    type: "AI_SUGGEST_CLIPS",
    engineUrl: settings.engineUrl,
    matchContext: getMatchContext(),
    events: aiState.events,
    maxSuggestions: 5
  });

  if (!response?.ok) {
    aiState.suggestions = [];
    renderSuggestions();
    throw new Error(response?.error || "Could not generate suggestions.");
  }

  aiState.suggestions = Array.isArray(response.suggestions) ? response.suggestions : [];
  renderSuggestions();

  if (!aiState.suggestions.length) {
    setStatus("No suggestions from AI service. Use manual or Save Last 30s.");
  } else {
    setStatus(`Prepared ${aiState.suggestions.length} suggestion${aiState.suggestions.length === 1 ? "" : "s"}.`);
  }
}

async function onAddTimestamp() {
  const response = await sendToTab({ type: "ADD_TIMESTAMP" });
  if (!response?.ok) throw new Error(response?.error || "Failed to add timestamp.");
  await loadState();
}

async function onClearTimestamps() {
  const response = await sendToTab({ type: "CLEAR_TIMESTAMPS" });
  if (!response?.ok) throw new Error(response?.error || "Failed to clear timestamps.");
  await loadState();
}

async function onDownloadVod() {
  const startMarker = markerById(startSelect.value);
  const endMarker = markerById(endSelect.value);

  if (!startMarker || !endMarker) {
    throw new Error("Select valid start and end timestamps.");
  }
  if (endMarker.seconds <= startMarker.seconds) {
    throw new Error("End timestamp must be after start timestamp.");
  }

  await saveSettings(false);
  downloadVodBtn.disabled = true;
  setStatus("Recording exact segment. Keep YouTube tab focused...");

  const meta = getVideoMeta();
  const result = await chrome.runtime.sendMessage({
    type: "START_VOD_CLIP",
    tabId: activeTab.id,
    startSec: startMarker.seconds,
    endSec: endMarker.seconds,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    convertToMp4: settings.convertToMp4,
    helperUrl: settings.helperUrl
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to download VOD clip.");
  }

  if (result.warning) {
    setStatus(`Downloaded ${result.filename} (WEBM fallback).`);
  } else {
    setStatus(`Downloaded: ${result.filename}`);
  }
  await loadState();
}

async function onStartLive() {
  await saveSettings(false);
  startLiveBtn.disabled = true;
  setStatus("Starting live capture...");

  const meta = getVideoMeta();
  const result = await chrome.runtime.sendMessage({
    type: "START_LIVE_CAPTURE",
    tabId: activeTab.id,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to start live capture.");
  }

  setStatus("Live capture started. Click Stop when exact moment ends.");
  await loadState();
}

async function onStopLive() {
  await saveSettings(false);
  stopLiveBtn.disabled = true;
  setStatus("Stopping live capture and exporting...");

  const result = await chrome.runtime.sendMessage({
    type: "STOP_LIVE_CAPTURE",
    tabId: activeTab.id,
    convertToMp4: settings.convertToMp4,
    helperUrl: settings.helperUrl
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to stop live capture.");
  }

  if (result.warning) {
    setStatus(`Downloaded ${result.filename} (WEBM fallback).`);
  } else {
    setStatus(`Downloaded: ${result.filename}`);
  }
  await loadState();
}

async function onStartRolling() {
  await saveSettings(false);
  startRollingBtn.disabled = true;
  setStatus("Starting rolling buffer...");

  const meta = getVideoMeta();
  const result = await chrome.runtime.sendMessage({
    type: "START_ROLLING_BUFFER",
    tabId: activeTab.id,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    maxBufferSec: settings.rollingMaxSec
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to start rolling buffer.");
  }

  setStatus(`Rolling buffer active (${result.maxBufferSec}s).`);
  await loadState();
}

async function onStopRolling() {
  stopRollingBtn.disabled = true;
  setStatus("Stopping rolling buffer...");

  const result = await chrome.runtime.sendMessage({
    type: "STOP_ROLLING_BUFFER",
    tabId: activeTab.id
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to stop rolling buffer.");
  }

  setStatus("Rolling buffer stopped.");
  await loadState();
}

async function exportLastN(seconds) {
  await saveSettings(false);
  const normalized = clampInt(seconds, settings.lastNSeconds, 1, 1800);

  setStatus(`Exporting last ${normalized}s...`);
  const meta = getVideoMeta();
  const result = await chrome.runtime.sendMessage({
    type: "EXPORT_LAST_N_SECONDS",
    tabId: activeTab.id,
    seconds: normalized,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    convertToMp4: settings.convertToMp4,
    helperUrl: settings.helperUrl
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Failed to save live retro clip.");
  }

  if (result.warning) {
    setStatus(`Downloaded ${result.filename} (WEBM fallback).`);
  } else {
    setStatus(`Downloaded: ${result.filename}`);
  }

  await loadState();
}

async function onSaveLast30() {
  lastNSecondsInput.value = "30";
  settings.lastNSeconds = 30;
  await exportLastN(30);
}

async function onSaveLastN() {
  const seconds = clampInt(lastNSecondsInput.value, settings.lastNSeconds, 1, 1800);
  lastNSecondsInput.value = String(seconds);
  settings.lastNSeconds = seconds;
  await exportLastN(seconds);
}

async function onClipTopSuggestion() {
  await saveSettings(false);

  if (!aiState.suggestions.length) {
    if (currentState?.isLive) {
      await onSaveLast30();
      return;
    }
    throw new Error("No AI suggestion available. Use manual timestamps.");
  }

  const top = aiState.suggestions[0];
  const startSec = Number(top.start_sec);
  const endSec = Number(top.end_sec);

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    if (currentState?.isLive) {
      await onSaveLast30();
      return;
    }
    throw new Error("Top suggestion has no valid timestamp range.");
  }

  const meta = getVideoMeta();
  const result = await chrome.runtime.sendMessage({
    type: "CREATE_CLIP_FROM_RANGE",
    tabId: activeTab.id,
    startSec,
    endSec,
    isLive: Boolean(currentState?.isLive),
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    convertToMp4: settings.convertToMp4,
    helperUrl: settings.helperUrl
  });

  if (!result?.ok) {
    if (currentState?.isLive) {
      await onSaveLast30();
      return;
    }
    throw new Error(result?.error || "Failed to create clip from AI suggestion.");
  }

  if (result.warning) {
    setStatus(`Downloaded ${result.filename} (${result.warning})`);
  } else {
    setStatus(`Downloaded: ${result.filename}`);
  }
  await loadState();
}

function bindEvents() {
  addTimestampBtn.addEventListener("click", () => runAction(onAddTimestamp));
  clearTimestampsBtn.addEventListener("click", () => runAction(onClearTimestamps));
  downloadVodBtn.addEventListener("click", () => runAction(onDownloadVod));
  startLiveBtn.addEventListener("click", () => runAction(onStartLive));
  stopLiveBtn.addEventListener("click", () => runAction(onStopLive));
  startRollingBtn.addEventListener("click", () => runAction(onStartRolling));
  stopRollingBtn.addEventListener("click", () => runAction(onStopRolling));
  saveLast30Btn.addEventListener("click", () => runAction(onSaveLast30));
  saveLastNBtn.addEventListener("click", () => runAction(onSaveLastN));

  engineHealthBtn.addEventListener("click", () => runAction(onCheckEngine));
  fetchEventsBtn.addEventListener("click", () => runAction(onFetchEvents));
  suggestHighlightsBtn.addEventListener("click", () => runAction(onSuggestHighlights));
  clipTopSuggestionBtn.addEventListener("click", () => runAction(onClipTopSuggestion));

  saveSettingsBtn.addEventListener("click", () => runAction(() => saveSettings(true)));
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unexpected popup error.", true);
    await refreshCaptureButtons().catch(() => undefined);
  }
}

(async () => {
  bindEvents();

  try {
    await loadSettings();
    await loadState();

    if (settings.aiEnabled) {
      await onCheckEngine().catch(() => undefined);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to initialize popup.", true);
  }
})();
