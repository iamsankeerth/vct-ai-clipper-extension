(() => {
  if (globalThis.__exactClipperInjected) {
    return;
  }
  globalThis.__exactClipperInjected = true;

  const OVERLAY_ID = "exact-clipper-overlay";
  const LIVE_PANEL_ID = "exact-clipper-live-panel";
  const STYLE_ID = "exact-clipper-style";
  const PLAYER_ADD_BUTTON_ID = "exact-clipper-add-btn";
  const PLAYER_CLEAR_BUTTON_ID = "exact-clipper-clear-btn";
  const FEEDBACK_ID = "exact-clipper-feedback";
  const CONTEXT_SECTION_ID = "exact-clipper-context-section";
  const CONTEXT_QUICK_ID = "exact-clipper-context-quick";
  const CONTEXT_ADD_ID = "exact-clipper-context-add";
  const CONTEXT_CLEAR_ID = "exact-clipper-context-clear";
  const CONTEXT_ANCHOR_ID = "exact-clipper-context-anchor";

  const state = {
    markersByVideo: new Map(),
    playbackSnapshot: null,
    lastVideoKey: null,
    feedbackTimer: null,
    quickClipAnchorMarkerId: null,
    quickClipAnchorSec: null,
    quickClipBusy: false,
    contextMenuInjectTimer: null
  };

  const formatSeconds = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  function normalizeHelperUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return "http://127.0.0.1:8799";
    return value.replace(/\/+$/, "");
  }

  async function getOutputSettings() {
    const defaults = {
      convertToMp4: false,
      helperUrl: "http://127.0.0.1:8799"
    };

    try {
      const stored = await chrome.storage.local.get(["convertToMp4", "helperUrl"]);
      return {
        convertToMp4: Boolean(stored.convertToMp4 ?? defaults.convertToMp4),
        helperUrl: normalizeHelperUrl(stored.helperUrl ?? defaults.helperUrl)
      };
    } catch {
      return defaults;
    }
  }

  function getVideoElement() {
    return document.querySelector("video");
  }

  function getVideoTitle() {
    const titleNode = document.querySelector("h1.ytd-watch-metadata yt-formatted-string");
    return titleNode?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
  }

  function getChannelName() {
    const selectors = [
      "#owner #channel-name a",
      "ytd-video-owner-renderer ytd-channel-name a",
      "#upload-info ytd-channel-name a",
      "ytd-watch-metadata #owner a"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = node?.textContent?.trim();
      if (text) {
        return text.replace(/^@/, "");
      }
    }

    return "unknown-channel";
  }

  function getVideoKey() {
    const url = new URL(location.href);
    const v = url.searchParams.get("v");
    return v || `${location.pathname}${location.search}`;
  }

  function isLikelyLive(video) {
    const hasLiveBadge = Array.from(document.querySelectorAll(".ytp-live-badge, .ytp-live"))
      .some((node) => /live/i.test(node.textContent || ""));

    const durationLive = !Number.isFinite(video.duration) || video.duration === Infinity;
    return hasLiveBadge || durationLive;
  }

  function getCurrentMarkers() {
    const key = getVideoKey();
    if (!state.markersByVideo.has(key)) {
      state.markersByVideo.set(key, []);
    }
    return state.markersByVideo.get(key);
  }

  function setCurrentMarkers(markers) {
    state.markersByVideo.set(getVideoKey(), markers);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 30;
      }

      #${OVERLAY_ID} .ec-marker {
        position: absolute;
        width: 4px;
        top: 0;
        bottom: 0;
        border-radius: 999px;
        background: #ff4e45;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.8);
      }

      #${OVERLAY_ID} .ec-marker.ec-marker-anchor {
        width: 5px;
        background: #1ed760;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95), 0 0 12px rgba(30, 215, 96, 0.95);
        animation: exactClipperAnchorPulse 1s ease-in-out infinite;
      }

      #${LIVE_PANEL_ID} {
        position: absolute;
        top: 64px;
        right: 16px;
        width: 250px;
        max-height: 42vh;
        overflow: auto;
        border-radius: 12px;
        background: rgba(14, 14, 14, 0.86);
        color: #ffffff;
        border: 1px solid rgba(255,255,255,0.16);
        backdrop-filter: blur(8px);
        z-index: 50;
        font-size: 12px;
        line-height: 1.4;
        font-family: Arial, sans-serif;
        padding: 10px;
      }

      #${LIVE_PANEL_ID} .ec-header {
        font-weight: 600;
        margin-bottom: 8px;
        color: #7de0ff;
      }

      #${LIVE_PANEL_ID} .ec-item {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 4px 0;
        border-bottom: 1px dashed rgba(255,255,255,0.14);
      }

      #${LIVE_PANEL_ID} .ec-item:last-child {
        border-bottom: 0;
      }

      #${LIVE_PANEL_ID} .ec-empty {
        color: rgba(255,255,255,0.75);
      }

      #${LIVE_PANEL_ID} .ec-item.ec-anchor {
        color: #8effba;
        font-weight: 700;
      }

      .exact-clipper-ytp-button {
        width: auto !important;
        min-width: 42px;
        padding: 0 10px !important;
        color: #ffffff !important;
        font-weight: 700;
        font-size: 11px !important;
        letter-spacing: 0.2px;
      }

      .exact-clipper-ytp-button:hover {
        color: #80d7ff !important;
      }

      #${FEEDBACK_ID} {
        position: absolute;
        left: 16px;
        top: 16px;
        z-index: 70;
        padding: 6px 10px;
        border-radius: 8px;
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        background: rgba(15, 109, 255, 0.9);
        border: 1px solid rgba(255,255,255,0.3);
        opacity: 0;
        transition: opacity 120ms ease;
        pointer-events: none;
      }

      #${CONTEXT_SECTION_ID} {
        border-top: 1px solid rgba(255,255,255,0.16);
        margin-top: 4px;
        padding-top: 4px;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item .ytp-menuitem-icon {
        width: 28px;
        min-width: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        opacity: 0.9;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item .ytp-menuitem-label {
        font-weight: 600;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item:hover .ytp-menuitem-label {
        color: #80d7ff;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item.exact-clipper-context-item-disabled {
        opacity: 0.55;
        pointer-events: none;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item.exact-clipper-context-status {
        pointer-events: none;
        opacity: 0.8;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item.exact-clipper-context-header {
        pointer-events: none;
        opacity: 0.74;
      }

      #${CONTEXT_SECTION_ID} .exact-clipper-context-item.exact-clipper-context-header .ytp-menuitem-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      @keyframes exactClipperAnchorPulse {
        0% { filter: brightness(1); }
        50% { filter: brightness(1.35); }
        100% { filter: brightness(1); }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function getProgressBarContainer() {
    return document.querySelector(".ytp-progress-bar-container");
  }

  function ensureProgressOverlay() {
    const container = getProgressBarContainer();
    if (!container) return null;

    let overlay = container.querySelector(`#${OVERLAY_ID}`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      container.style.position = container.style.position || "relative";
      container.appendChild(overlay);
    }

    return overlay;
  }

  function ensureLivePanel() {
    const player = document.querySelector(".html5-video-player");
    if (!player) return null;

    let panel = player.querySelector(`#${LIVE_PANEL_ID}`);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = LIVE_PANEL_ID;
      player.appendChild(panel);
    }

    return panel;
  }

  function showPlayerFeedback(message, isError = false) {
    const player = document.querySelector(".html5-video-player");
    if (!player) return;

    let node = player.querySelector(`#${FEEDBACK_ID}`);
    if (!node) {
      node = document.createElement("div");
      node.id = FEEDBACK_ID;
      player.appendChild(node);
    }

    node.textContent = message;
    node.style.background = isError ? "rgba(178, 22, 22, 0.92)" : "rgba(15, 109, 255, 0.92)";
    node.style.opacity = "1";

    if (state.feedbackTimer) {
      clearTimeout(state.feedbackTimer);
    }
    state.feedbackTimer = setTimeout(() => {
      node.style.opacity = "0";
    }, 1400);
  }

  function setQuickClipAnchor(marker) {
    state.quickClipAnchorMarkerId = marker?.id || null;
    state.quickClipAnchorSec = typeof marker?.seconds === "number" ? marker.seconds : null;
  }

  function clearQuickClipAnchor() {
    state.quickClipAnchorMarkerId = null;
    state.quickClipAnchorSec = null;
  }

  function ensureAnchorStillValid(markers) {
    if (!state.quickClipAnchorMarkerId) return;
    const stillExists = markers.some((marker) => marker.id === state.quickClipAnchorMarkerId);
    if (!stillExists) {
      clearQuickClipAnchor();
    }
  }

  function isMenuVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findOpenContextMenuPanel() {
    const menus = Array.from(document.querySelectorAll(".ytp-popup.ytp-contextmenu, .ytp-contextmenu"));
    for (let i = menus.length - 1; i >= 0; i -= 1) {
      const menu = menus[i];
      if (!isMenuVisible(menu)) continue;
      const panel = menu.querySelector(".ytp-panel-menu");
      if (panel) return panel;
    }
    return null;
  }

  function closeContextMenu() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function closeAllContextMenus() {
    closeContextMenu();
  }

  function createContextMenuItem({
    id,
    label,
    onClick,
    iconText = "",
    disabled = false,
    statusOnly = false,
    header = false
  }) {
    const item = document.createElement("div");
    item.id = id;
    item.className = "ytp-menuitem exact-clipper-context-item";
    item.setAttribute("role", statusOnly ? "presentation" : "menuitem");
    item.tabIndex = statusOnly || disabled ? -1 : 0;

    if (statusOnly) item.classList.add("exact-clipper-context-status");
    if (header) item.classList.add("exact-clipper-context-header");
    if (disabled) item.classList.add("exact-clipper-context-item-disabled");

    const icon = document.createElement("div");
    icon.className = "ytp-menuitem-icon";
    icon.textContent = iconText;

    const labelNode = document.createElement("div");
    labelNode.className = "ytp-menuitem-label";
    labelNode.textContent = label;

    const right = document.createElement("div");
    right.className = "ytp-menuitem-content";

    item.appendChild(icon);
    item.appendChild(labelNode);
    item.appendChild(right);

    if (!statusOnly && !disabled) {
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAllContextMenus();
        onClick();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    return item;
  }

  function setContextItemLabel(section, id, label) {
    const node = section.querySelector(`#${id} .ytp-menuitem-label`);
    if (node && node.textContent !== label) {
      node.textContent = label;
    }
  }

  function setContextItemDisabled(section, id, disabled) {
    const item = section.querySelector(`#${id}`);
    if (!item) return;
    item.classList.toggle("exact-clipper-context-item-disabled", Boolean(disabled));
    item.tabIndex = disabled ? -1 : 0;
    item.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  function ensureContextSection(panel) {
    let section = panel.querySelector(`#${CONTEXT_SECTION_ID}`);
    if (section) return section;

    section = document.createElement("div");
    section.id = CONTEXT_SECTION_ID;

    section.appendChild(createContextMenuItem({
      id: `${CONTEXT_SECTION_ID}-header`,
      label: "Exact Clipper",
      iconText: "EC",
      onClick: () => undefined,
      statusOnly: true,
      header: true
    }));

    section.appendChild(createContextMenuItem({
      id: CONTEXT_QUICK_ID,
      label: "Quick Clip: Set Start",
      iconText: ">>",
      onClick: () => {
        handleQuickClipContextAction();
      }
    }));

    section.appendChild(createContextMenuItem({
      id: CONTEXT_ADD_ID,
      label: "Add Timestamp",
      iconText: "+",
      onClick: handleAddTimestampContextAction
    }));

    section.appendChild(createContextMenuItem({
      id: CONTEXT_CLEAR_ID,
      label: "Clear Timestamps",
      iconText: "x",
      onClick: handleClearTimestampsContextAction
    }));

    panel.appendChild(section);
    return section;
  }

  function injectContextItemsIfOpen() {
    const panel = findOpenContextMenuPanel();
    if (!panel) return false;

    const section = ensureContextSection(panel);
    const quickLabel = state.quickClipBusy
      ? "Quick Clip: Busy"
      : state.quickClipAnchorMarkerId
        ? "Quick Clip: Create Now"
        : "Quick Clip: Set Start";

    setContextItemLabel(section, CONTEXT_QUICK_ID, quickLabel);
    setContextItemDisabled(section, CONTEXT_QUICK_ID, state.quickClipBusy);

    const anchorExisting = section.querySelector(`#${CONTEXT_ANCHOR_ID}`);
    if (state.quickClipAnchorMarkerId && state.quickClipAnchorSec !== null) {
      const anchorLabel = `Anchor at ${formatSeconds(state.quickClipAnchorSec)}`;
      if (anchorExisting) {
        setContextItemLabel(section, CONTEXT_ANCHOR_ID, anchorLabel);
      } else {
        section.appendChild(createContextMenuItem({
          id: CONTEXT_ANCHOR_ID,
          label: anchorLabel,
          iconText: "A",
          onClick: () => undefined,
          statusOnly: true
        }));
      }
    } else if (anchorExisting) {
      anchorExisting.remove();
    }

    return true;
  }

  async function handleQuickClipContextAction() {
    if (state.quickClipBusy) return;

    const video = getVideoElement();
    if (!video) {
      showPlayerFeedback("No video found on this page.", true);
      return;
    }

    const live = isLikelyLive(video);

    if (state.quickClipAnchorMarkerId && state.quickClipAnchorSec !== null) {
      const startSec = Number(state.quickClipAnchorSec);
      const endSec = Number(video.currentTime || 0);

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        showPlayerFeedback("Invalid clip range.", true);
        return;
      }

      if (endSec <= startSec) {
        showPlayerFeedback("Move ahead before creating clip.", true);
        return;
      }

      state.quickClipBusy = true;
      showPlayerFeedback("Creating clip...");

      try {
        const outputSettings = await getOutputSettings();
        const response = await chrome.runtime.sendMessage({
          type: "CREATE_CLIP_FROM_RANGE",
          startSec,
          endSec,
          isLive: live,
          videoTitle: getVideoTitle(),
          channelName: getChannelName(),
          convertToMp4: outputSettings.convertToMp4,
          helperUrl: outputSettings.helperUrl
        });

        if (!response?.ok) {
          throw new Error(response?.error || "Quick clip failed.");
        }

        clearQuickClipAnchor();
        renderMarkers();

        if (response.warning) {
          showPlayerFeedback(`Saved: ${response.filename} (${response.warning})`);
        } else {
          showPlayerFeedback(`Saved: ${response.filename}`);
        }
      } catch (error) {
        showPlayerFeedback(error instanceof Error ? error.message : "Quick clip failed.", true);
      } finally {
        state.quickClipBusy = false;
      }

      return;
    }

    const markerResult = createMarker("CLIP_START");
    if (!markerResult?.ok) {
      showPlayerFeedback(markerResult?.error || "Could not set clip start.", true);
      return;
    }

    setQuickClipAnchor(markerResult.marker);
    renderMarkers();
    showPlayerFeedback(`Anchor set at ${markerResult.marker.timeLabel}`);
  }

  function handleAddTimestampContextAction() {
    const markerResult = createMarker();
    if (!markerResult?.ok) {
      showPlayerFeedback(markerResult?.error || "Could not add timestamp.", true);
      return;
    }
    showPlayerFeedback(`Timestamp added: ${markerResult.marker.timeLabel}`);
  }

  function handleClearTimestampsContextAction() {
    clearMarkers();
    showPlayerFeedback("All timestamps cleared.");
  }

  function scheduleContextMenuInjection() {
    if (state.contextMenuInjectTimer) {
      clearTimeout(state.contextMenuInjectTimer);
      state.contextMenuInjectTimer = null;
    }

    let attempts = 0;
    const run = () => {
      attempts += 1;
      const injected = injectContextItemsIfOpen();
      if (!injected && attempts < 8) {
        state.contextMenuInjectTimer = setTimeout(run, 75);
      }
    };

    run();
  }

  function ensurePlayerButtons() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls) return;

    if (!controls.querySelector(`#${PLAYER_ADD_BUTTON_ID}`)) {
      const addBtn = document.createElement("button");
      addBtn.id = PLAYER_ADD_BUTTON_ID;
      addBtn.className = "ytp-button exact-clipper-ytp-button";
      addBtn.type = "button";
      addBtn.title = "Add Timestamp";
      addBtn.setAttribute("aria-label", "Add Timestamp");
      addBtn.textContent = "TS+";
      addBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const result = createMarker();
        if (result?.ok) {
          showPlayerFeedback(`Timestamp added: ${result.marker.timeLabel}`);
          return;
        }
        showPlayerFeedback(result?.error || "Could not add timestamp.", true);
      });
      controls.prepend(addBtn);
    }

    if (!controls.querySelector(`#${PLAYER_CLEAR_BUTTON_ID}`)) {
      const clearBtn = document.createElement("button");
      clearBtn.id = PLAYER_CLEAR_BUTTON_ID;
      clearBtn.className = "ytp-button exact-clipper-ytp-button";
      clearBtn.type = "button";
      clearBtn.title = "Clear Timestamps";
      clearBtn.setAttribute("aria-label", "Clear Timestamps");
      clearBtn.textContent = "TS-";
      clearBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearMarkers();
        showPlayerFeedback("All timestamps cleared.");
      });
      controls.prepend(clearBtn);
    }
  }

  function renderMarkers() {
    injectStyles();
    ensurePlayerButtons();

    const video = getVideoElement();
    if (!video) return;

    const markers = getCurrentMarkers();
    ensureAnchorStillValid(markers);
    const live = isLikelyLive(video);

    const overlay = ensureProgressOverlay();
    const livePanel = ensureLivePanel();

    if (overlay) {
      overlay.innerHTML = "";
    }

    if (livePanel) {
      livePanel.style.display = live ? "block" : "none";
      livePanel.innerHTML = "";
    }

    if (live) {
      if (!livePanel) return;

      const header = document.createElement("div");
      header.className = "ec-header";
      header.textContent = "Live Timestamp Markers";
      livePanel.appendChild(header);

      if (!markers.length) {
        const empty = document.createElement("div");
        empty.className = "ec-empty";
        empty.textContent = "No markers yet. Use the extension popup to add one.";
        livePanel.appendChild(empty);
        return;
      }

      for (const marker of markers.slice(-30)) {
        const row = document.createElement("div");
        row.className = "ec-item";
        if (state.quickClipAnchorMarkerId === marker.id) {
          row.classList.add("ec-anchor");
        }

        const left = document.createElement("span");
        left.textContent = marker.label;

        const right = document.createElement("span");
        right.textContent = marker.timeLabel;

        row.appendChild(left);
        row.appendChild(right);
        livePanel.appendChild(row);
      }

      return;
    }

    if (!overlay || !Number.isFinite(video.duration) || video.duration <= 0) return;

    for (const marker of markers) {
      const percent = (marker.seconds / video.duration) * 100;
      const dot = document.createElement("div");
      dot.className = "ec-marker";
      if (state.quickClipAnchorMarkerId === marker.id) {
        dot.classList.add("ec-marker-anchor");
      }
      dot.style.left = `${Math.min(100, Math.max(0, percent))}%`;
      dot.title = `${marker.label} (${marker.timeLabel})`;
      overlay.appendChild(dot);
    }
  }

  function createMarker(label) {
    const video = getVideoElement();
    if (!video) {
      return { ok: false, error: "No video element found on this page." };
    }

    const markers = [...getCurrentMarkers()];
    const seconds = Number.isFinite(video.currentTime) ? video.currentTime : 0;

    const marker = {
      id: crypto.randomUUID(),
      seconds,
      timeLabel: formatSeconds(seconds),
      label: label || `T${markers.length + 1}`,
      createdAt: Date.now()
    };

    markers.push(marker);
    markers.sort((a, b) => a.seconds - b.seconds);
    setCurrentMarkers(markers);

    renderMarkers();

    return {
      ok: true,
      marker,
      state: getStatePayload()
    };
  }

  function clearMarkers() {
    setCurrentMarkers([]);
    clearQuickClipAnchor();
    renderMarkers();
    return { ok: true, state: getStatePayload() };
  }

  function getStatePayload() {
    const video = getVideoElement();
    const markers = getCurrentMarkers();

    return {
      videoKey: getVideoKey(),
      title: getVideoTitle(),
      channelName: getChannelName(),
      markers,
      quickClipAnchorSec: state.quickClipAnchorSec,
      quickClipAnchorMarkerId: state.quickClipAnchorMarkerId,
      duration: video?.duration,
      currentTime: video?.currentTime,
      isLive: video ? isLikelyLive(video) : false,
      url: location.href
    };
  }

  function waitForSeek(video, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", onSeeked);
        clearTimeout(timer);
        resolve();
      };

      const onSeeked = () => finish();
      const timer = setTimeout(finish, timeoutMs);

      video.addEventListener("seeked", onSeeked, { once: true });
    });
  }

  async function prepareClipPlayback(startSec) {
    const video = getVideoElement();
    if (!video) {
      return { ok: false, error: "No video found." };
    }

    if (isLikelyLive(video)) {
      return {
        ok: false,
        error: "VOD clipping by seek is unavailable on live streams. Use live capture mode."
      };
    }

    state.playbackSnapshot = {
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      paused: video.paused
    };

    video.pause();
    video.playbackRate = 1;
    video.currentTime = Math.max(0, Number(startSec) || 0);

    await waitForSeek(video);

    return { ok: true };
  }

  async function startClipPlayback() {
    const video = getVideoElement();
    if (!video) return { ok: false, error: "No video found." };

    try {
      await video.play();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to play video."
      };
    }
  }

  function pauseClipPlayback() {
    const video = getVideoElement();
    if (!video) return { ok: false, error: "No video found." };
    video.pause();
    return { ok: true };
  }

  async function restoreClipPlayback() {
    const video = getVideoElement();
    if (!video || !state.playbackSnapshot) {
      return { ok: true };
    }

    const snapshot = state.playbackSnapshot;
    state.playbackSnapshot = null;

    video.currentTime = snapshot.currentTime;
    await waitForSeek(video, 2500);
    video.playbackRate = snapshot.playbackRate;

    if (snapshot.paused) {
      video.pause();
    } else {
      await video.play().catch(() => undefined);
    }

    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const run = async () => {
      switch (request?.type) {
        case "PING_CONTENT":
          return { ok: true };

        case "ADD_TIMESTAMP":
          return createMarker(request.label);

        case "CLEAR_TIMESTAMPS":
          return clearMarkers();

        case "GET_STATE":
          return { ok: true, state: getStatePayload() };

        case "GET_VIDEO_INFO": {
          const video = getVideoElement();
          return {
            ok: true,
            info: {
              title: getVideoTitle(),
              channelName: getChannelName(),
              duration: video?.duration,
              isLive: video ? isLikelyLive(video) : false,
              currentTime: video?.currentTime,
              url: location.href
            }
          };
        }

        case "PREPARE_CLIP_PLAYBACK":
          return await prepareClipPlayback(request.startSec);

        case "START_CLIP_PLAYBACK":
          return await startClipPlayback();

        case "PAUSE_CLIP_PLAYBACK":
          return pauseClipPlayback();

        case "RESTORE_CLIP_PLAYBACK":
          return await restoreClipPlayback();

        default:
          return { ok: false, error: "Unknown content-script request." };
      }
    };

    run().then(sendResponse);
    return true;
  });

  function checkVideoChange() {
    const current = getVideoKey();
    if (state.lastVideoKey !== current) {
      state.lastVideoKey = current;
      clearQuickClipAnchor();
      renderMarkers();
    }
  }

  document.addEventListener("contextmenu", (event) => {
    const player = document.querySelector(".html5-video-player");
    if (!player) return;
    if (!(event.target instanceof Node)) return;
    if (!player.contains(event.target)) return;
    scheduleContextMenuInjection();
  }, true);

  setInterval(() => {
    if (findOpenContextMenuPanel()) return;
    checkVideoChange();
    renderMarkers();
  }, 1500);
})();
