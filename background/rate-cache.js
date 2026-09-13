/**
 * Persistent rate cache (IndexedDB) — hotel calendars + shop rooms only for the map.
 * Seats.aero flight searches use a separate store and are never shown on the map.
 * Entries older than TTL_MS are treated as stale and refreshed on next use.
 */

const DB_NAME = "go-rates-cache";
const DB_VERSION = 3;
const STORE = "calendars";
const ROOM_STORE = "shopRooms";
const FLIGHT_STORE = "seatsFlights";
const TTL_MS = 4 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(ROOM_STORE)) {
        const store = db.createObjectStore(ROOM_STORE, { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(FLIGHT_STORE)) {
        const store = db.createObjectStore(FLIGHT_STORE, { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function calendarCacheKey({ ctyhocn, arrivalDate, nights, friendsAndFamily, guestId, currency = "USD" }) {
  return [
    String(ctyhocn || "").toUpperCase(),
    arrivalDate,
    String(nights || 1),
    friendsAndFamily ? "fnf" : "tm",
    guestId ? String(guestId) : "0",
    "usd-fx",
  ].join("|");
}

async function getCachedCalendar(params) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry?.calendar) return null;
    if (!isCompleteCalendarEntry(entry)) {
      // Drop incomplete identity so the next write can store a full record.
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.objectStore(STORE).delete(key);
        });
      } catch {
        /* ignore */
      }
      return null;
    }
    const age = Date.now() - Number(entry.fetchedAt || 0);
    if (age > TTL_MS) return null;
    return {
      ...entry.calendar,
      cached: true,
      fetchedAt: entry.fetchedAt,
      ageMs: age,
    };
  } finally {
    db.close();
  }
}

async function setCachedCalendar(params, calendar) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    // Preserve hotel identity if a refresh/write omits it (older paths left these null).
    let prev = null;
    try {
      prev = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      prev = null;
    }

    const ctyhocn = String(params.ctyhocn || "").toUpperCase();
    const pickMeta = (next, fallback) => {
      const n = next == null || next === "" ? null : String(next);
      if (n && n.toUpperCase() !== ctyhocn) return n;
      const f = fallback == null || fallback === "" ? null : String(fallback);
      if (f && f.toUpperCase() !== ctyhocn) return f;
      return n || f || null;
    };
    const pickCoord = (next, fallback) => {
      const n = Number(next);
      if (Number.isFinite(n)) return n;
      const f = Number(fallback);
      return Number.isFinite(f) ? f : null;
    };

    // If this key never stored a name, borrow identity from any other calendar for the same hotel.
    let sibling = null;
    if (!pickMeta(params.hotelName || calendar.hotelName, prev?.hotelName)) {
      try {
        const all = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        sibling =
          all.find(
            (e) =>
              e &&
              e.key !== key &&
              String(e.ctyhocn || "").toUpperCase() === ctyhocn &&
              e.hotelName &&
              String(e.hotelName).toUpperCase() !== ctyhocn
          ) || null;
      } catch {
        sibling = null;
      }
    }

    const record = {
      key,
      ctyhocn,
      arrivalDate: params.arrivalDate,
      nights: Number(params.nights || 1),
      friendsAndFamily: Boolean(params.friendsAndFamily),
      guestId: params.guestId || null,
      hotelName: pickMeta(
        params.hotelName || calendar.hotelName,
        prev?.hotelName || sibling?.hotelName
      ),
      brandCode: pickMeta(
        params.brandCode || calendar.brandCode,
        prev?.brandCode || sibling?.brandCode
      ),
      city: pickMeta(params.city || calendar.city, prev?.city || sibling?.city),
      country: pickMeta(
        params.country || calendar.country,
        prev?.country || sibling?.country
      ),
      lat: pickCoord(params.lat ?? calendar.lat, prev?.lat ?? sibling?.lat),
      lon: pickCoord(params.lon ?? calendar.lon, prev?.lon ?? sibling?.lon),
      fetchedAt: Date.now(),
      calendar: {
        ctyhocn: calendar.ctyhocn,
        currency: calendar.currency,
        statusCode: calendar.statusCode,
        days: calendar.days || [],
      },
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE);
      // Don't persist incomplete identity — Cached would show the CTYHOCN as the name.
      if (!isCompleteCalendarEntry(record)) {
        store.delete(key);
      } else {
        store.put(record);
      }
    });
  } finally {
    db.close();
  }
}

function hasRealHotelName(entry) {
  const code = String(entry?.ctyhocn || entry?.calendar?.ctyhocn || "").toUpperCase();
  const name = entry?.hotelName == null || entry.hotelName === "" ? "" : String(entry.hotelName);
  if (!name) return false;
  if (code && name.toUpperCase() === code) return false;
  return true;
}

/** Calendar rows need hotel identity; without it Cached falls back to the CTYHOCN. */
function isCompleteCalendarEntry(entry) {
  if (!entry?.calendar) return false;
  if (!Array.isArray(entry.calendar.days)) return false;
  if (!hasRealHotelName(entry)) return false;
  return true;
}

async function pruneStaleCache() {
  const cutoff = Date.now() - TTL_MS;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const stores = [STORE, ROOM_STORE];
      if (db.objectStoreNames.contains(FLIGHT_STORE)) stores.push(FLIGHT_STORE);
      const tx = db.transaction(stores, "readwrite");

      const calendars = tx.objectStore(STORE);
      const calReq = calendars.openCursor();
      calReq.onsuccess = () => {
        const cursor = calReq.result;
        if (!cursor) return;
        const entry = cursor.value;
        const stale = Number(entry?.fetchedAt || 0) <= cutoff;
        if (stale || !isCompleteCalendarEntry(entry)) cursor.delete();
        cursor.continue();
      };

      const rooms = tx.objectStore(ROOM_STORE);
      const roomIndex = rooms.index("fetchedAt");
      const roomReq = roomIndex.openCursor(IDBKeyRange.upperBound(cutoff));
      roomReq.onsuccess = () => {
        const cursor = roomReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };

      if (db.objectStoreNames.contains(FLIGHT_STORE)) {
        const flights = tx.objectStore(FLIGHT_STORE);
        const flightIndex = flights.index("fetchedAt");
        const flightReq = flightIndex.openCursor(IDBKeyRange.upperBound(cutoff));
        flightReq.onsuccess = () => {
          const cursor = flightReq.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function shopRoomsCacheKey({
  ctyhocn,
  arrivalDate,
  departureDate,
  friendsAndFamily,
  guestId,
  currency = "USD",
}) {
  return [
    String(ctyhocn || "").toUpperCase(),
    arrivalDate,
    departureDate,
    friendsAndFamily ? "fnf" : "tm",
    guestId ? String(guestId) : "0",
    "usd-fx-rt3",
  ].join("|");
}

async function getCachedShopRooms(params) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readonly");
      const req = tx.objectStore(ROOM_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry?.payload) return null;
    const age = Date.now() - Number(entry.fetchedAt || 0);
    if (age > TTL_MS) return null;
    return { ...entry.payload, cached: true, fetchedAt: entry.fetchedAt };
  } finally {
    db.close();
  }
}

async function setCachedShopRooms(params, payload) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(ROOM_STORE).put({
        key,
        fetchedAt: Date.now(),
        payload: {
          ctyhocn: payload.ctyhocn,
          currency: payload.currency,
          statusCode: payload.statusCode,
          rooms: payload.rooms || [],
        },
      });
    });
  } finally {
    db.close();
  }
}

/**
 * All non-stale calendar cache entries matching nights / rate type / guest.
 * Used by the "Cached" destination to search local results only.
 */
async function listCachedCalendars({
  nights = null,
  friendsAndFamily = null,
  guestId = null,
  includeStale = false,
} = {}) {
  const db = await openDb();
  try {
    const entries = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    const wantNights = nights == null ? null : Number(nights) || 1;
    const wantGuest = guestId == null ? null : guestId ? String(guestId) : "0";
    return entries.filter((entry) => {
      if (!isCompleteCalendarEntry(entry)) return false;
      if (!includeStale && now - Number(entry.fetchedAt || 0) > TTL_MS) return false;
      if (wantNights != null && Number(entry.nights || 1) !== wantNights) return false;
      if (friendsAndFamily != null && Boolean(entry.friendsAndFamily) !== Boolean(friendsAndFamily)) {
        return false;
      }
      if (wantGuest != null) {
        const entryGuest = entry.guestId ? String(entry.guestId) : "0";
        if (entryGuest !== wantGuest) return false;
      }
      return true;
    });
  } finally {
    db.close();
  }
}

async function deleteCachedCalendar(params) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(key);
    });
  } finally {
    db.close();
  }
}

async function deleteCachedShopRooms(params) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(ROOM_STORE).delete(key);
    });
  } finally {
    db.close();
  }
}

function normalizeAirportKeyPart(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return [
    ...new Set(
      raw
        .toUpperCase()
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => /^[A-Z]{3}$/.test(s))
    ),
  ]
    .sort()
    .join(",");
}

/** Flight award cache — separate from hotel calendars (never used by the map). */
function flightSearchCacheKey({
  originAirports,
  destinationAirports,
  startDate,
  endDate,
  transferPartners = "chase",
  onlyDirect = false,
  cabins = null,
  includeTrips = true,
}) {
  return [
    "seats",
    normalizeAirportKeyPart(originAirports),
    normalizeAirportKeyPart(destinationAirports),
    startDate || "",
    endDate || "",
    String(transferPartners || "chase").toLowerCase(),
    onlyDirect ? "direct" : "any",
    cabins ? String(cabins) : "",
    // "trips-full" busts older minify_trips caches that lacked aircraft/segments.
    includeTrips ? "trips-full" : "summary",
  ].join("|");
}

async function getCachedFlightSearch(params) {
  const key = flightSearchCacheKey(params);
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(FLIGHT_STORE)) return null;
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(FLIGHT_STORE, "readonly");
      const req = tx.objectStore(FLIGHT_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry?.payload) return null;
    const age = Date.now() - Number(entry.fetchedAt || 0);
    if (age > TTL_MS) return null;
    return {
      ...entry.payload,
      fromCache: true,
      fetchedAt: entry.fetchedAt,
      ageMs: age,
    };
  } finally {
    db.close();
  }
}

async function setCachedFlightSearch(params, payload) {
  const key = flightSearchCacheKey(params);
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(FLIGHT_STORE)) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FLIGHT_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(FLIGHT_STORE).put({
        key,
        fetchedAt: Date.now(),
        payload: {
          flights: payload.flights || [],
          count: payload.count ?? (payload.flights || []).length,
          rawCount: payload.rawCount ?? null,
          origins: payload.origins || [],
          destinations: payload.destinations || [],
          startDate: payload.startDate || null,
          endDate: payload.endDate || null,
          transferPartners: payload.transferPartners || "chase",
          sources: payload.sources ?? null,
        },
      });
    });
  } finally {
    db.close();
  }
}

async function deleteCachedFlightSearch(params) {
  const key = flightSearchCacheKey(params);
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(FLIGHT_STORE)) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FLIGHT_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(FLIGHT_STORE).delete(key);
    });
  } finally {
    db.close();
  }
}

/**
 * Unique hotels from the calendar cache for the coverage map.
 * Hotel rates only — never includes Seats.aero flight cache.
 * Aggregates entry counts; prefers stored lat/lon.
 */
async function listCachedMapHotels({ includeStale = true } = {}) {
  const entries = await listCachedCalendars({ includeStale });
  const byHotel = new Map();
  for (const entry of entries) {
    const ctyhocn = String(entry.ctyhocn || entry.calendar?.ctyhocn || "").toUpperCase();
    if (!ctyhocn) continue;
    const prev = byHotel.get(ctyhocn) || {
      ctyhocn,
      hotelName: null,
      city: null,
      country: null,
      brandCode: null,
      lat: null,
      lon: null,
      entries: 0,
      lastFetchedAt: 0,
    };
    prev.entries += 1;
    prev.lastFetchedAt = Math.max(prev.lastFetchedAt, Number(entry.fetchedAt || 0));
    if (!prev.hotelName && entry.hotelName) prev.hotelName = entry.hotelName;
    if (!prev.city && entry.city) prev.city = entry.city;
    if (!prev.country && entry.country) prev.country = entry.country;
    if (!prev.brandCode && entry.brandCode) prev.brandCode = entry.brandCode;
    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    if (prev.lat == null && Number.isFinite(lat)) prev.lat = lat;
    if (prev.lon == null && Number.isFinite(lon)) prev.lon = lon;
    byHotel.set(ctyhocn, prev);
  }
  return [...byHotel.values()].sort((a, b) => b.entries - a.entries);
}

/** Write lat/lon onto every calendar cache row for a hotel (map backfill). */
async function updateCachedHotelCoords(ctyhocn, lat, lon) {
  const code = String(ctyhocn || "").toUpperCase();
  const la = Number(lat);
  const lo = Number(lon);
  if (!code || !Number.isFinite(la) || !Number.isFinite(lo)) return 0;
  const db = await openDb();
  try {
    let updated = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const entry = cursor.value;
        if (String(entry?.ctyhocn || "").toUpperCase() === code) {
          cursor.update({ ...entry, lat: la, lon: lo });
          updated += 1;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return updated;
  } finally {
    db.close();
  }
}

export {
  getCachedCalendar,
  setCachedCalendar,
  deleteCachedCalendar,
  listCachedCalendars,
  listCachedMapHotels,
  updateCachedHotelCoords,
  getCachedShopRooms,
  setCachedShopRooms,
  deleteCachedShopRooms,
  getCachedFlightSearch,
  setCachedFlightSearch,
  deleteCachedFlightSearch,
  pruneStaleCache,
};
