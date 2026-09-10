import {
  searchHotelsNearDestination,
  fetchCalendar,
  fetchShopRooms,
  fetchMultiPropRates,
  MULTI_PROP_PAGE_SIZE,
  autocompleteDestination,
  syncGuestIdFromCookies,
  getAuthSession,
  getAccessTokenFingerprint,
  isUnauthorizedError,
} from "./hilton-api.js";
import {
  getCachedCalendar,
  setCachedCalendar,
  deleteCachedCalendar,
  getCachedShopRooms,
  setCachedShopRooms,
  deleteCachedShopRooms,
  listCachedCalendars,
  listCachedMapHotels,
  updateCachedHotelCoords,
  pruneStaleCache,
} from "./rate-cache.js";
import {
  startMetricsSession,
  endMetricsSession,
  getMetricsSnapshot,
  runWithMetricsSession,
  recordActivity,
} from "./request-metrics.js";

async function clearGuestSession() {
  const fingerprint = await getAccessTokenFingerprint().catch(() => null);
  await chrome.storage.local.set({
    sessionUnauthorized: true,
    failedAccessTokenFingerprint: fingerprint || "",
  });
  await chrome.storage.local.remove(["guestId", "guestIdUpdatedAt", "guestUserName", "guestUserNameFor"]);
}

async function clearUnauthorizedFlag() {
  await chrome.storage.local.remove(["sessionUnauthorized", "failedAccessTokenFingerprint"]);
}

const GEOCODE_CACHE_KEY = "mapGeocodeCache";

async function geocodePlaceLabel(city, country) {
  const label = [city, country].filter(Boolean).join(", ").trim();
  if (!label) return null;
  const cacheKey = label.toLowerCase();
  try {
    const stored = await chrome.storage.local.get(GEOCODE_CACHE_KEY);
    const map = stored[GEOCODE_CACHE_KEY] || {};
    if (map[cacheKey]?.lat != null && map[cacheKey]?.lon != null) {
      return { lat: Number(map[cacheKey].lat), lon: Number(map[cacheKey].lon) };
    }
  } catch {
    /* ignore */
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", label);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "GoPlusCacheMap/0.1" },
  });
  if (!response.ok) return null;
  const results = await response.json();
  if (!results?.length) return null;
  const hit = {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
  };
  if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return null;
  try {
    const stored = await chrome.storage.local.get(GEOCODE_CACHE_KEY);
    const map = { ...(stored[GEOCODE_CACHE_KEY] || {}), [cacheKey]: hit };
    // Cap cache size.
    const keys = Object.keys(map);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete map[k];
    }
    await chrome.storage.local.set({ [GEOCODE_CACHE_KEY]: map });
  } catch {
    /* ignore */
  }
  return hit;
}

/** Hotels for the coverage map; backfill a few missing coords from city/country. */
async function buildCacheMapHotels() {
  const hotels = await listCachedMapHotels({ includeStale: true });
  const needGeo = hotels.filter(
    (h) => (h.lat == null || h.lon == null) && (h.city || h.country)
  );
  const byLabel = new Map();
  for (const h of needGeo) {
    const label = [h.city, h.country].filter(Boolean).join(", ");
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(h);
  }
  let i = 0;
  for (const [, group] of byLabel) {
    if (i >= 5) break;
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      i += 1;
      const hit = await geocodePlaceLabel(group[0].city, group[0].country);
      if (!hit) continue;
      for (const h of group) {
        h.lat = hit.lat;
        h.lon = hit.lon;
        h.coordsSource = "geocode";
        updateCachedHotelCoords(h.ctyhocn, hit.lat, hit.lon).catch(() => {});
      }
    } catch {
      /* skip label */
    }
  }
  return hotels;
}

function extractGuestId(text) {
  if (!text) return null;
  const m = text.match(/"guestId"\s*:\s*"?(\d{5,})"?/);
  return m ? Number(m[1]) : null;
}

function bodyToText(requestBody) {
  if (!requestBody) return "";
  if (requestBody.raw?.length) {
    return requestBody.raw
      .map((part) => (part.bytes ? new TextDecoder("utf-8").decode(part.bytes) : ""))
      .join("");
  }
  return "";
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    (async () => {
      try {
        if (details.method !== "POST") return;
        const guestId = extractGuestId(bodyToText(details.requestBody));
        if (!guestId) return;
        // Always capture guestId from live Hilton traffic so re-login can recover.
        await chrome.storage.local.set({ guestId, guestIdUpdatedAt: Date.now() });
      } catch {
        /* ignore */
      }
    })();
  },
  { urls: ["https://www.hilton.com/graphql/*", "https://*.hilton.com/graphql/*"] },
  ["requestBody"]
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ delayMs: 1000 });
});

async function getGuestId() {
  const stored = await chrome.storage.local.get(["guestId", "sessionUnauthorized"]);
  if (stored.sessionUnauthorized) {
    // Still try cookie recovery; getAuthSession decides whether lockout clears.
    const fromCookies = await syncGuestIdFromCookies();
    if (fromCookies) return fromCookies;
    return null;
  }
  if (stored.guestId) return stored.guestId;
  return syncGuestIdFromCookies();
}

function dateOnly(iso) {
  const s = String(iso || "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function nightsBetweenISO(fromDate, toDate) {
  const from = new Date(`${dateOnly(fromDate)}T00:00:00`);
  const to = new Date(`${dateOnly(toDate)}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 1;
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
}

function normalizeScanRanges(message = {}) {
  const raw = Array.isArray(message.ranges)
    ? message.ranges
    : Array.isArray(message.stays)
      ? message.stays
      : [];
  const mapped = raw
    .map((r) => {
      let from = dateOnly(r?.from || r?.fromDate || "");
      let to = dateOnly(r?.to || r?.toDate || "");
      if (!from) return null;
      if (!to) to = addDaysISO(from, 1);
      if (to < from) {
        const tmp = from;
        from = to;
        to = tmp;
      }
      if (to === from) to = addDaysISO(from, 1);
      return {
        fromDate: from,
        toDate: to,
        // Always derive from dates — never trust a stale nights field.
        nights: nightsBetweenISO(from, to),
      };
    })
    .filter(Boolean);
  if (mapped.length) return mapped;
  if (message.fromDate) {
    let from = dateOnly(message.fromDate);
    let to = dateOnly(message.toDate) || addDaysISO(from, Number(message.nights) || 1);
    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    if (to === from) to = addDaysISO(from, 1);
    return [{ fromDate: from, toDate: to, nights: nightsBetweenISO(from, to) }];
  }
  return [];
}

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sortScanRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.error || b.error) return a.error ? 1 : -1;
    const amountDiff = (a.amount ?? Number.POSITIVE_INFINITY) - (b.amount ?? Number.POSITIVE_INFINITY);
    if (amountDiff !== 0) return amountDiff;
    if (a.arrivalDate !== b.arrivalDate) return a.arrivalDate.localeCompare(b.arrivalDate);
    return String(a.hotelName || "").localeCompare(String(b.hotelName || ""));
  });
}

function emitScanProgress({
  done,
  total,
  hotel,
  rows,
  fromCache = false,
  cacheHits = 0,
  hotelCount = 0,
  unauthorized = false,
}) {
  const matchRows = (rows || []).filter((r) => !r.error);
  const errorRows = (rows || []).filter((r) => r.error);
  recordActivity({
    type: "scan",
    name: unauthorized ? "progress_unauthorized" : "progress",
    ok: !unauthorized,
    error: unauthorized ? "unauthorized" : null,
    detail: {
      done,
      total,
      hotel: hotel || null,
      hotelCount,
      matches: matchRows.length,
      matchHotels: new Set(matchRows.map((r) => String(r.ctyhocn || "").toUpperCase()).filter(Boolean))
        .size,
      errors: errorRows.length,
      cacheHits,
      fromCache: Boolean(fromCache),
      cachedMatches: matchRows.filter((r) => r.fromCache).length,
    },
  });
  chrome.runtime
    .sendMessage({
      type: "SCAN_PROGRESS",
      done,
      total,
      hotel,
      fromCache,
      cacheHits,
      hotelCount,
      unauthorized,
      rows: sortScanRows(rows),
      matches: matchRows.length,
    })
    .catch(() => {});
}

async function openSearchPage(windowId = null) {
  const url = chrome.runtime.getURL("web/index.html");
  const createProps = { url };
  if (windowId != null) {
    createProps.windowId = windowId;
  } else {
    const win = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (win?.id != null) createProps.windowId = win.id;
  }
  await chrome.tabs.create(createProps);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openSearchPage(tab?.windowId ?? null);
  } catch {
    await openSearchPage();
  }
});

let scanCancelled = false;

function buildCachedScanRows(entries, {
  ranges = [],
  fromDate = null,
  toDate = null,
  nights = null,
  goOnly,
  maxRate,
  minRooms,
}) {
  const scanRanges = ranges?.length
    ? ranges
    : fromDate
      ? normalizeScanRanges({ fromDate, toDate, nights })
      : [];
  const rows = [];
  const matchedHotels = new Set();
  let cacheHits = 0;

  // Prefer a real hotel name from any cache entry for the same ctyhocn — refreshes
  // used to wipe hotelName and leave the code as the display name.
  const metaByCtyhocn = new Map();
  for (const entry of entries || []) {
    const code = String(entry.calendar?.ctyhocn || entry.ctyhocn || "").toUpperCase();
    if (!code) continue;
    const name = entry.hotelName && String(entry.hotelName).toUpperCase() !== code
      ? entry.hotelName
      : null;
    const prev = metaByCtyhocn.get(code) || {};
    metaByCtyhocn.set(code, {
      hotelName: name || prev.hotelName || null,
      brandCode: entry.brandCode || prev.brandCode || null,
      city: entry.city || prev.city || null,
      country: entry.country || prev.country || null,
    });
  }

  for (const entry of entries) {
    if (scanCancelled) break;
    cacheHits += 1;
    const hotelCtyhocn = String(entry.calendar?.ctyhocn || entry.ctyhocn || "").toUpperCase();
    const meta = metaByCtyhocn.get(hotelCtyhocn) || {};
    const entryNights = Number(entry.nights) || 1;
    for (const day of entry.calendar?.days || []) {
      if (day.amount == null) continue;
      const arrival = day.arrivalDate;
      if (!arrival) continue;
      if (goOnly && !day.isGoRate) continue;
      if (maxRate != null && day.amount > maxRate) continue;
      if ((day.roomsAvail ?? 0) < minRooms) continue;
      if (scanRanges.length) {
        const arrivalDay = String(arrival).slice(0, 10);
        const match = scanRanges.find(
          (r) =>
            String(r.fromDate).slice(0, 10) === arrivalDay &&
            Number(r.nights) === entryNights
        );
        if (!match) continue;
        const departureDate = match.toDate;
        if (hotelCtyhocn) matchedHotels.add(hotelCtyhocn);
        rows.push({
          arrivalDate: arrivalDay,
          departureDate,
          amount: day.amount,
          amountFmt: day.amountFmt,
          currency: day.currency,
          roomsAvail: day.roomsAvail,
          ratePlanCode: day.ratePlanCode,
          roomTypeCode: day.roomTypeCode,
          ratePlanName: day.ratePlanName,
          ratePlanDesc: day.ratePlanDesc,
          specialRateType: day.specialRateType,
          isGoRate: day.isGoRate,
          amountOriginal: day.amountOriginal,
          currencyOriginal: day.currencyOriginal,
          fxRateToUsd: day.fxRateToUsd,
          hotelName: meta.hotelName || entry.hotelName || hotelCtyhocn,
          brandCode: meta.brandCode || entry.brandCode || null,
          city: meta.city || entry.city || null,
          country: meta.country || entry.country || null,
          ctyhocn: hotelCtyhocn,
          nights: match.nights,
          fromCache: true,
          fetchedAt: entry.fetchedAt || null,
          bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
            hotelCtyhocn
          )}&arrivalDate=${encodeURIComponent(arrivalDay)}&departureDate=${encodeURIComponent(
            departureDate
          )}&room1NumAdults=1`,
        });
        continue;
      }
      const stayNights = entryNights;
      const departureDate = addDaysISO(arrival, stayNights);
      if (hotelCtyhocn) matchedHotels.add(hotelCtyhocn);
      rows.push({
        ...day,
        arrivalDate: arrival,
        departureDate,
        hotelName: meta.hotelName || entry.hotelName || hotelCtyhocn,
        brandCode: meta.brandCode || entry.brandCode || null,
        city: meta.city || entry.city || null,
        country: meta.country || entry.country || null,
        ctyhocn: hotelCtyhocn,
        nights: stayNights,
        fromCache: true,
        fetchedAt: entry.fetchedAt || null,
        bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
          hotelCtyhocn
        )}&arrivalDate=${encodeURIComponent(arrival)}&departureDate=${encodeURIComponent(
          departureDate
        )}&room1NumAdults=1`,
      });
    }
  }

  return { rows: sortScanRows(rows), cacheHits, hotelsCached: matchedHotels.size };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const msgType = String(message?.type || "unknown");
    const sessionId = message?.sessionId || null;

    // Handle cache-only search outside the metrics wrapper so it can't be
    // dropped by nested handler braces / session bookkeeping.
    if (message?.type === "SCAN_CACHED_RATES") {
      await runWithMetricsSession(sessionId, async () => {
        recordActivity({
          type: "message",
          name: "SCAN_CACHED_RATES",
          detail: {
            ranges: message.ranges,
            ctyhocn: message.ctyhocn || null,
            goOnly: message.goOnly,
            maxRate: message.maxRate,
            minRooms: message.minRooms,
          },
        });
        scanCancelled = false;
        pruneStaleCache().catch(() => {});
        const {
          fromDate = null,
          toDate = null,
          ranges = null,
          friendsAndFamily = true,
          goOnly = true,
          maxRate = null,
          minRooms = 1,
          ctyhocn = null,
        } = message;
        try {
          const guestId = await getGuestId();
          const scanRanges = normalizeScanRanges({ ranges, fromDate, toDate });
          const uniqueNights = [...new Set(scanRanges.map((r) => Number(r.nights)))];
          const nightsFilter = uniqueNights.length === 1 ? uniqueNights[0] : null;
          let entries = await listCachedCalendars({
            nights: nightsFilter,
            friendsAndFamily,
            guestId,
          });
          const hotelCode = String(ctyhocn || "").toUpperCase();
          if (hotelCode) {
            entries = entries.filter(
              (e) =>
                String(e.ctyhocn || e.calendar?.ctyhocn || "").toUpperCase() === hotelCode
            );
          }
          const { rows, cacheHits, hotelsCached } = buildCachedScanRows(entries, {
            ranges: scanRanges,
            goOnly,
            maxRate,
            minRooms,
          });
          const cancelled = scanCancelled;
          scanCancelled = false;
          recordActivity({
            type: "scan",
            name: "cached_done",
            ok: true,
            detail: {
              matches: rows.filter((r) => !r.error).length,
              cacheHits,
              hotelsCached,
              cancelled,
            },
          });
          sendResponse({
            ok: true,
            rows,
            guestId,
            cancelled,
            done: cacheHits,
            total: cacheHits,
            cacheHits,
            hotelsCached,
          });
        } catch (err) {
          scanCancelled = false;
          recordActivity({
            type: "scan",
            name: "cached_error",
            ok: false,
            error: String(err?.message || err),
          });
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      });
      return;
    }

    await runWithMetricsSession(sessionId, async () => {
      // Skip logging noisy metrics polling / session bookkeeping chatter.
      if (
        msgType !== "GET_METRICS" &&
        msgType !== "METRICS_SESSION_START" &&
        msgType !== "METRICS_SESSION_END" &&
        msgType !== "LOOKUP_CACHED_ROOM_RATES"
      ) {
        recordActivity({
          type: "message",
          name: msgType,
          detail: {
            fromTab: sender?.tab?.id ?? null,
            destination: message?.destination || null,
            hotelCount: Array.isArray(message?.hotels) ? message.hotels.length : undefined,
            ranges: message?.ranges,
            ctyhocn: message?.ctyhocn || null,
            query: message?.query || null,
            delayMs: message?.delayMs,
            goOnly: message?.goOnly,
            maxRate: message?.maxRate,
            minRooms: message?.minRooms,
            friendsAndFamily: message?.friendsAndFamily,
          },
        });
      }

      if (message?.type === "METRICS_SESSION_START") {
        const snap = await startMetricsSession(message.sessionId);
        sendResponse({ ok: true, session: snap });
        return;
      }

      if (message?.type === "METRICS_SESSION_END") {
        const snap = await endMetricsSession(message.sessionId);
        sendResponse({ ok: true, session: snap });
        return;
      }

      if (message?.type === "GET_METRICS") {
        sendResponse({ ok: true, ...(await getMetricsSnapshot(message.sessionId || null)) });
        return;
      }

      if (message?.type === "GET_CACHE_MAP") {
        const hotels = await buildCacheMapHotels();
        sendResponse({
          ok: true,
          hotels,
          withCoords: hotels.filter((h) => h.lat != null && h.lon != null).length,
          missingCoords: hotels.filter((h) => h.lat == null || h.lon == null).length,
          entries: hotels.reduce((n, h) => n + (h.entries || 0), 0),
        });
        return;
      }

      if (message?.type === "GET_STATUS") {
        const session = await getAuthSession();
        if (!session.signedIn && (session.unauthorized || session.reason === "token_expired")) {
          await clearGuestSession();
          sendResponse({
            ok: true,
            guestId: null,
            userName: null,
            unauthorized: true,
            signedIn: false,
            reason: session.reason,
          });
          return;
        }
        sendResponse({
          ok: true,
          guestId: session.guestId || null,
          userName: session.userName || null,
          unauthorized: false,
          signedIn: Boolean(session.signedIn),
          reason: session.reason,
        });
        return;
      }

      if (message?.type === "CLEAR_SESSION") {
        await clearGuestSession();
        sendResponse({ ok: true, guestId: null, userName: null, unauthorized: true, signedIn: false });
        return;
      }

      if (message?.type === "RESTORE_SESSION") {
        await clearUnauthorizedFlag();
        const session = await getAuthSession();
        if (!session.signedIn) {
          // Only re-lock when Hilton still has no usable session.
          if (
            session.reason === "no_token" ||
            session.reason === "token_expired" ||
            session.reason === "not_logged_in" ||
            session.unauthorized
          ) {
            await clearGuestSession();
            sendResponse({
              ok: true,
              guestId: null,
              userName: null,
              unauthorized: true,
              signedIn: false,
              reason: session.reason,
            });
            return;
          }
          sendResponse({
            ok: true,
            guestId: null,
            userName: null,
            unauthorized: false,
            signedIn: false,
            reason: session.reason,
          });
          return;
        }
        sendResponse({
          ok: true,
          guestId: session.guestId || null,
          userName: session.userName || null,
          unauthorized: false,
          signedIn: true,
          reason: session.reason,
        });
        return;
      }

      if (message?.type === "STOP_SCAN") {
        scanCancelled = true;
        recordActivity({ type: "scan", name: "stop_requested" });
        sendResponse({ ok: true, stopped: true });
        return;
      }

      if (message?.type === "AUTOCOMPLETE_DESTINATION") {
        const result = await autocompleteDestination(message.query || "", {
          limit: message.limit || 8,
        });
        const q = String(message.query || "").trim().toLowerCase();
        const showCached = !q || "cached".startsWith(q) || q.includes("cach");
        const suggestions = [...(result.suggestions || [])];
        if (showCached) {
          suggestions.unshift({
            id: "goplus:cached",
            type: "cached",
            label: "Cached",
            primary: "Cached",
            secondary: "Search all cached rates",
            query: "Cached",
            placeId: null,
            ctyhocn: null,
            city: null,
            state: null,
            country: null,
            countryCode: null,
          });
        }
        sendResponse({ ok: true, ...result, suggestions });
        return;
      }

      if (message?.type === "SEARCH_DESTINATION_HOTELS") {
        scanCancelled = false;
        recordActivity({
          type: "search",
          name: "destination_start",
          detail: {
            destination: message.destination || null,
            suggestionType: message.suggestion?.type || null,
            suggestionLabel: message.suggestion?.label || message.suggestion?.primary || null,
          },
        });
        try {
          const result = await searchHotelsNearDestination(message.destination, {
            suggestion: message.suggestion || null,
          });
          const hotels = result?.hotels || [];
          recordActivity({
            type: "search",
            name: scanCancelled ? "destination_cancelled" : "destination_done",
            ok: true,
            detail: {
              hotelCount: hotels.length,
              place: result?.place?.displayName || null,
              source: result?.source || null,
              cancelled: Boolean(scanCancelled),
              sample: hotels.slice(0, 8).map((h) => ({
                ctyhocn: h.ctyhocn,
                name: h.name,
                city: h.city,
              })),
            },
          });
          if (scanCancelled) {
            sendResponse({ ok: true, ...result, cancelled: true });
            return;
          }
          sendResponse({ ok: true, ...result });
        } catch (err) {
          recordActivity({
            type: "search",
            name: "destination_error",
            ok: false,
            error: String(err?.message || err),
          });
          throw err;
        }
        return;
      }

    if (message?.type === "FETCH_INVENTORY_RATES") {
      const {
        ctyhocns = [],
        arrivalDate,
        departureDate,
        numAdults = 1,
        numRooms = 1,
        friendsAndFamily = true,
        guestLocationCountry = "US",
      } = message;
      if (!ctyhocns.length || !arrivalDate || !departureDate) {
        sendResponse({ ok: false, error: "Missing stay details for inventory rates." });
        return;
      }
      if (scanCancelled) {
        sendResponse({ ok: true, rates: [], cancelled: true });
        return;
      }
      const guestId = await getGuestId();
      try {
        const rates = await fetchMultiPropRates({
          ctyhocns: ctyhocns.slice(0, MULTI_PROP_PAGE_SIZE),
          arrivalDate,
          departureDate,
          numAdults,
          numRooms,
          friendsAndFamily,
          guestId,
          guestLocationCountry,
        });
        sendResponse({ ok: true, rates, guestId, cancelled: scanCancelled });
        await clearUnauthorizedFlag();
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await clearGuestSession();
          sendResponse({
            ok: false,
            unauthorized: true,
            error: "Hilton session expired. Sign in again to continue.",
          });
          return;
        }
        sendResponse({ ok: false, error: err?.message || "Inventory rate fetch failed." });
      }
      return;
    }

    if (message?.type === "LOOKUP_CACHED_ROOM_RATES") {
      const stays = Array.isArray(message.stays) ? message.stays.slice(0, 500) : [];
      const guestId = await getGuestId();
      const results = [];
      for (const stay of stays) {
        const ctyhocn = stay?.ctyhocn;
        const arrivalDate = stay?.arrivalDate;
        const departureDate = stay?.departureDate;
        if (!ctyhocn || !arrivalDate || !departureDate) {
          results.push({ rooms: [], cacheMiss: true });
          continue;
        }
        const payload = await getCachedShopRooms({
          ctyhocn,
          arrivalDate,
          departureDate,
          friendsAndFamily: stay.friendsAndFamily !== false,
          guestId,
          currency: "USD",
        });
        if (!payload) {
          results.push({ rooms: [], cacheMiss: true });
          continue;
        }
        results.push({
          rooms: payload.rooms || [],
          currency: payload.currency || null,
          fromCache: true,
        });
      }
      sendResponse({ ok: true, results });
      return;
    }

    if (message?.type === "FETCH_ROOM_RATES") {
      const {
        ctyhocn,
        arrivalDate,
        departureDate,
        friendsAndFamily = true,
      } = message;
      if (!ctyhocn || !arrivalDate || !departureDate) {
        sendResponse({ ok: false, error: "Missing stay details for room shop." });
        return;
      }
      const guestId = await getGuestId();
      const cacheParams = {
        ctyhocn,
        arrivalDate,
        departureDate,
        friendsAndFamily,
        guestId,
        currency: "USD",
      };
      let payload = await getCachedShopRooms(cacheParams);
      let fromCache = Boolean(payload);
      if (!payload) {
        if (message.cacheOnly) {
          sendResponse({ ok: true, rooms: [], fromCache: false, cacheMiss: true });
          return;
        }
        try {
          payload = await fetchShopRooms({
            ctyhocn,
            arrivalDate,
            departureDate,
            friendsAndFamily,
            guestId,
          });
          await setCachedShopRooms(cacheParams, payload);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            await clearGuestSession();
            sendResponse({
              ok: false,
              unauthorized: true,
              error: "Hilton session expired. Sign in again to continue.",
            });
            return;
          }
          sendResponse({
            ok: false,
            error: String(err?.message || err || "Room shop failed."),
          });
          return;
        }
      }
      sendResponse({
        ok: true,
        rooms: payload.rooms || [],
        currency: payload.currency || null,
        fromCache,
        guestId,
      });
      await clearUnauthorizedFlag();
      return;
    }

    if (message?.type === "REFRESH_RATE_ENTRY") {
      const {
        ctyhocn,
        arrivalDate,
        departureDate,
        nights = 1,
        friendsAndFamily = true,
        hotelName = null,
        brandCode = null,
        city = null,
        country = null,
        lat = null,
        lon = null,
      } = message;
      if (!ctyhocn || !arrivalDate) {
        sendResponse({ ok: false, error: "Missing stay details to refresh." });
        return;
      }
      const guestId = await getGuestId();
      const lengthOfStay = Number(nights) || 1;
      const monthArrival = `${String(arrivalDate).slice(0, 7)}-01`;
      const calendarParams = {
        ctyhocn,
        arrivalDate: monthArrival,
        nights: lengthOfStay,
        friendsAndFamily,
        guestId,
        currency: "USD",
      };
      try {
        // Don't delete before rewrite — put merges identity from the prior
        // record when refresh sends a null/ctyhocn name (common after UI fallback).
        const calendar = await fetchCalendar({
          ctyhocn,
          arrivalDate: monthArrival,
          lengthOfStay,
          friendsAndFamily,
          guestId,
        });
        await setCachedCalendar(
          {
            ...calendarParams,
            hotelName: hotelName || null,
            brandCode: brandCode || null,
            city: city || null,
            country: country || null,
            lat: lat ?? null,
            lon: lon ?? null,
          },
          calendar
        );

        const dep =
          departureDate || addDaysISO(arrivalDate, lengthOfStay);
        const shopParams = {
          ctyhocn,
          arrivalDate,
          departureDate: dep,
          friendsAndFamily,
          guestId,
          currency: "USD",
        };
        await deleteCachedShopRooms(shopParams);
        let roomsPayload = null;
        try {
          roomsPayload = await fetchShopRooms({
            ctyhocn,
            arrivalDate,
            departureDate: dep,
            friendsAndFamily,
            guestId,
          });
          await setCachedShopRooms(shopParams, roomsPayload);
        } catch (shopErr) {
          // Calendar refresh still useful if room shop fails.
          if (isUnauthorizedError(shopErr)) throw shopErr;
          roomsPayload = { rooms: [], currency: null, error: String(shopErr.message || shopErr) };
        }

        const hotelCtyhocn = calendar.ctyhocn || ctyhocn;
        const resolvedName =
          hotelName &&
          String(hotelName).toUpperCase() !== String(hotelCtyhocn).toUpperCase()
            ? hotelName
            : null;
        const days = (calendar.days || [])
          .filter((day) => day?.arrivalDate && day.amount != null)
          .map((day) => {
            const arrival = day.arrivalDate;
            const departure = addDaysISO(arrival, lengthOfStay);
            return {
              ...day,
              arrivalDate: arrival,
              departureDate: departure,
              hotelName: resolvedName,
              brandCode: brandCode || null,
              city: city || null,
              country: country || null,
              ctyhocn: hotelCtyhocn,
              nights: lengthOfStay,
              fromCache: false,
              bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
                hotelCtyhocn
              )}&arrivalDate=${encodeURIComponent(arrival)}&departureDate=${encodeURIComponent(
                departure
              )}&room1NumAdults=1`,
            };
          });

        sendResponse({
          ok: true,
          days,
          rooms: roomsPayload?.rooms || [],
          roomsError: roomsPayload?.error || null,
          currency: roomsPayload?.currency || calendar.currency || null,
          fromCache: false,
          guestId,
          monthArrival,
        });
        await clearUnauthorizedFlag();
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await clearGuestSession();
          sendResponse({
            ok: false,
            unauthorized: true,
            error: "Hilton session expired. Sign in again to continue.",
          });
          return;
        }
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return;
    }

    if (message?.type === "SCAN_RATES") {
      scanCancelled = false;
      pruneStaleCache().catch(() => {});
      const {
        hotels,
        fromDate,
        toDate,
        ranges = null,
        friendsAndFamily = true,
        goOnly = true,
        maxRate = null,
        minRooms = 1,
        delayMs = 1000,
      } = message;

      const guestId = await getGuestId();
      const scanRanges = normalizeScanRanges({ ranges, fromDate, toDate });
      if (!scanRanges.length) {
        recordActivity({
          type: "scan",
          name: "rates_error",
          ok: false,
          error: "At least one stay is required",
        });
        sendResponse({ ok: false, error: "At least one stay is required" });
        return;
      }
      const tooLong = scanRanges.find((r) => r.nights > 7);
      if (tooLong) {
        const err = `Stays can be at most 7 nights (got ${tooLong.nights} for ${tooLong.fromDate} → ${tooLong.toDate}).`;
        recordActivity({ type: "scan", name: "rates_error", ok: false, error: err });
        sendResponse({ ok: false, error: err });
        return;
      }

      // One calendar fetch per hotel × stay (month + length of stay).
      const jobs = [];
      for (const hotel of hotels || []) {
        for (const stay of scanRanges) {
          jobs.push({
            hotel,
            stay,
            monthArrival: `${String(stay.fromDate).slice(0, 7)}-01`,
          });
        }
      }
      const rows = [];
      let done = 0;
      let cacheHits = 0;
      const total = jobs.length;
      const hotelCount = (hotels || []).length;

      recordActivity({
        type: "scan",
        name: "rates_start",
        detail: {
          hotelCount,
          stayCount: scanRanges.length,
          jobs: total,
          goOnly,
          maxRate,
          minRooms,
          delayMs,
          ranges: scanRanges,
        },
      });

      outer: for (const job of jobs) {
        if (scanCancelled) break outer;
        const { hotel, stay, monthArrival } = job;
        const nights = Math.max(1, Number(stay.nights) || nightsBetweenISO(stay.fromDate, stay.toDate));
        const checkIn = dateOnly(stay.fromDate);
        const checkOut = dateOnly(stay.toDate) || addDaysISO(checkIn, nights);
        const cacheParams = {
          ctyhocn: hotel.ctyhocn,
          arrivalDate: monthArrival,
          nights,
          friendsAndFamily,
          guestId,
          currency: "USD",
        };
        let fromCache = false;
        try {
          let calendar = await getCachedCalendar(cacheParams);
          if (calendar) {
            fromCache = true;
            cacheHits += 1;
          } else {
            calendar = await fetchCalendar({
              ctyhocn: hotel.ctyhocn,
              arrivalDate: monthArrival,
              lengthOfStay: nights,
              friendsAndFamily,
              guestId,
            });
            await setCachedCalendar(
              {
                ...cacheParams,
                hotelName: hotel.name || null,
                brandCode: hotel.brandCode || null,
                city: hotel.city || null,
                country: hotel.country || null,
                lat: hotel.lat ?? null,
                lon: hotel.lon ?? null,
              },
              calendar
            );
          }

          for (const day of calendar.days || []) {
            if (day.amount == null) continue;
            const arrival = dateOnly(day.arrivalDate);
            // Exact stay: check-in must match this range's start.
            if (arrival !== checkIn) continue;
            if (goOnly && !day.isGoRate) continue;
            if (maxRate != null && day.amount > maxRate) continue;
            if ((day.roomsAvail ?? 0) < minRooms) continue;
            const departureDate = checkOut;
            const ctyhocn = calendar.ctyhocn || hotel.ctyhocn;
            rows.push({
              arrivalDate: arrival,
              departureDate,
              amount: day.amount,
              amountFmt: day.amountFmt,
              currency: day.currency,
              roomsAvail: day.roomsAvail,
              ratePlanCode: day.ratePlanCode,
              roomTypeCode: day.roomTypeCode,
              ratePlanName: day.ratePlanName,
              ratePlanDesc: day.ratePlanDesc,
              specialRateType: day.specialRateType,
              isGoRate: day.isGoRate,
              amountOriginal: day.amountOriginal,
              currencyOriginal: day.currencyOriginal,
              fxRateToUsd: day.fxRateToUsd,
              hotelName: hotel.name,
              brandCode: hotel.brandCode,
              city: hotel.city,
              country: hotel.country,
              ctyhocn,
              nights,
              fromCache,
              fetchedAt: fromCache ? calendar.fetchedAt || null : null,
              bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
                ctyhocn
              )}&arrivalDate=${encodeURIComponent(arrival)}&departureDate=${encodeURIComponent(
                departureDate
              )}&room1NumAdults=1`,
            });
          }
        } catch (err) {
          if (isUnauthorizedError(err)) {
            await clearGuestSession();
            emitScanProgress({
              done,
              total,
              hotel: hotel.name,
              rows,
              fromCache,
              cacheHits,
              hotelCount,
              unauthorized: true,
            });
            scanCancelled = false;
            sendResponse({
              ok: false,
              unauthorized: true,
              error: "Hilton session expired. Sign in again to continue.",
              rows: sortScanRows(rows),
              guestId: null,
              cancelled: false,
              done,
              total,
              cacheHits,
            });
            return;
          }
          rows.push({
            error: true,
            ctyhocn: hotel.ctyhocn,
            hotelName: hotel.name,
            arrivalDate: stay.fromDate,
            message: String(err.message || err),
          });
        }
        done += 1;
        emitScanProgress({
          done,
          total,
          hotel: hotel.name,
          rows,
          fromCache,
          cacheHits,
          hotelCount,
        });
        if (scanCancelled) break outer;
        if (!fromCache) await new Promise((r) => setTimeout(r, delayMs));
      }

      const cancelled = scanCancelled;
      scanCancelled = false;

      const unauthorizedRows = rows.filter(
        (r) => r.error && /unauthorized/i.test(String(r.message || ""))
      );
      const matchRows = rows.filter((r) => !r.error);
      const errorRows = rows.filter((r) => r.error);
      if (unauthorizedRows.length) {
        await clearGuestSession();
        recordActivity({
          type: "scan",
          name: "rates_unauthorized",
          ok: false,
          error: "unauthorized",
          detail: { done, total, cacheHits, matches: matchRows.length, errors: errorRows.length },
        });
        sendResponse({
          ok: false,
          unauthorized: true,
          error: "Hilton session expired. Sign in again to continue.",
          rows: sortScanRows(rows),
          guestId: null,
          cancelled,
          done,
          total,
          cacheHits,
        });
        return;
      }

      await clearUnauthorizedFlag();
      recordActivity({
        type: "scan",
        name: cancelled ? "rates_cancelled" : "rates_done",
        ok: true,
        detail: {
          done,
          total,
          cacheHits,
          matches: matchRows.length,
          matchHotels: new Set(matchRows.map((r) => String(r.ctyhocn || "").toUpperCase()).filter(Boolean))
            .size,
          errors: errorRows.length,
          cancelled,
          errorSamples: errorRows.slice(0, 8).map((r) => ({
            hotel: r.hotelName || r.ctyhocn,
            arrivalDate: r.arrivalDate,
            message: r.message,
          })),
        },
      });
      sendResponse({
        ok: true,
        rows: sortScanRows(rows),
        guestId: (await getGuestId()) || guestId,
        cancelled,
        done,
        total,
        cacheHits,
      });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
    });
  })().catch(async (err) => {
    recordActivity({
      type: "error",
      name: "handler",
      ok: false,
      error: String(err?.message || err),
      sessionId: message?.sessionId || null,
      detail: { messageType: message?.type || null },
    });
    if (isUnauthorizedError(err)) {
      await clearGuestSession();
      sendResponse({
        ok: false,
        unauthorized: true,
        error: "Hilton session expired. Sign in again to continue.",
      });
      return;
    }
    sendResponse({ ok: false, error: String(err.message || err) });
  });

  return true;
});
