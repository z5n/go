const $ = (id) => document.getElementById(id);

const MAPS_KEY_STORAGE = "googleMapsApiKey";

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Open this page from the Chrome extension." });
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

async function readMapsApiKey() {
  try {
    const data = await chrome.storage.local.get(MAPS_KEY_STORAGE);
    return String(data[MAPS_KEY_STORAGE] || "").trim();
  } catch {
    return "";
  }
}

async function writeMapsApiKey(key) {
  const value = String(key || "").trim();
  await chrome.storage.local.set({ [MAPS_KEY_STORAGE]: value });
  return value;
}

let refreshTimer = null;
let sandboxReady = false;
let pendingPayload = null;

function mapFrame() {
  return $("mapFrame");
}

function postToSandbox(payload) {
  const frame = mapFrame();
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ source: "goplus-map-host", ...payload }, "*");
}

function sendRender(apiKey, hotels) {
  const payload = { type: "render", apiKey, hotels };
  if (!sandboxReady) {
    pendingPayload = payload;
    return;
  }
  postToSandbox(payload);
}

async function refreshMap({ auto = false } = {}) {
  const apiKey = ($("mapsApiKey")?.value || "").trim() || (await readMapsApiKey());
  if ($("mapsApiKey") && !$("mapsApiKey").value && apiKey) {
    $("mapsApiKey").value = apiKey;
  }

  if (!apiKey) {
    const details = document.querySelector(".map-key-details");
    if (details) details.open = true;
    $("mapLabel").textContent =
      "Paste a Google Maps JavaScript API key in the footer, then Save. For Chrome extensions, leave Application restrictions as None (or allow chrome-extension://YOUR_ID/*).";
    $("mapHotels").textContent = "0";
    $("mapPlotted").textContent = "0";
    $("mapEntries").textContent = "0";
    return;
  }

  if (!auto) $("mapLabel").textContent = "Loading cache…";
  const res = await sendMessage({ type: "GET_CACHE_MAP" });
  if (!res.ok) {
    $("mapLabel").textContent = res.error || "Could not load cache map.";
    $("mapHotels").textContent = "0";
    $("mapPlotted").textContent = "0";
    $("mapEntries").textContent = "0";
    return;
  }

  const hotels = res.hotels || [];
  $("mapHotels").textContent = String(hotels.length);
  $("mapEntries").textContent = String(res.entries || 0);

  if (!auto) $("mapLabel").textContent = "Loading Google Maps…";
  sendRender(apiKey, hotels);

  const missing = Number(res.missingCoords || 0);
  if (!hotels.length) {
    $("mapLabel").textContent = "No cached hotels yet — run a search to populate the map.";
    $("mapPlotted").textContent = "0";
  } else if (missing > 0) {
    $("mapLabel").textContent = `Resolving ${missing} hotels without coordinates…`;
    if (!refreshTimer) {
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshMap({ auto: true });
      }, 2500);
    }
  }
  // Final label is set when the sandbox posts "rendered" / "error".
}

function onSandboxMessage(event) {
  const data = event.data;
  if (!data || data.source !== "goplus-map-sandbox") return;

  if (data.type === "ready") {
    sandboxReady = true;
    if (pendingPayload) {
      postToSandbox(pendingPayload);
      pendingPayload = null;
    }
    return;
  }

  if (data.type === "rendered") {
    // Prefer viewport count once idle/bounds settle; fall back to total plotted.
    if (data.visible != null) {
      $("mapPlotted").textContent = String(data.visible);
    } else {
      $("mapPlotted").textContent = String(data.plotted || 0);
    }
    const hotels = Number($("mapHotels").textContent) || 0;
    if (!hotels) {
      $("mapLabel").textContent = "No cached hotels yet — run a search to populate the map.";
    } else {
      const n = data.visible != null ? data.visible : data.plotted || 0;
      $("mapLabel").textContent = `${n} hotel${n === 1 ? "" : "s"} in view`;
    }
    return;
  }

  if (data.type === "viewport") {
    const visible = Number(data.visible) || 0;
    $("mapPlotted").textContent = String(visible);
    const hotels = Number($("mapHotels").textContent) || 0;
    if (hotels) {
      $("mapLabel").textContent = `${visible} hotel${visible === 1 ? "" : "s"} in view`;
    }
    return;
  }

  if (data.type === "error") {
    $("mapLabel").textContent = data.message || "Google Maps failed to load.";
    $("mapPlotted").textContent = "0";
    return;
  }

  if (data.type === "hotelOpen") {
    const code = String(data.ctyhocn || "").toUpperCase();
    if (!code) return;
    const params = new URLSearchParams({
      destination: "Cached",
      ctyhocn: code,
    });
    if (data.hotelName) params.set("hotel", String(data.hotelName));
    window.open(`index.html?${params.toString()}`, "_blank", "noopener");
  }
}

async function boot() {
  const saved = await readMapsApiKey();
  if (saved) $("mapsApiKey").value = saved;

  window.addEventListener("message", onSandboxMessage);

  // Auto-open the key field when Maps can't load without one.
  async function ensureKeyPrompt(message) {
    const details = document.querySelector(".map-key-details");
    if (details) details.open = true;
    if (message) $("mapLabel").textContent = message;
  }

  $("saveMapsKeyBtn").addEventListener("click", async () => {
    const key = await writeMapsApiKey($("mapsApiKey").value);
    // Reload sandbox so a previous failed Maps bootstrap can retry cleanly.
    sandboxReady = false;
    pendingPayload = null;
    const frame = mapFrame();
    if (frame) frame.src = `map-sandbox.html?ts=${Date.now()}`;
    if (!key) {
      await ensureKeyPrompt("API key cleared. Add a key to load the map.");
      return;
    }
    const details = document.querySelector(".map-key-details");
    if (details) details.open = false;
    $("mapLabel").textContent = "Key saved. Loading map…";
    refreshMap();
  });

  $("refreshMapBtn").addEventListener("click", () => refreshMap());
  $("mapsApiKey").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("saveMapsKeyBtn").click();
    }
  });

  if (!saved) {
    await ensureKeyPrompt(
      "Paste a Google Maps JavaScript API key in the footer, then Save."
    );
  }

  refreshMap();
}

boot();
