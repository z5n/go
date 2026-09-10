/* Runs in a Manifest V3 sandbox page so Google Maps remote JS is allowed.
 * Heatmap is drawn manually on a canvas OverlayView (HeatmapLayer removed in Maps JS 3.65). */

/** Classic heat ramp matching the reference: purple fringe → yellow → orange → red core. */
const HEAT_GRADIENT_STOPS = [
  { stop: 0.0, color: [0, 0, 0, 0] },
  { stop: 0.12, color: [90, 50, 170, 90] },
  { stop: 0.28, color: [70, 80, 210, 140] },
  { stop: 0.48, color: [255, 220, 70, 190] },
  { stop: 0.7, color: [255, 140, 35, 230] },
  { stop: 1.0, color: [210, 25, 25, 255] },
];

let map = null;
let heatOverlay = null;
let markers = [];
let infoWindow = null;
let mapsLoadPromise = null;
let loadedMapsKey = null;
let gradientLut = null;
let plottedPoints = [];
let viewportListener = null;

function post(type, payload = {}) {
  parent.postMessage({ source: "goplus-map-sandbox", type, ...payload }, "*");
}

function countVisibleInViewport() {
  if (!map || !plottedPoints.length) return 0;
  const bounds = map.getBounds();
  if (!bounds) return 0;
  let n = 0;
  for (const p of plottedPoints) {
    if (bounds.contains(p)) n += 1;
  }
  return n;
}

function postViewportCount() {
  post("viewport", {
    visible: countVisibleInViewport(),
    plotted: plottedPoints.length,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatAge(ts) {
  const age = Date.now() - Number(ts || 0);
  if (!Number.isFinite(age) || age < 0) return "—";
  const mins = Math.round(age / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function clearMarkers() {
  for (const marker of markers) marker.setMap(null);
  markers = [];
  plottedPoints = [];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function buildGradientLut() {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let a = HEAT_GRADIENT_STOPS[0];
    let b = HEAT_GRADIENT_STOPS[HEAT_GRADIENT_STOPS.length - 1];
    for (let s = 0; s < HEAT_GRADIENT_STOPS.length - 1; s += 1) {
      if (t >= HEAT_GRADIENT_STOPS[s].stop && t <= HEAT_GRADIENT_STOPS[s + 1].stop) {
        a = HEAT_GRADIENT_STOPS[s];
        b = HEAT_GRADIENT_STOPS[s + 1];
        break;
      }
    }
    const span = b.stop - a.stop || 1;
    const u = (t - a.stop) / span;
    const o = i * 4;
    lut[o] = Math.round(lerp(a.color[0], b.color[0], u));
    lut[o + 1] = Math.round(lerp(a.color[1], b.color[1], u));
    lut[o + 2] = Math.round(lerp(a.color[2], b.color[2], u));
    lut[o + 3] = Math.round(lerp(a.color[3], b.color[3], u));
  }
  return lut;
}

function getGradientLut() {
  if (!gradientLut) gradientLut = buildGradientLut();
  return gradientLut;
}

/** Cap backing-store area so getImageData never allocates multi‑GB buffers. */
const HEAT_MAX_PIXELS = 1_500_000;

/**
 * Canvas heatmap overlay — intensity blobs + colorize (simpleheat-style).
 * Sized to the map viewport (not world div-pixels) to avoid OOM.
 */
function createHeatmapOverlay(gmaps) {
  class CanvasHeatmapOverlay extends gmaps.OverlayView {
    constructor() {
      super();
      this.points = [];
      this.canvas = null;
      this.listeners = [];
      this.opacity = 0.85;
      this.baseRadius = 8;
    }

    setPoints(points) {
      this.points = Array.isArray(points) ? points : [];
      this.draw();
    }

    onAdd() {
      this.canvas = document.createElement("canvas");
      this.canvas.style.position = "absolute";
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.opacity = String(this.opacity);
      this.getPanes().overlayLayer.appendChild(this.canvas);

      const mapInst = this.getMap();
      const redraw = () => this.draw();
      this.listeners = [
        mapInst.addListener("idle", redraw),
        mapInst.addListener("zoom_changed", redraw),
        mapInst.addListener("resize", redraw),
      ];
    }

    onRemove() {
      for (const listener of this.listeners) {
        gmaps.event.removeListener(listener);
      }
      this.listeners = [];
      this.canvas?.remove();
      this.canvas = null;
    }

    draw() {
      const mapInst = this.getMap();
      const projection = this.getProjection();
      const canvas = this.canvas;
      if (!mapInst || !projection || !canvas) return;

      const mapDiv = mapInst.getDiv();
      const cssW = Math.max(1, mapDiv.clientWidth);
      const cssH = Math.max(1, mapDiv.clientHeight);

      // Anchor a viewport-sized canvas in overlayLayer (div-pixel space).
      const origin = projection.fromContainerPixelToLatLng(new gmaps.Point(0, 0));
      const topLeft = projection.fromLatLngToDivPixel(origin);
      if (!topLeft) return;

      canvas.style.left = `${topLeft.x}px`;
      canvas.style.top = `${topLeft.y}px`;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      // Prefer device pixels, but shrink so width*height stays under HEAT_MAX_PIXELS.
      let scale = Math.min(window.devicePixelRatio || 1, 2);
      let pixelW = Math.max(1, Math.floor(cssW * scale));
      let pixelH = Math.max(1, Math.floor(cssH * scale));
      const area = pixelW * pixelH;
      if (area > HEAT_MAX_PIXELS) {
        scale *= Math.sqrt(HEAT_MAX_PIXELS / area);
        pixelW = Math.max(1, Math.floor(cssW * scale));
        pixelH = Math.max(1, Math.floor(cssH * scale));
      }

      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixelW, pixelH);

      if (!this.points.length) return;

      const sx = pixelW / cssW;
      const sy = pixelH / cssH;
      const zoom = mapInst.getZoom() || 2;
      // Mild screen-space size: stay visible when zoomed out, but not huge.
      const outBoost = 1 + Math.max(0, 4 - zoom) * 0.06;
      const inBoost = Math.pow(2, Math.max(0, zoom - 5) * 0.15);
      const radius = Math.max(4, this.baseRadius * outBoost * Math.min(inBoost, 1.35)) * sx;
      // At low zoom the map wraps; draw each point on neighboring world copies.
      const worldWidth =
        typeof projection.getWorldWidth === "function"
          ? projection.getWorldWidth()
          : 256 * Math.pow(2, zoom);

      for (const point of this.points) {
        const lat = Number(point.lat);
        const lng = Number(point.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const pixel = projection.fromLatLngToDivPixel(new gmaps.LatLng(lat, lng));
        if (!pixel) continue;

        const weight = Math.max(0.35, Math.min(1.5, Number(point.weight) || 1));
        const r = radius * (0.8 + weight * 0.45);
        const y = (pixel.y - topLeft.y) * sy;
        const baseX = pixel.x - topLeft.x;

        for (let wrap = -2; wrap <= 2; wrap += 1) {
          const x = (baseX + wrap * worldWidth) * sx;
          if (x < -r * 2 || y < -r * 2 || x > pixelW + r * 2 || y > pixelH + r * 2) {
            continue;
          }
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
          gradient.addColorStop(0, `rgba(0, 0, 0, ${0.65 * weight})`);
          gradient.addColorStop(0.4, `rgba(0, 0, 0, ${0.28 * weight})`);
          gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }

      let image;
      try {
        image = ctx.getImageData(0, 0, pixelW, pixelH);
      } catch {
        return;
      }
      const data = image.data;
      const lut = getGradientLut();
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (!alpha) continue;
        const o = alpha * 4;
        data[i] = lut[o];
        data[i + 1] = lut[o + 1];
        data[i + 2] = lut[o + 2];
        data[i + 3] = lut[o + 3];
      }
      ctx.putImageData(image, 0, 0);
    }
  }

  return new CanvasHeatmapOverlay();
}

function loadGoogleMaps(apiKey) {
  if (!apiKey) {
    return Promise.reject(new Error("Missing Google Maps API key."));
  }
  if (globalThis.google?.maps && loadedMapsKey === apiKey) {
    return Promise.resolve(globalThis.google.maps);
  }
  if (mapsLoadPromise && loadedMapsKey === apiKey) return mapsLoadPromise;

  document.getElementById("googleMapsApiScript")?.remove();
  try {
    delete globalThis.google;
  } catch {
    /* ignore */
  }
  loadedMapsKey = apiKey;

  mapsLoadPromise = new Promise((resolve, reject) => {
    const callbackName = `__goPlusSandboxMapsInit_${Date.now()}`;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        delete globalThis[callbackName];
      } catch {
        /* ignore */
      }
      fn(arg);
    };

    globalThis.gm_authFailure = () => {
      mapsLoadPromise = null;
      loadedMapsKey = null;
      finish(
        reject,
        new Error(
          "Google Maps rejected the API key. Use an unrestricted key (or allow this extension), with Maps JavaScript API enabled and billing active."
        )
      );
    };

    globalThis[callbackName] = () => {
      if (!globalThis.google?.maps) {
        finish(reject, new Error("Google Maps failed to initialize."));
        return;
      }
      finish(resolve, globalThis.google.maps);
    };

    const script = document.createElement("script");
    script.id = "googleMapsApiScript";
    script.async = true;
    script.defer = true;
    // No visualization library — heatmap is drawn on a canvas overlay.
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&callback=${callbackName}`;
    script.onerror = () => {
      mapsLoadPromise = null;
      loadedMapsKey = null;
      finish(
        reject,
        new Error("Could not load the Google Maps script (network or blocked request).")
      );
    };
    document.head.appendChild(script);
  });

  return mapsLoadPromise;
}

function initMap(gmaps) {
  if (map) return map;
  map = new gmaps.Map(document.getElementById("map"), {
    center: { lat: 39, lng: -98 },
    zoom: 4,
    minZoom: 4,
    maxZoom: 18,
    gestureHandling: "greedy",
    scrollwheel: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });
  infoWindow = new gmaps.InfoWindow({
    headerDisabled: true,
    maxWidth: 280,
  });
  heatOverlay = createHeatmapOverlay(gmaps);
  heatOverlay.setMap(map);
  // idle fires after pan/zoom settle — keep "On map" in sync with the viewport.
  viewportListener = map.addListener("idle", () => postViewportCount());
  return map;
}

function renderHotels(gmaps, hotels) {
  initMap(gmaps);
  clearMarkers();

  const plotted = hotels.filter(
    (h) => Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon))
  );
  plottedPoints = plotted.map(
    (h) => new gmaps.LatLng(Number(h.lat), Number(h.lon))
  );

  const maxEntries = Math.max(1, ...plotted.map((h) => Number(h.entries) || 1));
  const heatPoints = plotted.map((h) => ({
    lat: Number(h.lat),
    lng: Number(h.lon),
    weight: 0.45 + (0.9 * (Number(h.entries) || 1)) / maxEntries,
  }));

  if (heatOverlay) heatOverlay.setPoints(heatPoints);

  if (!plotted.length) {
    map.setOptions({ minZoom: 4 });
    map.setCenter({ lat: 20, lng: 0 });
    map.setZoom(4);
    postViewportCount();
    return 0;
  }

  // Invisible hit-targets so clicks still open hotel details without covering the heat.
  for (const h of plotted) {
    const marker = new gmaps.Marker({
      map,
      position: { lat: Number(h.lat), lng: Number(h.lon) },
      title: h.hotelName || h.ctyhocn,
      opacity: 0,
      flat: true,
      icon: {
        path: gmaps.SymbolPath.CIRCLE,
        scale: 10,
        fillOpacity: 0,
        strokeOpacity: 0,
      },
    });
    marker.addListener("click", () => {
      const title = escapeHtml(h.hotelName || h.ctyhocn);
      const place = [h.city, h.country].filter(Boolean).map(escapeHtml).join(", ");
      const code = escapeHtml(String(h.ctyhocn || "").toUpperCase());
      infoWindow.setContent(
        `<button type="button" class="map-popup" data-ctyhocn="${code}">
          <strong>${title}</strong>
          <div class="map-popup-meta">${place || code}</div>
          <div class="map-popup-meta">${h.entries} cache entr${
            h.entries === 1 ? "y" : "ies"
          } · ${escapeHtml(formatAge(h.lastFetchedAt))}</div>
          <span class="map-popup-cta">View cache entries →</span>
        </button>`
      );
      infoWindow.open({ map, anchor: marker });
      gmaps.event.addListenerOnce(infoWindow, "domready", () => {
        const btn = document.querySelector(".map-popup[data-ctyhocn]");
        if (!btn) return;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          post("hotelOpen", {
            ctyhocn: String(h.ctyhocn || "").toUpperCase(),
            hotelName: h.hotelName || h.ctyhocn || "",
            city: h.city || null,
            country: h.country || null,
            entries: h.entries || 0,
          });
        });
      });
    });
    markers.push(marker);
  }

  const bounds = new gmaps.LatLngBounds();
  for (const h of plotted) bounds.extend({ lat: Number(h.lat), lng: Number(h.lon) });
  // minZoom blocks fitBounds when the cluster is wider than zoom 4 — unlock, fit, then
  // restore the floor (default 4, or the fitted zoom if framing had to go wider).
  map.setOptions({ minZoom: 1 });
  map.fitBounds(bounds, 48);
  gmaps.event.addListenerOnce(map, "bounds_changed", () => {
    let z = map.getZoom();
    if (Number.isFinite(z) && z > 6) {
      map.setZoom(6);
      z = 6;
    }
    map.setOptions({ minZoom: Number.isFinite(z) ? Math.min(4, z) : 4 });
    heatOverlay?.draw();
    postViewportCount();
  });

  return plotted.length;
}

async function handleRender({ apiKey, hotels }) {
  try {
    const gmaps = await loadGoogleMaps(String(apiKey || "").trim());
    const plotted = renderHotels(gmaps, Array.isArray(hotels) ? hotels : []);
    post("rendered", { plotted });
  } catch (err) {
    post("error", { message: String(err?.message || err) });
  }
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "goplus-map-host") return;
  if (data.type === "render") {
    handleRender(data);
  }
});

post("ready");
